'use strict';
const http = require('node:http');
const path = require('node:path');
const fs = require('node:fs');
const crypto = require('node:crypto');
const express = require('express');
const { WebSocketServer } = require('ws');
const { db, DATA_DIR } = require('./db');
const M = require('./model');

const PORT = +process.env.PORT || 3000;
const SECURE_COOKIE = process.env.COOKIE_SECURE === '1';
const now = () => Date.now();
const COLORS = ['#b8a4ff', '#5fd6a0', '#f4bf5a', '#ff8a9a', '#6ccaff', '#e79bff', '#9fe36b', '#ffa36c'];

// ---------- auth helpers ----------
function hashPass(p) {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(p, salt, 64);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}
function checkPass(p, stored) {
  const [, salt, key] = stored.split('$');
  const k = crypto.scryptSync(p, Buffer.from(salt, 'hex'), 64);
  return crypto.timingSafeEqual(k, Buffer.from(key, 'hex'));
}
const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const publicUser = (u) => u && { id: u.id, email: u.email, name: u.name, role: u.role, color: u.color };

function parseCookies(h = '') {
  return Object.fromEntries(h.split(';').map((p) => p.trim().split('=')).filter((p) => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
}
function userFromReq(req) {
  const auth = req.headers.authorization || '';
  if (auth.startsWith('Bearer ')) {
    const t = db.prepare('SELECT * FROM api_tokens WHERE hash = ?').get(sha(auth.slice(7).trim()));
    if (!t) return null;
    db.prepare('UPDATE api_tokens SET last_used = ? WHERE id = ?').run(now(), t.id);
    return db.prepare('SELECT * FROM users WHERE id = ?').get(t.user_id);
  }
  const tok = parseCookies(req.headers.cookie).rm_session;
  if (!tok) return null;
  const s = db.prepare('SELECT * FROM sessions WHERE token = ?').get(sha(tok));
  return s ? db.prepare('SELECT * FROM users WHERE id = ?').get(s.user_id) : null;
}
function startSession(res, user) {
  const tok = crypto.randomBytes(32).toString('base64url');
  db.prepare('INSERT INTO sessions (token, user_id, created) VALUES (?, ?, ?)').run(sha(tok), user.id, now());
  res.setHeader('Set-Cookie', `rm_session=${tok}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${60 * 60 * 24 * 90}${SECURE_COOKIE ? '; Secure' : ''}`);
}

// Tiny in-memory limiter for login attempts.
const attempts = new Map();
function limited(key) {
  const t = now(), a = (attempts.get(key) || []).filter((x) => t - x < 10 * 60e3);
  a.push(t); attempts.set(key, a);
  return a.length > 20;
}

// ---------- app ----------
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', process.env.TRUST_PROXY === '0' ? false : 1);
app.use(express.json({ limit: '5mb' }));

const need = (req, res, next) => {
  const u = userFromReq(req);
  if (!u) return res.status(401).json({ error: 'Нужно войти' });
  req.user = u; next();
};
const admin = (req, res, next) => (req.user.role === 'admin' ? next() : res.status(403).json({ error: 'Только для администратора' }));
const bad = (res, msg, code = 400) => res.status(code).json({ error: msg });

app.get('/api/setup', (req, res) => {
  res.json({ needsAdmin: db.prepare('SELECT COUNT(*) c FROM users').get().c === 0 });
});

app.post('/api/auth/register', (req, res) => {
  const { email, name, password, invite } = req.body || {};
  const em = String(email || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(em)) return bad(res, 'Проверьте email');
  if (String(password || '').length < 8) return bad(res, 'Пароль должен быть не короче 8 символов');
  if (!String(name || '').trim()) return bad(res, 'Укажите имя');
  const first = db.prepare('SELECT COUNT(*) c FROM users').get().c === 0;
  let inv = null;
  if (!first) {
    inv = db.prepare('SELECT * FROM invites WHERE code = ? AND used_by IS NULL').get(String(invite || '').trim());
    if (!inv) return bad(res, 'Приглашение не найдено или уже использовано');
  }
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(em)) return bad(res, 'Такой email уже зарегистрирован');
  const count = db.prepare('SELECT COUNT(*) c FROM users').get().c;
  const user = { id: M.uid(), email: em, name: String(name).trim().slice(0, 60), pass: hashPass(password), role: first ? 'admin' : 'member', color: COLORS[count % COLORS.length], created: now() };
  db.prepare('INSERT INTO users (id,email,name,pass,role,color,created) VALUES (?,?,?,?,?,?,?)').run(user.id, user.email, user.name, user.pass, user.role, user.color, user.created);
  if (inv) db.prepare('UPDATE invites SET used_by = ? WHERE code = ?').run(user.id, inv.code);
  startSession(res, user);
  res.json({ user: publicUser(user) });
});

app.post('/api/auth/login', (req, res) => {
  const em = String(req.body?.email || '').trim().toLowerCase();
  if (limited(req.ip + em)) return bad(res, 'Слишком много попыток, подождите 10 минут', 429);
  const u = db.prepare('SELECT * FROM users WHERE email = ?').get(em);
  if (!u || !checkPass(String(req.body?.password || ''), u.pass)) return bad(res, 'Неверный email или пароль', 401);
  startSession(res, u);
  res.json({ user: publicUser(u) });
});

app.post('/api/auth/logout', (req, res) => {
  const tok = parseCookies(req.headers.cookie).rm_session;
  if (tok) db.prepare('DELETE FROM sessions WHERE token = ?').run(sha(tok));
  res.setHeader('Set-Cookie', 'rm_session=; Path=/; Max-Age=0');
  res.json({ ok: true });
});

app.get('/api/me', need, (req, res) => res.json({ user: publicUser(req.user) }));

app.post('/api/me/password', need, (req, res) => {
  const { current, next } = req.body || {};
  if (!checkPass(String(current || ''), req.user.pass)) return bad(res, 'Текущий пароль неверный');
  if (String(next || '').length < 8) return bad(res, 'Новый пароль должен быть не короче 8 символов');
  db.prepare('UPDATE users SET pass = ? WHERE id = ?').run(hashPass(next), req.user.id);
  res.json({ ok: true });
});

// Team & invites
app.get('/api/team', need, (req, res) => {
  const users = db.prepare('SELECT id,email,name,role,color FROM users ORDER BY created').all();
  const invites = req.user.role === 'admin' ? db.prepare('SELECT code, created FROM invites WHERE used_by IS NULL ORDER BY created DESC').all() : [];
  res.json({ users, invites });
});
app.post('/api/invites', need, admin, (req, res) => {
  const code = crypto.randomBytes(6).toString('base64url');
  db.prepare('INSERT INTO invites (code, created_by, created) VALUES (?,?,?)').run(code, req.user.id, now());
  res.json({ code });
});
app.delete('/api/invites/:code', need, admin, (req, res) => {
  db.prepare('DELETE FROM invites WHERE code = ? AND used_by IS NULL').run(req.params.code);
  res.json({ ok: true });
});
app.patch('/api/team/:id', need, admin, (req, res) => {
  const role = req.body?.role;
  if (!['admin', 'member', 'viewer'].includes(role)) return bad(res, 'Неизвестная роль');
  if (req.params.id === req.user.id) return bad(res, 'Свою роль поменять нельзя');
  db.prepare('UPDATE users SET role = ? WHERE id = ?').run(role, req.params.id);
  res.json({ ok: true });
});
app.delete('/api/team/:id', need, admin, (req, res) => {
  if (req.params.id === req.user.id) return bad(res, 'Себя удалить нельзя');
  db.prepare('DELETE FROM users WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// API tokens for the CLI
app.get('/api/tokens', need, (req, res) => {
  res.json({ tokens: db.prepare('SELECT id,name,created,last_used FROM api_tokens WHERE user_id = ? ORDER BY created DESC').all(req.user.id) });
});
app.post('/api/tokens', need, (req, res) => {
  const token = 'rm_' + crypto.randomBytes(24).toString('base64url');
  const id = M.uid();
  db.prepare('INSERT INTO api_tokens (id,hash,user_id,name,created) VALUES (?,?,?,?,?)').run(id, sha(token), req.user.id, String(req.body?.name || 'CLI').slice(0, 60), now());
  res.json({ id, token });
});
app.delete('/api/tokens/:id', need, (req, res) => {
  db.prepare('DELETE FROM api_tokens WHERE id = ? AND user_id = ?').run(req.params.id, req.user.id);
  res.json({ ok: true });
});

// ---------- maps ----------
const canWrite = (req, res, next) => (req.user.role === 'viewer' ? bad(res, 'У вас доступ только на просмотр', 403) : next());

function mapSummary(m) {
  const rows = db.prepare("SELECT data FROM items WHERE map_id = ? AND kind = 'node'").all(m.id);
  const done = rows.filter((r) => JSON.parse(r.data).status === 'done').length;
  return { id: m.id, name: m.name, created: m.created, updated: m.updated, total: rows.length, done };
}
function loadItems(mapId) {
  const out = { node: {}, edge: {}, shape: {} };
  for (const r of db.prepare('SELECT kind,id,data FROM items WHERE map_id = ?').all(mapId)) out[r.kind][r.id] = JSON.parse(r.data);
  return out;
}
const getMap = (id) => db.prepare('SELECT * FROM maps WHERE id = ?').get(id);
const touch = (id) => db.prepare('UPDATE maps SET updated = ? WHERE id = ?').run(now(), id);

app.get('/api/maps', need, (req, res) => {
  res.json({ maps: db.prepare('SELECT * FROM maps ORDER BY created').all().map(mapSummary) });
});

function createMap(name, content, user) {
  const id = M.uid();
  const t = now();
  db.exec('BEGIN');
  try {
    db.prepare('INSERT INTO maps (id,name,created,updated,created_by) VALUES (?,?,?,?,?)').run(id, name, t, t, user.id);
    const ins = db.prepare('INSERT INTO items (map_id,kind,id,data,updated,updated_by) VALUES (?,?,?,?,?,?)');
    for (const [k, coll] of [['node', content.nodes], ['edge', content.edges], ['shape', content.shapes]]) {
      for (const [iid, d] of Object.entries(coll || {})) ins.run(id, k, iid, JSON.stringify(d), t, user.id);
    }
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
  broadcastAll({ type: 'maps' });
  return mapSummary(getMap(id));
}

app.post('/api/maps', need, canWrite, (req, res) => {
  const name = String(req.body?.name || '').trim().slice(0, 120) || 'Новая карта';
  res.json({ map: createMap(name, {}, req.user) });
});

app.post('/api/maps/import', need, canWrite, (req, res) => {
  try {
    const c = M.fromImport(req.body);
    res.json({ map: createMap(c.name, c, req.user) });
  } catch (e) { bad(res, e.message); }
});

app.get('/api/maps/:id', need, (req, res) => {
  const m = getMap(req.params.id);
  if (!m) return bad(res, 'Карта не найдена', 404);
  res.json({ map: mapSummary(m), items: loadItems(m.id) });
});

app.patch('/api/maps/:id', need, canWrite, (req, res) => {
  const m = getMap(req.params.id);
  if (!m) return bad(res, 'Карта не найдена', 404);
  const name = String(req.body?.name || '').trim().slice(0, 120);
  if (name) db.prepare('UPDATE maps SET name = ?, updated = ? WHERE id = ?').run(name, now(), m.id);
  broadcastAll({ type: 'maps' });
  res.json({ map: mapSummary(getMap(m.id)) });
});

app.delete('/api/maps/:id', need, canWrite, (req, res) => {
  db.prepare('DELETE FROM maps WHERE id = ?').run(req.params.id);
  broadcastAll({ type: 'maps' });
  res.json({ ok: true });
});

app.get('/api/maps/:id/export', need, (req, res) => {
  const m = getMap(req.params.id);
  if (!m) return bad(res, 'Карта не найдена', 404);
  const items = loadItems(m.id);
  if (req.query.format === 'md') return res.type('text/markdown; charset=utf-8').send(M.toMarkdown(m, items));
  res.json(M.toExport(m, items));
});

const NORM = { node: M.normNode, edge: M.normEdge, shape: M.normShape };

// Batch write: [{kind, id, data|null}], used for single edits, undo groups and pastes.
app.post('/api/maps/:id/ops', need, canWrite, (req, res) => {
  const m = getMap(req.params.id);
  if (!m) return bad(res, 'Карта не найдена', 404);
  const ops = Array.isArray(req.body?.ops) ? req.body.ops.slice(0, 2000) : [];
  const t = now();
  const applied = [];
  db.exec('BEGIN');
  try {
    for (const op of ops) {
      if (!NORM[op.kind] || !/^[\w-]{1,40}$/.test(op.id || '')) continue;
      if (op.data == null) {
        db.prepare('DELETE FROM items WHERE map_id = ? AND kind = ? AND id = ?').run(m.id, op.kind, op.id);
        applied.push({ kind: op.kind, id: op.id, data: null });
      } else {
        const d = NORM[op.kind](op.data);
        if (!d) continue;
        db.prepare(`INSERT INTO items (map_id,kind,id,data,updated,updated_by) VALUES (?,?,?,?,?,?)
          ON CONFLICT(map_id,kind,id) DO UPDATE SET data=excluded.data, updated=excluded.updated, updated_by=excluded.updated_by`)
          .run(m.id, op.kind, op.id, JSON.stringify(d), t, req.user.id);
        applied.push({ kind: op.kind, id: op.id, data: d });
      }
    }
    touch(m.id);
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); return bad(res, 'Не удалось сохранить: ' + e.message, 500); }
  broadcastMap(m.id, { type: 'ops', ops: applied, by: req.user.id, client: req.body?.client || null });
  if (applied.some((o) => o.kind === 'node')) broadcastAll({ type: 'maps' });
  res.json({ ops: applied });
});

// Image uploads for the canvas
app.post('/api/uploads', need, canWrite, express.raw({ type: ['image/png', 'image/jpeg', 'image/gif', 'image/webp'], limit: '10mb' }), (req, res) => {
  const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' }[req.headers['content-type']];
  if (!ext || !Buffer.isBuffer(req.body) || !req.body.length) return bad(res, 'Поддерживаются PNG, JPEG, GIF и WebP до 10 МБ');
  const file = `${M.uid(16)}.${ext}`;
  fs.writeFileSync(path.join(DATA_DIR, 'uploads', file), req.body);
  res.json({ src: `/uploads/${file}` });
});
app.use('/uploads', (req, res, next) => (userFromReq(req) ? next() : res.status(401).end()), express.static(path.join(DATA_DIR, 'uploads'), { maxAge: '30d', immutable: true }));

app.use('/api', (req, res) => bad(res, 'Неизвестный адрес API', 404));
app.use(express.static(path.join(__dirname, '..', 'public'), { extensions: ['html'] }));
app.get('/{*any}', (req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'index.html')));

// ---------- realtime ----------
const server = http.createServer(app);
const wss = new WebSocketServer({ server, path: '/ws' });
const clients = new Set();

function broadcastMap(mapId, msg) {
  const s = JSON.stringify(msg);
  for (const c of clients) if (c.mapId === mapId && c.ws.readyState === 1) c.ws.send(s);
}
function broadcastAll(msg) {
  const s = JSON.stringify(msg);
  for (const c of clients) if (c.ws.readyState === 1) c.ws.send(s);
}
function sendPresence(mapId) {
  const peers = [...clients].filter((c) => c.mapId === mapId).map((c) => ({ client: c.id, id: c.user.id, name: c.user.name, color: c.user.color }));
  broadcastMap(mapId, { type: 'presence', peers });
}

wss.on('connection', (ws, req) => {
  const user = userFromReq(req);
  if (!user) return ws.close(4001, 'unauthorized');
  const c = { ws, user, mapId: null, id: M.uid(8) };
  clients.add(c);
  ws.send(JSON.stringify({ type: 'hello', client: c.id }));
  ws.on('message', (raw) => {
    let m; try { m = JSON.parse(raw); } catch { return; }
    if (m.type === 'join') {
      const prev = c.mapId; c.mapId = typeof m.map === 'string' ? m.map : null;
      if (prev) sendPresence(prev);
      if (c.mapId) sendPresence(c.mapId);
    } else if (m.type === 'cursor' && c.mapId) {
      const s = JSON.stringify({ type: 'cursor', client: c.id, name: user.name, color: user.color, x: +m.x || 0, y: +m.y || 0 });
      for (const o of clients) if (o !== c && o.mapId === c.mapId && o.ws.readyState === 1) o.ws.send(s);
    }
  });
  ws.on('close', () => { clients.delete(c); if (c.mapId) sendPresence(c.mapId); });
});
setInterval(() => { for (const c of clients) if (c.ws.readyState === 1) c.ws.ping(); }, 30e3).unref();

server.listen(PORT, () => console.log(`Roadmap is running on http://localhost:${PORT}`));
