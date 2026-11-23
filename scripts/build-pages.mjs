import { cpSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const variant = process.env.PAGES_API_ORIGIN || '';
let origin = '';
try {
  const url = new URL(variant);
  if (url.protocol === 'https:' && url.origin === variant) origin = url.origin;
} catch { /* configuration is reported below */ }
if (variant && !origin) {
  throw new Error('請將 PAGES_API_ORIGIN 設為後端 HTTPS 來源，例如 https://api.example.com（不含尾端斜線）。');
}

const source = new URL('../public/', import.meta.url);
const output = new URL('../dist-pages/', import.meta.url);
mkdirSync(output, { recursive: true });
for (const asset of ['index.html', 'styles.css', 'app.mjs', 'model.mjs', 'manifest.webmanifest', 'icon-192.png', 'icon-512.png', 'sw.js']) {
  cpSync(new URL(asset, source), new URL(asset, output));
}
const index = new URL('index.html', output);
const csp = `default-src 'self'; connect-src 'self'${origin ? ` ${origin}` : ''}; img-src 'self' blob: data:; object-src 'none'; base-uri 'none'; form-action 'self'`;
let html = readFileSync(index, 'utf8').replace('<meta charset="utf-8">', `<meta charset="utf-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">`);
if (!origin) {
  html = html
    .replace('  <script type="module" src="./app.mjs"></script>', '')
    .replace('  <link rel="manifest" href="./manifest.webmanifest">', '')
    .replace(/<button[^>]+id="menu-toggle"[^>]*>.*?<\/button>/, '')
    .replace('<p class="loading">正在讀取清單…</p>',
      '<section class="unlock panel"><h1>家人代購清單</h1><p class="subline">網站已發布。共用清單的後端尚在設定，完成後即可登入及上傳照片。</p></section>');
}
writeFileSync(index, html);
writeFileSync(new URL('config.mjs', output), `export const apiOrigin = ${JSON.stringify(origin)};\n`);
writeFileSync(new URL('.nojekyll', output), '');
