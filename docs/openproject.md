# OpenProject sync

OpenProject connections import work packages into Blackwall teams. This is a one-way integration. Blackwall never writes to OpenProject.

## Setup

An owner or administrator can add a connection in **Settings → Integrations → OpenProject**:

1. Enter the OpenProject installation URL and an API token. Use a dedicated OpenProject account with access only to the projects you intend to import.
2. Wait for background project discovery, or request a refresh.
3. Map each selected OpenProject project to a Blackwall team. Several projects can feed the same team.
4. Expand **Status mappings** for a project to override the default stages. Select **Create stage on save** to migrate an OpenProject status into the destination team.
5. Check **People mappings**. Matching email addresses use the corresponding workspace member automatically. Select another member to override a match.
6. Save the mappings. Use **Sync now** to request an immediate import.

Blackwall requests only projects and work packages visible to the integration account. Authentication uses HTTP Basic with username `apikey` and the API token as password. Tokens are write-only in the settings API and never appear in job payloads or frontend responses. Treat the database and its backups as credential-bearing storage.

Private-network installations are supported. The Blackwall worker must be able to reach the configured URL. Connection management is restricted to workspace administrators, but this is not a network isolation policy. Use deployment firewall rules to restrict worker egress. Prefer HTTPS, even on private networks.

## Imported data and ownership

The integration imports title, raw description, status, assignee, recognized priority names, due date, and a link back to OpenProject. It does not synchronize comments, attachments, or user accounts. Imported issue fields, direct stage moves, deletion, restoration, source-link additions, and issue attachment removal are read-only in Blackwall. Local discussion, following, time tracking, and attachment uploads remain available. Administrators can delete a local stage and migrate its issues, including imported issues, to a replacement stage. A later sync reapplies the remote status mapping.

Each work package has a stable identity consisting of its connection ID and OpenProject work-package ID. The remote parent work-package ID is recorded in source metadata and resolved to a local parent link when the parent is imported under the same connection. Links resolve regardless of scan or page order, follow remote re-parenting and removals, and skip links that would form a cycle until a later scan repairs them. A parent in an unmapped project, one hidden from the integration account, or one not yet imported leaves the local parent empty. Moving a work package between mapped projects changes its destination team without creating another issue. Mapping a project to another team also reconciles existing issues on a later sync. Once a connection has imported issues, its installation URL cannot change. Create a new connection for another installation to avoid mixing work packages with overlapping IDs.

By default, a work-package status maps to a team stage with a matching name. Otherwise, closed statuses use a done stage, and open statuses use a backlog stage. The first stage is the final fallback. Each project can override these defaults with explicit OpenProject status ID to Blackwall stage ID mappings in settings or the configuration API. Changing the destination team clears that project's stage overrides in the settings form. Mapping changes reconcile existing imported issues on the next sync.

To migrate a status, select **Create stage on save** for that status. Saving creates a stage with the remote status name through Blackwall's stage command, then saves its ID in the project mapping. An existing stage with the same name is reused. Closed statuses create done stages. New, open, and backlog statuses create backlog stages; other open statuses create active stages. If saving the connection fails after stage creation, the stage remains and the form retains its ID for retry.

Assignees match workspace members by email, ignoring case and surrounding whitespace. Connection-wide `people_mapping` overrides map remote email addresses to workspace member IDs. These overrides do not create or invite users. Hidden emails, people outside the workspace, and unmatched people leave the issue unassigned. Removing an assignee in OpenProject clears the local assignment. The integration account needs permission to see remote email addresses for matching to work.

Priority names map to Blackwall's low, normal, high, or urgent values; unknown priority names map to none.

Removing a mapping or losing access to a work package does not delete the imported issue. Missing remote data is not proof of deletion. Disconnecting preserves imported issues and their read-only source metadata. JSON exports omit connection-bound sync identities. Transferred copies become ordinary local issues with their OpenProject source link, rather than reconnecting to the original integration.

## Background execution

Mapped connections normally start a scan every five minutes while a Blackwall worker is running. The interval is measured from the previous scan's start. If a scan takes longer than five minutes, the worker waits at least 30 seconds after completion before starting another one. Connection checks, discovery, imports, and manual requests run in the background. Settings reads cached metadata, and ordinary issue reads use the local database only.

Initial imports, configuration changes, and **Sync now** perform full, paginated discovery and work-package scans, including closed packages. Automatic scans between discovery refreshes request packages modified within an overlapping timestamp window. The lower bound is midnight UTC two days before the last successful scan's start; the upper bound is two days after the current scan's start. Both bounds remain fixed across all pages and projects. The worker advances the watermark only when the entire scan commits successfully.

Once discovery metadata is 30 minutes old, the next automatic scan refreshes projects, statuses, and people and reconciles all mapped packages without a date filter. Local membership or stage changes also force an unfiltered reconciliation. Periodic full scans repair missed packages, newly visible packages, remote metadata changes, and remote timestamps outside the overlap window. They do not infer deletion. A discovery-only refresh clears the polling watermark so the next automatic scan reapplies the refreshed mappings to every package. Connections without mappings only refresh discovery every 30 minutes.

The incremental request uses OpenProject's `updatedAt` datetime range operator `<>d`. If an installation rejects a filtered request with HTTP 400 or 422, the worker restarts the scan without the date filter and keeps using unfiltered polling. **Sync now** or a sync-affecting configuration change permits another compatibility attempt. Other HTTP errors retain normal retry behavior. Slow or unavailable installations leave the last imported data available.

Jobs persist in PostgreSQL. Workers reuse a pooled HTTP client and fetch and normalize remote pages outside database transactions. Discovery pages occupy a separate bounded table until the complete resource replaces its public cache, so settings never sees a partially refreshed resource. Checkpoint updates do not rewrite discovery caches.

Work-package reconciliation loads stages, matching members, and existing issues once per page. Unchanged issues do not hydrate detail relations or issue individual writes. Changed issues use shared issue persistence, reminders, activity, completion events, and follower alerts. New issues allocate numbers and stage positions in batches. Sync activity uses a workspace owner as its audit actor. Imported issues, cache publication, checkpoints, and job completion remain protected by claim and configuration-generation fencing. Retries can repeat a page without duplicating its issues. Worker scheduling recovers after restarts.

`JOBS_OPENPROJECT_CONCURRENCY` defaults to 2 and accepts 1 through 4. OpenProject jobs have their own concurrency limit so slow requests do not consume email or database job slots. The database pool must have at least `JOBS_DATABASE_CONCURRENCY + JOBS_OPENPROJECT_CONCURRENCY + 3` connections.

For process isolation, run `blackwall serve` with `EMBEDDED_WORKERS=false` and run `blackwall worker` separately. Each process then owns its own runtime and database pool. They still share the database, so background writes can contend with interactive writes; batches and lock timeouts limit that contention.

Polling is eventually consistent, not a snapshot of OpenProject. Work packages can move or change while a scan is in progress; a later scan repairs missed changes. There are no webhooks in this version.

## Debug logging

The existing `tracing` subscriber reads `RUST_LOG`. Enable OpenProject debug logs with
`RUST_LOG=blackwall=info,blackwall::openproject=debug` on the server or worker process running the sync.

Logs include connection and job IDs, scan resources and page numbers, response status and size,
request timings, normalization, pool acquisition, workspace lock wait, reconciliation timings,
selected stage and assignee IDs, changed fields, and discarded pages.
Work-package reconciliation logs describe writes inside the page transaction. The page committed
message confirms that those writes persisted. Tokens, URLs, email addresses, titles, descriptions,
and remote response bodies are omitted.

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
  "people_mapping": {
    "remote.person@example.com": "a-blackwall-member-uuid"
  },
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

PATCH accepts any subset of the create fields. Name-only changes and saves with no effective changes preserve running jobs and their checkpoints. Changes to credentials, URL, enabled state, or mappings request a new full scan. Reference validation uses batched lookups. Omit `token` to retain the credential. Sending `projects` replaces all project mappings. Sending `people_mapping` replaces all people overrides; send `{}` to restore automatic email matching. Omit either field to retain its current configuration. Discovery and sync return HTTP 202 with `{"queued":true}`; this acknowledges queued work, not a completed remote request.

The list response is `{"connections":[...]}`. Connection responses contain cached projects, statuses, people, mapping configuration, status, last error, and last checked/synced timestamps. They never contain the token.

Issue responses include `openproject` metadata for imported work packages. The backend operation ownership policy generates the frontend command rules and capabilities. Clients use those capabilities to disable prohibited actions, rather than infer ownership from source-link URLs or maintain a separate command list.

## Scope

Imports respect Blackwall's 5,000-issue workspace capacity, including trashed issues. At capacity, existing work packages can still update, but a page that needs to create another issue fails without partial writes. Local board rebalancing may adjust imported card positions; imported fields and direct card moves remain read-only.

Each connection supports up to 100 project mappings. Discovery caches at most 5,000 projects, 5,000 statuses, and 5,000 people. Work-package pages contain at most 50 items and responses are limited to 2 MiB. A scan stops after 1,000 pages per project. If OpenProject changes its effective page size during a scan, request **Sync now** to restart the scan rather than resume with unsafe offsets.

Local issues cannot use imported issues as parents or dependencies in this version. OpenProject status changes must not invalidate Blackwall's local dependency workflow. Missing work packages remain unchanged; this version does not infer or display remote unavailability.

Two-way editing, webhook acceleration, comments, attachments, and user account creation are separate future tasks. Do not use this integration as a backup of OpenProject.

OpenProject references: [API introduction](https://www.openproject.org/docs/api/introduction/), [work packages](https://www.openproject.org/docs/api/endpoints/work-packages/), and [collections](https://www.openproject.org/docs/api/collections/), and [users](https://www.openproject.org/docs/api/endpoints/users/).
