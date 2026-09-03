#!/bin/sh
# This file must remain LF-only so it can run inside the Linux container.
set -eu

export PGPASSWORD="${POSTGRES_PASSWORD:?POSTGRES_PASSWORD is required}"
APP_DATABASE_USER="${APP_DATABASE_USER:-platform}"
APP_DATABASE_NAME="${APP_DATABASE_NAME:-gateway}"

psql --host postgres --username "$POSTGRES_USER" --dbname postgres --set ON_ERROR_STOP=1 \
  --set app_user="$APP_DATABASE_USER" --set app_password="$POSTGRES_PASSWORD" <<'SQL'
SELECT format('CREATE ROLE %I WITH LOGIN SUPERUSER PASSWORD %L', :'app_user', :'app_password')
WHERE NOT EXISTS (SELECT FROM pg_roles WHERE rolname = :'app_user')\gexec

SELECT format('ALTER ROLE %I WITH LOGIN SUPERUSER PASSWORD %L', :'app_user', :'app_password')\gexec
SQL

database_exists() {
  psql --host postgres --username "$POSTGRES_USER" --dbname postgres --tuples-only --no-align \
    --command 'SELECT datname FROM pg_database;' | grep -Fxq "$1"
}

create_database() {
  database_name="$1"
  if ! database_exists "$database_name"; then
    createdb --host postgres --username "$POSTGRES_USER" --owner "$APP_DATABASE_USER" "$database_name"
  fi
}

create_database "$APP_DATABASE_NAME"
create_database chatwoot
create_database n8n

psql --host postgres --username "$POSTGRES_USER" --dbname "$APP_DATABASE_NAME" --set ON_ERROR_STOP=1 \
  --command 'CREATE EXTENSION IF NOT EXISTS vector;'
