import { createServer } from 'node:http';
import { createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdirSync, readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { makeShoppingStore, reject, schema } from './shopping-store.mjs';
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
  ${schema}
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
const shopping = makeShoppingStore(db, transaction, backups?.enqueue);

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
  if (path === '/api/items' && method === 'GET') return json(res, 200, { items: shopping.list(), demo });
  if (path === '/api/items' && method === 'POST') {
    const id = shopping.create(await readJson(req));
    return json(res, 201, { id });
  }
  if (path === '/api/order' && method === 'PUT') {
    shopping.reorder(await readJson(req));
    return json(res, 200, {});
  }
  const itemMatch = path.match(/^\/api\/items\/(\d+)$/);
  if (itemMatch && ['PATCH', 'PUT', 'DELETE'].includes(method)) {
    shopping.modify(Number(itemMatch[1]), await readJson(req), method);
    return json(res, 200, {});
  }
  const photoMatch = path.match(/^\/api\/photos\/(\d+)$/);
  if (photoMatch && method === 'GET') {
    const photo = shopping.photo(Number(photoMatch[1]));
    res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Cache-Control': 'private, no-store' });
    return res.end(photo);
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
