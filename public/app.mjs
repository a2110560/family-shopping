import { statuses, currencies } from './model.mjs';
import { apiOrigin } from './config.mjs';

const basePath = new URL('.', location.href).pathname;
const remote = Boolean(apiOrigin && apiOrigin !== location.origin);
const sessionKey = `family-shopping:${basePath}:${apiOrigin}`;
const photoUrls = new Map();
let remoteToken = '';
if (remote) {
  try { remoteToken = sessionStorage.getItem(sessionKey) || ''; } catch { /* session can live in memory */ }
}
const screen = document.querySelector('#screen');
const views = document.querySelector('#views');
const utilities = document.querySelector('#utilities');
const sidebar = document.querySelector('#sidebar');
const menu = document.querySelector('#menu-toggle');
const notice = document.querySelector('#notice');
const dialog = document.querySelector('#dialog');
const announce = document.querySelector('#announce');
const formPage = new Set(['new', 'edit']);
const maxFile = 20 * 1024 * 1024;
const maxBatch = 60 * 1024 * 1024;
const photoLabels = { product: '商品照片', receipt: '採買明細' };
let items = [];
let unlocked = false;
let demo = false;
let loading = true;
let connectionError = '';
let installPrompt;
let modalUpload;
let sortDraft;
let originalOrder;
let draggedId;
let pendingFiles = new WeakMap();
let mutation = false;
let refreshVersion = 0;
let noticeType = '';
let noticeMessage = '';

const icons = {
  home: '<path d="m3 10 9-7 9 7v10H3z"/><path d="M9 20v-6h6v6"/>',
  trip: '<rect x="4" y="6" width="16" height="14" rx="2"/><path d="M9 6V3h6v3m-6 4v6m6-6v6"/>',
  half: '<circle cx="12" cy="12" r="9"/><path d="M12 3v18"/>',
  install: '<rect x="6" y="2" width="12" height="20" rx="2"/><path d="M10 18h4"/>',
  logout: '<path d="M10 4H4v16h6m4-12 4 4-4 4m4-4H9"/>',
  plus: '<path d="M12 5v14M5 12h14"/>'
};
const icon = (name) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${icons[name]}</svg>`;
const escape = (value) => String(value ?? '').replace(/[&<>"']/g, (character) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
})[character]);
const current = (state) => state ? ' aria-current="true"' : '';
const selected = (state) => state ? ' selected' : '';
const options = (values, value) => Object.entries(values).map(([key, text]) =>
  `<option value="${key}"${selected(key === value)}>${escape(text)}</option>`).join('');
const itemById = (id) => items.find((item) => item.id === Number(id));
const filterLabels = { ...statuses, all: '全部' };
const saveLabels = { status: '採買狀態已更新。', created: '已加入共用清單。', item: '需求已更新。', photos: '照片已儲存。', order: '排序已更新。', deleted: '已移除需求。' };

function route() {
  const { searchParams } = new URL(location.href);
  const view = searchParams.get('view') === 'abroad' ? 'abroad' : 'taiwan';
  const show = searchParams.get('show');
  return {
    view, show: view === 'taiwan' ? 'all' : Object.hasOwn(filterLabels, show) ? show : 'pending',
    mode: searchParams.get('mode') === 'compact' ? 'compact' : 'detail',
    action: searchParams.get('action') || '',
    id: Number(searchParams.get('id')),
    saved: searchParams.get('saved') || '',
    anchor: /^#item-\d+$/.test(location.hash) ? location.hash : ''
  };
}

let state = route();
function url(patch = {}) {
  const next = { ...state, action: '', id: 0, saved: '', anchor: '', ...patch };
  const params = new URLSearchParams();
  if (next.saved) params.set('saved', next.saved);
  if (next.show !== (next.view === 'abroad' ? 'pending' : 'all')) params.set('show', next.show);
  if (next.view !== 'taiwan') params.set('view', next.view);
  if (next.mode === 'compact') params.set('mode', 'compact');
  if (next.action) params.set('action', next.action);
  if (next.id) params.set('id', String(next.id));
  return `${basePath}${params.size ? '?' + params : ''}${next.anchor}`;
}

function navigate(target, options = {}) {
  history[options.replace ? 'replaceState' : 'pushState'](null, '', target);
  state = route();
  sortDraft = undefined;
  setNotice('');
  setMenu(false);
  render();
  placeAnchor(options.focus);
}

function placeAnchor(focus = true) {
  requestAnimationFrame(() => {
    const row = state.anchor && document.getElementById(state.anchor.slice(1));
    if (row) {
      row.scrollIntoView({ block: 'nearest' });
      if (focus) row.focus({ preventScroll: true });
    } else if (focus) {
      document.querySelector('#main').focus({ preventScroll: true });
      window.scrollTo(0, 0);
    }
  });
}

function setNotice(text, type = '') {
  noticeMessage = text;
  noticeType = type;
  renderNotice();
}

function renderNotice() {
  notice.textContent = noticeMessage || (Object.hasOwn(saveLabels, state.saved) ? saveLabels[state.saved] : '');
  notice.hidden = !unlocked || !notice.textContent;
  notice.classList.toggle('error', noticeType === 'error');
}

function setMenu(open) {
  sidebar.classList.toggle('open', open);
  menu.setAttribute('aria-expanded', String(open));
}

function theme() {
  try { return localStorage.getItem('family-theme') || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'); }
  catch { return 'light'; }
}

function applyTheme(value) {
  document.documentElement.dataset.theme = value;
  document.querySelector('meta[name="theme-color"]').content = value === 'dark' ? '#141922' : '#f2f4f7';
}
applyTheme(theme());

function viewLinks() {
  return Object.entries({ taiwan: '台灣登記', abroad: '國外採買' }).map(([view, label]) =>
    `<a class="nav-link" data-route href="${escape(url({ view, show: view === 'taiwan' ? 'all' : 'pending' }))}" ${state.view === view ? 'aria-current="page"' : ''}>
      ${icon(view === 'taiwan' ? 'home' : 'trip')}${label}</a>`).join('');
}

function renderSidebar() {
  views.hidden = !unlocked;
  views.innerHTML = viewLinks();
  const nextTheme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
  utilities.innerHTML = `
    <button class="utility" data-action="theme" data-theme-value="${nextTheme}">${icon('half')}${nextTheme === 'dark' ? '切換暗色模式' : '切換亮色模式'}</button>
    <button class="utility" data-action="install">${icon('install')}安裝到主畫面</button>
    ${unlocked ? `<button class="utility" data-action="logout">${icon('logout')}鎖定清單</button>` : ''}`;
}

function renderUnlock() {
  return `<section class="unlock panel" aria-labelledby="unlock-title">
    <h1 id="unlock-title">家人代購清單</h1><p class="subline">輸入家庭通行碼，即可查看和編輯共用清單。</p>
    <form class="form" data-form="unlock">
      <label class="field"><span>家庭通行碼</span><input name="code" type="password" required maxlength="128" autocomplete="current-password"></label>
      <p class="form-error" role="alert" hidden></p>
      <button class="button primary">開啟清單</button>
    </form>
  </section>`;
}

function photoGallery(photos, kind, remove = false) {
  const group = photos.filter((photo) => photo.kind === kind);
  if (!group.length) return '';
  return `<section aria-label="${photoLabels[kind]}"><h3>${photoLabels[kind]}</h3><div class="gallery">
    ${group.map((photo, index) => `<div class="gallery-entry">
      <button class="thumbnail" type="button" data-action="photo" data-id="${photo.id}" data-kind="${kind}" aria-label="查看${photoLabels[kind]} ${index + 1}">
        <img loading="lazy" ${photoSource(photo.id)} alt="${photoLabels[kind]} ${index + 1}" width="91" height="91">
      </button>
      ${photo.backup ? `<span class="secondary">${photo.backup === 'synced' ? '已備份至 GitHub' : '等待 GitHub 備份'}</span>` : ''}
      ${remove ? `<button class="button danger" type="button" data-action="remove-photo" data-id="${photo.id}" aria-label="移除${photoLabels[kind]} ${index + 1}">移除</button>` : ''}
    </div>`).join('')}</div></section>`;
}

function price(item) {
  if (item.amount === null) return '';
  const amount = new Intl.NumberFormat('zh-TW', { style: 'currency', currency: item.currency, maximumFractionDigits: 2 }).format(item.amount);
  return `<span>金額 <strong class="money">${escape(amount)}</strong> <span class="secondary">${item.currency}</span></span>`;
}

function row(item) {
  const compact = state.mode === 'compact' && state.anchor !== `#item-${item.id}`;
  const anchor = `#item-${item.id}`;
  const buyTools = state.view === 'abroad' ? `<div class="buy-tools">
    <label><span class="inline-label">採買狀態</span>
      <select data-status="${item.id}" aria-label="${escape(item.name)}的採買狀態">${options(statuses, item.status)}</select>
    </label>
    <button class="button" data-action="upload" data-id="${item.id}" data-kind="product">拍照新增</button>
    <button class="button" data-action="upload" data-id="${item.id}" data-kind="receipt">拍攝明細</button>
  </div>` : '';
  const titleUrl = state.anchor === anchor ? url() : url({ anchor });
  const maps = item.mapUrl || (item.store ? `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(item.store)}` : '');
  return `<li class="item" id="item-${item.id}" tabindex="-1">
    <div class="item-top"><div>
      <h3 class="item-title"><a data-route href="${escape(titleUrl)}">${escape(item.name)}</a> <span class="quantity">× ${item.quantity}</span></h3>
      <p class="item-info">${escape(item.person)} 想買</p></div>
      <span class="status ${item.status}">${statuses[item.status]}</span>
    </div>
    ${!compact && (item.amount !== null || item.store) ? `<div class="meta">${price(item)}${item.store ? `<span>店家 <strong>${escape(item.store)}</strong></span>` : ''}</div>` : ''}
    <div class="item-details">
      ${buyTools}
      ${!compact ? `${photoGallery(item.photos, 'product')}${photoGallery(item.photos, 'receipt')}
        ${item.note ? `<p class="note">${escape(item.note)}</p>` : ''}` : ''}
      <div class="row-tools">
        ${!compact ? `<div class="links">
          ${item.productUrl ? `<a href="${escape(item.productUrl)}" target="_blank" rel="noopener noreferrer">商品連結</a>` : ''}
          ${maps ? `<a href="${escape(maps)}" target="_blank" rel="noopener noreferrer">開啟 Google 地圖</a>` : ''}
        </div>` : ''}
        <div class="actions">
          ${!compact ? `<button class="button" data-action="upload" data-id="${item.id}" data-kind="product" data-paste="true">貼上圖片</button>` : ''}
          <a class="button" data-route href="${escape(url({ action: 'edit', id: item.id }))}">編輯<span class="sr-only">${escape(item.name)}</span></a>
        </div>
      </div>
    </div>
  </li>`;
}

function listPage() {
  const shown = state.show === 'all' ? items : items.filter((item) => item.status === state.show);
  const heading = state.show === 'all' ? '全部項目' : `${statuses[state.show]}項目`;
  const counts = { pending: 0, bought: 0, missed: 0 };
  for (const item of items) counts[item.status] += 1;
  const filterNav = state.view === 'abroad' ? `<nav class="filters" aria-label="依採買狀態篩選">
    ${Object.entries(filterLabels).map(([key, label]) => `<a class="status-filter" data-route${current(state.show === key)} href="${escape(url({ show: key }))}">${label}</a>`).join('')}
  </nav>` : '';
  const newLink = escape(url({ action: 'new' }));
  const empty = items.length ? '<p>目前沒有符合這個狀態的項目。</p>' :
    `<p>目前沒有代購需求。</p><a class="button" data-route href="${newLink}">新增第一筆</a>`;
  const missing = state.anchor && !shown.some((item) => `#item-${item.id}` === state.anchor);
  return `<header class="heading app-heading">
      <h1>家人代購清單</h1>
      <a class="button primary" data-route href="${newLink}">${icon('plus')}新增一筆</a>
      <p class="subline">${state.view === 'abroad' ? '依進度查看需求，記錄採買結果與明細。' : '替家人登記想買的商品，隨時查看採買進度。'}${demo ? ' 目前為示範清單。' : ''}</p>
    </header>
    <nav class="mobile-views" aria-label="清單檢視">${viewLinks()}</nav>
    <dl class="summary" aria-label="採買進度">${Object.entries(statuses).map(([key, label]) =>
      `<div><dt><span class="status ${key}">${key === 'pending' ? '還沒買' : label}</span></dt><dd>${counts[key]}</dd></div>`).join('')}</dl>
    <section aria-labelledby="list-title">
      <div class="list-heading"><h2 id="list-title">${heading}</h2><span>共 ${shown.length} 筆</span></div>
      <div class="toolbar">${filterNav}<div class="actions">
        <nav class="segmented" aria-label="顯示方式">
          <a data-route${current(state.mode === 'compact')} href="${escape(url({ mode: 'compact' }))}">條列</a>
          <a data-route${current(state.mode === 'detail')} href="${escape(url({ mode: 'detail' }))}">詳細</a>
        </nav>
        ${items.length > 1 ? '<button class="button" data-action="sort">編輯排序</button>' : ''}
      </div></div>
      ${missing ? `<p class="notice error">${itemById(state.anchor.slice(6)) ? `這筆需求不在目前的篩選結果中。 <a data-route href="${escape(url({ show: 'all', anchor: state.anchor }))}">查看這筆需求</a>` : '這份清單沒有這筆需求。'}</p>` : ''}
      ${shown.length ? `<ul class="list ${state.mode}">${shown.map(row).join('')}</ul>` : `<div class="empty">${empty}</div>`}
    </section>`;
}

const optional = '<small>選填</small>';
function field(label, input, isOptional = false) {
  return `<label class="field"><span>${label}${isOptional ? ` ${optional}` : ''}</span>${input}</label>`;
}

function uploader(kind) {
  return `<fieldset data-upload-kind="${kind}">
    <legend>新增${photoLabels[kind]} ${optional}</legend>
    ${field('選擇照片', '<input type="file" accept="image/*" multiple data-files>')}
    ${field('直接拍照', '<input type="file" accept="image/*" capture="environment" data-files>')}
    <button type="button" class="paste" data-action="paste">選取此處後按 Ctrl+V 或 ⌘V，可連續貼上多張圖片</button>
    <p class="secondary">每批最多 10 張，單張 20 MB，合計 60 MB。照片會保留比例並縮到 1080 px 以內。</p>
    <p class="form-error" role="alert" hidden></p>
    <div data-pending aria-live="polite"></div>
  </fieldset>`;
}

function editor(item) {
  const editing = Boolean(item);
  const value = (key, fallback = '') => escape(item?.[key] ?? fallback);
  const people = [...new Set(items.map((record) => record.person))];
  const personOptions = people.map((person) => `<option value="${escape(person)}"></option>`).join('');
  const back = escape(url({ anchor: item ? `#item-${item.id}` : '' }));
  return `<div class="form-shell">
    <header class="heading"><div><h1>${editing ? '編輯需求' : '新增需求'}</h1>
      <p class="subline">儲存後，家人就能在共用清單看到這筆需求。</p></div>
      <a class="button" href="${back}" data-route>返回清單</a></header>
    <form class="form panel" data-form="editor" data-id="${item?.id || ''}" data-revision="${item?.revision || ''}">
      ${field('商品名稱', `<input name="name" required maxlength="160" value="${value('name')}" placeholder="例如：抹茶餅乾">`)}
      <div class="form-grid">
        ${field('人員', `<input name="person" list="family-members" required maxlength="40" value="${value('person')}" placeholder="選擇或輸入人員">`)}
        ${field('數量', `<input name="quantity" type="number" required min="1" max="9999" value="${value('quantity', 1)}">`)}
      </div><datalist id="family-members">${personOptions}</datalist>
      <div class="form-grid">
        ${field('整筆金額', `<input name="amount" type="number" inputmode="decimal" step="0.01" min="0" max="999999999" value="${value('amount')}" placeholder="例如：1200">`, true)}
        ${field('幣別', `<select name="currency">${options(Object.fromEntries(Object.entries(currencies).map(([code, label]) => [code, `${label} ${code}`])), item?.currency || 'JPY')}</select>`)}
      </div>
      ${field('店家名稱或地址', `<input name="store" maxlength="300" value="${value('store')}" placeholder="顯示在清單上">`, true)}
      ${field('Google 地圖網址', `<input name="mapUrl" type="url" maxlength="2000" value="${value('mapUrl')}" placeholder="貼上 Google 地圖的分享網址">`, true)}
      ${field('商品連結', `<input name="productUrl" type="url" maxlength="2000" value="${value('productUrl')}" placeholder="https://">`, true)}
      ${field('規格或備註', `<textarea name="note" maxlength="8000" placeholder="例如：想要原味，小包裝">${value('note')}</textarea>`, true)}
      ${editing ? photoGallery(item.photos, 'product', true) + photoGallery(item.photos, 'receipt', true) : ''}
      ${uploader('product')}
      <p class="form-error" data-submit-error role="alert" hidden></p>
      <div class="form-actions"><button class="button primary">${editing ? '儲存變更' : '加入清單'}</button>
        ${editing ? `<button type="button" class="button danger" data-action="delete" data-id="${item.id}">刪除需求</button>` : ''}</div>
    </form></div>`;
}

function render() {
  renderSidebar();
  renderNotice();
  if (loading) return;
  releasePhotoObservers(screen);
  if (connectionError) {
    screen.innerHTML = `<div class="form-shell panel"><h1>無法讀取清單</h1><p class="subline">${escape(connectionError)}</p><button class="button" data-action="retry">重試</button></div>`;
    return;
  }
  if (!unlocked) {
    document.title = '進入家人代購清單';
    screen.innerHTML = renderUnlock();
    return;
  }
  document.title = '家人代購清單';
  if (!formPage.has(state.action)) {
    screen.innerHTML = listPage();
  } else if (state.action === 'new' || itemById(state.id)) {
    screen.innerHTML = editor(state.action === 'edit' ? itemById(state.id) : undefined);
  } else {
    screen.innerHTML = `<div class="form-shell panel"><h1>找不到這筆需求</h1><a data-route href="${escape(url())}">返回清單</a></div>`;
  }
  hydratePhotos(screen);
}

function rememberToken(token) {
  remoteToken = token;
  if (!token) {
    for (const entry of photoUrls.values()) entry.then((url) => { if (url) URL.revokeObjectURL(url); });
    photoUrls.clear();
  }
  try {
    if (token) sessionStorage.setItem(sessionKey, token);
    else sessionStorage.removeItem(sessionKey);
  } catch { /* session can live in memory */ }
}

function fetchApi(path, options = {}) {
  const headers = new Headers(options.headers);
  if (remote && remoteToken) headers.set('Authorization', `Bearer ${remoteToken}`);
  return fetch(`${apiOrigin}/api/${path}`, { ...options, headers, credentials: remote ? 'omit' : 'same-origin' });
}

function photoSource(id) {
  return remote ? `data-photo-id="${id}"` : `src="/api/photos/${id}"`;
}

const photoObserver = remote && typeof IntersectionObserver !== 'undefined' ? new IntersectionObserver((entries) => {
  for (const { target, isIntersecting } of entries) {
    if (!isIntersecting) continue;
    photoObserver.unobserve(target);
    void loadPhoto(target);
  }
}, { rootMargin: '160px' }) : null;

async function loadPhoto(image) {
  const id = image.dataset.photoId;
  if (!photoUrls.has(id)) {
    const photo = fetchApi(`photos/${id}`).then(async (response) => {
      if (!response.ok) throw new Error('無法載入照片。');
      return URL.createObjectURL(await response.blob());
    }).catch(() => {
      if (photoUrls.get(id) === photo) photoUrls.delete(id);
      return '';
    });
    photoUrls.set(id, photo);
  }
  const url = await photoUrls.get(id);
  if (url && image.isConnected && unlocked) image.src = url;
}

function hydratePhotos(zone) {
  if (!remote) return;
  for (const image of zone.querySelectorAll('[data-photo-id]')) {
    if (photoObserver) photoObserver.observe(image);
    else void loadPhoto(image);
  }
}

function releasePhotoObservers(zone) {
  if (photoObserver) for (const image of zone.querySelectorAll('[data-photo-id]')) photoObserver.unobserve(image);
}

async function api(path, { method = 'GET', body } = {}) {
  let response;
  try {
    response = await fetchApi(path, { method,
      headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  } catch { throw new Error('目前無法連線，請確認清單伺服器已啟動。'); }
  const data = await response.json();
  if (!response.ok) {
    const error = new Error(data.error);
    error.status = response.status;
    throw error;
  }
  return data;
}

async function refresh({ paint = true, report = false } = {}) {
  const version = ++refreshVersion;
  try {
    const data = await api('items');
    if (version !== refreshVersion) return;
    const changed = !unlocked || JSON.stringify(items) !== JSON.stringify(data.items) || connectionError;
    items = data.items;
    demo = data.demo;
    unlocked = true;
    connectionError = '';
    loading = false;
    if (paint && changed) render();
  } catch (error) {
    if (version !== refreshVersion) return;
    if (error.status === 401) {
      if (remote) rememberToken('');
      items = [];
      unlocked = false;
      connectionError = '';
      loading = false;
      if (dialog.open) dialog.close();
      render();
    } else if (report || !unlocked) {
      if (unlocked) setNotice(error.message, 'error');
      else {
        connectionError = error.message;
        loading = false;
        render();
      }
    } else if (!formPage.has(state.action)) {
      setNotice(error.message, 'error');
    }
  }
}

function localError(container, message) {
  if (!container) return;
  container.textContent = message;
  container.hidden = !message;
}

async function compress(file) {
  const source = URL.createObjectURL(file);
  try {
    const image = new Image();
    image.src = source;
    await image.decode();
    const scale = Math.min(1, 1080 / Math.max(image.naturalWidth, image.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(image.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(image.naturalHeight * scale));
    const context = canvas.getContext('2d', { alpha: false });
    context.fillStyle = '#fff';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.drawImage(image, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL('image/jpeg', .84);
  } catch {
    throw new Error(`無法讀取「${file.name || '貼上的圖片'}」。請使用 JPG、PNG 或瀏覽器支援的圖片格式。`);
  } finally {
    URL.revokeObjectURL(source);
  }
}

function pendingFor(group) {
  if (!pendingFiles.has(group)) pendingFiles.set(group, { files: [], busy: false });
  return pendingFiles.get(group);
}

function renderPending(group) {
  const { files } = pendingFor(group);
  group.querySelector('[data-pending]').innerHTML = files.length ? `<p class="secondary">已選擇 ${files.length} 張</p><div class="gallery">
    ${files.map((file, index) => `<div class="gallery-entry"><div class="thumbnail"><img src="${file.preview}" alt="待上傳照片 ${index + 1}" width="91" height="91"></div>
      <button class="button" type="button" data-action="discard-file" data-index="${index}" aria-label="取消上傳照片 ${index + 1}">移除</button></div>`).join('')}
  </div>` : '';
}

async function queueFiles(group, files) {
  if (!files.length) return;
  const pending = pendingFor(group);
  const err = group.querySelector('.form-error');
  if (pending.busy) return localError(err, '正在處理照片，請稍候再加入。');
  pending.busy = true;
  localError(err, '');
  try {
    const total = pending.files.reduce((sum, file) => sum + file.size, 0) + files.reduce((sum, file) => sum + file.size, 0);
    if (pending.files.length + files.length > 10 || total > maxBatch || files.some((file) => file.size > maxFile)) {
      throw new Error('每批最多 10 張，單張 20 MB，合計 60 MB。');
    }
    const next = [];
    for (const file of files) next.push({ preview: await compress(file), size: file.size });
    pending.files.push(...next);
    renderPending(group);
  } catch (error) { localError(err, error.message); }
  finally { pending.busy = false; }
}

function photoPayload(form) {
  return [...form.querySelectorAll('[data-upload-kind]')].flatMap((group) => {
    const pending = pendingFor(group);
    if (pending.busy) throw new Error('照片正在處理，請稍候再儲存。');
    return pending.files.map((file) => ({ kind: group.dataset.uploadKind, data: file.preview.split(',')[1] }));
  });
}

function showDialog(title, body, { viewer = false, paste = false } = {}) {
  if (dialog.open) dialog.close();
  releasePhotoObservers(dialog);
  dialog.classList.toggle('viewer', viewer);
  dialog.setAttribute('aria-labelledby', 'dialog-title');
  dialog.innerHTML = `<h2 id="dialog-title">${escape(title)}</h2>${body}`;
  dialog.showModal();
  hydratePhotos(dialog);
  if (paste) dialog.querySelector('.paste').focus();
}

function showUpload(item, kind, paste) {
  modalUpload = { id: item.id, revision: item.revision };
  showDialog(`新增${photoLabels[kind]}`, `<form class="form" data-form="upload">
    ${uploader(kind)}<p class="form-error" role="alert" data-submit-error hidden></p>
    <div class="actions"><button class="button primary">儲存照片</button><button type="button" class="button" data-action="close">取消</button></div>
  </form>`, { paste });
  if (!paste) dialog.querySelector('input[capture]').click();
}

function sortRows() {
  dialog.querySelector('.sorting').innerHTML = sortDraft.map((id, index) => `<li draggable="true" data-sort-id="${id}">
    <span>${escape(itemById(id).name)}</span><div class="actions">
      <button class="button" type="button" data-action="move" data-id="${id}" data-offset="-1" ${index === 0 ? 'disabled' : ''} aria-label="${escape(itemById(id).name)}往上">上移</button>
      <button class="button" type="button" data-action="move" data-id="${id}" data-offset="1" ${index === sortDraft.length - 1 ? 'disabled' : ''} aria-label="${escape(itemById(id).name)}往下">下移</button>
    </div></li>`).join('');
}

function showSort() {
  originalOrder = items.map((item) => item.id);
  sortDraft = [...originalOrder];
  showDialog('編輯排序', `<form class="form" data-form="sort"><p class="secondary">拖曳品項，或使用上移與下移按鈕。</p><ol class="sorting"></ol>
    <p class="form-error" role="alert" data-submit-error hidden></p>
    <div class="actions"><button class="button primary">儲存排序</button><button type="button" class="button" data-action="close">取消</button></div></form>`);
  sortRows();
}

function move(id, target, offset) {
  const from = sortDraft.indexOf(id);
  if (from < 0 || target < 0 || target >= sortDraft.length || from === target) return;
  sortDraft.splice(from, 1);
  sortDraft.splice(target, 0, id);
  sortRows();
  announce.textContent = `${itemById(id).name}已移到第 ${target + 1} 位。`;
  if (offset) {
    const button = dialog.querySelector(`[data-sort-id="${id}"] [data-offset="${offset}"]:enabled`) ||
      dialog.querySelector(`[data-sort-id="${id}"] [data-offset]:enabled`);
    button?.focus();
  }
}

dialog.addEventListener('dragstart', (event) => {
  const row = event.target.closest('[data-sort-id]');
  if (!row) return;
  draggedId = Number(row.dataset.sortId);
  event.dataTransfer.setData('text/plain', row.dataset.sortId);
  event.dataTransfer.effectAllowed = 'move';
  row.classList.add('dragging');
});
dialog.addEventListener('dragover', (event) => {
  if (draggedId && event.target.closest('[data-sort-id]')) event.preventDefault();
});
dialog.addEventListener('drop', (event) => {
  const row = event.target.closest('[data-sort-id]');
  if (!draggedId || !row) return;
  event.preventDefault();
  move(draggedId, sortDraft.indexOf(Number(row.dataset.sortId)));
});
dialog.addEventListener('dragend', () => {
  draggedId = undefined;
  dialog.querySelector('.dragging')?.classList.remove('dragging');
});

function finish(saved, item, filter) {
  if (dialog.open) dialog.close();
  navigate(url({ saved, show: filter ?? state.show, anchor: item ? `#item-${item.id}` : '' }));
}

async function submit(event) {
  const form = event.target.closest('[data-form]');
  if (!form) return;
  event.preventDefault();
  if (mutation) return;
  const mode = form.dataset.form;
  const submitButton = event.submitter || form.querySelector('button:not([type])');
  const errorBox = form.querySelector('[data-submit-error]') || form.querySelector('.form-error');
  localError(errorBox, '');
  mutation = true;
  if (submitButton) submitButton.disabled = true;
  try {
    if (mode === 'unlock') {
      const login = await api('unlock', { method: 'POST', body: { code: form.elements.code.value } });
      if (remote) rememberToken(login.token);
      await refresh({ report: true });
      placeAnchor(Boolean(state.anchor));
    } else if (mode === 'editor') {
      const data = Object.fromEntries(new FormData(form));
      const id = Number(form.dataset.id);
      const body = { ...data, quantity: Number(data.quantity), amount: data.amount === '' ? null : Number(data.amount),
        photos: photoPayload(form), revision: Number(form.dataset.revision),
        removePhotos: [...form.querySelectorAll('[data-removed-id]')].map((entry) => Number(entry.dataset.removedId))
      };
      const result = await api(id ? `items/${id}` : 'items', { method: id ? 'PUT' : 'POST', body });
      await refresh({ paint: false });
      finish(id ? 'item' : 'created', itemById(id || result.id), id ? state.show : state.view === 'abroad' ? 'pending' : 'all');
    } else if (mode === 'upload') {
      const { id, revision } = modalUpload;
      const photos = photoPayload(form);
      if (!photos.length) throw new Error('請先選擇、拍攝或貼上一張照片。');
      await api(`items/${id}`, { method: 'PATCH', body: { revision, photos } });
      await refresh({ paint: false });
      finish('photos', itemById(id));
    } else if (mode === 'sort') {
      await api('order', { method: 'PUT', body: { previous: originalOrder, ids: sortDraft } });
      await refresh({ paint: false });
      finish('order');
    } else if (mode === 'delete') {
      const { id, revision } = form.dataset;
      await api(`items/${id}`, { method: 'DELETE', body: { revision: Number(revision) } });
      await refresh({ paint: false });
      finish('deleted');
    }
  } catch (error) {
    if (error.status === 401 && mode !== 'unlock') await refresh();
    else localError(errorBox, error.message);
  } finally {
    mutation = false;
    if (submitButton) submitButton.disabled = false;
  }
}

async function updateStatus(select) {
  const item = itemById(select.dataset.status);
  if (!item) return;
  if (mutation) { select.value = item.status; return; }
  mutation = true;
  select.disabled = true;
  try {
    await api(`items/${item.id}`, { method: 'PATCH', body: { revision: item.revision, status: select.value } });
    await refresh({ paint: false });
    const updated = itemById(item.id);
    const show = state.show === 'all' || state.show === updated?.status ? state.show : 'all';
    finish('status', updated, show);
  } catch (error) {
    select.value = item.status;
    if (error.status === 401 || error.status === 409) await refresh();
    setNotice(error.message, 'error');
  } finally {
    mutation = false;
    select.disabled = false;
  }
}

async function install() {
  if (installPrompt) {
    const prompt = installPrompt;
    installPrompt = undefined;
    await prompt.prompt();
    return;
  }
  showDialog('安裝到主畫面', `<div class="form">
    <p>在 iPhone 或 iPad 的 Safari，點分享選單，再選「加入主畫面」。</p>
    <p>在 Android、Chrome 或 Edge，開啟瀏覽器選單並選「安裝應用程式」或「新增至主畫面」。</p>
    <p class="secondary">安裝功能需要 HTTPS 或本機網址。清單同步需要連線。</p>
    <button class="button" data-action="close">關閉</button></div>`);
}

document.addEventListener('submit', submit);
document.addEventListener('change', (event) => {
  const target = event.target;
  if (target.matches('[data-status]')) void updateStatus(target);
  if (target.matches('[data-files]')) {
    void queueFiles(target.closest('[data-upload-kind]'), [...target.files]);
    target.value = '';
  }
});
document.addEventListener('paste', (event) => {
  const group = event.target.closest('[data-upload-kind]');
  if (!group) return;
  const files = [...(event.clipboardData?.items || [])].filter((item) => item.type.startsWith('image/'))
    .map((item) => item.getAsFile()).filter(Boolean);
  if (!files.length) return;
  event.preventDefault();
  void queueFiles(group, files);
});

document.addEventListener('click', async (event) => {
  const target = event.target.closest('[data-route], [data-action]');
  if (!target) return;
  if (target.matches('a') && (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey)) return;
  const { action, id, kind, offset } = target.dataset;
  if (target.matches('[data-route]') || action === 'home') {
    event.preventDefault();
    if (!mutation) navigate(action === 'home' ? url() : target.getAttribute('href'));
    return;
  }
  if (action === 'theme') {
    const value = target.dataset.themeValue;
    try { localStorage.setItem('family-theme', value); } catch { /* keep session theme */ }
    applyTheme(value);
    renderSidebar();
    utilities.querySelector('[data-action="theme"]').focus();
  } else if (action === 'retry') {
    await refresh({ report: true });
    placeAnchor(false);
  } else if (action === 'logout') {
    if (mutation) return;
    try {
      await api('logout', { method: 'POST' });
      if (remote) rememberToken('');
      await refresh();
      setMenu(false);
    } catch (error) { setNotice(error.message, 'error'); }
  } else if (action === 'install') {
    await install();
  } else if (action === 'sort') {
    showSort();
  } else if (action === 'move') {
    move(Number(id), sortDraft.indexOf(Number(id)) + Number(offset), Number(offset));
  } else if (action === 'close') {
    if (!mutation) dialog.close();
  } else if (action === 'upload') {
    showUpload(itemById(id), kind, target.dataset.paste === 'true');
  } else if (action === 'photo') {
    showDialog(photoLabels[kind], `<img ${photoSource(Number(id))} alt="${photoLabels[kind]}"><button class="button" data-action="close">關閉</button>`, { viewer: true });
  } else if (action === 'remove-photo') {
    const entry = target.closest('.gallery-entry');
    entry.dataset.removedId = id;
    entry.hidden = true;
    announce.textContent = '儲存需求時會移除這張照片。';
  } else if (action === 'delete') {
    const item = itemById(id);
    showDialog('刪除需求', `<form class="form" data-form="delete" data-id="${item.id}" data-revision="${item.revision}">
      <p>確定刪除「${escape(item.name)}」及其照片？</p><p class="form-error" role="alert" data-submit-error hidden></p>
      <div class="actions"><button class="button" type="button" data-action="close" autofocus>取消</button>
      <button class="button danger" type="submit">刪除需求</button></div></form>`);
  } else if (action === 'discard-file') {
    const group = target.closest('[data-upload-kind]');
    pendingFor(group).files.splice(Number(target.dataset.index), 1);
    renderPending(group);
    group.querySelector('.paste').focus();
  } else if (action === 'paste') {
    announce.textContent = '請按 Ctrl+V 或 Command+V 貼上圖片。';
  }
});
dialog.addEventListener('cancel', (event) => { if (mutation) event.preventDefault(); });
menu.addEventListener('click', () => setMenu(!sidebar.classList.contains('open')));
window.addEventListener('popstate', () => {
  state = route();
  sortDraft = undefined;
  if (dialog.open) dialog.close();
  setNotice('');
  render();
  placeAnchor(false);
});
window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  installPrompt = event;
});
function refreshWhenIdle() {
  if (unlocked && !document.hidden && !document.activeElement?.matches('[data-status]') &&
      !mutation && !dialog.open && !formPage.has(state.action)) void refresh();
}
document.addEventListener('visibilitychange', refreshWhenIdle);
window.setInterval(refreshWhenIdle, 15_000);
if ('serviceWorker' in navigator) navigator.serviceWorker.register('./sw.js').catch(() => {});
render();
await refresh();
placeAnchor(false);
