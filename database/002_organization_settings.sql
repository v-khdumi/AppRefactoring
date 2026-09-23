CREATE TABLE IF NOT EXISTS organization_settings (
  tenant_id text PRIMARY KEY,
  policies jsonb NOT NULL DEFAULT '{}'::jsonb,
  notifications jsonb NOT NULL DEFAULT '{}'::jsonb,
  updated_by text NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now()
);