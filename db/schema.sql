-- Morz local store (better-sqlite3). v0.1 stub schema.
-- Backs the spaces sidebar, sessions, agents, task board, and checkpoints.
-- Migrations land in db/migrations/ once Phase 1 wiring starts.

CREATE TABLE IF NOT EXISTS spaces (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  cwd         TEXT NOT NULL,
  branch      TEXT,
  created_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS sessions (
  id          TEXT PRIMARY KEY,
  space_id    TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  title       TEXT,
  cli         TEXT,                 -- claude | codex | agy | opencode | pi | shell
  scrollback  TEXT,                 -- serialized xterm buffer (session restore)
  updated_at  INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS agents (
  id          TEXT PRIMARY KEY,
  space_id    TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  name        TEXT NOT NULL,
  cli         TEXT NOT NULL,
  model       TEXT,
  state       TEXT NOT NULL DEFAULT 'idle',
  worktree    TEXT
);

-- Shared task board (atomic claim so parallel agents don't collide).
CREATE TABLE IF NOT EXISTS tasks (
  id          TEXT PRIMARY KEY,
  space_id    TEXT NOT NULL REFERENCES spaces(id) ON DELETE CASCADE,
  title       TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'pending',   -- pending | claimed | done | failed
  claimed_by  TEXT,
  depends_on  TEXT,                 -- csv of task ids (DAG edges)
  dod         TEXT                  -- definition-of-done checks (json)
);

-- Per-agent checkpoints (shadow-git commit <-> bus event mapping).
CREATE TABLE IF NOT EXISTS checkpoints (
  id          TEXT PRIMARY KEY,
  agent_id    TEXT NOT NULL,
  commit_hash TEXT NOT NULL,
  event_id    TEXT,
  ts          INTEGER NOT NULL
);
