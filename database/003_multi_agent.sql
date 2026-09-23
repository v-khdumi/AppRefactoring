CREATE TABLE IF NOT EXISTS agent_tasks (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), run_id uuid NOT NULL REFERENCES modernization_runs(id) ON DELETE CASCADE,
  agent_type text NOT NULL CHECK (agent_type IN ('architect','frontend','backend','cloud','testing','security')),
  status text NOT NULL DEFAULT 'queued', progress integer NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
  objective text NOT NULL, summary text, files_owned jsonb NOT NULL DEFAULT '[]'::jsonb,
  started_at timestamptz, completed_at timestamptz, error text,
  UNIQUE(run_id, agent_type)
);
CREATE INDEX IF NOT EXISTS ix_agent_tasks_run ON agent_tasks(run_id);

CREATE TABLE IF NOT EXISTS agent_messages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), run_id uuid NOT NULL REFERENCES modernization_runs(id) ON DELETE CASCADE,
  agent_type text NOT NULL, role text NOT NULL CHECK (role IN ('user','agent','system')),
  actor_id text NOT NULL, content text NOT NULL CHECK (length(content) <= 12000),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_agent_messages_run_created ON agent_messages(run_id, created_at);

CREATE TABLE IF NOT EXISTS user_code_edits (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), run_id uuid NOT NULL REFERENCES modernization_runs(id) ON DELETE CASCADE,
  path text NOT NULL, content text NOT NULL, edited_by text NOT NULL, base_version integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(), UNIQUE(run_id, path, base_version)
);

CREATE TABLE IF NOT EXISTS architecture_revisions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(), run_id uuid NOT NULL REFERENCES modernization_runs(id) ON DELETE CASCADE,
  nodes jsonb NOT NULL, connections jsonb NOT NULL DEFAULT '[]'::jsonb, rationale text,
  created_by text NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS ix_architecture_run_created ON architecture_revisions(run_id, created_at DESC);

ALTER TABLE transformation_changes ADD COLUMN IF NOT EXISTS agent_type text;
ALTER TABLE transformation_changes ADD COLUMN IF NOT EXISTS user_modified boolean NOT NULL DEFAULT false;