#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
: "${TEST_POSTGRES_URL:?set TEST_POSTGRES_URL to PostgreSQL with CREATEDB privileges}"
case "$TEST_POSTGRES_URL" in
    postgres://*|postgresql://*) ;;
    *) echo "TEST_POSTGRES_URL must use PostgreSQL" >&2; exit 2 ;;
esac
if command -v cargo >/dev/null 2>&1; then
    blackwall_cargo=cargo
else
    blackwall_cargo="$HOME/.cargo/bin/cargo"
fi
"$blackwall_cargo" fmt --check
"$blackwall_cargo" clippy --all-targets -- -D warnings
"$blackwall_cargo" test --locked
(cd web && pnpm install --frozen-lockfile && pnpm exec vp check && pnpm exec vp test run && pnpm run typecheck && pnpm run build)
