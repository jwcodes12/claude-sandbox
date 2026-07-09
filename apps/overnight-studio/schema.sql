-- Overnight Studio scoreboard + votes (v0)
-- One sqlite DB at /home/studio/data/studio.sqlite holds both the agent-org
-- scoreboard (runs, bandit stats, critic scores) and John's ground-truth votes.
PRAGMA journal_mode = WAL;

-- One row per nightly build attempt (shipped or failed).
CREATE TABLE IF NOT EXISTS runs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  slug          TEXT UNIQUE NOT NULL,       -- e.g. 2026-07-08-marble-maze
  night         TEXT NOT NULL,              -- ISO date of the run (ET)
  level         INTEGER NOT NULL,
  kind          TEXT,                       -- site | game | art-toy
  title         TEXT,
  brief         TEXT,                       -- the build brief handed to the builder
  builder_model TEXT,                       -- model that produced the build
  status        TEXT NOT NULL DEFAULT 'building', -- building|shipped|failed
  fail_reason   TEXT,
  budget_frac   REAL,                       -- fraction of energy budget consumed (0..1+)
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  shipped_at    TEXT
);

-- Dense nightly critic signal. One row per critic verdict on a run.
-- Scores are comparative (rank vs a named peer set), never absolute truth.
CREATE TABLE IF NOT EXISTS critic_scores (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id        INTEGER NOT NULL REFERENCES runs(id),
  role          TEXT NOT NULL,              -- code | vision | playtest
  critic_model  TEXT NOT NULL,
  score         REAL,                       -- normalized 0..1 (comparative)
  rank_note     TEXT,                       -- "better than <slug>, worse than <slug>"
  verdict       TEXT,                       -- freeform critic prose
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- John's sparse ground truth (👍/👎) + soft signals (no-visit).
CREATE TABLE IF NOT EXISTS votes (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  slug          TEXT NOT NULL,
  vote          INTEGER NOT NULL,           -- +1 up, -1 down
  source        TEXT NOT NULL DEFAULT 'john', -- john | soft-novisit
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_votes_slug ON votes(slug);

-- Bandit scoreboard: which model suits which role/output-type, learned empirically.
-- reward_sum/trials = mean reward; failures counts quota/auth/parse outcomes.
CREATE TABLE IF NOT EXISTS model_stats (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  role          TEXT NOT NULL,              -- builder | code-critic | vision-critic | ...
  model         TEXT NOT NULL,              -- claude | gemini | codex
  output_type   TEXT NOT NULL DEFAULT 'any',-- site | game | art-toy | any
  trials        INTEGER NOT NULL DEFAULT 0,
  reward_sum    REAL NOT NULL DEFAULT 0,
  failures      INTEGER NOT NULL DEFAULT 0,
  last_used     TEXT,
  UNIQUE(role, model, output_type)
);

-- Generic append-only event log (quota/auth failures, retro decisions, etc.).
CREATE TABLE IF NOT EXISTS events (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  run_id        INTEGER REFERENCES runs(id),
  kind          TEXT NOT NULL,             -- quota|auth|error|retro|info
  detail        TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
