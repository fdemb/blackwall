# Development

## Run locally

Install stable Rust, Node 22+, pnpm, and Docker. Start PostgreSQL 17 and Mailpit, then build the frontend and run the server.

```sh
docker compose up -d --wait
cp .env.example .env
(cd web && pnpm install --frozen-lockfile && pnpm run build)
cargo run
```

`cargo run` starts HTTP only. Run `cargo run -- worker` in a second terminal for email, webhooks, reminders and issue trackers.

The server requires a PostgreSQL `DATABASE_URL` and applies SQLx migrations at startup. `DATABASE_MAX_CONNECTIONS` defaults to 16 and `DATABASE_ACQUIRE_TIMEOUT_SECONDS` to 10. `.env.example` uses `postgres://blackwall:blackwall@127.0.0.1:5432/blackwall`. The Compose services bind to loopback, and PostgreSQL keeps local data in the `postgres-data` volume. Set `POSTGRES_PORT` to change the host port and update your database URLs to match.

Open `http://127.0.0.1:3000`, register an account, and create a workspace. Create a team before adding issues.

The server serves `web/build/client`. Set `WEB_DIR` to use another build. For frontend development, run `cargo run` and `pnpm run dev` inside `web/`. Vite proxies `/api` to port 3000 and serves the app on port 5173.

Apply migrations without starting HTTP or workers:

```sh
DATABASE_URL=postgres://blackwall:blackwall@127.0.0.1:5432/blackwall ./scripts/database.sh migrate
```

Stop the app before running `./scripts/database.sh reset`. Reset deletes and recreates only the local Compose `blackwall` database, then applies migrations. Load a deterministic workspace after reset:

```sh
cargo run -- fixtures empty
# Or load the feature-rich fixture into a fresh database.
cargo run -- fixtures rich
```

Fixtures use `fixture-password-123`. The empty fixture account is `empty@example.com`; the rich fixture accounts are `owner@example.com` and `member@example.com`. Load each fixture once per fresh database.

There is no converter for old development databases.

Run `./scripts/worktree.sh init` in a linked git worktree. It writes a `.env` with its own database and HTTP port, reuses the main checkout's Compose services and Rust build cache, builds the frontend, and applies migrations. `FIXTURE=rich` loads a fixture into a new database. In the worktree, `pnpm run dev` proxies to that port and `./scripts/database.sh reset` resets only that database. Run `./scripts/worktree.sh drop` before removing the worktree.

Static SQL uses `sqlx::query!` and its siblings, so a query that no longer matches the schema fails the build. It compiles offline using the committed `.sqlx` metadata. After changing a checked query, regenerate its metadata against a migrated PostgreSQL database:

```sh
rm -rf .sqlx && mkdir .sqlx
SQLX_OFFLINE=false SQLX_OFFLINE_DIR=$PWD/.sqlx DATABASE_URL=postgres://blackwall:blackwall@127.0.0.1:5432/blackwall cargo check
```

CI does the same against a fresh schema and fails when the committed `.sqlx` differs. The failed run uploads the regenerated files as the `generated` artifact.

The web app's API types come from the internal OpenAPI spec. `cargo run -- openapi > web/app/lib/openapi.json` writes the spec, and `pnpm run gen:api` in `web/` turns it into `web/app/lib/api.gen.ts`, which `web/app/lib/types.ts` builds on. CI checks both files the same way.

## Verify

Integration tests require PostgreSQL and a role with `CREATEDB`. Each test creates a disposable database visible to all application pool connections.

```sh
export DATABASE_URL=postgres://blackwall:blackwall@127.0.0.1:5432/blackwall
export TEST_POSTGRES_URL="$DATABASE_URL"
./scripts/check.sh
cargo build --locked
python3 scripts/smoke.py
```

`check.sh` runs formatting, Clippy, Rust tests, and frontend checks. The smoke script runs real HTTP, applies migrations twice, restarts the server, and exercises expired job lease recovery. It requires `psql` or the local Compose PostgreSQL service. No browser verification is required. See [verification](verification.md) for coverage and limits.

