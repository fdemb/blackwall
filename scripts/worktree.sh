#!/usr/bin/env bash
# Linked worktrees share the main checkout's Compose stack but get their own database and HTTP port.
set -euo pipefail
cd "$(dirname "$0")/.."

main=$(git worktree list --porcelain | sed -n '1s/^worktree //p')
if [ "$main" = "$PWD" ]; then
    echo "run this in a linked worktree, not the main checkout" >&2
    exit 2
fi

slug=$(basename "$PWD" | tr 'A-Z' 'a-z' | tr -c 'a-z0-9\n' '_')
db="blackwall_${slug#blackwall_}"

database_exists() {
    [ -n "$(docker compose exec -T postgres psql -U blackwall -Atc "SELECT 1 FROM pg_database WHERE datname = '$db'")" ]
}

case "${1:-}" in
    init)
        if [ ! -f .env ]; then
            # A port derived from the worktree name, bumped past anything already listening.
            port=$((3100 + $(printf %s "$slug" | cksum | cut -d' ' -f1) % 800))
            while ss -Hltn "sport = :$port" | grep -q .; do port=$((port + 1)); done
            sed -e "/^DATABASE_URL=/s#/blackwall\$#/${db}#" \
                -e "s#^BIND_ADDR=.*#BIND_ADDR=127.0.0.1:${port}#" \
                .env.example > .env
            echo "COMPOSE_PROJECT_NAME=$(basename "$main")" >> .env
        fi

        docker compose up -d --wait

        fresh=false
        if ! database_exists; then
            docker compose exec -T postgres createdb -U blackwall "$db"
            fresh=true
        fi

        # Reflinks make this copy nearly free on btrfs and xfs; Cargo reuses the compiled dependencies.
        if [ ! -d target/debug ] && [ -d "$main/target/debug" ]; then
            mkdir -p target
            cp -r --reflink=auto "$main/target/debug" target/
        fi

        (cd web && pnpm install --frozen-lockfile && pnpm run build)

        cargo run --locked -- migrate
        if $fresh && [ -n "${FIXTURE:-}" ]; then
            cargo run --locked -- fixtures "$FIXTURE"
        fi

        echo "database $db, http://$(sed -n 's/^BIND_ADDR=//p' .env)"
        ;;
    drop)
        docker compose exec -T postgres dropdb --force -U blackwall --if-exists "$db"
        ;;
    *)
        echo "usage: $0 init|drop" >&2
        echo "init creates .env, database $db and build caches; FIXTURE=empty|rich loads a fixture into a new database" >&2
        echo "drop deletes database $db; run it before git worktree remove" >&2
        exit 2
        ;;
esac
