-- Database roles for Dyce. Run ONCE, as a superuser, BEFORE the first migration.
--
--   * dyce_api  group role. The migrations grant it exactly what the application may do: read/write ordinary
--               tables, and CALL the money functions, but never write the ledger tables directly.
--   * dyce_app  the login role the API and the game server connect as (DATABASE_URL). A member of dyce_api,
--               never a superuser. This is the role that keeps money safe even if the API is compromised.
--
-- The migrations themselves run as the database OWNER (MIGRATION_DATABASE_URL), a different, more privileged
-- login that the running services never see.
--
-- docker-compose runs this file automatically with the development password below.
-- IN PRODUCTION: do not use this password. Run the same two statements with a strong generated password,
-- and put the result in DATABASE_URL (see deploy/production.env.example).

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dyce_api') THEN
    CREATE ROLE dyce_api NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'dyce_app') THEN
    CREATE ROLE dyce_app LOGIN PASSWORD 'dyce_app' IN ROLE dyce_api;
  END IF;
END
$$;
