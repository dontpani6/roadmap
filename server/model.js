'use strict';
// Data shapes shared by the API, the importer and the CLI.
const crypto = require('node:crypto');

const uid = (n = 10) => crypto.randomBytes(16).toString('base64url').replace(/[-_]/g, '').slice(0, n);

const STATUSES = ['planned', 'active', 'done'];
const PRIORITIES = ['', 'low', 'medium', 'high'];
const CARD_W = 460;

const str = (v, max = 4000) => (v == null ? '' : String(v)).slice(0, max);

function normSubs(list, depth = 0) {
  if (!Array.isArray(list) || depth > 6) return [];
  return list.slice(0, 300).map((s) => {
    if (typeof s === 'string') return { id: uid(8), t: str(s, 1000), d: false, c: [] };
    const c = normSubs(s.c || s.children || s.subtasks || [], depth + 1);
    let d = !!(s.d ?? s.done);
    if (c.length) d = c.every((x) => x.d);
    return { id: s.id ? str(s.id, 40) : uid(8), t: str(s.t ?? s.text ?? s.title, 1000), d, c };
  });
}

function normNode(n) {
  const status = STATUSES.includes(n.status) ? n.status : 'planned';
  const pr = { high: 'high', medium: 'medium', low: 'low', высокий: 'high', средний: 'medium', низкий: 'low' }[String(n.priority || '').toLowerCase()] || '';
  return {
    lane: str(n.lane ?? n.owner ?? 'Этап', 60),
    title: str(n.title ?? n.name, 300) || 'Без названия',
    desc: str(n.desc ?? n.description, 8000),
    status,
    due: /^\d{4}-\d{2}-\d{2}$/.test(n.due || '') ? n.due : '',
    priority: pr,
    subs: normSubs(n.subs || n.subtasks || []),
    x: Number.isFinite(+n.x) ? Math.round(+n.x) : 0,
    y: Number.isFinite(+n.y) ? Math.round(+n.y) : 0,
    w: Number.isFinite(+n.w) ? Math.max(280, Math.min(900, Math.round(+n.w))) : CARD_W,
  };
}

function normEdge(e) {
  return {
    from: str(e.from, 40),
    to: str(e.to, 40),
    style: e.style === 'dashed' ? 'dashed' : 'solid',
    label: str(e.label, 80),
  };
}

const SHAPE_TYPES = ['rect', 'diamond', 'ellipse', 'arrow', 'pen', 'text', 'image'];
function normShape(s) {
  if (!SHAPE_TYPES.includes(s.type)) return null;
  const num = (v) => (Number.isFinite(+v) ? Math.round(+v * 10) / 10 : 0);
  const out = { type: s.type, color: /^#[0-9a-f]{3,8}$/i.test(s.color || '') ? s.color : '#e6e3ee' };
  if (s.type === 'arrow') Object.assign(out, { x1: num(s.x1), y1: num(s.y1), x2: num(s.x2), y2: num(s.y2), dashed: !!s.dashed });
  else if (s.type === 'pen') out.pts = (Array.isArray(s.pts) ? s.pts : []).slice(0, 4000).map((p) => [num(p[0]), num(p[1])]);
  else Object.assign(out, { x: num(s.x), y: num(s.y), w: num(s.w), h: num(s.h) });
  if (s.type === 'text') { out.text = str(s.text, 4000); out.size = Math.max(10, Math.min(120, num(s.size) || 20)); }
  if (s.type === 'image') out.src = /^\/uploads\/[\w.-]+$/.test(s.src || '') ? s.src : '';
  return out;
}

function countSubs(subs) {
  let total = 0, done = 0;
  const walk = (l) => l.forEach((s) => { total++; if (s.d) done++; walk(s.c || []); });
  walk(subs || []);
  return { total, done };
}

function estHeight(n) {
  const { total } = countSubs(n.subs);
  return 170 + Math.ceil((n.desc || '').length / 70) * 20 + total * 25;
}

// Place stages that have no coordinates: columns follow the links, rows stack inside a column.
function autoLayout(nodes, edges) {
  const ids = Object.keys(nodes);
  const depth = Object.fromEntries(ids.map((id) => [id, 0]));
  for (let pass = 0; pass < ids.length; pass++) {
    let changed = false;
    for (const e of edges) {
      if (depth[e.from] == null || depth[e.to] == null || e.from === e.to) continue;
      if (depth[e.to] < depth[e.from] + 1) { depth[e.to] = depth[e.from] + 1; changed = true; }
    }
    if (!changed) break;
  }
  const cols = {};
  ids.forEach((id) => (cols[depth[id]] ||= []).push(id));
  Object.keys(cols).sort((a, b) => a - b).forEach((c) => {
    let y = 0;
    cols[c].forEach((id) => {
      nodes[id].x = c * (CARD_W + 160);
      nodes[id].y = y;
      y += estHeight(nodes[id]) + 70;
    });
  });
}

/**
 * Turn the import format into stored items.
 * { name, stages: [{ id?, lane, title, desc, status, due, priority, subtasks, x?, y? }],
 *   links: [{ from, to, style: "solid"|"dashed", label }] }
 */
function fromImport(json) {
  if (!json || typeof json !== 'object') throw new Error('Ожидается JSON-объект');
  const stages = json.stages || json.nodes || [];
  if (!Array.isArray(stages) || !stages.length) throw new Error('Нужен непустой список stages');
  const idMap = {};
  const nodes = {};
  let needsLayout = false;
  stages.forEach((s, i) => {
    const id = uid();
    idMap[s.id ?? s.key ?? String(i)] = id;
    if (s.title) idMap['title:' + s.title] = id;
    nodes[id] = normNode(s);
    if (s.x == null || s.y == null) needsLayout = true;
  });
  const edges = {};
  for (const l of json.links || json.edges || []) {
    const from = idMap[l.from] || idMap['title:' + l.from];
    const to = idMap[l.to] || idMap['title:' + l.to];
    if (from && to) edges[uid()] = normEdge({ ...l, from, to });
  }
  if (needsLayout) autoLayout(nodes, Object.values(edges));
  const shapes = {};
  for (const s of json.shapes || []) { const n = normShape(s); if (n) shapes[uid()] = n; }
  return { name: str(json.name || json.title, 120) || 'Новая карта', nodes, edges, shapes };
}

function toExport(map, items) {
  const order = Object.entries(items.node || {}).sort((a, b) => a[1].x - b[1].x || a[1].y - b[1].y);
  const strip = (l) => l.map((s) => ({ t: s.t, done: s.d, ...(s.c?.length ? { c: strip(s.c) } : {}) }));
  return {
    name: map.name,
    stages: order.map(([id, n]) => ({ id, lane: n.lane, title: n.title, desc: n.desc, status: n.status, due: n.due, priority: n.priority, subtasks: strip(n.subs), x: n.x, y: n.y })),
    links: Object.values(items.edge || {}).map((e) => ({ from: e.from, to: e.to, style: e.style, label: e.label })),
    shapes: Object.values(items.shape || {}),
  };
}

const STATUS_RU = { planned: 'Запланировано', active: 'В работе', done: 'Готово' };
const PRIO_RU = { high: 'Высокий', medium: 'Средний', low: 'Низкий' };
function toMarkdown(map, items) {
  const ex = toExport(map, items);
  const out = [`# ${ex.name}`, ''];
  const walk = (l, ind) => l.forEach((s) => { out.push(`${'  '.repeat(ind)}- [${s.done ? 'x' : ' '}] ${s.t}`); walk(s.c || [], ind + 1); });
  for (const s of ex.stages) {
    out.push(`## ${s.title}`, '');
    const meta = [s.lane, STATUS_RU[s.status], s.due && `до ${s.due}`, PRIO_RU[s.priority] && `приоритет: ${PRIO_RU[s.priority]}`].filter(Boolean);
    out.push(`_${meta.join(' · ')}_`, '');
    if (s.desc) out.push(s.desc, '');
    if (s.subtasks.length) { walk(s.subtasks, 0); out.push(''); }
  }
  return out.join('\n');
}

module.exports = { uid, normNode, normEdge, normShape, countSubs, fromImport, toExport, toMarkdown, STATUSES };
