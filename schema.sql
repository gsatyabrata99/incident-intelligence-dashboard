CREATE TABLE IF NOT EXISTS feedback (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,
  product_area TEXT,
  severity TEXT,
  sentiment TEXT,
  status TEXT NOT NULL DEFAULT 'new',
  escalated_to TEXT,
  resolved_at TEXT,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS triage (
  feedback_id TEXT PRIMARY KEY,
  ai_reason TEXT,
  draft_reply TEXT,
  updated_at TEXT NOT NULL
);

