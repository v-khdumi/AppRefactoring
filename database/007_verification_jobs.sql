CREATE TABLE IF NOT EXISTS verification_jobs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  run_id uuid NOT NULL REFERENCES modernization_runs(id) ON DELETE CASCADE,
  tenant_id text NOT NULL,
  source_sha text NOT NULL,
  changeset_digest text NOT NULL,
  status text NOT NULL DEFAULT 'preparing',
  token_hash text NOT NULL,
  snapshot jsonb,
  report jsonb,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL DEFAULT now()+interval '45 minutes'
);
CREATE INDEX IF NOT EXISTS ix_verification_run_created ON verification_jobs(run_id,created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS ix_verification_active ON verification_jobs(run_id) WHERE status IN ('preparing','running');