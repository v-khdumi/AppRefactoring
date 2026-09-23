ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS output_text text NOT NULL DEFAULT '';
ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS output_updated_at timestamptz;
ALTER TABLE agent_tasks ADD COLUMN IF NOT EXISTS input_paths jsonb NOT NULL DEFAULT '[]'::jsonb;