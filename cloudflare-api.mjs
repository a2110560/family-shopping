import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { Buffer } from 'node:buffer';
import { makeShoppingStore, reject, schema } from './shopping-store.mjs';
import { makePhotoBackup } from './github-photos.mjs';

const maxRequest = 30 * 1024 * 1024;
const sessionLifetime = 30 * 24 * 60 * 60 * 1000;
const hash = (value) => createHash('sha256').update(value).digest();

function sqlAdapter(sql) {
  const parameter = (value) => ArrayBuffer.isView(value) ?
    value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) : value;
  return {
    prepare(statement) {
      const all = (...values) => sql.exec(statement, ...values.map(parameter)).toArray();
      return { all, get: (...values) => all(...values)[0], run: all };
    }
  };
}

async function readBody(request) {
  if (request.headers.get('Content-Type')?.split(';')[0] !== 'application/json' || !request.body) {
    reject(415, '請使用 JSON 格式。');
  }
  if (Number(request.headers.get('Content-Length')) > maxRequest) reject(413, '上傳檔案過大。');
  const reader = request.body.getReader();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maxRequest) {
        await reader.cancel();
        reject(413, '上傳檔案過大。');
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  let body;
  try { body = JSON.parse(Buffer.concat(chunks, bytes)); } catch { reject(400, '無法讀取送出的內容。'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) reject(400, '資料格式錯誤。');
  return body;
}

export function makeCloudflareApi(storage, env, requestGitHub = fetch) {
  storage.sql.exec(schema).toArray();
  const origin = env.FAMILY_SHOPPING_PAGES_ORIGIN;
  const code = env.FAMILY_SHOPPING_CODE?.trim();
  const configured = code?.length >= 22 && code.length <= 128;
  const codeHash = configured && hash(code);
  const sessionKey = (token) => createHash('sha256').update(codeHash).update(token).digest('hex');
  const attempts = new Map();
  const db = sqlAdapter(storage.sql);
  const backup = env.FAMILY_SHOPPING_GITHUB_TOKEN ? makePhotoBackup(db, env, requestGitHub) : undefined;
  const shopping = makeShoppingStore(db, (callback) => storage.transactionSync(callback), backup?.enqueue);

  async function scheduleBackup() {
    const due = backup?.nextDue();
    if (due == null) return;
    const when = Math.max(due, Date.now() + 2500);
    await storage.transaction(async () => {
      const alarm = await storage.getAlarm();
      if (alarm == null || when < alarm) await storage.setAlarm(when);
    });
  }

  function unlock(address, candidate) {
    const now = Date.now();
    const attempt = attempts.get(address);
    if (attempt?.count >= 6 && attempt.until > now) reject(429, '輸入次數過多，請稍後再試。');
    if (typeof candidate !== 'string' || candidate.length > 128 || !timingSafeEqual(hash(candidate.trim()), codeHash)) {
      if (attempts.size >= 2048) {
        for (const [key, record] of attempts) if (record.until <= now) attempts.delete(key);
        if (attempts.size >= 2048) attempts.delete(attempts.keys().next().value);
      }
      attempts.set(address, attempt?.until > now ? { count: attempt.count + 1, until: attempt.until } :
        { count: 1, until: now + 60_000 });
      reject(401, '通行碼不正確。');
    }
    attempts.delete(address);
    const token = randomBytes(32).toString('base64url');
    storage.transactionSync(() => {
      db.prepare('DELETE FROM sessions WHERE expires <= ?').run(now);
      db.prepare('INSERT INTO sessions VALUES (?, ?)').run(sessionKey(token), now + sessionLifetime);
    });
    return { unlocked: true, token };
  }

  async function fetchRequest(request) {
    const headers = new Headers({ 'Cache-Control': 'no-store', Vary: 'Origin', 'X-Content-Type-Options': 'nosniff' });
    const json = (data, status = 200) => Response.json(data, { status, headers });
    const { pathname } = new URL(request.url);
    if (pathname === '/health' && request.method === 'GET') {
      return json({ ok: Boolean(configured), photoBackup: Boolean(backup) }, configured ? 200 : 503);
    }
    if (!origin || request.headers.get('Origin') !== origin) return json({ error: '請從家人代購網站送出資料。' }, 403);
    headers.set('Access-Control-Allow-Origin', origin);
    const { method } = request;
    if (method === 'OPTIONS') {
      headers.set('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
      headers.set('Access-Control-Allow-Headers', 'Authorization, Content-Type');
      headers.set('Access-Control-Max-Age', '600');
      return new Response(null, { status: 204, headers });
    }

    try {
      if (!configured) reject(503, '還需要設定家庭通行碼。');
      if (pathname === '/api/unlock' && method === 'POST') {
        const input = await readBody(request);
        return json(unlock(request.headers.get('CF-Connecting-IP') || 'unknown', input.code));
      }
      const token = /^Bearer ([a-zA-Z0-9_-]{43})$/.exec(request.headers.get('Authorization') || '')?.[1];
      const key = token && sessionKey(token);
      const session = key && db.prepare('SELECT expires FROM sessions WHERE token = ?').get(key);
      if (!session || session.expires <= Date.now()) reject(401, '請輸入家庭通行碼。');
      if (pathname === '/api/logout' && method === 'POST') {
        db.prepare('DELETE FROM sessions WHERE token = ?').run(key);
        return json({});
      }
      if (pathname === '/api/items' && method === 'GET') {
        await scheduleBackup();
        return json({ items: shopping.list(), demo: false });
      }
      if (pathname === '/api/items' && method === 'POST') {
        const id = shopping.create(await readBody(request));
        await scheduleBackup();
        return json({ id }, 201);
      }
      if (pathname === '/api/order' && method === 'PUT') {
        shopping.reorder(await readBody(request));
        return json({});
      }
      const itemPath = /^\/api\/items\/(\d+)$/.exec(pathname);
      if (itemPath && ['PUT', 'PATCH', 'DELETE'].includes(method)) {
        shopping.modify(Number(itemPath[1]), await readBody(request), method);
        await scheduleBackup();
        return json({});
      }
      const photoPath = /^\/api\/photos\/(\d+)$/.exec(pathname);
      if (photoPath && method === 'GET') {
        const image = shopping.photo(Number(photoPath[1]));
        headers.set('Content-Type', 'image/jpeg');
        return new Response(image, { headers });
      }
      reject(404, '找不到這個功能。');
    } catch (error) {
      if (!error.status) console.error('Cloudflare 購物清單請求失敗', error.name);
      return json({ error: error.status ? error.message : '暫時無法完成，請稍後再試。' }, error.status || 500);
    }
  }

  return {
    fetch: fetchRequest,
    async alarm() {
      await backup?.sync();
      await scheduleBackup();
    }
  };
}
