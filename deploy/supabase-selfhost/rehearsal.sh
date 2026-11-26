#!/usr/bin/env bash
# Rehearsal of the self-hosted Supabase on one machine (a computer with Docker, or the new server).
#   bash rehearsal.sh all <dump>   create .env, build functions, start, restore the production structure from <dump>, run the checks, print the memory use
#   bash rehearsal.sh up|restore <dump>|mark|migrate|smoke|stats|down|reset
# <dump> = a schema-only dump of production:  npx supabase db dump --linked --schema public -f prod-schema-public.sql
# "down" stops everything and keeps the data; "reset" stops and DELETES the data of this rehearsal stack (only this one).
set -euo pipefail
cd "$(dirname "$0")"
REPO_ROOT="$(cd ../.. && pwd)"
COMPOSE=(docker compose --env-file .env -f docker-compose.yml)
DB=staysee-selfhost-db

env_value() { grep -E "^$1=" .env | head -n 1 | cut -d= -f2-; }

psql_in_db() { docker exec -i "$DB" psql -U postgres -v ON_ERROR_STOP=1 -q "$@"; }

cmd_up() {
  node make-env.mjs
  node prepare-functions.mjs
  "${COMPOSE[@]}" up -d --wait
  echo "stack is up"
}

cmd_migrate() {
  psql_in_db -c "create schema if not exists supabase_migrations; create table if not exists supabase_migrations.schema_migrations (version text primary key, statements text[], name text);" >/dev/null
  applied=0
  skipped=0
  for file in "$REPO_ROOT"/supabase/migrations/*.sql; do
    base="$(basename "$file" .sql)"
    version="${base%%_*}"
    name="${base#*_}"
    already="$(docker exec "$DB" psql -U postgres -tAc "select 1 from supabase_migrations.schema_migrations where version = '$version'")"
    if [ "$already" = "1" ]; then skipped=$((skipped + 1)); continue; fi
    if ! psql_in_db -1 < "$file" >/dev/null; then
      echo "MIGRATION FAILED: $base" >&2
      exit 1
    fi
    docker exec "$DB" psql -U postgres -v ON_ERROR_STOP=1 -q -c "insert into supabase_migrations.schema_migrations (version, name) values ('$version', '$name')" >/dev/null
    applied=$((applied + 1))
  done
  # PostgREST reads the schema once at start: tell it the schema has changed.
  docker exec "$DB" psql -U postgres -q -c "notify pgrst, 'reload schema'" >/dev/null
  echo "migrations applied: $applied, already there: $skipped"
}

# The real move path: the production structure (a schema-only dump) + what the dump does not carry (after-restore.sql).
# The repo migrations alone do NOT rebuild production (it has drifted: for example messages.role and messages.user_id exist only there).
cmd_restore() {
  dump="${1:?usage: bash rehearsal.sh restore <path to the schema-only dump of production>}"
  docker exec "$DB" psql -U postgres -v ON_ERROR_STOP=1 -q -c "create extension if not exists vector with schema public; create extension if not exists pg_cron;" >/dev/null
  log="$(dirname "$dump")/restore.log"
  docker exec -i "$DB" psql -U postgres -q -v ON_ERROR_STOP=0 < "$dump" > "$log" 2>&1 || true
  errors="$(grep -c "ERROR" "$log" || true)"
  echo "structure restored, errors in the restore log: $errors ($log)"
  [ "$errors" = "0" ] || { echo "RESTORE HAD ERRORS: read the log before going on" >&2; exit 1; }
  docker exec -i "$DB" psql -U postgres -v ON_ERROR_STOP=1 -q < after-restore.sql >/dev/null
  docker exec "$DB" psql -U postgres -q -c "notify pgrst, 'reload schema'" >/dev/null
  echo "after-restore.sql applied (auth.users triggers, 4 daily jobs)"
}

# After a restore: write down that every migration file of the repo is already in the database (so that later "migrate" applies only new ones).
cmd_mark() {
  docker exec "$DB" psql -U postgres -v ON_ERROR_STOP=1 -q -c "create schema if not exists supabase_migrations; create table if not exists supabase_migrations.schema_migrations (version text primary key, statements text[], name text);" >/dev/null
  for file in "$REPO_ROOT"/supabase/migrations/*.sql; do
    base="$(basename "$file" .sql)"
    docker exec "$DB" psql -U postgres -q -c "insert into supabase_migrations.schema_migrations (version, name) values ('${base%%_*}', '${base#*_}') on conflict do nothing" >/dev/null
  done
  echo "migration history marked"
}

cmd_smoke() { node smoke.mjs; }

cmd_stats() {
  echo "== memory and processor of the stack (idle or under the checks just run)"
  docker stats --no-stream --format "table {{.Name}}\t{{.MemUsage}}\t{{.CPUPerc}}" \
    staysee-selfhost-db staysee-selfhost-auth staysee-selfhost-rest staysee-selfhost-functions staysee-selfhost-kong
  docker stats --no-stream --format "{{.Name}} {{.MemUsage}}" \
    staysee-selfhost-db staysee-selfhost-auth staysee-selfhost-rest staysee-selfhost-functions staysee-selfhost-kong |
    awk '{v=$2; if (v ~ /GiB/) {sub("GiB","",v); t+=v*1024} else if (v ~ /MiB/) {sub("MiB","",v); t+=v} else if (v ~ /KiB/) {sub("KiB","",v); t+=v/1024}} END {printf "TOTAL: %.0f MB\n", t}'
  echo "== size of the database"
  docker exec "$DB" psql -U postgres -tAc "select pg_size_pretty(pg_database_size('postgres'))"
}

cmd_down() { "${COMPOSE[@]}" down; }
cmd_reset() { "${COMPOSE[@]}" down -v; }

case "${1:-all}" in
  all) cmd_up; cmd_restore "${2:?usage: bash rehearsal.sh all <schema-only dump of production>}"; cmd_mark; cmd_smoke || true; cmd_stats ;;
  up) cmd_up ;;
  restore) cmd_restore "${2:-}" ;;
  mark) cmd_mark ;;
  migrate) cmd_migrate ;;
  smoke) cmd_smoke ;;
  stats) cmd_stats ;;
  down) cmd_down ;;
  reset) cmd_reset ;;
  *) echo "usage: bash rehearsal.sh [all|up|migrate|smoke|stats|down|reset]"; exit 2 ;;
esac
