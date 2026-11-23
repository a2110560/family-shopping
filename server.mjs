import { createServer } from 'node:http';
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { statuses, currencies } from './public/model.mjs';
import { startPhotoBackup } from './github-photos.mjs';

const demo = process.argv.includes('--demo');
const resetCode = process.argv.includes('--reset-code');
const port = Number(process.env.FAMILY_SHOPPING_PORT || 4173);
const host = process.env.FAMILY_SHOPPING_HOST || '127.0.0.1';
const origin = process.env.FAMILY_SHOPPING_ORIGIN;
const pagesOrigin = process.env.FAMILY_SHOPPING_PAGES_ORIGIN;
if (pagesOrigin && !/^https:\/\/[a-z0-9.-]+(?::\d+)?$/i.test(pagesOrigin)) {
  throw new Error('FAMILY_SHOPPING_PAGES_ORIGIN 必須是 HTTPS 來源，不帶路徑或尾端斜線。');
}
if (pagesOrigin && pagesOrigin === origin) throw new Error('GitHub Pages 與 API 須使用各自的 HTTPS 來源。');
const file = resolve(process.env.FAMILY_SHOPPING_DB || (demo ? 'data/demo.sqlite' : 'data/shopping.sqlite'));
mkdirSync(dirname(file), { recursive: true });
const db = new DatabaseSync(file);
db.exec(`
  PRAGMA foreign_keys = ON;
  PRAGMA journal_mode = WAL;
  PRAGMA busy_timeout = 5000;
  CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, expires INTEGER NOT NULL);
  CREATE TABLE IF NOT EXISTS items (
    id INTEGER PRIMARY KEY AUTOINCREMENT, item TEXT NOT NULL,
    position INTEGER NOT NULL, revision INTEGER NOT NULL DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS photos (
    id INTEGER PRIMARY KEY AUTOINCREMENT, item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    kind TEXT NOT NULL, data BLOB NOT NULL
  );
  CREATE TABLE IF NOT EXISTS github_photo_backups (
    photo_id INTEGER PRIMARY KEY REFERENCES photos(id) ON DELETE CASCADE, repository TEXT NOT NULL,
    synced_at INTEGER, attempts INTEGER NOT NULL DEFAULT 0, retry_at INTEGER NOT NULL DEFAULT 0
  );
`);

function makeCode() {
  const code = demo ? 'demo-shopping' : randomBytes(12).toString('base64url');
  const salt = randomBytes(16).toString('hex');
  const hash = scryptSync(code, salt, 64).toString('hex');
  db.prepare("INSERT OR REPLACE INTO settings VALUES ('passcode', ?)").run(`${salt}:${hash}`);
  db.exec('DELETE FROM sessions');
  console.log(`家庭通行碼（請妥善保存）\n${code}`);
}

if (resetCode || !db.prepare("SELECT 1 FROM settings WHERE key = 'passcode'").get()) makeCode();
if (resetCode) process.exit(0);
const backups = demo ? undefined : startPhotoBackup(db, process.env);

function transaction(work) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = work();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

if (demo && !db.prepare("SELECT 1 FROM settings WHERE key = 'demo-seeded'").get()) {
  transaction(() => {
    const insert = db.prepare('INSERT INTO items (item, position) VALUES (?, ?)');
    const examples = [
      ['抹茶夾心餅乾', '家人 A', 2, 'pending', '百貨地下食品區', '原味，獨立小包裝。'],
      ['旅行收納袋', '家人 B', 1, 'bought', '生活用品店', '中尺寸，深色。'],
      ['焙茶茶包', '家人 A', 3, 'pending', '茶葉專賣店', '無糖，20 入左右。'],
      ['迷你保溫杯', '家人 C', 1, 'missed', '車站商場', '250 mL。'],
      ['柚子胡椒', '家人 B', 2, 'bought', '超市', '罐裝或軟管皆可。']
    ];
    examples.forEach(([name, person, quantity, status, store, note], position) => {
      insert.run(JSON.stringify({ name, person, quantity, status, store, note,
        amount: [null, 1800, 960, null, 880][position], currency: 'JPY', productUrl: '', mapUrl: '' }), position);
    });
    db.exec("INSERT INTO settings VALUES ('demo-seeded', 'true')");
  });
}

const files = new Map([
  ['/', ['index.html', 'text/html; charset=utf-8']],
  ['/index.html', ['index.html', 'text/html; charset=utf-8']],
  ['/app.mjs', ['app.mjs', 'text/javascript; charset=utf-8']],
  ['/model.mjs', ['model.mjs', 'text/javascript; charset=utf-8']],
  ['/config.mjs', ['config.mjs', 'text/javascript; charset=utf-8']],
  ['/styles.css', ['styles.css', 'text/css; charset=utf-8']],
  ['/icon-192.png', ['icon-192.png', 'image/png']],
  ['/icon-512.png', ['icon-512.png', 'image/png']],
  ['/manifest.webmanifest', ['manifest.webmanifest', 'application/manifest+json']],
  ['/sw.js', ['sw.js', 'text/javascript; charset=utf-8']]
]);
const cookieName = 'family_shopping_session';
const digest = (value) => createHash('sha256').update(value).digest('hex');
const lifetime = 60 * 60 * 24 * 30;
const attempts = new Map();

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function reject(status, message) { throw new ApiError(status, message); }

function json(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  if (req.headers['content-type']?.split(';')[0] !== 'application/json') reject(415, '請使用 JSON 格式。');
  const maximum = 30 * 1024 * 1024;
  if (Number(req.headers['content-length']) > maximum) reject(413, '上傳檔案過大。');
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > maximum) reject(413, '上傳檔案過大。');
    chunks.push(chunk);
  }
  let result;
  try { result = JSON.parse(Buffer.concat(chunks)); } catch { reject(400, '無法讀取送出的內容。'); }
  if (!result || typeof result !== 'object' || Array.isArray(result)) reject(400, '資料格式錯誤。');
  return result;
}

function tokenFrom(req) {
  if (pagesOrigin && req.headers.origin === pagesOrigin) {
    return /^Bearer ([a-zA-Z0-9_-]{43})$/.exec(req.headers.authorization || '')?.[1];
  }
  return req.headers.cookie?.split(/;\s*/).find((cookie) => cookie.startsWith(`${cookieName}=`))?.slice(cookieName.length + 1);
}

function sessionCookie(token, age) {
  return `${cookieName}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${age}${origin?.startsWith('https://') ? '; Secure' : ''}`;
}

function unlock(req, res, input) {
  const address = req.socket.remoteAddress;
  const now = Date.now();
  for (const [key, entry] of attempts) if (entry.until <= now) attempts.delete(key);
  const attempt = attempts.get(address) || { count: 0, until: now + 60_000 };
  if (attempt.count >= 6) reject(429, '輸入次數過多，請稍後再試。');
  const [salt, hash] = db.prepare("SELECT value FROM settings WHERE key = 'passcode'").get().value.split(':');
  if (typeof input.code !== 'string' || input.code.length > 128 ||
      !timingSafeEqual(scryptSync(input.code.trim(), salt, 64), Buffer.from(hash, 'hex'))) {
    attempt.count += 1;
    attempts.set(address, attempt);
    reject(401, '通行碼不正確。');
  }
  attempts.delete(address);
  db.prepare('DELETE FROM sessions WHERE expires <= ?').run(now);
  const token = randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions VALUES (?, ?)').run(digest(token), now + lifetime * 1000);
  if (pagesOrigin && req.headers.origin === pagesOrigin) return json(res, 200, { unlocked: true, token });
  json(res, 200, { unlocked: true }, { 'Set-Cookie': sessionCookie(token, lifetime) });
}

function field(value, max, required = false) {
  const clean = typeof value === 'string' ? value.trim() : '';
  if ((required && !clean) || clean.length > max) reject(422, '請檢查必填欄位和文字長度。');
  return clean;
}

function link(value) {
  const clean = field(value, 2000);
  if (!clean) return '';
  try {
    const url = new URL(clean);
    if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) return url.href;
  } catch { /* invalid URL */ }
  reject(422, '請輸入完整的 http:// 或 https:// 網址。');
}

function validatedItem(input, status) {
  if (!Number.isInteger(input.quantity) || input.quantity < 1 || input.quantity > 9999) reject(422, '數量須為 1 到 9999 的整數。');
  if (!Object.hasOwn(currencies, input.currency)) reject(422, '請選擇幣別。');
  if (input.amount !== null && (!Number.isFinite(input.amount) || input.amount < 0 || input.amount > 999999999)) {
    reject(422, '請輸入有效的整筆金額。');
  }
  return {
    name: field(input.name, 160, true), person: field(input.person, 40, true),
    quantity: input.quantity, amount: input.amount, currency: input.currency, status,
    store: field(input.store, 300), note: field(input.note, 8000),
    productUrl: link(input.productUrl), mapUrl: link(input.mapUrl)
  };
}

function validatedImages(input = []) {
  if (!Array.isArray(input) || input.length > 10) reject(422, '每批最多新增 10 張照片。');
  return input.map((photo) => {
    if (!photo || !['product', 'receipt'].includes(photo.kind) || typeof photo.data !== 'string' ||
        photo.data.length > 2_800_000 || !/^[A-Za-z0-9+/]+={0,2}$/.test(photo.data)) reject(422, '照片格式或大小無效。');
    const data = Buffer.from(photo.data, 'base64');
    if (data.length > 2 * 1024 * 1024 || data[0] !== 255 || data[1] !== 216 || data[2] !== 255 ||
        data.at(-2) !== 255 || data.at(-1) !== 217) reject(422, '照片須為壓縮後的 JPEG。');
    return { kind: photo.kind, data };
  });
}

function addImages(id, photos) {
  const insert = db.prepare('INSERT INTO photos (item_id, kind, data) VALUES (?, ?, ?)');
  for (const photo of photos) {
    const { lastInsertRowid } = insert.run(id, photo.kind, photo.data);
    backups?.enqueue(lastInsertRowid);
  }
}

function list() {
  const photos = Map.groupBy(db.prepare(`
    SELECT id, item_id, kind, CASE
      WHEN job.synced_at IS NOT NULL THEN 'synced'
      WHEN job.photo_id IS NOT NULL THEN 'pending'
    END AS backup
    FROM photos LEFT JOIN github_photo_backups AS job ON photos.id = job.photo_id
    ORDER BY id
  `).all(), (photo) => photo.item_id);
  return db.prepare('SELECT * FROM items ORDER BY position, id').all().map((row) => ({
    ...JSON.parse(row.item), id: row.id, revision: row.revision,
    photos: (photos.get(row.id) || []).map(({ id, kind, backup }) => ({ id, kind, backup }))
  }));
}

function getItem(id, revision) {
  const row = db.prepare('SELECT item, revision FROM items WHERE id = ?').get(id);
  if (!row) reject(404, '找不到這筆需求。');
  if (row.revision !== revision) reject(409, '這筆需求已被更新，請返回清單重新開啟。');
  return JSON.parse(row.item);
}

function reorder(input) {
  if (!Array.isArray(input.ids) || !Array.isArray(input.previous)) reject(422, '排序資料格式錯誤。');
  transaction(() => {
    const current = db.prepare('SELECT id FROM items ORDER BY position, id').all().map(({ id }) => id);
    if (JSON.stringify(current) !== JSON.stringify(input.previous)) reject(409, '清單順序已變更，請重新編輯排序。');
    const expected = new Set(current);
    if (input.ids.length !== current.length || new Set(input.ids).size !== current.length ||
        input.ids.some((id) => !expected.has(id))) reject(422, '排序須包含所有品項。');
    const setPosition = db.prepare('UPDATE items SET position = ? WHERE id = ?');
    input.ids.forEach((id, position) => setPosition.run(position, id));
  });
}

async function api(req, res, path) {
  const method = req.method;
  const sender = req.headers.origin;
  const fromPages = pagesOrigin && sender === pagesOrigin;
  const fromServer = sender === (origin || `http://${req.headers.host}`);
  res.setHeader('Vary', 'Origin');
  if (fromPages) res.setHeader('Access-Control-Allow-Origin', pagesOrigin);
  if (method === 'OPTIONS' && fromPages) {
    res.writeHead(204, {
      'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Max-Age': '600'
    });
    return res.end();
  }
  if ((sender || method !== 'GET') && !fromPages && !fromServer) reject(403, '請從此網站送出資料。');
  if (path === '/api/unlock' && method === 'POST') return unlock(req, res, await readJson(req));
  const token = tokenFrom(req);
  const session = token && db.prepare('SELECT expires FROM sessions WHERE token = ?').get(digest(token));
  if (!session || session.expires <= Date.now()) reject(401, '請輸入家庭通行碼。');
  if (path === '/api/logout' && method === 'POST') {
    db.prepare('DELETE FROM sessions WHERE token = ?').run(digest(token));
    return json(res, 200, {}, fromPages ? {} : { 'Set-Cookie': sessionCookie('', 0) });
  }
  if (path === '/api/items' && method === 'GET') return json(res, 200, { items: list(), demo });
  if (path === '/api/items' && method === 'POST') {
    const input = await readJson(req);
    const item = validatedItem(input, 'pending');
    const photos = validatedImages(input.photos);
    const id = transaction(() => {
      const row = db.prepare('INSERT INTO items (item, position) VALUES (?, (SELECT COALESCE(MAX(position), -1) + 1 FROM items))')
        .run(JSON.stringify(item));
      addImages(row.lastInsertRowid, photos);
      return Number(row.lastInsertRowid);
    });
    return json(res, 201, { id });
  }
  if (path === '/api/order' && method === 'PUT') {
    reorder(await readJson(req));
    return json(res, 200, {});
  }
  const itemMatch = path.match(/^\/api\/items\/(\d+)$/);
  if (itemMatch && ['PATCH', 'PUT', 'DELETE'].includes(method)) {
    const id = Number(itemMatch[1]);
    const input = await readJson(req);
    const photos = validatedImages(input.photos);
    transaction(() => {
      const previous = getItem(id, input.revision);
      if (method === 'DELETE') {
        db.prepare('DELETE FROM items WHERE id = ?').run(id);
        return;
      }
      const item = method === 'PUT' ? validatedItem(input, previous.status) : previous;
      if (method === 'PATCH' && input.status !== undefined) {
        if (!Object.hasOwn(statuses, input.status)) reject(422, '採買狀態無效。');
        item.status = input.status;
      }
      if (Array.isArray(input.removePhotos) && input.removePhotos.every(Number.isSafeInteger)) {
        const remove = db.prepare('DELETE FROM photos WHERE id = ? AND item_id = ?');
        for (const photoId of input.removePhotos) remove.run(photoId, id);
      }
      addImages(id, photos);
      db.prepare('UPDATE items SET item = ?, revision = revision + 1 WHERE id = ?').run(JSON.stringify(item), id);
    });
    return json(res, 200, {});
  }
  const photoMatch = path.match(/^\/api\/photos\/(\d+)$/);
  if (photoMatch && method === 'GET') {
    const photo = db.prepare('SELECT data FROM photos WHERE id = ?').get(Number(photoMatch[1]));
    if (!photo) reject(404, '找不到照片。');
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, no-store' });
    return res.end(photo.data);
  }
  reject(404, '找不到這個功能。');
}

createServer(async (req, res) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' blob: data:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
  try {
    const path = new URL(req.url, 'http://localhost').pathname;
    if (path.startsWith('/api/')) return await api(req, res, path);
    const asset = files.get(path);
    if (!asset || !['GET', 'HEAD'].includes(req.method)) return json(res, 404, { error: '找不到這個頁面。' });
    const [name, type] = asset;
    const bytes = readFileSync(new URL(`./public/${name}`, import.meta.url));
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': bytes.length, 'Cache-Control': 'no-cache' });
    res.end(req.method === 'HEAD' ? undefined : bytes);
  } catch (error) {
    if (!error.status) console.error(error);
    if (!res.headersSent) json(res, error.status || 500, { error: error.status ? error.message : '暫時無法完成，請稍後再試。' });
  }
}).listen(port, host, () => console.log(`家人代購清單已啟動：${origin || `http://${host}:${port}`}`));
