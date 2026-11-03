import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

export const DATA_DIR = process.env.DATA_DIR || './data';
fs.mkdirSync(path.join(DATA_DIR, 'files'), { recursive: true });

export const db = new DatabaseSync(path.join(DATA_DIR, 'app.db'));

const NOW = `(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;
db.exec(`
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
CREATE TABLE IF NOT EXISTS patients (
  id INTEGER PRIMARY KEY,
  phone TEXT NOT NULL UNIQUE,
  name TEXT,                -- patient name, learned from medical documents or set by an agent
  policyholder TEXT,        -- from the policy copy; KYC / cheque may legitimately be in this name
  profile_name TEXT,        -- WhatsApp display name
  wa_number TEXT,           -- our WhatsApp number the patient wrote to; replies go out from it
  updated_at TEXT DEFAULT ${NOW}
);
CREATE TABLE IF NOT EXISTS files (
  id INTEGER PRIMARY KEY,
  phone TEXT NOT NULL REFERENCES patients(phone),
  sha256 TEXT NOT NULL,
  mime TEXT,
  path TEXT,
  status TEXT NOT NULL,     -- processing | done | error | duplicate | unsupported
  error TEXT,
  dup_of INTEGER,
  received_at TEXT DEFAULT ${NOW}
);
CREATE TABLE IF NOT EXISTS documents (
  id INTEGER PRIMARY KEY,
  file_id INTEGER NOT NULL REFERENCES files(id),
  phone TEXT NOT NULL,
  type TEXT,
  title TEXT,
  pages TEXT,
  patient_name TEXT,
  identifier TEXT,
  status TEXT NOT NULL,     -- ok | other | unreadable | wrong_patient | duplicate | rejected
  note TEXT,
  related_id INTEGER,
  reviewed_by TEXT,
  created_at TEXT DEFAULT ${NOW}
);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY,
  phone TEXT NOT NULL,
  direction TEXT NOT NULL,  -- in | out
  body TEXT,
  status TEXT,
  created_at TEXT DEFAULT ${NOW}
);
CREATE TABLE IF NOT EXISTS audit (
  id INTEGER PRIMARY KEY,
  user TEXT,
  action TEXT,
  phone TEXT,
  detail TEXT,
  at TEXT DEFAULT ${NOW}
);
`);

try { db.exec(`ALTER TABLE patients ADD COLUMN wa_number TEXT`); } catch {} // existing DBs

export const one = (sql, ...a) => db.prepare(sql).get(...a);
export const all = (sql, ...a) => db.prepare(sql).all(...a);
export const run = (sql, ...a) => db.prepare(sql).run(...a);
