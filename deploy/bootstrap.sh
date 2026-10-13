#!/usr/bin/env bash
# One-time, rerunnable server setup for Debian 13. Run as root from a copy of deploy/.
# RUNNER_TOKEN, a GitHub runner registration token, also installs the self-hosted runner.
set -euo pipefail
cd "$(dirname "$0")"

repo_url=https://github.com/fdemb/blackwall-rust
runner_dir=/opt/actions-runner

export DEBIAN_FRONTEND=noninteractive
apt-get update
apt-get install -y postgresql curl tar

id blackwall >/dev/null 2>&1 \
    || useradd --system --home-dir /opt/blackwall --shell /usr/sbin/nologin blackwall
# Peer authentication over the Unix socket: no database password to manage.
if ! runuser -u postgres -- psql -tAc "SELECT 1 FROM pg_roles WHERE rolname = 'blackwall'" | grep -q 1; then
    runuser -u postgres -- createuser blackwall
fi
if ! runuser -u postgres -- psql -tAc "SELECT 1 FROM pg_database WHERE datname = 'blackwall'" | grep -q 1; then
    runuser -u postgres -- createdb --owner blackwall blackwall
fi

install -d -m 0755 /opt/blackwall /opt/blackwall/releases
install -d -m 0750 -g blackwall /etc/blackwall
if [[ ! -f /etc/blackwall/blackwall.env ]]; then
    install -m 0640 -g blackwall /dev/stdin /etc/blackwall/blackwall.env <<EOF
DATABASE_URL=postgres://blackwall@localhost/blackwall?host=/var/run/postgresql
BIND_ADDR=127.0.0.1:3000
RUST_LOG=blackwall=info
# Served over HTTPS by the svc:blackwall Tailscale service
COOKIE_SECURE=true
# SMTP_URL=smtps://user:password@smtp.example.com
# SMTP_FROM="Blackwall <noreply@example.com>"
EOF
fi

install -m 0755 blackwall-deploy /usr/local/sbin/blackwall-deploy
install -m 0644 blackwall-web.service blackwall-worker.service /etc/systemd/system/
systemctl daemon-reload
systemctl enable blackwall-web blackwall-worker

# Service hosts must be tagged nodes. An admin approves the host for svc:blackwall once.
tailscale serve --bg --yes --service=svc:blackwall --https=443 http://127.0.0.1:3000

id gh-runner >/dev/null 2>&1 \
    || useradd --system --create-home --home-dir "$runner_dir" --shell /bin/bash gh-runner
install -m 0440 /dev/stdin /etc/sudoers.d/blackwall-deploy <<EOF
gh-runner ALL=(root) NOPASSWD: /usr/local/sbin/blackwall-deploy
EOF
visudo -cf /etc/sudoers.d/blackwall-deploy

if [[ -n ${RUNNER_TOKEN:-} && ! -f $runner_dir/.runner ]]; then
    version=$(curl -fsSL https://api.github.com/repos/actions/runner/releases/latest \
        | sed -n 's/.*"tag_name": "v\(.*\)".*/\1/p')
    curl -fsSL "https://github.com/actions/runner/releases/download/v$version/actions-runner-linux-arm64-$version.tar.gz" \
        | runuser -u gh-runner -- tar -xz -C "$runner_dir"
    "$runner_dir/bin/installdependencies.sh"
    (cd "$runner_dir" && runuser -u gh-runner -- ./config.sh --unattended --replace \
        --url "$repo_url" --token "$RUNNER_TOKEN" --name "$(hostname)" --labels deploy)
    (cd "$runner_dir" && ./svc.sh install gh-runner && ./svc.sh start)
fi
