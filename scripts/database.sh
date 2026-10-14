#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
case "${1:-}" in
    migrate)
        : "${DATABASE_URL:?set DATABASE_URL to a PostgreSQL database}"
        cargo run -- migrate
        ;;
    reset)
        # Worktrees name their own database in .env; reset only that one.
        url=${DATABASE_URL:-$(sed -n 's/^DATABASE_URL=//p' .env 2>/dev/null)}
        db=${url##*/}
        db=${db%%\?*}
        db=${db:-blackwall}
        docker compose up -d --wait postgres
        docker compose exec -T postgres dropdb --force -U blackwall --if-exists "$db"
        docker compose exec -T postgres createdb -U blackwall "$db"
        DATABASE_URL="postgres://blackwall:blackwall@127.0.0.1:${POSTGRES_PORT:-5432}/$db" cargo run -- migrate
        ;;
    *)
        echo "usage: $0 migrate|reset" >&2
        echo "reset deletes only the local Compose database named by DATABASE_URL or .env; stop the app first" >&2
        exit 2
        ;;
esac
