#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
: "${TEST_POSTGRES_URL:?set TEST_POSTGRES_URL to PostgreSQL with CREATEDB privileges}"
case "$TEST_POSTGRES_URL" in
    postgres://*|postgresql://*) ;;
    *) echo "TEST_POSTGRES_URL must use PostgreSQL" >&2; exit 2 ;;
esac

cargo fmt --check
cargo clippy --all-targets -- -D warnings
cargo test --locked

cd web
pnpm install --frozen-lockfile
pnpm run typecheck
pnpm exec vp check
pnpm exec vp lint -A all -W eslint/complexity -f json | node ../scripts/complexity.mjs
pnpm exec vp test run
SYNC_CONTRACT=1 pnpm exec vp test run app/sync/contract
pnpm run build
