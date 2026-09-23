CREATE TABLE IF NOT EXISTS worker_heartbeats (
  worker_name text PRIMARY KEY,
  instance_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('starting','healthy','stopping','degraded')),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS rate_limit_windows (
  tenant_id text NOT NULL,
  endpoint text NOT NULL,
  window_start timestamptz NOT NULL,
  request_count integer NOT NULL DEFAULT 0 CHECK (request_count >= 0),
  PRIMARY KEY (tenant_id, endpoint, window_start)
);
CREATE INDEX IF NOT EXISTS ix_rate_limit_windows_cleanup ON rate_limit_windows(window_start);

ALTER TABLE modernization_runs ADD COLUMN IF NOT EXISTS last_heartbeat_at timestamptz;
ALTER TABLE modernization_runs ADD COLUMN IF NOT EXISTS error_code text;
ALTER TABLE modernization_runs ADD COLUMN IF NOT EXISTS error_detail text;
ALTER TABLE modernization_runs ADD COLUMN IF NOT EXISTS started_at timestamptz;
ALTER TABLE modernization_runs ADD COLUMN IF NOT EXISTS completed_at timestamptz;
ALTER TABLE modernization_runs ADD COLUMN IF NOT EXISTS cancelled_at timestamptz;
ALTER TABLE modernization_runs ADD COLUMN IF NOT EXISTS cancel_reason text;

ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS last_progress_at timestamptz NOT NULL DEFAULT now();
ALTER TABLE outbox_events ADD COLUMN IF NOT EXISTS next_attempt_at timestamptz NOT NULL DEFAULT now();

CREATE INDEX IF NOT EXISTS ix_runs_recovery ON modernization_runs(status, updated_at)
  WHERE status IN ('queued','retrying','running');
CREATE INDEX IF NOT EXISTS ix_outbox_ready ON outbox_events(next_attempt_at, created_at)
  WHERE processed_at IS NULL;
