// Вехи — team roadmap canvas. Vanilla JS, no build step.
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clone = (o) => (o == null ? null : structuredClone(o));
const uid = (n = 10) => { const a = 'abcdefghijkmnopqrstuvwxyz23456789'; let s = ''; const r = crypto.getRandomValues(new Uint8Array(n)); r.forEach((x) => (s += a[x % a.length])); return s; };
const icon = (n, cls = '') => `<svg class="i ${cls}"><use href="#i-${n}"/></svg>`;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const CARD_W = 460;
const COLORS = ['#e6e3ee', '#b8a4ff', '#5fd6a0', '#f4bf5a', '#ff8a9a', '#6ccaff'];
const STATUS = { planned: 'Запланировано', active: 'В работе', done: 'Готово' };
const NEXT_STATUS = { planned: 'active', active: 'done', done: 'planned' };
const PRIO = { '': 'Без приоритета', low: 'Низкий приоритет', medium: 'Средний приоритет', high: 'Высокий приоритет' };
const NEXT_PRIO = { '': 'low', low: 'medium', medium: 'high', high: '' };

// ---------------- state ----------------
const S = {
  me: null, maps: [], mapId: null, map: null,
  items: { node: {}, edge: {}, shape: {} },
  view: { x: 80, y: 90, z: 1 },
  tool: 'select', sel: null, filter: 'all', q: '',
  undo: [], redo: [], heights: {}, client: null, ws: null, peers: [], cursors: {},
  ro: false, drag: null, space: false, focus: null, pendingImg: null,
  collapsed: new Set(load('rm.collapsed', [])), subClosed: new Set(load('rm.subClosed', [])),
};
function load(k, d) { try { return JSON.parse(localStorage.getItem(k)) ?? d; } catch { return d; } }
function save(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} }

// ---------------- api ----------------
async function api(method, url, body, raw) {
  const opt = { method, headers: {} };
  if (raw) { opt.body = raw; opt.headers['Content-Type'] = raw.type; }
  else if (body !== undefined) { opt.body = JSON.stringify(body); opt.headers['Content-Type'] = 'application/json'; }
  const r = await fetch(url, opt);
  const ct = r.headers.get('content-type') || '';
  const data = ct.includes('json') ? await r.json() : await r.text();
  if (!r.ok) { const e = new Error(data?.error || `Ошибка ${r.status}`); e.status = r.status; throw e; }
  return data;
}
function toast(msg, bad) {
  const t = document.createElement('div');
  t.className = 'toast' + (bad ? ' bad' : '');
  t.textContent = msg;
  $('#toasts').append(t);
  setTimeout(() => t.remove(), bad ? 5000 : 2600);
}

// ---------------- auth ----------------
let authMode = 'login';
function showAuth(mode, hint) {
  authMode = mode;
  $('#app').hidden = true; $('#auth').hidden = false;
  const reg = mode !== 'login';
  $('#authTitle').textContent = mode === 'setup' ? 'Создайте аккаунт администратора' : reg ? 'Присоединиться к команде' : 'Вход в команду';
  $('#authHint').textContent = hint || (mode === 'setup' ? 'Вы первый на этом сервере. После входа сможете приглашать коллег.' : reg ? 'Попросите код приглашения у администратора команды.' : '');
  $('#nameRow').hidden = !reg; $('#inviteRow').hidden = mode !== 'register';
  $('#fName').required = reg; $('#fInvite').required = mode === 'register';
  $('#fPass').autocomplete = reg ? 'new-password' : 'current-password';
  $('#authSubmit').textContent = reg ? 'Создать аккаунт' : 'Войти';
  $('#authSwitch').hidden = mode === 'setup';
  $('#authSwitch').textContent = reg ? 'У меня уже есть аккаунт' : 'У меня есть приглашение';
  $('#authErr').textContent = '';
}
$('#authSwitch').onclick = () => showAuth(authMode === 'login' ? 'register' : 'login');
$('#authForm').onsubmit = async (e) => {
  e.preventDefault();
  $('#authErr').textContent = '';
  try {
    const body = { email: $('#fEmail').value, password: $('#fPass').value, name: $('#fName').value, invite: $('#fInvite').value };
    const r = await api('POST', authMode === 'login' ? '/api/auth/login' : '/api/auth/register', body);
    history.replaceState(null, '', location.pathname);
    start(r.user);
  } catch (err) { $('#authErr').textContent = err.message; }
};

async function boot() {
  try { const r = await api('GET', '/api/me'); start(r.user); }
  catch {
    const inv = new URLSearchParams(location.search).get('invite');
    const { needsAdmin } = await api('GET', '/api/setup').catch(() => ({}));
    if (needsAdmin) showAuth('setup');
    else if (inv) { showAuth('register'); $('#fInvite').value = inv; }
    else showAuth('login');
  }
}

async function start(user) {
  S.me = user; S.ro = user.role === 'viewer';
  $('#auth').hidden = true; $('#app').hidden = false;
  $('#roBadge').hidden = !S.ro;
  document.body.classList.toggle('ro', S.ro);
  $('#meName').textContent = user.name;
  const av = $('#meAvatar'); av.textContent = initials(user.name); av.style.background = user.color;
  if (innerWidth < 760) $('#app').classList.add('side-off');
  connectWs();
  await loadMaps();
  const want = location.hash.slice(1) || load('rm.lastMap', null);
  const first = S.maps.find((m) => m.id === want) || S.maps[0];
  if (first) await openMap(first.id); else render();
}
const initials = (n) => (n || '?').split(/\s+/).map((w) => w[0]).slice(0, 2).join('').toUpperCase();

// ---------------- realtime ----------------
let wsDelay = 500;
function connectWs() {
  const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
  S.ws = ws;
  ws.onopen = () => { wsDelay = 500; if (S.mapId) ws.send(JSON.stringify({ type: 'join', map: S.mapId })); };
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    if (m.type === 'hello') { const reconnect = !!S.client; S.client = m.client; if (reconnect && S.mapId) refreshMap(); }
    else if (m.type === 'ops' && m.client !== S.client) applyRemote(m.ops);
    else if (m.type === 'maps') loadMaps();
    else if (m.type === 'presence') { S.peers = m.peers; renderPeers(); }
    else if (m.type === 'cursor') { S.cursors[m.client] = { ...m, t: Date.now() }; renderCursors(); }
  };
  ws.onclose = (ev) => {
    if (ev.code === 4001) return location.reload();
    setTimeout(connectWs, wsDelay); wsDelay = Math.min(wsDelay * 2, 10000);
  };
}
let lastCursor = 0;
function sendCursor(p) {
  const t = Date.now();
  if (t - lastCursor < 50 || S.ws?.readyState !== 1 || !S.mapId) return;
  lastCursor = t;
  S.ws.send(JSON.stringify({ type: 'cursor', x: Math.round(p.x), y: Math.round(p.y) }));
}
setInterval(() => {
  const t = Date.now(); let ch = false;
  for (const [k, c] of Object.entries(S.cursors)) if (t - c.t > 6000 || !S.peers.some((p) => p.client === k)) { delete S.cursors[k]; ch = true; }
  if (ch) renderCursors();
}, 2000);

// ---------------- maps ----------------
async function loadMaps() {
  try { S.maps = (await api('GET', '/api/maps')).maps; } catch (e) { if (e.status === 401) return location.reload(); toast(e.message, true); }
  render();
}
async function openMap(id) {
  S.mapId = id; S.sel = null; S.undo = []; S.redo = []; S.heights = {};
  save('rm.lastMap', id);
  if (location.hash.slice(1) !== id) history.replaceState(null, '', '#' + id);
  S.ws?.readyState === 1 && S.ws.send(JSON.stringify({ type: 'join', map: id }));
  $('#cards').innerHTML = '';
  await refreshMap();
  fitView(false);
}
async function refreshMap() {
  try {
    const r = await api('GET', `/api/maps/${S.mapId}`);
    S.map = r.map; S.items = r.items;
  } catch (e) { toast(e.message, true); S.items = { node: {}, edge: {}, shape: {} }; }
  render();
}
async function newMap(name = 'Новая карта') {
  try {
    const { map } = await api('POST', '/api/maps', { name });
    await loadMaps(); await openMap(map.id);
    setTimeout(() => renameMapInline(map.id), 50);
  } catch (e) { toast(e.message, true); }
}
async function importMap(json) {
  const { map } = await api('POST', '/api/maps/import', json);
  await loadMaps(); await openMap(map.id);
  toast(`Карта «${map.name}» создана: ${map.total} этапов`);
}
async function renameMap(id, name) {
  name = name.trim(); if (!name) return render();
  try { await api('PATCH', `/api/maps/${id}`, { name }); await loadMaps(); } catch (e) { toast(e.message, true); }
}
async function deleteMap(id) {
  try {
    await api('DELETE', `/api/maps/${id}`);
    await loadMaps();
    if (S.mapId === id) { S.mapId = null; S.map = null; S.items = { node: {}, edge: {}, shape: {} }; $('#cards').innerHTML = ''; if (S.maps[0]) openMap(S.maps[0].id); else render(); }
  } catch (e) { toast(e.message, true); }
}

// ---------------- ops / undo ----------------
let sendQ = Promise.resolve();
function commit(ops, { undo = true, prev = null } = {}) {
  if (!ops.length || !S.mapId) return;
  if (S.ro) { toast('У вас доступ только на просмотр', true); return render(); }
  const inverse = ops.map((o) => ({ kind: o.kind, id: o.id, data: prev && (o.kind + ':' + o.id) in prev ? prev[o.kind + ':' + o.id] : clone(S.items[o.kind][o.id] ?? null) }));
  applyLocal(ops);
  if (undo) { S.undo.push({ ops: clone(ops), inverse }); if (S.undo.length > 200) S.undo.shift(); S.redo = []; }
  send(ops);
}
function send(ops) {
  const mapId = S.mapId;
  sendQ = sendQ.then(() => api('POST', `/api/maps/${mapId}/ops`, { ops, client: S.client }))
    .then(() => { if (ops.some((o) => o.kind === 'node')) loadMaps(); })
    .catch((e) => { toast('Не сохранилось: ' + e.message, true); if (mapId === S.mapId) refreshMap(); });
}
function applyLocal(ops) {
  for (const o of ops) {
    if (o.data == null) delete S.items[o.kind][o.id];
    else S.items[o.kind][o.id] = clone(o.data);
  }
  if (S.sel && !S.items[S.sel.kind]?.[S.sel.id]) S.sel = null;
  render();
}
function applyRemote(ops) { applyLocal(ops); }
function undo() { const u = S.undo.pop(); if (!u) return; applyLocal(u.inverse); send(u.inverse); S.redo.push(u); }
function redo() { const u = S.redo.pop(); if (!u) return; applyLocal(u.ops); send(u.ops); S.undo.push(u); }
const putNode = (id, data, opt) => commit([{ kind: 'node', id, data }], opt);

// ---------------- subtasks ----------------
function countSubs(subs) { let total = 0, done = 0; const w = (l) => l.forEach((s) => { total++; if (s.d) done++; w(s.c || []); }); w(subs || []); return { total, done }; }
function findSub(list, id, parent = null) {
  for (let i = 0; i < list.length; i++) {
    if (list[i].id === id) return { list, i, item: list[i], parent };
    const r = findSub(list[i].c || [], id, list[i]); if (r) return r;
  }
  return null;
}
function fixParents(list) { for (const s of list) { s.c ||= []; if (s.c.length) { fixParents(s.c); s.d = s.c.every((x) => x.d); } } }
const setAll = (s, d) => { s.d = d; (s.c || []).forEach((c) => setAll(c, d)); };
function autoStatus(n) {
  const { total, done } = countSubs(n.subs); if (!total) return;
  if (done === total) n.status = 'done';
  else if (done > 0) n.status = 'active';
  else if (n.status === 'done') n.status = 'active';
}
function editNode(id, fn, opt) {
  const cur = S.items.node[id]; if (!cur) return;
  const n = clone(cur); fn(n); putNode(id, n, opt);
}

// ---------------- view ----------------
const stage = $('#stage'), world = $('#world');
function toWorld(cx, cy) { const r = stage.getBoundingClientRect(); return { x: (cx - r.left - S.view.x) / S.view.z, y: (cy - r.top - S.view.y) / S.view.z }; }
function toScreen(x, y) { return { x: x * S.view.z + S.view.x, y: y * S.view.z + S.view.y }; }
function applyView() {
  const { x, y, z } = S.view;
  world.style.transform = `translate(${x}px, ${y}px) scale(${z})`;
  world.style.setProperty('--iz', Math.min(3, Math.max(1, 0.8 / z)));
  let g = 22 * z; while (g < 11) g *= 2;
  stage.style.backgroundSize = `${g}px ${g}px`;
  stage.style.backgroundPosition = `${x}px ${y}px`;
  $('#zVal').textContent = Math.round(z * 100) + '%';
  $$('.cursor').forEach((c) => (c.style.setProperty('--s', 1 / z)));
  renderCursors();
  drawMinimap(); renderPop();
}
function zoomAt(f, cx, cy) {
  const r = stage.getBoundingClientRect();
  cx ??= r.left + r.width / 2; cy ??= r.top + r.height / 2;
  const p = toWorld(cx, cy);
  const z = clamp(S.view.z * f, 0.08, 3);
  S.view = { z, x: cx - r.left - p.x * z, y: cy - r.top - p.y * z };
  applyView();
}
function bounds(withShapes = true) {
  let x1 = Infinity, y1 = Infinity, x2 = -Infinity, y2 = -Infinity;
  const add = (a, b, c, d) => { x1 = Math.min(x1, a); y1 = Math.min(y1, b); x2 = Math.max(x2, c); y2 = Math.max(y2, d); };
  for (const [id, n] of Object.entries(S.items.node)) add(n.x, n.y, n.x + (n.w || CARD_W), n.y + (S.heights[id] || 220));
  if (withShapes) for (const s of Object.values(S.items.shape)) { const b = shapeBox(s); add(b.x, b.y, b.x + b.w, b.y + b.h); }
  return x1 === Infinity ? null : { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}
function fitView(animate = true) {
  const b = bounds(); const r = stage.getBoundingClientRect();
  if (!b) { S.view = { x: r.width / 2 - 230, y: 110, z: 1 }; return applyView(); }
  const pad = 80;
  const z = clamp(Math.min((r.width - pad * 2) / b.w, (r.height - pad * 2) / b.h), 0.08, 1.1);
  animateTo({ z, x: (r.width - b.w * z) / 2 - b.x * z, y: (r.height - b.h * z) / 2 - b.y * z }, animate);
}
function animateTo(target, animate = true) {
  if (!animate || matchMedia('(prefers-reduced-motion: reduce)').matches) { S.view = target; return applyView(); }
  const from = { ...S.view }, t0 = performance.now();
  const step = (t) => {
    const k = Math.min(1, (t - t0) / 260), e = 1 - Math.pow(1 - k, 3);
    S.view = { x: from.x + (target.x - from.x) * e, y: from.y + (target.y - from.y) * e, z: from.z + (target.z - from.z) * e };
    applyView(); if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
function focusNode(id) {
  const n = S.items.node[id]; if (!n) return;
  const r = stage.getBoundingClientRect();
  const z = Math.max(S.view.z, 0.85), h = S.heights[id] || 300;
  animateTo({ z, x: r.width / 2 - (n.x + (n.w || CARD_W) / 2) * z, y: Math.max(70, r.height / 2 - (h / 2) * z) - n.y * z });
  select({ kind: 'node', id });
}

// ---------------- rendering ----------------
let raf = 0;
function render() { if (!raf) raf = requestAnimationFrame(() => { raf = 0; renderAll(); }); }
function renderAll() {
  renderSide(); renderTop(); renderCards(); renderEdges(); renderShapes(); renderEmpty(); applyView();
}

function ring(done, total, size = 14) {
  const r = size / 2 - 1.5, c = 2 * Math.PI * r, p = total ? done / total : 0;
  const col = p >= 1 ? 'var(--ok)' : 'var(--info)';
  return `<svg class="ring" viewBox="0 0 ${size} ${size}" style="width:${size}px;height:${size}px"><circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="var(--line-hi)" stroke-width="2"/>` +
    `<circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${col}" stroke-width="2" stroke-dasharray="${c * p} ${c}" transform="rotate(-90 ${size / 2} ${size / 2})" stroke-linecap="round"/></svg>`;
}
function matches(n) {
  const q = S.q.trim().toLowerCase(); if (!q) return true;
  const inSubs = (l) => l.some((s) => s.t.toLowerCase().includes(q) || inSubs(s.c || []));
  return n.title.toLowerCase().includes(q) || (n.desc || '').toLowerCase().includes(q) || n.lane.toLowerCase().includes(q) || inSubs(n.subs || []);
}
const orderedNodes = () => Object.entries(S.items.node).sort((a, b) => a[1].x - b[1].x || a[1].y - b[1].y);

function renderSide() {
  const q = S.q.trim().toLowerCase();
  const maps = S.maps.filter((m) => !q || m.name.toLowerCase().includes(q) || m.id === S.mapId);
  const ul = $('#maps');
  if (!ul.querySelector('input')) {
    ul.innerHTML = maps.map((m) => `<li data-map="${m.id}" class="${m.id === S.mapId ? 'on' : ''}">${icon('map', 'sm')}<span class="nm">${esc(m.name)}</span>` +
      `${S.ro ? '' : `<button class="icon-btn sm del" title="Удалить карту">${icon('trash', 'sm')}</button>`}<span title="${m.done} из ${m.total} этапов готовы">${ring(m.done, m.total)}</span></li>`).join('') ||
      `<li class="none muted" style="cursor:default">Карт пока нет</li>`;
  }
  $('#meSub').textContent = `${S.maps.length} ${plural(S.maps.length, 'карта', 'карты', 'карт')}`;
  $('#stagesHead').hidden = $('#filter').hidden = !S.mapId;
  const list = orderedNodes().filter(([, n]) => (S.filter === 'all' || (S.filter === 'done' ? n.status === 'done' : n.status !== 'done')) && matches(n));
  $('#stages').innerHTML = !S.mapId ? '' : list.map(([id, n]) => {
    const c = countSubs(n.subs);
    return `<li data-node="${id}" class="${n.status === 'done' ? 'done' : ''}" title="${esc(n.title)}"><span class="st-ico ${n.status}"></span><span class="nm">${esc(n.title)}</span>` +
      `${n.priority === 'high' ? icon('flag', 'fl') : ''}<span class="cnt">${c.done}/${c.total}</span></li>`;
  }).join('') || `<li class="none">${S.q ? 'Ничего не найдено' : 'Этапов пока нет'}</li>`;
}
const plural = (n, a, b, c) => { const m = n % 10, h = n % 100; return m === 1 && h !== 11 ? a : m >= 2 && m <= 4 && (h < 10 || h >= 20) ? b : c; };

function renderTop() {
  const nodes = Object.values(S.items.node);
  const done = nodes.filter((n) => n.status === 'done').length;
  if (!$('#mapName').querySelector('input')) $('#mapName').textContent = S.map?.name || '';
  $('#topProgress').innerHTML = S.mapId ? `${ring(done, nodes.length)}${done} из ${nodes.length} ${plural(nodes.length, 'этапа', 'этапов', 'этапов')}` : '';
  $('#exportBtn').disabled = $('#importBtn').disabled = false;
  $$('#toolbar [data-tool]').forEach((b) => b.classList.toggle('on', b.dataset.tool === S.tool));
  stage.dataset.tool = S.space ? 'hand' : S.tool;
  $('#undo').disabled = !S.undo.length; $('#redo').disabled = !S.redo.length;
  $('#undo').style.opacity = S.undo.length ? 1 : .4; $('#redo').style.opacity = S.redo.length ? 1 : .4;
  $$('#filter button').forEach((b) => b.classList.toggle('on', b.dataset.f === S.filter));
}
function renderPeers() {
  const seen = new Set();
  $('#peers').innerHTML = S.peers.filter((p) => !seen.has(p.id) && seen.add(p.id)).map((p) => `<span class="avatar" style="background:${p.color}" title="${esc(p.name)}${p.id === S.me.id ? ' (вы)' : ''}">${esc(initials(p.name))}</span>`).join('');
}
function renderCursors() {
  const box = $('#cursors');
  box.innerHTML = Object.values(S.cursors).map((c) =>
    `<div class="cursor" style="transform:translate(${c.x}px,${c.y}px) scale(${1 / S.view.z});transform-origin:0 0"><svg viewBox="0 0 24 24"><path d="M5 3.5 18.5 10l-6 1.8-2.6 6.2z" fill="${c.color}" stroke="#0d0c11" stroke-width="1.5"/></svg><span style="background:${c.color}">${esc(c.name)}</span></div>`).join('');
}

// --- cards
function fmtDue(d) {
  if (!d) return 'Без срока';
  const dt = new Date(d + 'T00:00:00');
  return 'до ' + dt.toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });
}
function subsHtml(list, ro) {
  return `<ul class="subs">${list.map((s) => {
    const kids = s.c || [], closed = S.subClosed.has(s.id), c = countSubs(kids);
    return `<li data-sid="${s.id}"><div class="sub-row ${s.d ? 'd' : ''}">` +
      `<span class="grip">${icon('grip', 'sm')}</span>` +
      (kids.length ? `<button class="car ${closed ? 'closed' : ''}" data-a="subfold" title="Свернуть">${icon('chevdown')}</button>` : '') +
      `<button class="check ${s.d ? 'on' : ''}" data-a="subcheck" title="Отметить">${icon('check')}</button>` +
      `<div class="sub-t" data-f="sub" ${ro ? '' : 'contenteditable="true"'} spellcheck="false">${esc(s.t)}</div>` +
      (kids.length ? `<span class="cnt">${c.done}/${c.total}</span>` : '') +
      (ro ? '' : `<button class="icon-btn sm addc" data-a="subchild" title="Добавить вложенную">${icon('sub', 'sm')}</button><button class="icon-btn sm x" data-a="subdel" title="Удалить">${icon('x', 'sm')}</button>`) +
      `</div>${kids.length && !closed ? subsHtml(kids, ro) : ''}</li>`;
  }).join('')}</ul>`;
}
function cardHtml(id, n) {
  const c = countSubs(n.subs), ro = S.ro, ce = ro ? '' : 'contenteditable="true"';
  const pct = c.total ? Math.round((c.done / c.total) * 100) : 0;
  const late = n.due && n.status !== 'done' && n.due < new Date().toISOString().slice(0, 10);
  const collapsed = S.collapsed.has(id);
  return `<div class="card-head">
      <span class="lane" data-f="lane" ${ce} spellcheck="false">${esc(n.lane)}</span><span class="spacer"></span>
      <button class="status ${n.status}" data-a="status" title="Сменить статус"><span class="dot"></span>${STATUS[n.status]}</button>
      ${ro ? '' : `<button class="icon-btn sm tool" data-a="delcard" title="Удалить этап">${icon('trash', 'sm')}</button>`}
      <button class="icon-btn sm" data-a="collapse" title="${collapsed ? 'Развернуть' : 'Свернуть'}">${icon(collapsed ? 'chevdown' : 'chevup', 'sm')}</button>
    </div>
    <div class="title-row"><button class="check ${n.status === 'done' ? 'on' : c.done ? 'part' : ''}" style="--p:${pct}%" data-a="done" title="Отметить этап готовым">${icon('check')}</button>
      <div class="title" data-f="title" ${ce} spellcheck="false">${esc(n.title)}</div></div>
    <div class="body">
      <div class="desc" data-f="desc" ${ce}>${esc(n.desc)}</div>
      ${c.total ? `<div class="prog"><div class="bar"><i style="width:${pct}%"></i></div><span>${c.done} из ${c.total}</span></div>` : '<div style="height:8px"></div>'}
      ${subsHtml(n.subs || [], ro)}
      ${ro ? '' : `<button class="add-sub" data-a="subadd">${icon('plus')}Добавить подзадачу</button>`}
    </div>
    <div class="card-foot">
      <label class="due ${late ? 'late' : ''}" title="Срок">${icon('cal')}<span>${fmtDue(n.due)}</span>${ro ? '' : `<input type="date" data-f="due" value="${n.due || ''}">`}</label>
      <button class="prio ${n.priority}" data-a="prio" title="Сменить приоритет">${icon('flag')}${PRIO[n.priority || '']}</button>
    </div>
    ${ro ? '' : '<span class="port r" title="Потяните, чтобы связать"></span><span class="port l" title="Потяните, чтобы связать"></span>'}`;
}
const ro = new ResizeObserver((entries) => {
  let ch = false;
  for (const e of entries) { const id = e.target.dataset.id; const h = e.target.offsetHeight; if (id && S.heights[id] !== h) { S.heights[id] = h; ch = true; } }
  if (ch) { renderEdges(); drawMinimap(); }
});
function renderCards() {
  const box = $('#cards');
  const seen = new Set();
  for (const [id, n] of Object.entries(S.items.node)) {
    seen.add(id);
    let el = box.querySelector(`.card[data-id="${id}"]`);
    if (!el) { el = document.createElement('div'); el.className = 'card'; el.dataset.id = id; box.append(el); ro.observe(el); }
    el.style.left = n.x + 'px'; el.style.top = n.y + 'px'; el.style.width = (n.w || CARD_W) + 'px';
    const { x, y, ...rest } = n;
    const sig = JSON.stringify(rest) + S.collapsed.has(id) + [...S.subClosed].join() + S.ro;
    const ae = document.activeElement;
    const editing = el.contains(ae) && (ae.isContentEditable || ae.tagName === 'INPUT');
    if (el._sig !== sig && !editing) { el.innerHTML = cardHtml(id, n); el._sig = sig; }
    el.classList.toggle('sel', S.sel?.kind === 'node' && S.sel.id === id);
    el.classList.toggle('done', n.status === 'done');
    el.classList.toggle('collapsed', S.collapsed.has(id));
    el.style.opacity = matches(n) ? '' : '.3';
  }
  for (const el of $$('.card', box)) if (!seen.has(el.dataset.id)) { ro.unobserve(el); el.remove(); delete S.heights[el.dataset.id]; }
  if (S.focus) {
    const f = S.focus; S.focus = null;
    const el = f.sub ? box.querySelector(`[data-sid="${f.sub}"] > .sub-row .sub-t`) : box.querySelector(`.card[data-id="${f.node}"] .title`);
    if (el) { el.focus({ preventScroll: true }); const r = document.createRange(); r.selectNodeContents(el); if (!f.selectAll) r.collapse(false); const s = getSelection(); s.removeAllRanges(); s.addRange(r); }
  }
}

// --- edges
function rectOf(id) { const n = S.items.node[id]; return n && { x: n.x, y: n.y, w: n.w || CARD_W, h: S.heights[id] || 220 }; }
function anchors(a, b) {
  if (b.x >= a.x + a.w + 24) return [{ x: a.x + a.w, y: a.y + Math.min(a.h / 2, 160), dx: 1, dy: 0 }, { x: b.x, y: b.y + Math.min(b.h / 2, 160), dx: -1, dy: 0 }];
  if (b.x + b.w + 24 <= a.x) return [{ x: a.x, y: a.y + Math.min(a.h / 2, 160), dx: -1, dy: 0 }, { x: b.x + b.w, y: b.y + Math.min(b.h / 2, 160), dx: 1, dy: 0 }];
  if (b.y > a.y) return [{ x: a.x + a.w / 2, y: a.y + a.h, dx: 0, dy: 1 }, { x: b.x + b.w / 2, y: b.y, dx: 0, dy: -1 }];
  return [{ x: a.x + a.w / 2, y: a.y, dx: 0, dy: -1 }, { x: b.x + b.w / 2, y: b.y + b.h, dx: 0, dy: 1 }];
}
function curve(p1, p2) {
  const d = Math.max(50, Math.hypot(p2.x - p1.x, p2.y - p1.y) * 0.4);
  const c1 = { x: p1.x + p1.dx * d, y: p1.y + p1.dy * d }, c2 = { x: p2.x + p2.dx * d, y: p2.y + p2.dy * d };
  return { d: `M${p1.x},${p1.y} C${c1.x},${c1.y} ${c2.x},${c2.y} ${p2.x},${p2.y}`, c1, c2, mid: { x: (p1.x + 3 * c1.x + 3 * c2.x + p2.x) / 8, y: (p1.y + 3 * c1.y + 3 * c2.y + p2.y) / 8 } };
}
function headPath(p, ux, uy, s = 8) {
  // arrowhead at p pointing along (ux, uy)
  const px = -uy, py = ux;
  return `M${p.x - ux * s + px * s * 0.55},${p.y - uy * s + py * s * 0.55} L${p.x},${p.y} L${p.x - ux * s - px * s * 0.55},${p.y - uy * s - py * s * 0.55}`;
}
function edgeGeom(e) {
  const a = rectOf(e.from), b = rectOf(e.to); if (!a || !b) return null;
  const [p1, p2] = anchors(a, b); return { ...curve(p1, p2), p1, p2 };
}
function renderEdges() {
  let svg = '', labels = '';
  for (const [id, e] of Object.entries(S.items.edge)) {
    const g = edgeGeom(e); if (!g) continue;
    const sel = S.sel?.kind === 'edge' && S.sel.id === id;
    svg += `<g><path class="edge ${e.style === 'dashed' ? 'dashed' : ''} ${sel ? 'sel' : ''}" d="${g.d}"/>` +
      `<path class="edge ${sel ? 'sel' : ''}" style="stroke-dasharray:none" d="${headPath(g.p2, -g.p2.dx, -g.p2.dy)}"/>` +
      `<path class="hit" data-edge="${id}" d="${g.d}"/></g>`;
    if (e.label) labels += `<div class="elabel" data-edge="${id}" style="left:${g.mid.x}px;top:${g.mid.y}px">${esc(e.label)}</div>`;
  }
  $('#edges').innerHTML = svg; $('#labels').innerHTML = labels;
  if (S.sel?.kind === 'edge') renderPop();
}

// --- shapes
function shapeBox(s) {
  if (s.type === 'arrow') return { x: Math.min(s.x1, s.x2), y: Math.min(s.y1, s.y2), w: Math.abs(s.x2 - s.x1), h: Math.abs(s.y2 - s.y1) };
  if (s.type === 'pen') { const xs = s.pts.map((p) => p[0]), ys = s.pts.map((p) => p[1]); const x = Math.min(...xs), y = Math.min(...ys); return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y }; }
  return { x: Math.min(s.x, s.x + s.w), y: Math.min(s.y, s.y + s.h), w: Math.abs(s.w), h: Math.abs(s.h) };
}
function shapeSvg(s, id = '') {
  const c = s.color || COLORS[0], st = `stroke="${c}" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"`;
  const b = shapeBox(s); let geo = '', filled = false;
  if (s.type === 'rect') geo = `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" rx="10" ATTR/>`;
  else if (s.type === 'ellipse') geo = `<ellipse cx="${b.x + b.w / 2}" cy="${b.y + b.h / 2}" rx="${b.w / 2}" ry="${b.h / 2}" ATTR/>`;
  else if (s.type === 'diamond') geo = `<path d="M${b.x + b.w / 2},${b.y} L${b.x + b.w},${b.y + b.h / 2} L${b.x + b.w / 2},${b.y + b.h} L${b.x},${b.y + b.h / 2} Z" ATTR/>`;
  else if (s.type === 'pen') geo = `<path d="${s.pts.map((p, i) => (i ? 'L' : 'M') + p[0] + ',' + p[1]).join(' ')}" ATTR/>`;
  else if (s.type === 'arrow') {
    const L = Math.hypot(s.x2 - s.x1, s.y2 - s.y1) || 1, ux = (s.x2 - s.x1) / L, uy = (s.y2 - s.y1) / L;
    geo = `<path d="M${s.x1},${s.y1} L${s.x2},${s.y2}" ATTR ${s.dashed ? 'stroke-dasharray="7 6"' : ''}/><path d="${headPath({ x: s.x2, y: s.y2 }, ux, uy, 11)}" ATTR/>`;
  } else if (s.type === 'text') {
    filled = true;
    const lines = (s.text || '').split('\n');
    geo = `<text x="${s.x}" y="${s.y}" fill="${c}" font-family="Onest, sans-serif" font-size="${s.size}" style="font-style:italic">${lines.map((l, i) => `<tspan x="${s.x}" dy="${i ? s.size * 1.25 : s.size}">${esc(l) || ' '}</tspan>`).join('')}</text>`;
  } else if (s.type === 'image') { filled = true; geo = `<image href="${esc(s.src)}" x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}" preserveAspectRatio="none"/>`; }
  const vis = geo.replace(/ATTR/g, st);
  if (!id) return vis;
  const hit = filled ? `<rect class="hitf" x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}"/>` : geo.replace(/ATTR/g, 'class="hit"').replace(/<text[\s\S]*<\/text>/, '');
  const sel = S.sel?.kind === 'shape' && S.sel.id === id ? `<rect class="sel-outline" x="${b.x - 6}" y="${b.y - 6}" width="${b.w + 12}" height="${b.h + 12}" rx="4"/>` : '';
  return `<g data-shape="${id}">${vis}${hit}${sel}</g>`;
}
function renderShapes() { $('#shapes').innerHTML = Object.entries(S.items.shape).map(([id, s]) => shapeSvg(s, id)).join(''); }

// --- empty state
function renderEmpty() {
  const box = $('#empty');
  let html = '';
  if (!S.mapId) html = `<div class="empty-box"><h2>Здесь появятся дорожные карты команды</h2><p>Создайте карту с нуля, начните с шаблона релиза или загрузите JSON, который сгенерировал CLI.</p>
    <div class="row">${S.ro ? '' : `<button class="btn primary" data-e="new">${icon('plus')}Новая карта</button><button class="btn ghost" data-e="tpl">Шаблон релиза</button><button class="btn ghost" data-e="import">${icon('import')}Импорт JSON</button>`}</div></div>`;
  else if (!Object.keys(S.items.node).length && !Object.keys(S.items.shape).length) html = `<div class="empty-box"><h2>Карта пока пустая</h2><p>Добавьте первый этап кнопкой ниже или инструментом «Этап» на панели сверху. Связи рисуются, если потянуть за точку на краю карточки.</p>
    <div class="row">${S.ro ? '' : `<button class="btn primary" data-e="card">${icon('card')}Добавить этап</button><button class="btn ghost" data-e="import">${icon('import')}Импорт JSON</button>`}</div></div>`;
  box.hidden = !html; box.innerHTML = html;
}
$('#empty').addEventListener('click', (e) => {
  const a = e.target.closest('[data-e]')?.dataset.e;
  if (a === 'new') newMap();
  else if (a === 'tpl') importMap(TEMPLATE).catch((er) => toast(er.message, true));
  else if (a === 'import') openImport();
  else if (a === 'card') { const r = stage.getBoundingClientRect(); createCard(toWorld(r.left + r.width / 2, r.top + r.height / 3)); }
});

// --- selection popover
function select(sel) { S.sel = sel; render(); }
function renderPop() {
  const pop = $('#pop');
  const sel = S.sel;
  if (!sel || sel.kind === 'node' || S.ro || S.drag) { pop.hidden = true; return; }
  let anchor, html = '';
  if (sel.kind === 'edge') {
    const e = S.items.edge[sel.id]; const g = e && edgeGeom(e); if (!g) { pop.hidden = true; return; }
    anchor = { x: g.mid.x, y: g.mid.y - 18 };
    html = `<button class="icon-btn ${e.style !== 'dashed' ? 'on' : ''}" data-p="solid" title="Сплошная: последовательно">${icon('line')}</button>
      <button class="icon-btn ${e.style === 'dashed' ? 'on' : ''}" data-p="dashed" title="Пунктир: параллельно">${icon('dash')}</button>
      <input id="edgeLabel" placeholder="Подпись связи" value="${esc(e.label)}">
      <button class="icon-btn" data-p="swap" title="Развернуть направление">${icon('swap')}</button>
      <button class="icon-btn" data-p="del" title="Удалить связь">${icon('trash')}</button>`;
  } else {
    const s = S.items.shape[sel.id]; if (!s) { pop.hidden = true; return; }
    const b = shapeBox(s); anchor = { x: b.x + b.w / 2, y: b.y - 14 };
    html = COLORS.map((c) => `<button class="sw ${s.color === c ? 'on' : ''}" style="background:${c}" data-p="color" data-c="${c}" title="Цвет"></button>`).join('') +
      (s.type === 'arrow' ? `<button class="icon-btn ${s.dashed ? 'on' : ''}" data-p="dash" title="Пунктир">${icon('dash')}</button>` : '') +
      `<button class="icon-btn" data-p="del" title="Удалить">${icon('trash')}</button>`;
  }
  const p = toScreen(anchor.x, anchor.y);
  if (pop._html !== html || pop.hidden) { if (!pop.contains(document.activeElement)) { pop.innerHTML = html; pop._html = html; } }
  pop.style.left = clamp(p.x, 120, stage.clientWidth - 120) + 'px'; pop.style.top = clamp(p.y, 60, stage.clientHeight - 10) + 'px';
  pop.hidden = false;
}
$('#pop').addEventListener('pointerdown', (e) => e.stopPropagation());
$('#pop').addEventListener('click', (e) => {
  const b = e.target.closest('[data-p]'); if (!b || !S.sel) return;
  const { kind, id } = S.sel, cur = S.items[kind][id]; if (!cur) return;
  const a = b.dataset.p, d = clone(cur);
  if (a === 'del') return deleteSelection();
  if (a === 'solid' || a === 'dashed') d.style = a;
  if (a === 'swap') [d.from, d.to] = [d.to, d.from];
  if (a === 'color') d.color = b.dataset.c;
  if (a === 'dash') d.dashed = !d.dashed;
  commit([{ kind, id, data: d }]);
});
$('#pop').addEventListener('change', (e) => {
  if (e.target.id !== 'edgeLabel' || S.sel?.kind !== 'edge') return;
  const cur = S.items.edge[S.sel.id]; if (!cur) return;
  commit([{ kind: 'edge', id: S.sel.id, data: { ...cur, label: e.target.value.trim() } }]);
});
$('#pop').addEventListener('keydown', (e) => { if (e.key === 'Enter') e.target.blur(); e.stopPropagation(); });

function deleteSelection() {
  const sel = S.sel; if (!sel) return;
  const ops = [{ kind: sel.kind, id: sel.id, data: null }];
  if (sel.kind === 'node') for (const [eid, e] of Object.entries(S.items.edge)) if (e.from === sel.id || e.to === sel.id) ops.push({ kind: 'edge', id: eid, data: null });
  S.sel = null; commit(ops);
}

// --- minimap
const mm = $('#minimap'), mmx = mm.getContext('2d');
let mmT = null;
function drawMinimap() {
  const dpr = devicePixelRatio || 1, W = 220, H = 130;
  if (mm.width !== W * dpr) { mm.width = W * dpr; mm.height = H * dpr; }
  mmx.setTransform(dpr, 0, 0, dpr, 0, 0); mmx.clearRect(0, 0, W, H);
  const r = stage.getBoundingClientRect();
  const vw = { x: -S.view.x / S.view.z, y: -S.view.y / S.view.z, w: r.width / S.view.z, h: r.height / S.view.z };
  const b = bounds() || vw;
  const x1 = Math.min(b.x, vw.x), y1 = Math.min(b.y, vw.y), x2 = Math.max(b.x + b.w, vw.x + vw.w), y2 = Math.max(b.y + b.h, vw.y + vw.h);
  const k = Math.min((W - 16) / (x2 - x1), (H - 16) / (y2 - y1));
  const ox = (W - (x2 - x1) * k) / 2 - x1 * k, oy = (H - (y2 - y1) * k) / 2 - y1 * k;
  mmT = { k, ox, oy };
  const css = getComputedStyle(document.documentElement);
  for (const [id, n] of Object.entries(S.items.node)) {
    mmx.fillStyle = n.status === 'done' ? css.getPropertyValue('--ok') + '99' : n.status === 'active' ? '#6ccaff88' : '#5b5868';
    mmx.fillRect(n.x * k + ox, n.y * k + oy, Math.max(2, (n.w || CARD_W) * k), Math.max(2, (S.heights[id] || 220) * k));
  }
  mmx.strokeStyle = css.getPropertyValue('--accent'); mmx.lineWidth = 1.5;
  mmx.strokeRect(vw.x * k + ox, vw.y * k + oy, vw.w * k, vw.h * k);
}
function mmJump(e) {
  if (!mmT) return;
  const rr = mm.getBoundingClientRect(); const r = stage.getBoundingClientRect();
  const wx = (e.clientX - rr.left - mmT.ox) / mmT.k, wy = (e.clientY - rr.top - mmT.oy) / mmT.k;
  S.view.x = r.width / 2 - wx * S.view.z; S.view.y = r.height / 2 - wy * S.view.z; applyView();
}
mm.addEventListener('pointerdown', (e) => { e.stopPropagation(); mm.setPointerCapture(e.pointerId); mmJump(e); mm.onpointermove = mmJump; });
mm.addEventListener('pointerup', () => (mm.onpointermove = null));
$('#minimapWrap').addEventListener('pointerdown', (e) => e.stopPropagation());
$('#mmToggle').onclick = () => $('#minimapWrap').classList.toggle('closed');

// ---------------- card interactions ----------------
function createCard(p) {
  const id = uid();
  putNode(id, { lane: 'Этап', title: 'Новый этап', desc: '', status: 'planned', due: '', priority: '', subs: [], x: Math.round(p.x - CARD_W / 2), y: Math.round(p.y - 30), w: CARD_W });
  S.sel = { kind: 'node', id }; S.focus = { node: id, selectAll: true }; setTool('select');
}
const cards = $('#cards');
cards.addEventListener('click', (e) => {
  const b = e.target.closest('[data-a]'); if (!b) return;
  const card = b.closest('.card'), id = card.dataset.id, a = b.dataset.a;
  const sid = b.closest('[data-sid]')?.dataset.sid;
  if (a === 'collapse') { S.collapsed.has(id) ? S.collapsed.delete(id) : S.collapsed.add(id); save('rm.collapsed', [...S.collapsed]); return render(); }
  if (a === 'subfold') { S.subClosed.has(sid) ? S.subClosed.delete(sid) : S.subClosed.add(sid); save('rm.subClosed', [...S.subClosed]); return render(); }
  if (S.ro) return;
  if (a === 'status') editNode(id, (n) => (n.status = NEXT_STATUS[n.status]));
  if (a === 'prio') editNode(id, (n) => (n.priority = NEXT_PRIO[n.priority || '']));
  if (a === 'done') editNode(id, (n) => { n.status = n.status === 'done' ? (countSubs(n.subs).done ? 'active' : 'planned') : 'done'; });
  if (a === 'delcard') {
    if (!b.classList.contains('armed')) { b.classList.add('armed'); b.textContent = 'Удалить?'; setTimeout(() => card.isConnected && render(), 2500); card._sig = null; return; }
    S.sel = { kind: 'node', id }; deleteSelection();
  }
  if (a === 'subcheck') editNode(id, (n) => { const f = findSub(n.subs, sid); setAll(f.item, !f.item.d); fixParents(n.subs); autoStatus(n); });
  if (a === 'subdel') editNode(id, (n) => { const f = findSub(n.subs, sid); f.list.splice(f.i, 1); fixParents(n.subs); autoStatus(n); });
  if (a === 'subadd') { const nid = uid(8); editNode(id, (n) => { n.subs.push({ id: nid, t: '', d: false, c: [] }); autoStatus(n); }); S.focus = { sub: nid }; }
  if (a === 'subchild') {
    const nid = uid(8); S.subClosed.delete(sid);
    editNode(id, (n) => { const f = findSub(n.subs, sid); f.item.c.push({ id: nid, t: '', d: false, c: [] }); fixParents(n.subs); autoStatus(n); });
    S.focus = { sub: nid };
  }
});
cards.addEventListener('change', (e) => {
  if (e.target.dataset.f === 'due') { e.target.blur(); const id = e.target.closest('.card').dataset.id; editNode(id, (n) => (n.due = e.target.value)); }
});
function commitText(el) {
  const card = el.closest('.card'); if (!card || S.ro) return;
  const id = card.dataset.id, n = S.items.node[id]; if (!n) return;
  const f = el.dataset.f;
  const val = (f === 'desc' ? el.innerText.replace(/\n$/, '') : el.innerText.replace(/\s+/g, ' ')).trim();
  if (f === 'sub') {
    const sid = el.closest('[data-sid]').dataset.sid; const cur = findSub(n.subs, sid);
    if (cur && cur.item.t !== val) editNode(id, (m) => (findSub(m.subs, sid).item.t = val));
  } else if (f === 'title' || f === 'lane' || f === 'desc') {
    const v = f === 'title' ? val || 'Без названия' : f === 'lane' ? val || 'Этап' : val;
    if (n[f] !== v) editNode(id, (m) => (m[f] = v));
  }
}
cards.addEventListener('focusout', (e) => {
  if (e.target.matches('[data-f]') && e.target.isContentEditable) { commitText(e.target); setTimeout(render, 0); }
});
cards.addEventListener('paste', (e) => {
  if (!e.target.closest('[contenteditable="true"]')) return;
  e.preventDefault(); document.execCommand('insertText', false, e.clipboardData.getData('text/plain'));
});
cards.addEventListener('keydown', (e) => {
  const el = e.target; const f = el.dataset?.f; if (!f) return;
  e.stopPropagation();
  if (e.key === 'Escape') { el.blur(); return; }
  if ((f === 'title' || f === 'lane') && e.key === 'Enter') { e.preventDefault(); el.blur(); return; }
  if (f === 'desc' && e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); el.blur(); return; }
  if (f !== 'sub') return;
  const id = el.closest('.card').dataset.id, sid = el.closest('[data-sid]').dataset.sid;
  const text = el.innerText.replace(/\s+/g, ' ').trim();
  const restructure = (fn) => { e.preventDefault(); S.focus = { sub: sid }; editNode(id, (n) => { findSub(n.subs, sid).item.t = text; fn(n); fixParents(n.subs); autoStatus(n); }); el.blur(); };
  if (e.key === 'Enter') {
    const nid = uid(8);
    restructure((n) => { const fs = findSub(n.subs, sid); fs.list.splice(fs.i + 1, 0, { id: nid, t: '', d: false, c: [] }); });
    S.focus = { sub: nid };
  } else if (e.key === 'Tab' && !e.shiftKey) {
    const n0 = S.items.node[id], fs0 = findSub(n0.subs, sid); if (!fs0 || fs0.i === 0) { e.preventDefault(); return; }
    restructure((n) => { const fs = findSub(n.subs, sid); const [it] = fs.list.splice(fs.i, 1); const prev = fs.list[fs.i - 1]; prev.c.push(it); S.subClosed.delete(prev.id); });
  } else if (e.key === 'Tab' && e.shiftKey) {
    const fs0 = findSub(S.items.node[id].subs, sid); if (!fs0?.parent) { e.preventDefault(); return; }
    restructure((n) => { const fs = findSub(n.subs, sid); const [it] = fs.list.splice(fs.i, 1); const pf = findSub(n.subs, fs.parent.id); pf.list.splice(pf.i + 1, 0, it); });
  } else if (e.key === 'Backspace' && !text) {
    e.preventDefault();
    const fs0 = findSub(S.items.node[id].subs, sid); const prev = fs0.i > 0 ? fs0.list[fs0.i - 1].id : fs0.parent?.id;
    S.focus = prev ? { sub: prev } : null;
    el.dataset.f = ''; editNode(id, (n) => { const fs = findSub(n.subs, sid); fs.list.splice(fs.i, 1); fixParents(n.subs); autoStatus(n); }); el.blur();
  }
});

// ---------------- sidebar & top ----------------
$('#maps').addEventListener('click', (e) => {
  const li = e.target.closest('[data-map]'); if (!li) return;
  const del = e.target.closest('.del');
  if (del) {
    e.stopPropagation();
    if (!del.classList.contains('armed')) { del.classList.add('armed'); del.textContent = 'Удалить?'; setTimeout(render, 2500); return; }
    return deleteMap(li.dataset.map);
  }
  if (li.dataset.map !== S.mapId) openMap(li.dataset.map);
});
$('#maps').addEventListener('dblclick', (e) => { const li = e.target.closest('[data-map]'); if (li && !S.ro) renameMapInline(li.dataset.map); });
function renameMapInline(id) {
  const li = $(`#maps [data-map="${id}"]`); if (!li) return;
  const nm = li.querySelector('.nm'); const m = S.maps.find((x) => x.id === id);
  const inp = document.createElement('input'); inp.className = 'nm'; inp.value = m?.name || '';
  nm.replaceWith(inp); inp.focus(); inp.select();
  let done = false;
  const fin = (ok) => { if (done) return; done = true; inp.remove(); if (ok) renameMap(id, inp.value); else render(); };
  inp.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') fin(true); if (e.key === 'Escape') fin(false); };
  inp.onblur = () => fin(true);
  inp.onclick = (e) => e.stopPropagation();
}
$('#mapName').addEventListener('dblclick', () => {
  if (!S.mapId || S.ro) return;
  const b = $('#mapName'); const inp = document.createElement('input'); inp.value = S.map.name;
  b.textContent = ''; b.append(inp); inp.focus(); inp.select();
  let done = false;
  const fin = (ok) => { if (done) return; done = true; const v = inp.value; inp.remove(); if (ok) { S.map.name = v.trim() || S.map.name; renameMap(S.mapId, v); } render(); };
  inp.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Enter') fin(true); if (e.key === 'Escape') fin(false); };
  inp.onblur = () => fin(true);
});
$('#newMap').onclick = () => (S.ro ? toast('У вас доступ только на просмотр', true) : newMap());
$('#stages').addEventListener('click', (e) => { const li = e.target.closest('[data-node]'); if (li) { focusNode(li.dataset.node); if (innerWidth < 760) $('#app').classList.add('side-off'); } });
$('#filter').addEventListener('click', (e) => { const b = e.target.closest('[data-f]'); if (b) { S.filter = b.dataset.f; render(); } });
$('#q').addEventListener('input', (e) => { S.q = e.target.value; render(); });
$('#q').addEventListener('keydown', (e) => e.stopPropagation());
$('#toggleSide').onclick = () => { $('#app').classList.toggle('side-off'); setTimeout(applyView, 220); };
$('#toolbar').addEventListener('click', (e) => { const b = e.target.closest('[data-tool]'); if (b) setTool(b.dataset.tool); });
$('#toolbar').addEventListener('pointerdown', (e) => e.stopPropagation());
$$('.zoom').forEach((z) => z.addEventListener('pointerdown', (e) => e.stopPropagation()));
$('#zIn').onclick = () => zoomAt(1.2); $('#zOut').onclick = () => zoomAt(1 / 1.2);
$('#zVal').onclick = () => zoomAt(1 / S.view.z); $('#zFit').onclick = () => fitView();
$('#undo').onclick = undo; $('#redo').onclick = redo;
function setTool(t) {
  if (S.ro && !['hand', 'select'].includes(t)) return toast('У вас доступ только на просмотр', true);
  S.tool = t; if (t !== 'select') S.sel = null; render();
}

// export
$('#exportBtn').onclick = (e) => { e.stopPropagation(); $('#exportMenu').hidden = !$('#exportMenu').hidden; };
document.addEventListener('click', () => ($('#exportMenu').hidden = true));
$('#exportMenu').addEventListener('click', async (e) => {
  const x = e.target.closest('[data-x]')?.dataset.x; if (!x || !S.mapId) return toast('Сначала откройте карту', true);
  const name = (S.map?.name || 'roadmap').replace(/[\\/:*?"<>|]+/g, '_');
  try {
    if (x === 'json') downloadBlob(new Blob([JSON.stringify(await api('GET', `/api/maps/${S.mapId}/export`), null, 2)], { type: 'application/json' }), name + '.json');
    if (x === 'md') downloadBlob(new Blob([await api('GET', `/api/maps/${S.mapId}/export?format=md`)], { type: 'text/markdown' }), name + '.md');
    if (x === 'png') exportPng(name);
    if (x === 'copy') { await navigator.clipboard.writeText(JSON.stringify(await api('GET', `/api/maps/${S.mapId}/export`), null, 2)); toast('JSON скопирован'); }
  } catch (er) { toast(er.message, true); }
});
function downloadBlob(blob, name) { const a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name; a.click(); setTimeout(() => URL.revokeObjectURL(a.href), 2000); }

// ---------------- canvas pointer handling ----------------
const pointers = new Map();
stage.addEventListener('pointerdown', (e) => {
  if (e.target.closest('.toolbar,.zoom,.minimap,.pop,.empty-box,.text-edit')) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 2) { const [a, b] = [...pointers.values()]; S.drag = { type: 'pinch', d0: Math.hypot(a.x - b.x, a.y - b.y), z0: S.view.z, prev: null }; return; }
  const p = toWorld(e.clientX, e.clientY);
  const tool = S.space ? 'hand' : S.tool;
  const onBg = !e.target.closest('.card,[data-edge],[data-shape]');
  if (onBg || e.button === 1 || tool === 'hand') { document.activeElement?.blur?.(); }
  if (e.button === 1 || tool === 'hand') return startPan(e);
  const card = e.target.closest('.card');
  if (card) {
    const id = card.dataset.id;
    if (tool === 'eraser' || S.ro && !e.target.closest('.card-head')) { if (S.sel?.id !== id) select({ kind: 'node', id }); return; }
    if (e.target.closest('.port') || (tool === 'arrow' && !e.target.closest('[contenteditable="true"],button,input'))) { e.preventDefault(); return startConnect(e, id, p); }
    if (S.sel?.id !== id) select({ kind: 'node', id });
    if (e.target.closest('.card-head') && !e.target.closest('button,[contenteditable="true"]:focus,input')) {
      const n = S.items.node[id]; e.preventDefault();
      S.drag = { type: 'card', id, start: p, orig: clone(n), moved: false };
      stage.setPointerCapture(e.pointerId);
    }
    return;
  }
  const edgeEl = e.target.closest('[data-edge]');
  if (edgeEl) { if (tool === 'eraser') { S.sel = { kind: 'edge', id: edgeEl.dataset.edge }; deleteSelection(); } else select({ kind: 'edge', id: edgeEl.dataset.edge }); return; }
  const shEl = e.target.closest('[data-shape]');
  if (tool === 'eraser') { S.drag = { type: 'erase', ops: [], prev: {} }; stage.setPointerCapture(e.pointerId); eraseAt(e); return; }
  if (shEl && tool === 'select') {
    const id = shEl.dataset.shape; select({ kind: 'shape', id });
    if (!S.ro) { S.drag = { type: 'shape', id, start: p, orig: clone(S.items.shape[id]), moved: false }; stage.setPointerCapture(e.pointerId); }
    return;
  }
  if (S.ro && tool !== 'select') return;
  switch (tool) {
    case 'select': if (S.sel) select(null); return startPan(e);
    case 'card': return createCard(p);
    case 'text': e.preventDefault(); return editText(null, p);
    case 'image': S.pendingImg = p; $('#imgInput').click(); return;
    case 'rect': case 'diamond': case 'ellipse': case 'arrow': case 'pen':
      S.drag = { type: 'draw', tool, start: p, pts: [[p.x, p.y]] }; stage.setPointerCapture(e.pointerId); return;
  }
});
function startPan(e) { S.drag = { type: 'pan', sx: e.clientX, sy: e.clientY, vx: S.view.x, vy: S.view.y }; stage.classList.add('panning'); stage.setPointerCapture(e.pointerId); }
function startConnect(e, id, p) { S.drag = { type: 'connect', from: id, p }; stage.setPointerCapture(e.pointerId); drawConnectPreview(p); }

stage.addEventListener('pointermove', (e) => {
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  const p = toWorld(e.clientX, e.clientY);
  sendCursor(p);
  const d = S.drag; if (!d) return;
  if (d.type === 'pinch') {
    if (pointers.size < 2) return;
    const [a, b] = [...pointers.values()]; const dist = Math.hypot(a.x - b.x, a.y - b.y); const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    zoomAt((d.z0 * dist / d.d0) / S.view.z, mid.x, mid.y);
    if (d.prev) { S.view.x += mid.x - d.prev.x; S.view.y += mid.y - d.prev.y; applyView(); }
    d.prev = mid; return;
  }
  if (d.type === 'pan') { S.view.x = d.vx + e.clientX - d.sx; S.view.y = d.vy + e.clientY - d.sy; applyView(); return; }
  if (d.type === 'card') {
    const dx = p.x - d.start.x, dy = p.y - d.start.y; if (!d.moved && Math.hypot(dx, dy) * S.view.z < 3) return;
    d.moved = true;
    S.items.node[d.id] = { ...S.items.node[d.id], x: Math.round(d.orig.x + dx), y: Math.round(d.orig.y + dy) };
    const el = $(`.card[data-id="${d.id}"]`); el.style.left = S.items.node[d.id].x + 'px'; el.style.top = S.items.node[d.id].y + 'px';
    renderEdges(); drawMinimap(); return;
  }
  if (d.type === 'shape') {
    const dx = p.x - d.start.x, dy = p.y - d.start.y; if (!d.moved && Math.hypot(dx, dy) * S.view.z < 3) return;
    d.moved = true; S.items.shape[d.id] = moveShape(d.orig, dx, dy); renderShapes(); renderPop(); return;
  }
  if (d.type === 'connect') { d.p = p; drawConnectPreview(p, e); return; }
  if (d.type === 'erase') { eraseAt(e); return; }
  if (d.type === 'draw') {
    if (d.tool === 'pen') { const last = d.pts[d.pts.length - 1]; if (Math.hypot(p.x - last[0], p.y - last[1]) * S.view.z > 2) d.pts.push([Math.round(p.x * 10) / 10, Math.round(p.y * 10) / 10]); }
    d.end = p; d.shape = draftShape(d, e.shiftKey);
    $('#overlay').innerHTML = d.shape ? shapeSvg(d.shape) : '';
  }
});
function endDrag(e) {
  pointers.delete(e.pointerId);
  const d = S.drag; S.drag = null; stage.classList.remove('panning');
  if (!d) return;
  if (d.type === 'card' && d.moved) commit([{ kind: 'node', id: d.id, data: S.items.node[d.id] }], { prev: { ['node:' + d.id]: d.orig } });
  if (d.type === 'shape' && d.moved) commit([{ kind: 'shape', id: d.id, data: S.items.shape[d.id] }], { prev: { ['shape:' + d.id]: d.orig } });
  if (d.type === 'connect') {
    $('#overlay').innerHTML = ''; $$('.card.drop').forEach((c) => c.classList.remove('drop'));
    const target = document.elementFromPoint(e.clientX, e.clientY)?.closest('.card')?.dataset.id;
    if (target && target !== d.from) {
      const dup = Object.values(S.items.edge).some((x) => x.from === d.from && x.to === target);
      if (!dup) { const id = uid(); commit([{ kind: 'edge', id, data: { from: d.from, to: target, style: 'solid', label: '' } }]); S.sel = { kind: 'edge', id }; }
      if (S.tool === 'arrow') setTool('select');
    }
  }
  if (d.type === 'erase' && d.ops.length) { commit(d.ops, { prev: d.prev }); }
  if (d.type === 'draw') {
    $('#overlay').innerHTML = '';
    if (d.shape) { const id = uid(); commit([{ kind: 'shape', id, data: d.shape }]); if (d.tool !== 'pen') { S.tool = 'select'; select({ kind: 'shape', id }); } }
  }
  render();
}
stage.addEventListener('pointerup', endDrag);
stage.addEventListener('pointercancel', endDrag);
stage.addEventListener('pointerleave', () => {});

function draftShape(d, shift) {
  const a = d.start, b = d.end || a;
  if (d.tool === 'pen') return d.pts.length > 1 ? { type: 'pen', pts: d.pts, color: COLORS[0] } : null;
  if (d.tool === 'arrow') return Math.hypot(b.x - a.x, b.y - a.y) > 6 ? { type: 'arrow', x1: a.x, y1: a.y, x2: b.x, y2: b.y, color: COLORS[0], dashed: false } : null;
  let w = b.x - a.x, h = b.y - a.y;
  if (shift) { const m = Math.max(Math.abs(w), Math.abs(h)); w = Math.sign(w || 1) * m; h = Math.sign(h || 1) * m; }
  if (Math.abs(w) < 6 || Math.abs(h) < 6) return null;
  return { type: d.tool, x: Math.min(a.x, a.x + w), y: Math.min(a.y, a.y + h), w: Math.abs(w), h: Math.abs(h), color: COLORS[0] };
}
function moveShape(s, dx, dy) {
  const o = clone(s); dx = Math.round(dx); dy = Math.round(dy);
  if (o.type === 'arrow') { o.x1 += dx; o.x2 += dx; o.y1 += dy; o.y2 += dy; }
  else if (o.type === 'pen') o.pts = o.pts.map(([x, y]) => [x + dx, y + dy]);
  else { o.x += dx; o.y += dy; }
  return o;
}
function eraseAt(e) {
  const d = S.drag; const el = document.elementFromPoint(e.clientX, e.clientY);
  const sh = el?.closest('[data-shape]')?.dataset.shape, ed = el?.closest('[data-edge]')?.dataset.edge;
  const kill = (kind, id) => { if (!S.items[kind][id]) return; d.prev[kind + ':' + id] = clone(S.items[kind][id]); d.ops.push({ kind, id, data: null }); delete S.items[kind][id]; renderShapes(); renderEdges(); };
  if (sh) kill('shape', sh); if (ed) kill('edge', ed);
}
function drawConnectPreview(p, e) {
  const a = rectOf(S.drag.from);
  const over = e && document.elementFromPoint(e.clientX, e.clientY)?.closest('.card');
  $$('.card.drop').forEach((c) => c !== over && c.classList.remove('drop'));
  if (over && over.dataset.id !== S.drag.from) over.classList.add('drop');
  const right = p.x >= a.x + a.w / 2;
  const p1 = { x: right ? a.x + a.w : a.x, y: a.y + Math.min(a.h / 2, 160), dx: right ? 1 : -1, dy: 0 };
  const p2 = { x: p.x, y: p.y, dx: right ? -1 : 1, dy: 0 };
  $('#overlay').innerHTML = `<path class="edge sel" d="${curve(p1, p2).d}" stroke-dasharray="6 5"/>`;
}

stage.addEventListener('wheel', (e) => {
  if (e.target.closest('.toolbar,.minimap,.pop,.modal')) return;
  e.preventDefault();
  if (e.ctrlKey || e.metaKey) zoomAt(Math.exp(-e.deltaY * 0.01), e.clientX, e.clientY);
  else { S.view.x -= e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX; S.view.y -= e.shiftKey && !e.deltaX ? 0 : e.deltaY; applyView(); }
}, { passive: false });
stage.addEventListener('dblclick', (e) => {
  const sh = e.target.closest('[data-shape]');
  if (sh && S.items.shape[sh.dataset.shape]?.type === 'text' && !S.ro) return editText(sh.dataset.shape);
  if (!e.target.closest('.card,[data-edge],[data-shape],.toolbar,.zoom,.minimap,.pop,.empty-box') && S.tool === 'select' && !S.ro && S.mapId) createCard(toWorld(e.clientX, e.clientY));
});

// --- text tool
function measureText(text, size) {
  const c = measureText.c ||= document.createElement('canvas').getContext('2d');
  c.font = `italic ${size}px Onest, sans-serif`;
  const lines = text.split('\n');
  return { w: Math.max(20, ...lines.map((l) => c.measureText(l).width)) + 4, h: lines.length * size * 1.25 + size * 0.3 };
}
function editText(id, p) {
  const s = id ? S.items.shape[id] : { type: 'text', x: p.x, y: p.y, text: '', size: 20, color: COLORS[0] };
  const ta = document.createElement('textarea'); ta.className = 'text-edit'; ta.value = s.text;
  const sp = toScreen(s.x, s.y);
  Object.assign(ta.style, { left: sp.x - 5 + 'px', top: sp.y - 3 + 'px', fontSize: s.size * S.view.z + 'px', color: s.color, fontStyle: 'italic' });
  const fit = () => { ta.style.height = 'auto'; ta.style.height = ta.scrollHeight + 'px'; ta.style.width = Math.max(120, measureText(ta.value || ' ', s.size).w * S.view.z + 20) + 'px'; };
  stage.append(ta); fit(); setTimeout(() => ta.focus(), 0);
  if (id) $(`[data-shape="${id}"]`)?.setAttribute('opacity', '0');
  let done = false;
  const fin = (ok) => {
    if (done) return; done = true; ta.remove();
    const text = ta.value.replace(/\s+$/, '');
    if (ok && text && text !== s.text) { const m = measureText(text, s.size); commit([{ kind: 'shape', id: id || uid(), data: { ...s, text, w: m.w, h: m.h } }]); }
    else if (ok && !text && id) commit([{ kind: 'shape', id, data: null }]);
    setTool('select'); render();
  };
  ta.oninput = fit;
  ta.onkeydown = (e) => { e.stopPropagation(); if (e.key === 'Escape') fin(false); if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) fin(true); };
  ta.onblur = () => fin(true);
  ta.onpointerdown = (e) => e.stopPropagation();
}

// --- images
$('#imgInput').onchange = async (e) => { const f = e.target.files[0]; e.target.value = ''; if (f) placeImage(f, S.pendingImg); };
async function placeImage(file, p) {
  if (!p) { const r = stage.getBoundingClientRect(); p = toWorld(r.left + r.width / 2, r.top + r.height / 2); }
  try {
    toast('Загружаю картинку…');
    const { src } = await api('POST', '/api/uploads', undefined, file);
    const img = new Image(); img.src = src; await img.decode();
    const k = Math.min(1, 480 / img.naturalWidth);
    const w = Math.round(img.naturalWidth * k), h = Math.round(img.naturalHeight * k);
    const id = uid(); commit([{ kind: 'shape', id, data: { type: 'image', x: Math.round(p.x - w / 2), y: Math.round(p.y - h / 2), w, h, src, color: COLORS[0] } }]);
    S.tool = 'select'; select({ kind: 'shape', id });
  } catch (er) { toast(er.message, true); }
}
stage.addEventListener('dragover', (e) => e.preventDefault());
stage.addEventListener('drop', (e) => {
  e.preventDefault(); if (S.ro || !S.mapId) return;
  const f = [...e.dataTransfer.files].find((x) => x.type.startsWith('image/'));
  const j = [...e.dataTransfer.files].find((x) => x.name.endsWith('.json'));
  if (f) placeImage(f, toWorld(e.clientX, e.clientY));
  else if (j) j.text().then((t) => importMap(JSON.parse(t))).catch((er) => toast(er.message, true));
});
document.addEventListener('paste', (e) => {
  if (e.target.closest?.('input,textarea,[contenteditable="true"]') || S.ro || !S.mapId) return;
  const f = [...(e.clipboardData?.files || [])].find((x) => x.type.startsWith('image/'));
  if (f) { e.preventDefault(); placeImage(f); }
});

// ---------------- keyboard ----------------
const TOOL_KEYS = { '1': 'select', v: 'select', '2': 'rect', r: 'rect', '3': 'diamond', d: 'diamond', '4': 'ellipse', o: 'ellipse', '5': 'arrow', a: 'arrow', '6': 'pen', p: 'pen', '7': 'text', t: 'text', '8': 'image', i: 'image', '9': 'eraser', e: 'eraser', '0': 'card', n: 'card', h: 'hand' };
document.addEventListener('keydown', (e) => {
  if (e.target.closest?.('input,textarea,[contenteditable="true"]') || !$('#modal').hidden || $('#app').hidden) return;
  const k = e.key.toLowerCase();
  if ((e.ctrlKey || e.metaKey) && k === 'z') { e.preventDefault(); return e.shiftKey ? redo() : undo(); }
  if ((e.ctrlKey || e.metaKey) && k === 'y') { e.preventDefault(); return redo(); }
  if ((e.ctrlKey || e.metaKey) && (k === '=' || k === '+')) { e.preventDefault(); return zoomAt(1.2); }
  if ((e.ctrlKey || e.metaKey) && k === '-') { e.preventDefault(); return zoomAt(1 / 1.2); }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  if (e.key === ' ') { e.preventDefault(); if (!S.space) { S.space = true; renderTop(); } return; }
  if (e.key === 'Escape') { S.sel = null; setTool('select'); return; }
  if ((e.key === 'Delete' || e.key === 'Backspace') && S.sel && !S.ro) { e.preventDefault(); return deleteSelection(); }
  if (e.shiftKey && k === '1') return fitView();
  if (TOOL_KEYS[k] && S.mapId) setTool(TOOL_KEYS[k]);
});
document.addEventListener('keyup', (e) => { if (e.key === ' ') { S.space = false; renderTop(); } });
addEventListener('resize', () => applyView());
// Focusing an off-screen element makes the browser scroll the canvas; the view is driven by transforms only.
stage.addEventListener('scroll', () => { stage.scrollTop = 0; stage.scrollLeft = 0; });

// ---------------- modals ----------------
function modal(html, onMount) {
  $('#modalBox').innerHTML = html; $('#modal').hidden = false;
  onMount?.($('#modalBox'));
  $('#modalBox [autofocus]')?.focus();
}
const closeModal = () => { $('#modal').hidden = true; $('#modalBox').innerHTML = ''; };
$('#modal').addEventListener('pointerdown', (e) => { if (e.target.id === 'modal') closeModal(); });
$('#modal').addEventListener('keydown', (e) => { if (e.key === 'Escape') closeModal(); });
$('#modalBox').addEventListener('click', (e) => { if (e.target.closest('[data-close]')) closeModal(); });

const FORMAT_SAMPLE = `{
  "name": "Релиз 1.0",
  "stages": [
    { "id": "m0", "lane": "Владелец", "title": "Аккаунт и ранние шаги",
      "desc": "Что нужно сделать в первую неделю",
      "status": "active", "due": "2026-11-20", "priority": "high",
      "subtasks": ["Завести аккаунт",
        { "t": "Проверить доступы", "done": true, "c": ["Сервер", "Репозиторий"] }] },
    { "id": "m1", "lane": "Параллельно", "title": "Лицензии и ассеты" }
  ],
  "links": [{ "from": "m0", "to": "m1", "style": "dashed", "label": "параллельно" }]
}`;
function openImport() {
  if (S.ro) return toast('У вас доступ только на просмотр', true);
  modal(`<h2>Импорт карты из JSON</h2>
    <p>Вставьте JSON или перетащите .json-файл на холст. Координаты не обязательны: этапы расставятся по связям автоматически. Так же работает CLI: <code>node cli/roadmap.js import plan.json</code>.</p>
    <textarea id="impText" spellcheck="false" placeholder='${esc(FORMAT_SAMPLE)}' autofocus></textarea>
    <div id="impErr" class="err"></div>
    <details><summary class="muted" style="cursor:pointer">Формат файла</summary><pre>${esc(FORMAT_SAMPLE)}</pre>
    <p style="margin-top:8px">status: planned, active или done. priority: low, medium или high. Подзадача может быть строкой или объектом с полями t, done и c (вложенные).</p></details>
    <div class="modal-foot"><label class="btn ghost" style="cursor:pointer">Выбрать файл<input type="file" id="impFile" accept=".json,application/json" hidden></label><button class="btn ghost" data-close>Отмена</button><button class="btn primary" id="impGo">Создать карту</button></div>`, (box) => {
    box.querySelector('#impFile').onchange = async (e) => { box.querySelector('#impText').value = await e.target.files[0].text(); };
    box.querySelector('#impGo').onclick = async () => {
      try { const json = JSON.parse(box.querySelector('#impText').value); await importMap(json); closeModal(); }
      catch (er) { box.querySelector('#impErr').textContent = er instanceof SyntaxError ? 'Это не похоже на корректный JSON: ' + er.message : er.message; }
    };
  });
}
$('#importBtn').onclick = openImport;

async function openSettings(tab = 'team') {
  const admin = S.me.role === 'admin';
  const [team, tokens] = await Promise.all([api('GET', '/api/team'), api('GET', '/api/tokens')]).catch((e) => { toast(e.message, true); return []; });
  if (!team) return;
  const ROLE = { admin: 'Администратор', member: 'Участник', viewer: 'Только просмотр' };
  const inviteUrl = (c) => `${location.origin}/?invite=${c}`;
  const tabs = { team: 'Команда', cli: 'CLI и API', account: 'Аккаунт' };
  const body = {
    team: `<div class="rows">${team.users.map((u) => `<div class="rowi"><span class="avatar" style="background:${u.color}">${esc(initials(u.name))}</span><span class="grow"><b>${esc(u.name)}</b> <span class="muted">${esc(u.email)}</span></span>
        ${admin && u.id !== S.me.id ? `<select data-role="${u.id}">${Object.entries(ROLE).map(([k, v]) => `<option value="${k}" ${u.role === k ? 'selected' : ''}>${v}</option>`).join('')}</select><button class="icon-btn sm" data-rmuser="${u.id}" title="Удалить из команды">${icon('trash', 'sm')}</button>` : `<span class="muted">${ROLE[u.role]}</span>`}</div>`).join('')}</div>
      ${admin ? `<h3>Приглашения</h3><p>Каждая ссылка работает один раз. Отправьте её коллеге любым удобным способом.</p>
      <div class="rows">${team.invites.map((i) => `<div class="rowi"><code class="grow">${esc(inviteUrl(i.code))}</code><button class="btn ghost" data-copy="${esc(inviteUrl(i.code))}">Копировать</button><button class="icon-btn sm" data-rminv="${i.code}" title="Отозвать">${icon('x', 'sm')}</button></div>`).join('') || '<p class="muted">Активных приглашений нет.</p>'}</div>
      <div class="modal-foot"><button class="btn primary" id="mkInvite">${icon('plus')}Создать приглашение</button></div>` : '<p>Приглашать коллег может администратор.</p>'}`,
    cli: `<p>Токен позволяет создавать и выгружать карты из терминала или скриптов, например чтобы сгенерировать дорожную карту из дизайн-документов.</p>
      <pre>export ROADMAP_URL=${esc(location.origin)}
export ROADMAP_TOKEN=rm_…

node cli/roadmap.js list
node cli/roadmap.js import plan.json
node cli/roadmap.js export &lt;id&gt; --md &gt; plan.md</pre>
      <p>То же через HTTP: <code>POST /api/maps/import</code> с заголовком <code>Authorization: Bearer rm_…</code> и JSON карты в теле.</p>
      <h3>Ваши токены</h3>
      <div id="newTok"></div>
      <div class="rows">${(tokens.tokens || []).map((t) => `<div class="rowi"><span class="grow">${esc(t.name)} <span class="muted">· создан ${new Date(t.created).toLocaleDateString('ru-RU')}${t.last_used ? ', использовался ' + new Date(t.last_used).toLocaleDateString('ru-RU') : ''}</span></span><button class="icon-btn sm" data-rmtok="${t.id}" title="Отозвать">${icon('trash', 'sm')}</button></div>`).join('') || '<p class="muted">Токенов пока нет.</p>'}</div>
      <div class="modal-foot"><input type="text" id="tokName" placeholder="Название, например «Ноутбук»"><button class="btn primary" id="mkTok">Создать токен</button></div>`,
    account: `<p>${esc(S.me.name)} · ${esc(S.me.email)} · ${ROLE[S.me.role]}</p>
      <h3>Сменить пароль</h3>
      <input type="password" id="pwCur" placeholder="Текущий пароль" autocomplete="current-password"><input type="password" id="pwNew" placeholder="Новый пароль, от 8 символов" autocomplete="new-password">
      <div id="pwErr" class="err"></div>
      <div class="modal-foot"><button class="btn ghost" id="logout">Выйти</button><button class="btn primary" id="pwGo">Сменить пароль</button></div>`,
  };
  modal(`<h2>Настройки</h2><div class="tabs">${Object.entries(tabs).map(([k, v]) => `<button data-tab="${k}" class="${k === tab ? 'on' : ''}">${v}</button>`).join('')}</div>${body[tab]}
    <div class="modal-foot"><button class="btn ghost" data-close>Закрыть</button></div>`, (box) => {
    box.querySelectorAll('[data-tab]').forEach((b) => (b.onclick = () => openSettings(b.dataset.tab)));
    box.querySelectorAll('[data-copy]').forEach((b) => (b.onclick = () => navigator.clipboard.writeText(b.dataset.copy).then(() => toast('Ссылка скопирована'), () => toast('Не удалось скопировать, выделите ссылку вручную', true))));
    box.querySelectorAll('[data-role]').forEach((s) => (s.onchange = () => api('PATCH', `/api/team/${s.dataset.role}`, { role: s.value }).then(() => toast('Роль изменена'), (e) => toast(e.message, true))));
    box.querySelectorAll('[data-rmuser]').forEach((b) => (b.onclick = () => { if (b.dataset.armed) api('DELETE', `/api/team/${b.dataset.rmuser}`).then(() => openSettings('team')); else { b.dataset.armed = 1; b.style.color = 'var(--bad)'; b.title = 'Нажмите ещё раз, чтобы удалить'; } }));
    box.querySelectorAll('[data-rminv]').forEach((b) => (b.onclick = () => api('DELETE', `/api/invites/${b.dataset.rminv}`).then(() => openSettings('team'))));
    box.querySelectorAll('[data-rmtok]').forEach((b) => (b.onclick = () => api('DELETE', `/api/tokens/${b.dataset.rmtok}`).then(() => openSettings('cli'))));
    const mi = box.querySelector('#mkInvite'); if (mi) mi.onclick = () => api('POST', '/api/invites').then(() => openSettings('team'));
    const mt = box.querySelector('#mkTok'); if (mt) mt.onclick = async () => {
      const { token } = await api('POST', '/api/tokens', { name: box.querySelector('#tokName').value || 'CLI' });
      await openSettings('cli');
      $('#newTok').innerHTML = `<div class="rowi" style="border:1px solid var(--ok)"><code class="grow">${esc(token)}</code><button class="btn ghost" id="cpTok">Копировать</button></div><p>Сохраните токен сейчас: показать его ещё раз не получится.</p>`;
      $('#cpTok').onclick = () => navigator.clipboard.writeText(token).then(() => toast('Токен скопирован'));
    };
    const lo = box.querySelector('#logout'); if (lo) lo.onclick = () => api('POST', '/api/auth/logout').then(() => location.reload());
    const pw = box.querySelector('#pwGo'); if (pw) pw.onclick = () => api('POST', '/api/me/password', { current: box.querySelector('#pwCur').value, next: box.querySelector('#pwNew').value })
      .then(() => { toast('Пароль изменён'); closeModal(); }, (e) => (box.querySelector('#pwErr').textContent = e.message));
  });
}
$('#openSettings').onclick = () => openSettings();

// ---------------- PNG export ----------------
function wrapLines(ctx, text, maxW) {
  const out = [];
  for (const para of String(text || '').split('\n')) {
    let line = '';
    for (const w of para.split(' ')) { const t = line ? line + ' ' + w : w; if (ctx.measureText(t).width > maxW && line) { out.push(line); line = w; } else line = t; }
    out.push(line);
  }
  return out;
}
function exportPng(name) {
  const b = bounds(); if (!b) return toast('Карта пустая', true);
  const pad = 60, scale = Math.min(2, 12000 / (b.w + pad * 2), 12000 / (b.h + pad * 2));
  const cv = document.createElement('canvas'); cv.width = (b.w + pad * 2) * scale; cv.height = (b.h + pad * 2) * scale;
  const c = cv.getContext('2d'); const css = getComputedStyle(document.documentElement); const v = (n) => css.getPropertyValue(n).trim();
  c.scale(scale, scale); c.translate(pad - b.x, pad - b.y);
  c.fillStyle = v('--bg'); c.fillRect(b.x - pad, b.y - pad, b.w + pad * 2, b.h + pad * 2);
  c.lineCap = 'round'; c.lineJoin = 'round';
  // shapes
  for (const s of Object.values(S.items.shape)) {
    c.strokeStyle = c.fillStyle = s.color; c.lineWidth = 2; c.setLineDash([]);
    const bx = shapeBox(s); c.beginPath();
    if (s.type === 'rect') c.roundRect(bx.x, bx.y, bx.w, bx.h, 10);
    else if (s.type === 'ellipse') c.ellipse(bx.x + bx.w / 2, bx.y + bx.h / 2, bx.w / 2, bx.h / 2, 0, 0, Math.PI * 2);
    else if (s.type === 'diamond') { c.moveTo(bx.x + bx.w / 2, bx.y); c.lineTo(bx.x + bx.w, bx.y + bx.h / 2); c.lineTo(bx.x + bx.w / 2, bx.y + bx.h); c.lineTo(bx.x, bx.y + bx.h / 2); c.closePath(); }
    else if (s.type === 'pen') s.pts.forEach((p, i) => (i ? c.lineTo(p[0], p[1]) : c.moveTo(p[0], p[1])));
    else if (s.type === 'arrow') { if (s.dashed) c.setLineDash([7, 6]); c.moveTo(s.x1, s.y1); c.lineTo(s.x2, s.y2); c.stroke(); c.setLineDash([]); c.stroke(new Path2D(headPath({ x: s.x2, y: s.y2 }, (s.x2 - s.x1) / (Math.hypot(s.x2 - s.x1, s.y2 - s.y1) || 1), (s.y2 - s.y1) / (Math.hypot(s.x2 - s.x1, s.y2 - s.y1) || 1), 11))); continue; }
    else if (s.type === 'text') { c.font = `italic ${s.size}px Onest, sans-serif`; s.text.split('\n').forEach((l, i) => c.fillText(l, s.x, s.y + s.size + i * s.size * 1.25)); continue; }
    else if (s.type === 'image') { const img = $(`[data-shape] image[href="${s.src}"]`); continue; }
    c.stroke();
  }
  // edges
  for (const e of Object.values(S.items.edge)) {
    const g = edgeGeom(e); if (!g) continue;
    c.strokeStyle = v('--fg-2'); c.lineWidth = 1.6; c.setLineDash(e.style === 'dashed' ? [7, 6] : []);
    c.stroke(new Path2D(g.d)); c.setLineDash([]); c.stroke(new Path2D(headPath(g.p2, -g.p2.dx, -g.p2.dy)));
    if (e.label) { c.font = 'italic 12px Onest, sans-serif'; const w = c.measureText(e.label).width + 24; c.fillStyle = v('--bg'); c.strokeStyle = v('--line-hi'); c.beginPath(); c.roundRect(g.mid.x - w / 2, g.mid.y - 12, w, 24, 8); c.fill(); c.stroke(); c.fillStyle = v('--fg-2'); c.textAlign = 'center'; c.fillText(e.label, g.mid.x, g.mid.y + 4); c.textAlign = 'left'; }
  }
  // cards
  for (const [id, n] of Object.entries(S.items.node)) {
    const w = n.w || CARD_W, h = S.heights[id] || 220, x = n.x, y = n.y;
    c.save(); c.beginPath(); c.roundRect(x, y, w, h, 12); c.fillStyle = v('--card'); c.fill(); c.strokeStyle = v('--line'); c.lineWidth = 1; c.stroke(); c.clip();
    c.font = '600 11px Onest, sans-serif'; c.fillStyle = v('--mute'); c.fillText(n.lane.toUpperCase(), x + 16, y + 26);
    const st = STATUS[n.status]; c.font = '12px Onest, sans-serif'; const sw = c.measureText(st).width + 20;
    c.fillStyle = n.status === 'done' ? v('--ok') : n.status === 'active' ? v('--info') : v('--fg-2'); c.fillText(st, x + w - 16 - sw + 10, y + 26);
    c.font = '600 17px Onest, sans-serif'; c.fillStyle = n.status === 'done' ? v('--fg-2') : v('--fg');
    let cy = y + 56; for (const l of wrapLines(c, n.title, w - 62)) { c.fillText(l, x + 45, cy); cy += 23; }
    c.beginPath(); c.arc(x + 25, y + 50, 9, 0, Math.PI * 2); c.strokeStyle = n.status === 'done' ? v('--ok') : v('--mute'); c.lineWidth = 1.7; c.stroke(); if (n.status === 'done') { c.fillStyle = v('--ok'); c.fill(); }
    if (!S.collapsed.has(id)) {
      c.font = '13.5px Onest, sans-serif'; c.fillStyle = v('--fg-2');
      for (const l of wrapLines(c, n.desc, w - 32)) { c.fillText(l, x + 16, cy); cy += 20; }
      const cnt = countSubs(n.subs);
      if (cnt.total) { cy += 6; c.fillStyle = v('--line'); c.fillRect(x + 16, cy, w - 110, 4); c.fillStyle = v('--ok'); c.fillRect(x + 16, cy, (w - 110) * cnt.done / cnt.total, 4); c.fillStyle = v('--fg-2'); c.font = '11.5px "JetBrains Mono", monospace'; c.fillText(`${cnt.done} из ${cnt.total}`, x + w - 84, cy + 5); cy += 22; }
      const walk = (l, ind) => l.forEach((s) => { c.beginPath(); c.arc(x + 30 + ind * 22, cy - 4, 7, 0, Math.PI * 2); c.strokeStyle = s.d ? v('--ok') : v('--mute'); c.stroke(); if (s.d) { c.fillStyle = v('--ok'); c.fill(); } c.font = '13px Onest, sans-serif'; c.fillStyle = s.d ? v('--mute') : v('--fg'); c.fillText(s.t, x + 44 + ind * 22, cy); cy += 24; if (!S.subClosed.has(s.id)) walk(s.c || [], ind + 1); });
      walk(n.subs || [], 0);
    }
    c.font = '12.5px Onest, sans-serif'; c.fillStyle = v('--fg-2'); c.fillText(fmtDue(n.due), x + 16, y + h - 16);
    if (n.priority) { c.fillStyle = n.priority === 'high' ? v('--warn') : v('--fg-2'); c.fillText(PRIO[n.priority], x + 150, y + h - 16); }
    c.restore();
  }
  // images last so they don't need async ordering issues
  const imgs = Object.values(S.items.shape).filter((s) => s.type === 'image');
  Promise.all(imgs.map((s) => new Promise((res) => { const im = new Image(); im.onload = () => { c.drawImage(im, s.x, s.y, s.w, s.h); res(); }; im.onerror = res; im.src = s.src; })))
    .then(() => cv.toBlob((blob) => downloadBlob(blob, name + '.png')));
}

// ---------------- template ----------------
const TEMPLATE = {
  name: 'Шаблон релиза',
  stages: [
    { id: 'a', lane: 'Владелец', title: 'Подготовка и доступы', desc: 'Аккаунты, доступы и решения, без которых команда не может начать.', status: 'active', priority: 'high', subtasks: ['Собрать команду и роли', 'Завести репозиторий и доски', { t: 'Зафиксировать даты', c: ['Дата альфы', 'Дата релиза'] }] },
    { id: 'b', lane: 'Команда', title: 'Прототип', desc: 'Минимальная версия, на которой проверяем основную идею.', subtasks: ['Основной сценарий', 'Первые плейтесты', 'Решение: продолжаем или меняем'] },
    { id: 'c', lane: 'Параллельно', title: 'Арт и звук', desc: 'Стиль, ассеты и реестр лицензий.', subtasks: ['Мудборд', 'Реестр ассетов и лицензий'] },
    { id: 'd', lane: 'Команда', title: 'Продакшн', desc: 'Наполнение контентом и доводка систем.', subtasks: ['Контент', 'Экономика и баланс', 'Интерфейс'] },
    { id: 'e', lane: 'Команда', title: 'Тестирование', desc: 'Закрытый тест, сбор фидбэка, исправление ошибок.', subtasks: ['Закрытый плейтест', 'Список критичных багов'] },
    { id: 'f', lane: 'Владелец', title: 'Релиз', desc: 'Страница проекта, материалы и публикация.', priority: 'high', subtasks: ['Страница и описание', 'Иконка и скриншоты', 'Публикация'] },
    { id: 'g', lane: 'Команда', title: 'Поддержка после релиза', desc: 'Метрики первых недель и план обновлений.', subtasks: ['Метрики первых 14 дней', 'План обновлений'] },
  ],
  links: [{ from: 'a', to: 'b' }, { from: 'a', to: 'c', style: 'dashed', label: 'параллельно' }, { from: 'b', to: 'd' }, { from: 'c', to: 'd', style: 'dashed' }, { from: 'd', to: 'e' }, { from: 'e', to: 'f' }, { from: 'f', to: 'g' }],
};

boot();
