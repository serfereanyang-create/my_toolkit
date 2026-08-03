const fs = require('node:fs');
const path = require('node:path');
const Database = require('better-sqlite3');

let db;

function getDbPath(userDataPath) {
  return path.join(userDataPath, 'paper-assistant.sqlite');
}

function migrate(database) {
  database.exec(`
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL UNIQUE,
      email TEXT UNIQUE,
      password_hash TEXT NOT NULL,
      password_salt TEXT NOT NULL,
      display_name TEXT NOT NULL DEFAULT '',
      institution TEXT NOT NULL DEFAULT '',
      research_field TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      token_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS papers (
      id TEXT NOT NULL,
      user_id TEXT NOT NULL,
      payload TEXT NOT NULL,
      title TEXT NOT NULL DEFAULT '',
      year TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL,
      PRIMARY KEY (user_id, id),
      FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_papers_user ON papers(user_id);
    CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);
  `);
}

function openDb(userDataPath) {
  fs.mkdirSync(userDataPath, { recursive: true });
  const file = getDbPath(userDataPath);
  db = new Database(file);
  db.pragma('journal_mode = WAL');
  migrate(db);
  return db;
}

function getDb() {
  if (!db) throw new Error('Database not initialized');
  return db;
}

function closeDb() {
  if (db) {
    db.close();
    db = null;
  }
}

module.exports = { openDb, getDb, closeDb, getDbPath, migrate };
