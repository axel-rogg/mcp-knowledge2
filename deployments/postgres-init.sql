-- Postgres bootstrap (runs once on first container start).
-- Creates app and admin roles. Schema is managed by drizzle-kit migrations.

CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE EXTENSION IF NOT EXISTS vector;

-- App-Role (no BYPASSRLS, normal access)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'knowledge_app') THEN
    CREATE ROLE knowledge_app WITH LOGIN PASSWORD 'devpassword';
  END IF;
END
$$;

-- Admin-Role (BYPASSRLS for /v1/internal/erase-user + audit reports)
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'knowledge_admin') THEN
    CREATE ROLE knowledge_admin WITH LOGIN PASSWORD 'adminpassword' BYPASSRLS;
  END IF;
END
$$;

GRANT CONNECT ON DATABASE knowledge TO knowledge_app, knowledge_admin;
GRANT USAGE ON SCHEMA public TO knowledge_app, knowledge_admin;

-- Future objects: grant defaults so migrations don't need re-granting per table
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO knowledge_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO knowledge_admin;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO knowledge_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT USAGE, SELECT ON SEQUENCES TO knowledge_admin;
