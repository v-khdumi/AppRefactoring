CREATE TABLE IF NOT EXISTS modernization_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL,
  repository_url text NOT NULL,
  source_branch text NOT NULL DEFAULT 'main',
  target_branch text NOT NULL,
  scope text NOT NULL CHECK (scope IN ('frontend','backend','fullstack')),
  options jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'queued',
  progress integer NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  current_stage text NOT NULL DEFAULT 'queued',
  source_commit_sha text,
  generated_commit_sha text,
  pull_request_url text,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version integer NOT NULL DEFAULT 1,
  UNIQUE (tenant_id, target_branch)
);

CREATE INDEX IF NOT EXISTS ix_runs_tenant_created ON modernization_runs (tenant_id, created_at DESC);

CREATE TABLE IF NOT EXISTS transformation_changes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), run_id uuid NOT NULL REFERENCES modernization_runs(id) ON DELETE CASCADE,
  path text NOT NULL, old_path text, operation text NOT NULL CHECK (operation IN ('added','modified','deleted','renamed')),
  area text NOT NULL, additions integer NOT NULL DEFAULT 0, deletions integer NOT NULL DEFAULT 0,
  rationale text NOT NULL, before_content text, after_content text, validation jsonb NOT NULL DEFAULT '[]'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (run_id, path)
);

CREATE TABLE IF NOT EXISTS approvals (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), run_id uuid NOT NULL REFERENCES modernization_runs(id) ON DELETE CASCADE,
  commit_sha text NOT NULL, approved_by text NOT NULL, decision text NOT NULL CHECK (decision IN ('approved','rejected')),
  comment text, created_at timestamptz NOT NULL DEFAULT now(), UNIQUE (run_id, commit_sha, approved_by)
);

CREATE TABLE IF NOT EXISTS audit_events (
  sequence bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY, event_id uuid NOT NULL DEFAULT gen_random_uuid(),
  tenant_id text NOT NULL, actor_id text NOT NULL, actor_name text NOT NULL, action text NOT NULL,
  resource_type text NOT NULL, resource_id text NOT NULL, data jsonb NOT NULL DEFAULT '{}'::jsonb,
  request_id text, created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS ix_audit_tenant_sequence ON audit_events (tenant_id, sequence DESC);

REVOKE UPDATE, DELETE ON audit_events FROM PUBLIC;

CREATE TABLE IF NOT EXISTS outbox_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id text NOT NULL, event_type text NOT NULL,
  aggregate_id text NOT NULL, payload jsonb NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz, attempts integer NOT NULL DEFAULT 0, last_error text
);
CREATE INDEX IF NOT EXISTS ix_outbox_pending ON outbox_events (created_at) WHERE processed_at IS NULL;