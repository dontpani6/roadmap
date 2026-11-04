'use strict';
// Model Context Protocol server (Streamable HTTP, stateless JSON responses).
// Lets Claude or another assistant read and fill roadmaps from any chat.
//   POST /mcp            with header  Authorization: Bearer rm_...
//   POST /mcp/rm_...     token in the URL, for clients that cannot send headers

const PROTOCOL = '2025-06-18';

const INSTRUCTIONS = `Вехи — командное приложение дорожных карт. Карта состоит из этапов (карточек) на холсте и связей между ними.

Этап: lane (метка: «Владелец», «Команда», «Параллельно» или любая своя), title, desc, status (planned | active | done), due (YYYY-MM-DD), priority (low | medium | high), subtasks (вложенные подзадачи). Связь: from → to, style solid (последовательно) или dashed (параллельно), label.

Как работать:
1. Сначала list_maps, чтобы не создать дубль. Для существующей карты вызови get_map: там id этапов и подзадач.
2. Новую карту целиком создавай одним вызовом create_map: все этапы, подзадачи и связи сразу. Координаты не нужны, этапы расставятся по связям.
3. В существующую карту добавляй этапы через add_stages, меняй поля через update_stage, подзадачи через add_subtasks и set_subtasks_done, связи через link_stages.
4. Пиши по-русски, если пользователь не попросил иначе. Делай этапы крупными вехами (5–20 на карту), а конкретную работу раскладывай в подзадачи. Каждая подзадача — проверяемое действие, а не тема.
5. Изменения сразу видны всей команде в приложении. После работы сообщи пользователю ссылку на карту из ответа инструмента.`;

const SUB_SCHEMA = {
  description: 'Подзадачи: строка или объект {t, done, c: [вложенные]}',
  type: 'array',
  items: {
    anyOf: [
      { type: 'string' },
      { type: 'object', properties: { t: { type: 'string' }, done: { type: 'boolean' }, c: { type: 'array', items: {} } }, required: ['t'] },
    ],
  },
};
const STAGE_FIELDS = {
  lane: { type: 'string', description: 'Метка над заголовком: «Владелец», «Команда», «Параллельно»…' },
  title: { type: 'string' },
  desc: { type: 'string', description: 'Описание этапа, 1–3 предложения' },
  status: { type: 'string', enum: ['planned', 'active', 'done'] },
  due: { type: 'string', description: 'Срок в формате YYYY-MM-DD' },
  priority: { type: 'string', enum: ['', 'low', 'medium', 'high'] },
};
const STAGE_SCHEMA = {
  type: 'object',
  properties: { id: { type: 'string', description: 'Ваш ключ для ссылок в links (например "m1")' }, ...STAGE_FIELDS, subtasks: SUB_SCHEMA },
  required: ['title'],
};
const LINK_SCHEMA = {
  type: 'object',
  properties: {
    from: { type: 'string', description: 'id этапа (ваш ключ из stages или id из get_map)' },
    to: { type: 'string' },
    style: { type: 'string', enum: ['solid', 'dashed'] },
    label: { type: 'string' },
  },
  required: ['from', 'to'],
};
const str = { type: 'string' };

const TOOLS = [
  { name: 'roadmap_guide', description: 'Как устроено приложение Вехи и как правильно заполнять карты. Вызови, если не уверен в формате.', inputSchema: { type: 'object', properties: {} }, readOnly: true },
  { name: 'list_maps', description: 'Список дорожных карт команды с прогрессом (сколько этапов готово).', inputSchema: { type: 'object', properties: {} }, readOnly: true },
  { name: 'get_map', description: 'Полное содержимое карты: этапы с id, подзадачи с id, связи.', inputSchema: { type: 'object', properties: { map_id: str }, required: ['map_id'] }, readOnly: true },
  {
    name: 'create_map',
    description: 'Создать новую карту целиком: этапы, подзадачи и связи за один вызов. Этапы расставляются автоматически по связям.',
    inputSchema: { type: 'object', properties: { name: str, stages: { type: 'array', items: STAGE_SCHEMA }, links: { type: 'array', items: LINK_SCHEMA } }, required: ['name', 'stages'] },
  },
  { name: 'rename_map', description: 'Переименовать карту.', inputSchema: { type: 'object', properties: { map_id: str, name: str }, required: ['map_id', 'name'] } },
  {
    name: 'add_stages',
    description: 'Добавить этапы в существующую карту. В links можно ссылаться и на новые этапы (по их id из stages), и на существующие (id из get_map). Новые этапы ставятся правее связанных.',
    inputSchema: { type: 'object', properties: { map_id: str, stages: { type: 'array', items: STAGE_SCHEMA }, links: { type: 'array', items: LINK_SCHEMA } }, required: ['map_id', 'stages'] },
  },
  {
    name: 'update_stage',
    description: 'Изменить поля этапа. Передавай только то, что меняется. subtasks, если передан, полностью заменяет список подзадач.',
    inputSchema: { type: 'object', properties: { map_id: str, stage_id: str, ...STAGE_FIELDS, subtasks: SUB_SCHEMA }, required: ['map_id', 'stage_id'] },
  },
  {
    name: 'add_subtasks',
    description: 'Добавить подзадачи в этап, в конец списка или внутрь подзадачи parent_id.',
    inputSchema: { type: 'object', properties: { map_id: str, stage_id: str, parent_id: { type: 'string', description: 'id подзадачи-родителя, необязательно' }, subtasks: SUB_SCHEMA }, required: ['map_id', 'stage_id', 'subtasks'] },
  },
  {
    name: 'set_subtasks_done',
    description: 'Отметить подзадачи выполненными или снять отметку. Статус этапа обновится сам.',
    inputSchema: { type: 'object', properties: { map_id: str, stage_id: str, subtask_ids: { type: 'array', items: str }, done: { type: 'boolean' } }, required: ['map_id', 'stage_id', 'subtask_ids', 'done'] },
  },
  { name: 'link_stages', description: 'Связать два этапа стрелкой. solid значит «последовательно», dashed значит «параллельно».', inputSchema: { type: 'object', properties: { map_id: str, ...LINK_SCHEMA.properties }, required: ['map_id', 'from', 'to'] } },
  { name: 'unlink_stages', description: 'Убрать связь между двумя этапами.', inputSchema: { type: 'object', properties: { map_id: str, from: str, to: str }, required: ['map_id', 'from', 'to'] } },
  { name: 'delete_stage', description: 'Удалить этап вместе с его связями. Спроси пользователя перед удалением.', inputSchema: { type: 'object', properties: { map_id: str, stage_id: str }, required: ['map_id', 'stage_id'] }, destructive: true },
];

class ToolError extends Error {}

function mount(app, ctx) {
  const { M, userFromReq, applyOps, createMap, loadItems, getMap, mapSummary, db, broadcastAll } = ctx;
  const origin = (req) => process.env.PUBLIC_URL?.replace(/\/$/, '') || `${req.protocol}://${req.get('host')}`;
  const link = (req, id) => `${origin(req)}/#${id}`;

  function needMap(id) { const m = getMap(String(id || '')); if (!m) throw new ToolError(`Карта ${id} не найдена. Вызови list_maps.`); return m; }
  function needStage(items, id) { const n = items.node[id]; if (!n) throw new ToolError(`Этап ${id} не найден. Вызови get_map, чтобы увидеть id этапов.`); return n; }
  function canWrite(user) { if (user.role === 'viewer') throw new ToolError('У этого токена доступ только на просмотр.'); }

  function describeMap(req, m, items) {
    const subs = (l) => l.map((s) => ({ id: s.id, t: s.t, done: s.d, ...(s.c?.length ? { c: subs(s.c) } : {}) }));
    const stages = Object.entries(items.node).sort((a, b) => a[1].x - b[1].x || a[1].y - b[1].y)
      .map(([id, n]) => ({ id, lane: n.lane, title: n.title, desc: n.desc, status: n.status, due: n.due, priority: n.priority, progress: M.countSubs(n.subs), subtasks: subs(n.subs) }));
    const links = Object.entries(items.edge).map(([id, e]) => ({ id, from: e.from, to: e.to, style: e.style, label: e.label }));
    return { map: { ...mapSummary(m), url: link(req, m.id) }, stages, links };
  }

  // Place new stages to the right of what they link from, or after the existing map.
  function placeNew(items, newNodes, links) {
    const fresh = Object.fromEntries(Object.entries(newNodes).map(([k, n]) => [k, { ...n }]));
    M.autoLayout(fresh, links.filter((l) => fresh[l.from] && fresh[l.to]));
    const existing = Object.values(items.node);
    const colW = M.CARD_W + 160;
    const fromExisting = links.filter((l) => items.node[l.from] && fresh[l.to]).map((l) => items.node[l.from].x);
    const baseX = fromExisting.length ? Math.max(...fromExisting) + colW : existing.length ? Math.max(...existing.map((n) => n.x)) + colW : 0;
    const right = baseX + Math.max(0, ...Object.values(fresh).map((n) => n.x)) + M.CARD_W;
    const overlapping = existing.filter((n) => n.x + (n.w || M.CARD_W) > baseX && n.x < right);
    const baseY = overlapping.length ? Math.max(...overlapping.map((n) => n.y + M.estHeight(n))) + 80 : existing.length ? Math.min(...existing.map((n) => n.y)) : 0;
    for (const [k, n] of Object.entries(fresh)) { newNodes[k].x = n.x + baseX; newNodes[k].y = n.y + baseY; }
  }

  function buildStages(stages) {
    if (!Array.isArray(stages) || !stages.length) throw new ToolError('stages должен быть непустым списком');
    const keyMap = {}, nodes = {};
    stages.forEach((s, i) => {
      const id = M.uid();
      keyMap[s.id ?? String(i)] = id; if (s.title) keyMap['title:' + s.title] = id;
      const { x, y, ...rest } = s;
      nodes[id] = M.normNode(rest);
    });
    return { keyMap, nodes };
  }
  const resolve = (keyMap, items) => (k) => keyMap[k] || keyMap['title:' + k] || (items?.node[k] ? k : null) ||
    (items && Object.entries(items.node).find(([, n]) => n.title === k)?.[0]) || null;

  function autoStatus(n) {
    const { total, done } = M.countSubs(n.subs); if (!total) return;
    if (done === total) n.status = 'done'; else if (done > 0) n.status = 'active'; else if (n.status === 'done') n.status = 'active';
  }
  function fixParents(list) { for (const s of list) if (s.c?.length) { fixParents(s.c); s.d = s.c.every((x) => x.d); } }
  function findSub(list, id) { for (const s of list) { if (s.id === id) return s; const r = findSub(s.c || [], id); if (r) return r; } return null; }

  const handlers = {
    roadmap_guide: () => INSTRUCTIONS,
    list_maps: (a, req) => ({ maps: db.prepare('SELECT * FROM maps ORDER BY created').all().map((m) => ({ ...mapSummary(m), url: link(req, m.id) })) }),
    get_map: (a, req) => { const m = needMap(a.map_id); return describeMap(req, m, loadItems(m.id)); },
    create_map: (a, req, user) => {
      canWrite(user);
      const c = M.fromImport({ name: a.name, stages: a.stages, links: a.links || [] });
      const map = createMap(c.name, c, user);
      return { created: { ...map, url: link(req, map.id) }, ...describeMap(req, getMap(map.id), loadItems(map.id)) };
    },
    rename_map: (a, req, user) => {
      canWrite(user); const m = needMap(a.map_id);
      const name = String(a.name || '').trim().slice(0, 120); if (!name) throw new ToolError('Пустое название');
      db.prepare('UPDATE maps SET name = ?, updated = ? WHERE id = ?').run(name, Date.now(), m.id); broadcastAll({ type: 'maps' });
      return { map: { ...mapSummary(getMap(m.id)), url: link(req, m.id) } };
    },
    add_stages: (a, req, user) => {
      canWrite(user); const m = needMap(a.map_id); const items = loadItems(m.id);
      const { keyMap, nodes } = buildStages(a.stages);
      const r = resolve(keyMap, items);
      const links = (a.links || []).map((l) => ({ ...l, from: r(l.from), to: r(l.to) })).filter((l) => l.from && l.to && l.from !== l.to);
      placeNew(items, nodes, links);
      const ops = [...Object.entries(nodes).map(([id, data]) => ({ kind: 'node', id, data })), ...links.map((l) => ({ kind: 'edge', id: M.uid(), data: l }))];
      applyOps(m.id, ops, user);
      return { added: Object.fromEntries(Object.entries(keyMap).filter(([k]) => !k.startsWith('title:'))), links_added: links.length, url: link(req, m.id) };
    },
    update_stage: (a, req, user) => {
      canWrite(user); const m = needMap(a.map_id); const items = loadItems(m.id); const n = { ...needStage(items, a.stage_id) };
      for (const k of Object.keys(STAGE_FIELDS)) if (a[k] !== undefined) n[k] = a[k];
      if (a.subtasks !== undefined) { n.subs = M.normSubs(a.subtasks); if (a.status === undefined) autoStatus(n); }
      const [op] = applyOps(m.id, [{ kind: 'node', id: a.stage_id, data: n }], user);
      return { stage: { id: a.stage_id, ...op.data }, url: link(req, m.id) };
    },
    add_subtasks: (a, req, user) => {
      canWrite(user); const m = needMap(a.map_id); const items = loadItems(m.id); const n = structuredClone(needStage(items, a.stage_id));
      const add = M.normSubs(a.subtasks);
      if (a.parent_id) { const p = findSub(n.subs, a.parent_id); if (!p) throw new ToolError(`Подзадача ${a.parent_id} не найдена`); p.c.push(...add); }
      else n.subs.push(...add);
      fixParents(n.subs); autoStatus(n);
      applyOps(m.id, [{ kind: 'node', id: a.stage_id, data: n }], user);
      return { added: add.map((s) => ({ id: s.id, t: s.t })), progress: M.countSubs(n.subs) };
    },
    set_subtasks_done: (a, req, user) => {
      canWrite(user); const m = needMap(a.map_id); const items = loadItems(m.id); const n = structuredClone(needStage(items, a.stage_id));
      const missing = [];
      const setAll = (s, d) => { s.d = d; (s.c || []).forEach((c) => setAll(c, d)); };
      for (const id of a.subtask_ids || []) { const s = findSub(n.subs, id); if (s) setAll(s, !!a.done); else missing.push(id); }
      fixParents(n.subs); autoStatus(n);
      applyOps(m.id, [{ kind: 'node', id: a.stage_id, data: n }], user);
      return { status: n.status, progress: M.countSubs(n.subs), ...(missing.length ? { not_found: missing } : {}) };
    },
    link_stages: (a, req, user) => {
      canWrite(user); const m = needMap(a.map_id); const items = loadItems(m.id); const r = resolve({}, items);
      const from = r(a.from), to = r(a.to); if (!from || !to) throw new ToolError('Этап не найден, проверь id через get_map');
      const dup = Object.entries(items.edge).find(([, e]) => e.from === from && e.to === to);
      const id = dup ? dup[0] : M.uid();
      applyOps(m.id, [{ kind: 'edge', id, data: { from, to, style: a.style || 'solid', label: a.label || '' } }], user);
      return { link_id: id, updated: !!dup };
    },
    unlink_stages: (a, req, user) => {
      canWrite(user); const m = needMap(a.map_id); const items = loadItems(m.id); const r = resolve({}, items);
      const from = r(a.from), to = r(a.to);
      const ops = Object.entries(items.edge).filter(([, e]) => e.from === from && e.to === to).map(([id]) => ({ kind: 'edge', id, data: null }));
      applyOps(m.id, ops, user);
      return { removed: ops.length };
    },
    delete_stage: (a, req, user) => {
      canWrite(user); const m = needMap(a.map_id); const items = loadItems(m.id); needStage(items, a.stage_id);
      const ops = [{ kind: 'node', id: a.stage_id, data: null }, ...Object.entries(items.edge).filter(([, e]) => e.from === a.stage_id || e.to === a.stage_id).map(([id]) => ({ kind: 'edge', id, data: null }))];
      applyOps(m.id, ops, user);
      return { deleted: a.stage_id, links_removed: ops.length - 1 };
    },
  };

  function rpc(msg, req, user) {
    const { id, method, params = {} } = msg;
    const ok = (result) => ({ jsonrpc: '2.0', id, result });
    const fail = (code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
    if (method === 'initialize') {
      return ok({
        protocolVersion: params.protocolVersion || PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'vehi-roadmap', title: 'Вехи: дорожные карты', version: '1.1.0' },
        instructions: INSTRUCTIONS,
      });
    }
    if (method === 'ping') return ok({});
    if (method === 'tools/list') {
      return ok({ tools: TOOLS.map(({ readOnly, destructive, ...t }) => ({ ...t, annotations: { readOnlyHint: !!readOnly, destructiveHint: !!destructive } })) });
    }
    if (method === 'tools/call') {
      const h = handlers[params.name];
      if (!h) return fail(-32602, `Неизвестный инструмент ${params.name}`);
      try {
        const out = h(params.arguments || {}, req, user);
        return ok({ content: [{ type: 'text', text: typeof out === 'string' ? out : JSON.stringify(out, null, 2) }] });
      } catch (e) {
        return ok({ isError: true, content: [{ type: 'text', text: e instanceof ToolError ? e.message : 'Ошибка: ' + e.message }] });
      }
    }
    return fail(-32601, `Метод ${method} не поддерживается`);
  }

  function handle(req, res) {
    if (req.params.token) req.headers.authorization = 'Bearer ' + req.params.token;
    const user = userFromReq(req);
    if (!user) return res.status(401).json({ jsonrpc: '2.0', id: null, error: { code: -32001, message: 'Нужен токен из «Настройки → ИИ и API»' } });
    const body = req.body;
    const msgs = Array.isArray(body) ? body : [body];
    const replies = msgs.filter((m) => m && m.id !== undefined && m.method).map((m) => rpc(m, req, user));
    if (!replies.length) return res.status(202).end(); // notifications only
    res.json(Array.isArray(body) ? replies : replies[0]);
  }
  const notAllowed = (req, res) => res.status(405).set('Allow', 'POST').end();
  app.post('/mcp', handle); app.post('/mcp/:token', handle);
  app.get('/mcp', notAllowed); app.get('/mcp/:token', notAllowed);
  app.delete('/mcp', (req, res) => res.status(200).end()); app.delete('/mcp/:token', (req, res) => res.status(200).end());
}

module.exports = { mount, INSTRUCTIONS };
