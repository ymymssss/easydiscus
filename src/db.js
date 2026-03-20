const fs = require("fs");
const path = require("path");
const initSqlJs = require("sql.js");

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function nowMs() {
  return Date.now();
}

function tryReadFile(filePath) {
  try {
    return fs.readFileSync(filePath);
  } catch (_e) {
    return null;
  }
}

function schemaSql() {
  return `
  PRAGMA foreign_keys = ON;

  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0,
    is_agent INTEGER NOT NULL DEFAULT 0
  );

  CREATE TABLE IF NOT EXISTS sessions (
    token TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    last_seen_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS sessions_user_id_idx ON sessions(user_id);
  CREATE INDEX IF NOT EXISTS sessions_expires_at_idx ON sessions(expires_at);

  CREATE TABLE IF NOT EXISTS posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    kind TEXT NOT NULL DEFAULT 'post',
    status TEXT NOT NULL DEFAULT 'open',
    assignee_user_id INTEGER,
    title TEXT NOT NULL,
    body_md TEXT NOT NULL,
    body_html TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (assignee_user_id) REFERENCES users(id) ON DELETE SET NULL
  );
  CREATE INDEX IF NOT EXISTS posts_created_at_idx ON posts(created_at);
  CREATE INDEX IF NOT EXISTS posts_deleted_at_idx ON posts(deleted_at);
  -- Indexes for columns that may be added via migrations
  -- (Some SQLite engines can error on index creation if the column doesn't exist yet)
  -- These indexes are created in applyMigrations() after columns exist.

  CREATE TABLE IF NOT EXISTS post_tags (
    post_id INTEGER NOT NULL,
    tag TEXT NOT NULL,
    FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS post_tags_post_id_idx ON post_tags(post_id);
  CREATE INDEX IF NOT EXISTS post_tags_tag_idx ON post_tags(tag);

  CREATE TABLE IF NOT EXISTS comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    body_md TEXT NOT NULL,
    body_html TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER,
    FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS comments_post_id_idx ON comments(post_id);
  CREATE INDEX IF NOT EXISTS comments_deleted_at_idx ON comments(deleted_at);

  CREATE TABLE IF NOT EXISTS likes (
    user_id INTEGER NOT NULL,
    post_id INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, post_id),
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
    FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS likes_post_id_idx ON likes(post_id);

  CREATE TABLE IF NOT EXISTS api_tokens (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    created_at INTEGER NOT NULL,
    last_used_at INTEGER,
    expires_at INTEGER,
    revoked_at INTEGER,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS api_tokens_user_id_idx ON api_tokens(user_id);
  CREATE INDEX IF NOT EXISTS api_tokens_expires_at_idx ON api_tokens(expires_at);
  CREATE INDEX IF NOT EXISTS api_tokens_revoked_at_idx ON api_tokens(revoked_at);

  CREATE TABLE IF NOT EXISTS uploads (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL,
    kind TEXT NOT NULL,
    original_name TEXT NOT NULL,
    storage_name TEXT NOT NULL UNIQUE,
    mime_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    deleted_at INTEGER,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS uploads_user_id_idx ON uploads(user_id);
  CREATE INDEX IF NOT EXISTS uploads_created_at_idx ON uploads(created_at);

  CREATE TABLE IF NOT EXISTS post_uploads (
    post_id INTEGER NOT NULL,
    upload_id INTEGER NOT NULL,
    PRIMARY KEY (post_id, upload_id),
    FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
    FOREIGN KEY (upload_id) REFERENCES uploads(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS post_uploads_upload_id_idx ON post_uploads(upload_id);

  CREATE TABLE IF NOT EXISTS post_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER NOT NULL,
    actor_user_id INTEGER,
    type TEXT NOT NULL,
    payload_json TEXT,
    created_at INTEGER NOT NULL,
    FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE,
    FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE SET NULL
  );
  CREATE INDEX IF NOT EXISTS post_events_post_id_idx ON post_events(post_id);
  CREATE INDEX IF NOT EXISTS post_events_created_at_idx ON post_events(created_at);
  CREATE INDEX IF NOT EXISTS post_events_type_idx ON post_events(type);

  CREATE TABLE IF NOT EXISTS conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL,
    title TEXT,
    dm_key TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE UNIQUE INDEX IF NOT EXISTS conversations_dm_key_uidx ON conversations(dm_key);
  CREATE INDEX IF NOT EXISTS conversations_created_at_idx ON conversations(created_at);

  CREATE TABLE IF NOT EXISTS conversation_members (
    conversation_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    joined_at INTEGER NOT NULL,
    PRIMARY KEY (conversation_id, user_id),
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS conversation_members_user_id_idx ON conversation_members(user_id);

  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL,
    user_id INTEGER NOT NULL,
    body_md TEXT NOT NULL,
    body_html TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    deleted_at INTEGER,
    FOREIGN KEY (conversation_id) REFERENCES conversations(id) ON DELETE CASCADE,
    FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
  );
  CREATE INDEX IF NOT EXISTS messages_conversation_id_idx ON messages(conversation_id);
  CREATE INDEX IF NOT EXISTS messages_created_at_idx ON messages(created_at);
  `;
}

function tableHasColumn(db, table, column) {
  const stmt = db.prepare(`PRAGMA table_info(${table})`);
  try {
    while (stmt.step()) {
      const row = stmt.getAsObject();
      if (row && row.name === column) return true;
    }
    return false;
  } finally {
    stmt.free();
  }
}

function applyMigrations(db) {
  // Add columns for older DBs created before these fields existed.
  if (!tableHasColumn(db, "users", "is_agent")) {
    db.exec("ALTER TABLE users ADD COLUMN is_agent INTEGER NOT NULL DEFAULT 0;");
  }

  if (!tableHasColumn(db, "posts", "kind")) {
    db.exec("ALTER TABLE posts ADD COLUMN kind TEXT NOT NULL DEFAULT 'post';");
  }
  if (!tableHasColumn(db, "posts", "status")) {
    db.exec("ALTER TABLE posts ADD COLUMN status TEXT NOT NULL DEFAULT 'open';");
  }
  if (!tableHasColumn(db, "posts", "assignee_user_id")) {
    db.exec("ALTER TABLE posts ADD COLUMN assignee_user_id INTEGER;");
  }

  // Indexes for migrated columns.
  try {
    db.exec("CREATE INDEX IF NOT EXISTS posts_kind_idx ON posts(kind);");
  } catch (_e) {
    // ignore
  }
  try {
    db.exec("CREATE INDEX IF NOT EXISTS posts_status_idx ON posts(status);");
  } catch (_e) {
    // ignore
  }
  try {
    db.exec(
      "CREATE INDEX IF NOT EXISTS posts_assignee_user_id_idx ON posts(assignee_user_id);",
    );
  } catch (_e) {
    // ignore
  }

  if (tableHasColumn(db, "conversations", "dm_key") === false) {
    // Only relevant if an older DB had conversations without dm_key.
    try {
      db.exec("ALTER TABLE conversations ADD COLUMN dm_key TEXT;");
      db.exec(
        "CREATE UNIQUE INDEX IF NOT EXISTS conversations_dm_key_uidx ON conversations(dm_key);",
      );
    } catch (_e) {
      // ignore
    }
  }

  // Newer tables may not exist in older DBs (sql.js stores full schema).
  // Ensure post_events exists.
  try {
    db.exec(
      "CREATE TABLE IF NOT EXISTS post_events (id INTEGER PRIMARY KEY AUTOINCREMENT, post_id INTEGER NOT NULL, actor_user_id INTEGER, type TEXT NOT NULL, payload_json TEXT, created_at INTEGER NOT NULL, FOREIGN KEY (post_id) REFERENCES posts(id) ON DELETE CASCADE, FOREIGN KEY (actor_user_id) REFERENCES users(id) ON DELETE SET NULL);",
    );
    db.exec(
      "CREATE INDEX IF NOT EXISTS post_events_post_id_idx ON post_events(post_id);",
    );
    db.exec(
      "CREATE INDEX IF NOT EXISTS post_events_created_at_idx ON post_events(created_at);",
    );
    db.exec("CREATE INDEX IF NOT EXISTS post_events_type_idx ON post_events(type);");
  } catch (_e) {
    // ignore
  }
}

async function openDb({ dbFile }) {
  ensureDir(path.dirname(dbFile));

  const SQL = await initSqlJs({
    locateFile: (file) => {
      return path.join(__dirname, "..", "node_modules", "sql.js", "dist", file);
    },
  });

  const buf = tryReadFile(dbFile);
  const db = buf ? new SQL.Database(new Uint8Array(buf)) : new SQL.Database();
  db.exec(schemaSql());
  applyMigrations(db);

  const wrapper = makeWrapper({ SQL, db, dbFile });
  await wrapper.flush();
  return wrapper;
}

function makeWrapper({ SQL, db, dbFile }) {
  let dirty = true;
  let flushing = false;

  function run(sql, params) {
    const stmt = db.prepare(sql);
    try {
      stmt.bind(params || []);
      stmt.step();
      dirty = true;
    } finally {
      stmt.free();
    }
  }

  function insert(sql, params) {
    run(sql, params);
    const row = get("SELECT last_insert_rowid() AS id", []);
    return row ? row.id : null;
  }

  function get(sql, params) {
    const stmt = db.prepare(sql);
    try {
      stmt.bind(params || []);
      if (!stmt.step()) return null;
      return stmt.getAsObject();
    } finally {
      stmt.free();
    }
  }

  function all(sql, params) {
    const stmt = db.prepare(sql);
    const out = [];
    try {
      stmt.bind(params || []);
      while (stmt.step()) out.push(stmt.getAsObject());
      return out;
    } finally {
      stmt.free();
    }
  }

  async function flush() {
    if (!dirty) return;
    if (flushing) return;
    flushing = true;
    try {
      const data = db.export();
      fs.writeFileSync(dbFile, Buffer.from(data));
      dirty = false;
    } finally {
      flushing = false;
    }
  }

  // Best-effort cleanup.
  setInterval(() => {
    try {
      const cutoff = nowMs() - 1000 * 60 * 60 * 24 * 30;
      run("DELETE FROM sessions WHERE expires_at < ?", [nowMs()]);
      run("DELETE FROM sessions WHERE last_seen_at < ?", [cutoff]);
      flush();
    } catch (_e) {
      // ignore
    }
  }, 1000 * 60 * 10).unref?.();

  return { SQL, run, insert, get, all, flush };
}

module.exports = { openDb };
