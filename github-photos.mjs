import { createHash, randomUUID } from 'node:crypto';
import { Buffer } from 'node:buffer';

export function makePhotoBackup(db, env, request = fetch) {
  const repository = env.FAMILY_SHOPPING_GITHUB_REPO;
  const token = env.FAMILY_SHOPPING_GITHUB_TOKEN?.trim();
  if (!repository && !token) return;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository || '') || !token) {
    throw new Error('請同時設定 FAMILY_SHOPPING_GITHUB_REPO 與 FAMILY_SHOPPING_GITHUB_TOKEN。');
  }
  if (repository.split('/').some((part) => part === '.' || part === '..')) throw new Error('GitHub 儲存庫名稱無效。');
  db.prepare("INSERT OR IGNORE INTO settings VALUES ('github-backup-id', ?)").run(randomUUID());
  const instance = db.prepare("SELECT value FROM settings WHERE key = 'github-backup-id'").get().value;
  const root = `https://api.github.com/repos/${repository}`;
  const headers = {
    Accept: 'application/vnd.github+json',
    Authorization: `Bearer ${token}`,
    'Content-Type': 'application/json',
    'User-Agent': 'family-shopping-photo-backup'
  };
  function send(path = '', attributes = {}) {
    return request(root + path, { ...attributes, headers: { ...headers, ...attributes.headers },
      redirect: 'manual', signal: AbortSignal.timeout(20_000) });
  }

  const enqueue = db.prepare('INSERT INTO github_photo_backups (photo_id, repository) VALUES (?, ?)');
  const poll = db.prepare(`
    SELECT job.photo_id, job.attempts, photo.data FROM github_photo_backups AS job
    JOIN photos AS photo ON photo.id = job.photo_id
    WHERE job.repository = ? AND job.synced_at IS NULL AND job.retry_at <= ?
    ORDER BY job.photo_id LIMIT 1
  `);
  const uploaded = db.prepare('UPDATE github_photo_backups SET synced_at = ? WHERE photo_id = ?');
  const retry = db.prepare('UPDATE github_photo_backups SET attempts = attempts + 1, retry_at = ? WHERE photo_id = ?');
  let running = false;

  async function sync() {
    if (running) return;
    const job = poll.get(repository, Date.now());
    if (!job) return;
    running = true;
    let phase = 'repository';
    let status;
    try {
      const info = await send();
      status = info.status;
      if (!info.ok || (await info.json()).visibility !== 'private') {
        throw new Error('備份需要可存取的私有 GitHub 儲存庫。');
      }
      const path = `/contents/photos/${instance}/${job.photo_id}.jpg`;
      const data = Buffer.from(job.data);
      const hash = createHash('sha1').update(`blob ${data.length}\0`).update(data).digest('hex');
      phase = 'photo lookup';
      status = undefined;
      const existing = await send(path, { headers: { Accept: 'application/vnd.github.object+json' } });
      status = existing.status;
      if (existing.ok) {
        if ((await existing.json()).sha !== hash) throw new Error('備份路徑已有不同內容。');
      } else if (existing.status === 404) {
        phase = 'photo write';
        status = undefined;
        const result = await send(path, {
          method: 'PUT', body: JSON.stringify({ message: 'Back up a shopping photo', content: data.toString('base64') })
        });
        status = result.status;
        if (!result.ok) throw new Error(`GitHub 寫入失敗（HTTP ${result.status}）。`);
        await result.body?.cancel();
      } else {
        throw new Error(`GitHub 查詢失敗（HTTP ${existing.status}）。`);
      }
      phase = 'record backup';
      uploaded.run(Date.now(), job.photo_id);
    } catch (error) {
      const seconds = Math.min(3600, 15 * 2 ** Math.min(job.attempts, 8));
      retry.run(Date.now() + seconds * 1000, job.photo_id);
      console.warn('照片備份稍後重試。', { photoId: job.photo_id, phase, status, errorType: error.name });
    } finally {
      running = false;
    }
  }

  const due = db.prepare('SELECT MIN(retry_at) AS time FROM github_photo_backups WHERE repository = ? AND synced_at IS NULL');
  return { enqueue: (id) => enqueue.run(id, repository), sync, nextDue: () => due.get(repository).time };
}

export function startPhotoBackup(db, env, request = fetch) {
  const backup = makePhotoBackup(db, env, request);
  if (!backup) return;
  const timer = setInterval(() => void backup.sync(), 2500);
  timer.unref();
  return backup;
}

