'use strict';
// SQLite storage using Node's built-in driver (no native build step).
const path = require('node:path');
const fs = require('node:fs');
process.removeAllListeners('warning');
const { DatabaseSync } = require('node:sqlite');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, '..', 'data');
fs.mkdirSync(path.join(DATA_DIR, 'uploads'), { recursive: true });

const db = new DatabaseSync(path.join(DATA_DIR, 'roadmap.db'));
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  pass TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'member',
  color TEXT NOT NULL,
  created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS api_tokens (
  id TEXT PRIMARY KEY,
  hash TEXT UNIQUE NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  created INTEGER NOT NULL,
  last_used INTEGER
);
CREATE TABLE IF NOT EXISTS invites (
  code TEXT PRIMARY KEY,
  created_by TEXT NOT NULL,
  created INTEGER NOT NULL,
  used_by TEXT
);
CREATE TABLE IF NOT EXISTS maps (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created INTEGER NOT NULL,
  updated INTEGER NOT NULL,
  created_by TEXT
);
CREATE TABLE IF NOT EXISTS items (
  map_id TEXT NOT NULL REFERENCES maps(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  id TEXT NOT NULL,
  data TEXT NOT NULL,
  updated INTEGER NOT NULL,
  updated_by TEXT,
  PRIMARY KEY (map_id, kind, id)
);
`);

module.exports = { db, DATA_DIR };
