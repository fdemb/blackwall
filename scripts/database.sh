#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
case "${1:-}" in
    migrate)
        : "${DATABASE_URL:?set DATABASE_URL to a PostgreSQL database}"
        cargo run -- migrate
        ;;
    reset)
        docker compose up -d --wait postgres
        docker compose exec -T postgres dropdb --force -U blackwall --if-exists blackwall
        docker compose exec -T postgres createdb -U blackwall blackwall
        DATABASE_URL="postgres://blackwall:blackwall@127.0.0.1:${POSTGRES_PORT:-5432}/blackwall" cargo run -- migrate
        ;;
    *)
        echo "usage: $0 migrate|reset" >&2
        echo "reset deletes only the local Compose blackwall database; stop the app first" >&2
        exit 2
        ;;
esac
