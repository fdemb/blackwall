# Deploy

Every push to `main` deploys to `deploy-host`, an aarch64 Debian 13 host reachable only over Tailscale. After `check` passes, the `build` job cross-compiles the release binary and bundles it with the frontend. A self-hosted runner on the host then runs the `deploy` job. The runner only makes outbound connections to GitHub, so the host accepts no inbound traffic from the internet.

`deploy` passes the archive to `/usr/local/sbin/blackwall-deploy`, the one command the runner may run with sudo. The script unpacks the archive into `/opt/blackwall/releases/<sha>`, runs `blackwall migrate`, points `/opt/blackwall/current` at the release, and restarts `blackwall-web` and `blackwall-worker`. If `/health` or the worker is down after 30 seconds, it switches back to the previous release; migrations stay applied. It keeps the five newest releases.

PostgreSQL 17 runs natively, and the `blackwall` system user connects with peer authentication. The `svc:blackwall` Tailscale service publishes the app at `https://blackwall.example.com` inside the tailnet only. Service hosts must be tagged nodes; `deploy-host` has `tag:deploy`, and an admin approved it as the service's host. Configuration lives in `/etc/blackwall/blackwall.env`. Mail stays off until you set `SMTP_URL`, `SMTP_FROM` and `PUBLIC_URL` there.

`deploy/bootstrap.sh` sets up the host and can be rerun. Copy `deploy/` to the host and run it as root. Add `RUNNER_TOKEN` from `gh api -X POST repos/fdemb/blackwall-rust/actions/runners/registration-token --jq .token` to register the runner too. To redeploy a commit, rerun its `deploy` job in GitHub Actions. To roll back by hand, run `blackwall-deploy` with an older archive, or repoint `current` and restart both services.

