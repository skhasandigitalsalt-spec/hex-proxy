CREATE TABLE user_credits (
  user_id TEXT PRIMARY KEY,
  day TEXT NOT NULL,
  credits_used INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
) WITHOUT ROWID;
