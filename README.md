<p align="center">
  <img src="web/public/favicon.svg" width="96" alt="Blackwall logo">
</p>

<h1 align="center">Blackwall</h1>

<p align="center">
  A fast, AI-native work tracker for teams.
  <br>
  Self-hosted, as one Rust binary and a PostgreSQL database.
</p>

<p align="center">
  <a href="#about">About</a>
  ·
  <a href="#features">Features</a>
  ·
  <a href="#get-started">Get started</a>
  ·
  <a href="#documentation">Documentation</a>
  ·
  <a href="LICENSE">License</a>
</p>

## About

Blackwall keeps a team's issues, projects, sprints, and the discussion around them in one workspace. You run it on your own server. PostgreSQL holds the data, the search index, and the background job queue, so there is no Redis, message broker, or search service to operate.

## Features

- **Fast.** Blackwall uses a sync engine, so perceived speed is instant. Work software used every day shouldn't slow you down.
- **AI-native.** A built-in MCP server gives your agents access to the app's data, with granular control on what they can and can't do.
- **Planning.** Teams with their own workflows, projects with milestones and health, sprints, boards, saved views, and bulk edits.
- **Discussion.** Markdown comments, mentions, follows, and an inbox of what needs your attention.
- **Time tracking.** Log and correct time on issues, then report on it.
- **Integrations.** Signed webhooks that carry the changed record, source links from your git host, and two-way sync with OpenProject.
- **Access control.** Owner, admin, member, and viewer roles, invitations, invite-only registration, and email verification.
- **Import and export.** JSON transfer keeps relations, comments, time entries, trash, and history.
- **English and Polish.** Light, dark, and system themes.

## Get started

For the time being, building from source is mandatory. You need stable Rust, Node 22+, pnpm, and Docker. Easier deployment and More deployment targets are planned.

```sh
docker compose up -d --wait
cp .env.example .env
(cd web && pnpm install --frozen-lockfile && pnpm run build)
cargo run
```

Open `http://127.0.0.1:3000`, register, create a workspace, and add a team. Run `cargo run -- worker` in a second terminal to send email and webhooks and to sync issue trackers.

To try it with sample data, run `cargo run -- fixtures rich` against a fresh database and sign in as `owner@example.com` with `fixture-password-123`.

## Documentation

Full documentation is in progress. Until then:

- [Development](docs/development.md)
- [Operations](docs/operations.md): background jobs, email, registration, webhooks, and workspace limits
- [Deploy](docs/deploy.md)
- [Public API and MCP](docs/api.md)
- [Internal API](docs/internal-api.md)
- [Issue trackers](docs/trackers.md)
- [Backend design](docs/architecture.md)
- [Sync engine](docs/sync.md)
- [`.env.example`](.env.example) lists the configuration options.

Blackwall is in early development. The public API and MCP server are in beta, and breaking changes are expected.

## License

Blackwall is released under the [MIT License](LICENSE).
