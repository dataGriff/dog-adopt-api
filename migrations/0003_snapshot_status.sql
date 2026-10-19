-- Snapshots now claim their Idempotency-Key before any dog is written, so a
-- row can exist before it has a result. `status` says where it got to and
-- `result` is null until it is done. SQLite cannot drop NOT NULL in place,
-- so the table is rebuilt.

CREATE TABLE snapshots_new (
  id TEXT PRIMARY KEY,
  rescue_id TEXT NOT NULL REFERENCES rescues (id),
  idempotency_key TEXT NOT NULL UNIQUE,
  body_hash TEXT NOT NULL,
  captured_at TEXT NOT NULL,
  processed_at TEXT NOT NULL,
  adapter TEXT NOT NULL,
  mode TEXT NOT NULL,
  complete INTEGER NOT NULL CHECK (complete IN (0, 1)),
  status TEXT NOT NULL DEFAULT 'done' CHECK (status IN ('pending', 'done', 'failed')),
  result TEXT,
  CHECK ((status = 'done') = (result IS NOT NULL))
);
INSERT INTO snapshots_new (id, rescue_id, idempotency_key, body_hash, captured_at, processed_at, adapter, mode, complete, status, result)
  SELECT id, rescue_id, idempotency_key, body_hash, captured_at, processed_at, adapter, mode, complete, 'done', result FROM snapshots;
DROP TABLE snapshots;
ALTER TABLE snapshots_new RENAME TO snapshots;
CREATE INDEX idx_snapshots_rescue ON snapshots (rescue_id, processed_at DESC);
