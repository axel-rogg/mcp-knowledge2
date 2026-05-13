-- Production bootstrap. Same shape as dev, but uses env-substituted passwords.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;

DO $$
DECLARE
  app_pw   TEXT := current_setting('KNOWLEDGE_APP_PASSWORD', true);
  admin_pw TEXT := current_setting('KNOWLEDGE_ADMIN_PASSWORD', true);
BEGIN
  IF app_pw IS NULL OR app_pw = '' THEN
    RAISE EXCEPTION 'KNOWLEDGE_APP_PASSWORD env not set';
  END IF;
  IF admin_pw IS NULL OR admin_pw = '' THEN
    RAISE EXCEPTION 'KNOWLEDGE_ADMIN_PASSWORD env not set';
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'knowledge_app') THEN
    EXECUTE format('CREATE ROLE knowledge_app WITH LOGIN PASSWORD %L', app_pw);
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'knowledge_admin') THEN
    EXECUTE format('CREATE ROLE knowledge_admin WITH LOGIN PASSWORD %L BYPASSRLS', admin_pw);
  END IF;
END
$$;

GRANT CONNECT ON DATABASE knowledge TO knowledge_app, knowledge_admin;
GRANT USAGE ON SCHEMA public TO knowledge_app, knowledge_admin;

ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO knowledge_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO knowledge_admin;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO knowledge_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO knowledge_admin;
