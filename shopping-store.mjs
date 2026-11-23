import { Buffer } from 'node:buffer';
import { statuses, currencies } from './public/model.mjs';

export const schema = `
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
`;

class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function reject(status, message) { throw new ApiError(status, message); }

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

export function makeShoppingStore(db, transaction, onPhoto) {
  function addImages(id, photos) {
    const insert = db.prepare('INSERT INTO photos (item_id, kind, data) VALUES (?, ?, ?) RETURNING id');
    for (const photo of photos) {
      const stored = insert.get(id, photo.kind, photo.data);
      onPhoto?.(stored.id);
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


  function create(input) {
    const item = validatedItem(input, 'pending');
    const photos = validatedImages(input.photos);
    return transaction(() => {
      const { id } = db.prepare('INSERT INTO items (item, position) VALUES (?, (SELECT COALESCE(MAX(position), -1) + 1 FROM items)) RETURNING id')
        .get(JSON.stringify(item));
      addImages(id, photos);
      return id;
    });
  }

  function modify(id, input, method) {
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
  }

  function photo(id) {
    const result = db.prepare('SELECT data FROM photos WHERE id = ?').get(id);
    if (!result) reject(404, '找不到照片。');
    return result.data;
  }

  return { list, reorder, create, modify, photo };
}
