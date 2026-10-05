# OpenProject sync

OpenProject connections import work packages into Blackwall teams. This is a one-way integration. Blackwall never writes to OpenProject.

## Setup

An owner or administrator can add a connection in **Settings → Integrations → OpenProject**:

1. Enter the OpenProject installation URL and an API token. Use a dedicated OpenProject account with access only to the projects you intend to import.
2. Wait for background project discovery, or request a refresh.
3. Map each selected OpenProject project to a Blackwall team. Several projects can feed the same team.
4. Save the mappings. Use **Sync now** to request an immediate import.

Blackwall requests only projects and work packages visible to the integration account. Authentication uses HTTP Basic with username `apikey` and the API token as password. Tokens are write-only in the settings API and never appear in job payloads or frontend responses. Treat the database and its backups as credential-bearing storage.

Private-network installations are supported. The Blackwall worker must be able to reach the configured URL. Connection management is restricted to workspace administrators, but this is not a network isolation policy. Use deployment firewall rules to restrict worker egress. Prefer HTTPS, even on private networks.

## Imported data and ownership

The first version imports title, raw description, status, recognized priority names, due date, and a link back to OpenProject. It does not synchronize comments, attachments, users, or hierarchy. Imported issue fields, direct stage moves, deletion, restoration, source-link additions, and issue attachment removal are read-only in Blackwall. Local discussion, following, time tracking, and attachment uploads remain available. Administrators can delete a local stage and migrate its issues, including imported issues, to a replacement stage. A later sync reapplies the remote status mapping.

Each work package has a stable identity consisting of its connection ID and OpenProject work-package ID. Moving a work package between mapped projects changes its destination team without creating another issue. Mapping a project to another team also reconciles existing issues on a later sync. Once a connection has imported issues, its installation URL cannot change. Create a new connection for another installation to avoid mixing work packages with overlapping IDs.

By default, a work-package status maps to a team stage with a matching name. Otherwise, closed statuses use a done stage, and open statuses use a backlog stage. The first stage is the final fallback. The configuration API also accepts explicit OpenProject status ID to Blackwall stage ID mappings. Priority names map to Blackwall's low, normal, high, or urgent values; unknown priority names map to none.

Removing a mapping or losing access to a work package does not delete the imported issue. Missing remote data is not proof of deletion. Disconnecting preserves imported issues and their read-only source metadata. JSON exports omit connection-bound sync identities. Transferred copies become ordinary local issues with their OpenProject source link, rather than reconnecting to the original integration.

## Background execution

Enabled connections synchronize every five minutes while a Blackwall worker is running. Connection checks, project discovery, initial imports, and manual sync requests all run in the background. Settings reads cached metadata, and ordinary issue reads use the local database only.

This version performs full, paginated scans of selected projects, including closed work packages. It favors straightforward reconciliation over version-dependent incremental date-filter behavior. Slow or unavailable OpenProject instances leave the last imported data available. Settings shows the last successful sync and errors.

Jobs persist in PostgreSQL. Workers fetch and normalize remote data into typed pages outside database transactions, then apply bounded batches through the shared issue persistence implementation. Imports and updates schedule deadline reminders and emit change and completion events. Sync activity uses a workspace owner as its audit actor. Continuations and checkpoints let later jobs resume a scan. Retries can repeat a page without duplicating its issues. Worker scheduling recovers after restarts.

`JOBS_OPENPROJECT_CONCURRENCY` defaults to 2 and accepts 1 through 4. OpenProject jobs have their own concurrency limit so slow requests do not consume email or database job slots. The database pool must have at least `JOBS_DATABASE_CONCURRENCY + JOBS_OPENPROJECT_CONCURRENCY + 3` connections.

For process isolation, run `blackwall serve` with `EMBEDDED_WORKERS=false` and run `blackwall worker` separately. Each process then owns its own runtime and database pool. They still share the database, so background writes can contend with interactive writes; batches and lock timeouts limit that contention.

Polling is eventually consistent, not a snapshot of OpenProject. Work packages can move or change while a scan is in progress; a later scan repairs missed changes. There are no webhooks in this version.

## API

All routes are scoped to a workspace and require owner or administrator access:

```text
GET    /api/workspaces/{workspace_id}/openproject/connections
POST   /api/workspaces/{workspace_id}/openproject/connections
PATCH  /api/workspaces/{workspace_id}/openproject/connections/{connection_id}
DELETE /api/workspaces/{workspace_id}/openproject/connections/{connection_id}
POST   /api/workspaces/{workspace_id}/openproject/connections/{connection_id}/refresh
POST   /api/workspaces/{workspace_id}/openproject/connections/{connection_id}/sync
```

Create a connection:

```json
{
  "name": "Engineering OpenProject",
  "base_url": "https://openproject.example.com",
  "token": "your-api-token",
  "enabled": true,
  "projects": [
    {
      "project_id": 42,
      "team_id": "a-blackwall-team-uuid",
      "stage_mapping": {
        "7": "a-blackwall-stage-uuid"
      }
    }
  ]
}
```

PATCH accepts any subset of the create fields. Omit `token` to retain the credential. Sending `projects` replaces all project mappings. Discovery and sync return HTTP 202 with `{"queued":true}`; this acknowledges queued work, not a completed remote request.

The list response is `{"connections":[...]}`. Connection responses contain cached projects, mapping configuration, status, last error, and last checked/synced timestamps. They never contain the token.

Issue responses include `openproject` metadata for imported work packages. The backend operation ownership policy generates the frontend command rules and capabilities. Clients use those capabilities to disable prohibited actions, rather than infer ownership from source-link URLs or maintain a separate command list.

## Scope

Imports respect Blackwall's 5,000-issue workspace capacity, including trashed issues. At capacity, existing work packages can still update, but a page that needs to create another issue fails without partial writes. Local board rebalancing may adjust imported card positions; imported fields and direct card moves remain read-only.

Each connection supports up to 100 project mappings. Discovery caches at most 5,000 projects and 5,000 statuses. Work-package pages contain at most 50 items and responses are limited to 2 MiB. A scan stops after 1,000 pages per project. If OpenProject changes its effective page size during a scan, request **Sync now** to restart the scan rather than resume with unsafe offsets.

Local issues cannot use imported issues as parents or dependencies in this version. OpenProject status changes must not invalidate Blackwall's local dependency workflow. Missing work packages remain unchanged; this version does not infer or display remote unavailability.

Two-way editing, webhook acceleration, comments, attachments, user matching, and hierarchy import are separate future tasks. Do not use this integration as a backup of OpenProject.

OpenProject references: [API introduction](https://www.openproject.org/docs/api/introduction/), [work packages](https://www.openproject.org/docs/api/endpoints/work-packages/), and [collections](https://www.openproject.org/docs/api/collections/).
