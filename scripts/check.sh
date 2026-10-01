#!/usr/bin/env bash
set -euo pipefail
if command -v cargo >/dev/null 2>&1; then
    blackwall_cargo=cargo
else
    blackwall_cargo="$HOME/.cargo/bin/cargo"
fi
"$blackwall_cargo" fmt --check
"$blackwall_cargo" clippy --all-targets -- -D warnings
"$blackwall_cargo" test
(cd web && pnpm install --frozen-lockfile && pnpm exec vp check && pnpm run typecheck && pnpm run build)
