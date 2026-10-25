# Issue trackers

Issue tracker connections keep Blackwall teams in step with an external issue tracker. OpenProject is the first and currently the only provider. The tracker framework itself is provider-neutral: connection settings, scheduling, merging, the outbound queue, and comment import do not depend on OpenProject.

Synced issues are ordinary, fully editable Blackwall issues. Every local action remains available. Actions the provider does not support, or that a connection does not send, simply stay local.

Each field syncs in two independent directions. **Import** applies changes made in the tracker. **Send** pushes changes made in Blackwall to the tracker in the background, never inside the HTTP request. OpenProject supports:

| Field | Import | Send | New connection default |
| --- | --- | --- | --- |
| Status (stage) | yes | yes | import and send |
| Title | yes | yes | import and send |
| Description | yes | yes | import and send |
| Assignee | yes | yes | import and send |
| Due date | yes | yes | import and send |
| Priority | yes | no | import |
| Parent | yes | no | import |
| Comments | yes | yes | import and send |

Connections created before two-way sync keep importing every field, including comments, and send nothing until an administrator enables sending. Imported issues also carry the author (as creator) and a link back to the work package. Attachments, user accounts, labels, and estimates do not sync.

## Setup

An owner or administrator adds a connection in **Settings → Integrations → Issue trackers** with **Add connection**. The wizard has six steps:

1. **Connect**: choose the tracker, a connection name, the OpenProject installation URL, and an API token. Use a dedicated OpenProject account with access only to the projects you intend to sync. Selecting **Connect** saves the connection immediately and starts background discovery of projects, statuses, and people.
2. **Projects**: check the remote projects to sync and choose a Blackwall team for each. Several projects can feed the same team.
3. **Statuses**: choose the stage each status maps to, per project. **Automatic** uses the rules in [Mapping](#mapping). Select **Create stage on save** to migrate a status into the destination team.
4. **People**: matching email addresses map to workspace members automatically. Select another member to override a match.
5. **What to sync**: check **Import from OpenProject** and **Send to OpenProject** per field. Directions the provider does not support are disabled.
6. **Review**: check the summary and select **Save and start syncing**. Saving creates any new stages, saves the mappings and options, and starts a full scan.

**Edit** opens the same wizard for an existing connection, with every step directly reachable. If another administrator changed the connection meanwhile, the wizard asks you to reload before saving. The connection list also shows the status, last sync time, and last error, and offers an enable switch, **Sync now**, and **Disconnect**. **Sync now** requests an immediate full scan; queued local changes are sent first.

**Disconnect** stops syncing in both directions. It discards unsent local changes and clears the stored token. Synced issues and their comments stay in Blackwall with their link metadata and become ordinary local issues in practice. Reconnecting creates a new connection, which imports the work packages as new issues.

Blackwall requests only projects, work packages, and activities visible to the integration account. Authentication uses HTTP Basic with username `apikey` and the API token as password. Sending changes needs an account allowed to edit the work packages and add comments. Matching people needs permission to see remote email addresses. Tokens are write-only in the settings API and never appear in job payloads, frontend responses, or logs. Treat the database and its backups as credential-bearing storage.

Private-network installations are supported. The Blackwall worker must be able to reach the configured URL. The HTTP client uses no proxy and follows no redirects. Connection management is restricted to workspace administrators, but this is not a network isolation policy. Use deployment firewall rules to restrict worker egress. Prefer HTTPS, even on private networks.

## Mapping

Each work package has a stable identity consisting of its connection ID and remote ID. Moving a work package between mapped projects changes its destination team without creating another issue. Once a connection has imported issues, its URL cannot change. Create a new connection for another installation to avoid mixing work packages with overlapping IDs. A workspace can have up to 20 connections, and a connection's provider cannot change.

**Statuses.** A status with an explicit mapping uses that stage. Otherwise, it maps to the destination team's stage with a matching name (case-insensitive). Failing that, closed statuses use a done stage and open statuses a backlog stage. The first stage is the final fallback. Changing the destination team clears that project's stage overrides in the wizard. **Create stage on save** creates a stage with the remote status name through Blackwall's stage command and saves its ID in the mapping. An existing stage with the same name is reused. Closed statuses create done stages; New, Open, and Backlog statuses create backlog stages; other open statuses create active stages. If saving fails after stage creation, the stage remains and the wizard retains its ID for retry. Deleting a stage moves its issues, synced ones included, to the replacement stage and rewrites explicit mappings that pointed to it. When status export is on, the move queues a status push for each synced issue, like a local stage change.

**People.** Assignees match workspace members by email, ignoring case and surrounding whitespace. Connection-wide `people_mapping` overrides map remote email addresses to member IDs. These overrides do not create or invite users. Hidden emails, people outside the workspace, and unmatched people leave the issue unassigned. Work package authors become the issue creator by the same rules when the issue is first imported; an unmatched author leaves the creator empty.

**Priority.** Priority names map to Blackwall's low, normal, high, or urgent values; unknown names map to none.

Entering a done stage through an import starts the done clock used by auto-archiving. Leaving it clears the clock and unarchives the issue. Entering a backlog stage takes the issue out of its sprint, as backlog issues have no sprint. A team change clears the issue's project, milestone, and sprint, which belong to the previous team. A team change also gives the issue the next number in its new team, because numbers count per team. The number comes from the same rule as a local creation, the team's highest number plus one. Issue keys have no aliases, so the old key, such as `ENG-2`, stops resolving and a later issue in the old team can reuse it if it was the team's highest number.

## How merging works

Each synced issue stores a baseline: the remote values last imported or successfully sent, expressed as local values after mapping. When a scan sees a work package, each field is merged three ways:

- If import is off for the field, the local value never changes.
- If the remote value equals the baseline, the remote did not change, and the local value stays. Local edits survive scans.
- If the remote value differs from the baseline, the remote changed, and its value replaces the local one. The later change wins.
- If the field has a local change waiting to be sent, the local value stays until the push resolves it.
- Issues without a baseline take every remote value once. This applies to new issues and to links created before two-way sync.

The baseline then moves to the current remote value. Because the baseline stores mapped values, changing a status mapping, a project's team, or a people override counts as a remote change. The next scan reapplies the new mapping to issues whose remote value would now map differently, even where they were edited locally.

Status and team move together, because stages belong to teams. Team placement has no toggle: it follows remote project moves and project-to-team mapping changes even when status import is off.

Locally trashed issues keep every local value. Scans only update their link and baseline. Restoring an issue from the trash does not reapply remote values that arrived meanwhile; later remote changes apply as usual. Issues purged from the trash after 30 days are not imported again.

Parents resolve to local issues of the same connection, regardless of scan or page order. Links follow remote re-parenting and removals. A parent in an unmapped project, one hidden from the integration account, or one not yet imported leaves the local parent empty. Local parent changes are allowed, including linking synced and local issues, and are kept until the remote parent changes. A remote change that would form a cycle is skipped and retried by a later scan.

Removing a mapping or losing access to a work package does not delete the issue. Missing remote data is not proof of deletion. JSON exports omit tracker links and comment tracker metadata, and transfers reject issues with tracker links. Transferred copies are ordinary local issues with their source link.

## Sending changes

Local changes to a synced issue queue in a per-connection outbox in the same transaction as the command. Nothing is queued when the connection is disabled or deleted, or when sending is off for the field. Imports never queue changes, so imported values are not echoed back.

| Local action | Sent as |
| --- | --- |
| Edit title, description, assignee, or due date (single or bulk) | that field |
| Change stage, by edit, board move, or bulk edit | status |
| Add a comment | a new comment |

Everything else stays local: deleting, restoring, archiving, priority, parent, labels, estimates, projects, milestones, sprints, dependencies, attachments, source links, and comment edits or deletions.

Only issues of mapped projects push. Removing a project mapping drops the changes its issues still have queued, and their later edits stay local. A synced comment deleted here stays deleted: later imports skip its remote copy.

Dependencies only gate local moves into an active or done stage. An imported stage change never checks them, so a remote reopening leaves started dependents in place, shown as blocked.

An issue has at most one pending field change. Further edits add field names to it. The outbox stores field names, not values: the push reads the current local values when it is sent. Several quick edits therefore become one request carrying the latest values. Comments queue one entry each.

A queued change makes the connection's tracker job due immediately, so it is usually sent within seconds. Between scans, a push-only job sends due changes; a scheduled scan sends them before fetching its page. Each job sends at most 20 changes in 30 seconds, oldest first. The scheduler starts another job for the rest.

Field values map to OpenProject as follows:

- **Status**: the explicitly mapped statuses for the issue's stage in the issue's project, preferring one named like the stage. Without an explicit mapping, statuses named like the stage that are not explicitly mapped to another stage. If the work package's current status already represents the stage, the status does not change. If no status represents the stage, the status is skipped.
- **Assignee**: the remote person whose email has a people override to the member, otherwise the remote person with the member's email that no override claims. A member without a remote person is skipped. Unassigning is always sent.
- **Due date**: the deadline's date. Clearing the deadline clears the due date.
- **Title** and **description** are sent as they are. Descriptions use OpenProject's raw markdown.

A skipped field stays local without an error. Other fields of the same change are still sent. The push fetches the work package's `lockVersion` and patches only the queued fields. A lock conflict (HTTP 409) refetches and retries once. A status is not patched when the work package's status already represents the stage; other queued fields are sent even when they already match. Success moves the baseline to the sent values and clears any previous push error on the issue.

**Rejections.** HTTP 400, 404, 422, and other client errors except 401, 403, 408, 409, and 429 are permanent. The change is dropped, and the issue shows the error as `push_error`, for example `OpenProject rejected the change (422); check workflow and required fields`. Workflow restrictions and required custom fields commonly cause 422. The local value stays; edit the issue again to retry, or let the next remote change replace it. The next successful push for the issue clears the error.

**Retries.** Network errors, timeouts, server errors, rate limits, and repeated lock conflicts keep the change. It retries with backoff starting at 30 seconds, doubling up to one hour. A transient failure ends the current batch, since the tracker is probably unavailable. After 10 failed attempts, the change is dropped and the issue shows `Tracker push gave up: …`. A newer edit to the issue restarts the retry count.

**Authentication failures.** HTTP 401 and 403 concern the connection, not the change. The connection reports the error, for example `OpenProject authentication failed (401); check the API token`, separately from scan errors. Queued changes are kept and retried every few minutes, and these failures do not count towards giving up. After the token or the account's permissions are fixed, the changes go through and the error clears.

**Disabling.** Turning sending off for a field drops that field from queued changes when they are sent. Disabling the connection stops sending: a batch in progress sends no further changes, though a request already under way completes. Queued changes stay and are sent after it is re-enabled. Disconnecting discards them.

Polling is eventually consistent. A change made in both places between scans resolves by the rules above: an unsent local change wins and overwrites the remote value when sent; once sent, a later remote change wins.

## Comments

When comment import is on, a scan fetches the comments of each work package on the page whose remote modification time moved since its comments were last imported completely, and of each newly seen one. An unchanged work package is fetched again while its history is incomplete, for example after a failed fetch or at the comment limit, and on every scan when OpenProject omits `updatedAt`. Other unchanged work packages cause no comment requests. OpenProject comments are work package activities with a non-empty comment; field-change activities are ignored.

Missing comments are inserted with their original creation time. A comment by a remote person who maps to a member is authored by that member. Other comments are attributed to the workspace's tracker actor, its first owner. Every imported comment shows its remote author as "via OpenProject · Name". The first import for an issue, including history when comment import is first enabled, is silent. Later imported comments notify the issue's followers other than the author, as local comments do. Imports never edit or delete local comments, and remote edits and deletions are not applied.

When sending comments is on, new comments on synced issues are posted to the work package. The local comment records the remote comment's ID, so the next import does not duplicate it. Comments sent from Blackwall show "via OpenProject". Comments created before sending was enabled are not sent.

A request whose response was lost may still have posted the comment. Before each post, the outbox records the body and the integration account's remote user. Before posting again, a retry looks for a comment with the recorded body that the recorded account posted since that attempt and links it instead, even if the local comment was edited meanwhile. Only when there is none does it post the current body. Meanwhile, scans do not import the recorded account's comments on the issue as new ones. A lost response therefore creates no duplicate in either system, as long as the connection's current account can still see the earlier comment: after the token changes to a different OpenProject account that cannot see it, the retry posts again. Identical comments written by other people are never merged with the sent comment.

Limits:

- At most 50 work packages per page have their comments fetched, and fetching stops 45 seconds after the job started. Work packages never fetched go first, then those whose last fetch attempt, successful or not, is oldest, so failing work packages cannot hold back the rest. Skipped work packages are fetched when a later scan sees them again: the next incremental scan if they change, otherwise the next full scan.
- A work package with more than 1,000 activities (20 pages of 50) fails its comment fetch and is retried on later scans. A failed fetch skips only that work package.
- Comment bodies longer than 100,000 bytes of UTF-8 are truncated at a character boundary. A workspace holds at most 20,000 comments; comments beyond that are not imported while the workspace is at the limit.

The initial comment import makes at least one request per work package and follows the page-by-page scan. With listings well under a second, a workspace at the 5,000-issue capacity needs roughly 20 to 40 minutes of back-to-back scan jobs. Work packages that miss a page's deadline wait for a later full scan. A full scan starts once discovery metadata is 30 minutes old and then runs page by page, so on slow installations the gap between full scans, and the initial import, can take several hours. Issues and fields sync normally meanwhile.

## Background execution

Connection checks, discovery, imports, sends, and manual requests run in the background on the worker. Settings reads cached metadata, and ordinary issue reads use the local database only. Each tracker job fetches at most one page, and each connection has at most one active job. A job has 75 seconds. Pushes stop starting provider requests after 30 seconds and a request in flight is cut off then; their database writes are not bounded by it. The page request has a 20-second timeout, and comment fetching ends 45 seconds after the job started. The page transaction uses what remains; its statements have a 10-second timeout and lock waits a 5-second one.

Mapped connections normally start a scan every five minutes while a worker is running. The interval is measured from the previous scan's start. If a scan takes longer than five minutes, the worker waits at least 30 seconds after completion before starting another one. Pages of a running scan follow each other at the worker's polling interval.

Saving the wizard, configuration changes that affect imports, and **Sync now** perform full, paginated discovery and work-package scans, including closed packages. Changes to the name or to send options alone keep running scans and their checkpoints. Automatic scans between discovery refreshes request packages modified within an overlapping timestamp window. The lower bound is midnight UTC two days before the last successful scan's start; the upper bound is two days after the current scan's start. Both bounds remain fixed across all pages and projects. The worker advances the watermark only when the entire scan commits successfully.

Once discovery metadata is 30 minutes old, the next automatic scan to start refreshes projects, statuses, and people and reconciles all mapped packages without a date filter. Local membership or team changes also force an unfiltered reconciliation. Periodic full scans repair missed packages, newly visible packages, remote metadata changes, and remote timestamps outside the overlap window. They do not infer deletion. A discovery-only refresh clears the polling watermark so the next automatic scan reapplies the refreshed mappings to every package. Connections without mappings only refresh discovery every 30 minutes.

The incremental request uses OpenProject's `updatedAt` datetime range operator `<>d`. If an installation rejects a filtered request with HTTP 400 or 422, the worker restarts the scan without the date filter and keeps using unfiltered polling. **Sync now** or an import-affecting configuration change permits another compatibility attempt. Other HTTP errors retain normal retry behavior. Slow or unavailable installations leave the last imported data available.

Jobs persist in PostgreSQL. Workers reuse a pooled HTTP client and fetch and normalize remote pages outside database transactions. Discovery pages occupy a separate bounded table until the complete resource replaces its public cache, so settings never sees a partially refreshed resource. Checkpoint updates do not rewrite discovery caches.

Work-package reconciliation loads stages, matching members, existing issues, and pending local changes once per page. Unchanged issues do not hydrate detail relations or issue individual writes; a baseline-only change is a batched link update without a version bump or activity. Changed issues use shared issue persistence, reminders, activity, completion events, and follower alerts. New issues allocate numbers and stage positions in batches. Tracker activity uses the workspace's first owner as its audit actor. Imported issues, comments, cache publication, checkpoints, and job completion remain protected by claim and configuration-generation fencing. Retries can repeat a page without duplicating its issues or comments. Worker scheduling recovers after restarts.

`JOBS_TRACKER_CONCURRENCY` defaults to 2 and accepts 1 through 4. `JOBS_OPENPROJECT_CONCURRENCY` is still read when it is unset. Tracker jobs have their own concurrency limit so slow requests do not consume email or database job slots. The database pool must have at least `JOBS_DATABASE_CONCURRENCY + JOBS_TRACKER_CONCURRENCY + 3` connections. Concurrency spreads connections across jobs; it does not parallelize one connection.

Run `blackwall serve` and `blackwall worker` as separate processes. Each process then owns its own runtime and database pool. They still share the database, so background writes can contend with interactive writes; batches and lock timeouts limit that contention.

Polling is eventually consistent, not a snapshot of OpenProject. Work packages can move or change while a scan is in progress; a later scan repairs missed changes. There are no webhooks in this version.

## Limits

Imports respect Blackwall's 5,000-issue workspace capacity, including trashed issues until they are purged 30 days after deletion. At capacity, existing work packages can still update, but a page that needs to create another issue fails without partial writes.

Each connection supports up to 100 project mappings with up to 100 status mappings each, and up to 5,000 people overrides. Discovery caches at most 5,000 projects, 5,000 statuses, and 5,000 people. Work-package pages contain at most 50 items and responses are limited to 2 MiB. A scan stops after 1,000 pages per project. If OpenProject changes its effective page size during a scan, request **Sync now** to restart the scan rather than resume with unsafe offsets.

Webhook acceleration, attachments, remote deletion, and user account creation are not supported. Do not use this integration as a backup of OpenProject.

## Debug logging

The existing `tracing` subscriber reads `RUST_LOG`. Enable tracker debug logs with `RUST_LOG=blackwall=info,blackwall::tracker=debug` on the server or worker process running the tracker jobs.

Logs include connection and job IDs, scan resources and page numbers, response status and size, request timings, normalization, pool acquisition, workspace lock wait, reconciliation timings, selected stage and assignee IDs, changed fields, discarded pages, queued and sent pushes with their outcome, skipped unmappable fields, and comment fetch counts. Work-package reconciliation logs describe writes inside the page transaction. The page committed message confirms that those writes persisted. Tokens, URLs, email addresses, titles, descriptions, comment bodies, and remote response bodies are omitted.

## API

Connections are managed through the app's internal routes, which are scoped to a workspace and require owner or administrator access. The public API (`/api/v1`) and MCP server do not manage connections. Their issues carry a `tracker` object with the link's public fields (`provider`, `connection_id`, `remote_id`, `project_id`, `parent_remote_id`, `status_name`, `url`, `push_error`), and their comments a `tracker` object naming the remote comment. Writes through them, like sync push and the app's commands, queue changes for sending.

```text
GET    /internal-api/workspaces/{workspace_id}/trackers/providers
GET    /internal-api/workspaces/{workspace_id}/trackers/connections
POST   /internal-api/workspaces/{workspace_id}/trackers/connections
PATCH  /internal-api/workspaces/{workspace_id}/trackers/connections/{connection_id}
DELETE /internal-api/workspaces/{workspace_id}/trackers/connections/{connection_id}
POST   /internal-api/workspaces/{workspace_id}/trackers/connections/{connection_id}/refresh
POST   /internal-api/workspaces/{workspace_id}/trackers/connections/{connection_id}/sync
```

`GET /trackers/providers` lists the registered providers. `fields` holds the supported directions per field, and `defaults` the options of new connections (abbreviated here):

```json
[
  {
    "kind": "openproject",
    "name": "OpenProject",
    "fields": {
      "status": {"import": true, "export": true},
      "priority": {"import": true, "export": false},
      "...": {}
    },
    "defaults": {"status": {"import": true, "export": true}, "...": {}}
  }
]
```

Create a connection:

```json
{
  "provider": "openproject",
  "name": "Engineering OpenProject",
  "base_url": "https://openproject.example.com",
  "token": "your-api-token",
  "enabled": true,
  "options": {
    "comments": {"import": true, "export": false}
  },
  "people_mapping": {
    "remote.person@example.com": "a-blackwall-member-uuid"
  },
  "projects": [
    {
      "project_id": "42",
      "team_id": "a-blackwall-team-uuid",
      "stage_mapping": {
        "7": "a-blackwall-stage-uuid"
      }
    }
  ]
}
```

`provider`, `name`, `base_url`, and `token` are required on create. `provider` cannot change. Remote project and status IDs are strings; OpenProject IDs are canonical positive integers. `options` sets per-field directions for `status`, `title`, `description`, `assignee`, `due_date`, `priority`, `parent`, and `comments`, using `import` and `export` (send). Omitted fields keep their current directions; new connections start from the provider defaults. Enabling a direction the provider does not support is rejected.

PATCH accepts any subset of the create fields. Name-only changes, send-option changes, and saves with no effective changes preserve running jobs and their checkpoints. Changes to credentials, URL, enabled state, mappings, or import options request a new full scan. Reference validation uses batched lookups. Omit `token` to retain the credential. Sending `projects` replaces all project mappings. Sending `people_mapping` replaces all people overrides; send `{}` to restore automatic email matching. Omit either field to retain its current configuration. DELETE disconnects. Discovery (`refresh`) and `sync` return HTTP 202 with `{"queued":true}`; this acknowledges queued work, not a completed remote request.

The list response is `{"connections":[...]}`. Connection responses contain `provider`, `options`, cached projects, statuses, and people, mapping configuration, `generation`, `status` (`pending`, `syncing`, `idle`, or `error`), `last_error`, last checked and synced timestamps, `pending_pushes`, the number of queued local changes, and `push_error`, why queued changes cannot currently be sent (null when they can). They never contain the token.

Issue responses include `tracker` link metadata (`provider`, `connection_id`, `remote_id`, `project_id`, `parent_remote_id`, `status_name`, `url`) for synced issues, plus `push_error` when the last push for the issue failed. Remote IDs are strings. Comments sent to or imported from a provider include `tracker` metadata (`provider`, `connection_id`, `remote_id`, `author_name`). `author_name` is the remote author for imported comments and null for sent ones. Clients should ignore other keys in tracker metadata.

## Adding a provider

Generic code owns connection settings and validation, options, scheduling, generation fencing, checkpoint storage, the discovery page store, job dispatch, reconciliation and merging, the outbox, comment import, and error recording. A provider supplies transport, a scan state machine, normalization, and pushes. The registry is enum dispatch over `ProviderKind` in `src/tracker/provider.rs`; the OpenProject module in `src/tracker/openproject.rs` and `src/tracker/openproject/` is the reference.

On the backend:

1. Add a `ProviderKind` variant with its serialized key, and extend `ALL`, `key`, and `name`.
2. Return a `Descriptor` from `descriptor`: the supported direction per `TrackerField`, and the defaults for new connections. Fields a provider cannot send must not support export; `push` never receives them.
3. Implement `valid_id` for remote project and status IDs.
4. Implement the scan. `checkpoint` returns the opaque JSON state of a full scan starting with discovery, `poll` plans the next automatic scan from an idle checkpoint, and `step` fetches and normalizes exactly one page. A page yields `PageData::Projects`, `Statuses`, `People`, or `Issues` as `RemoteProject`, `RemoteStatus`, `RemotePerson`, and `RemoteIssue`, plus the next checkpoint (`None` when the scan is done). `RemoteIssue::updated_at` drives comment fetching. Return `Step::FullRescan` when the tracker rejects an incremental request.
5. Implement `push` for `Push::Fields` (already mapped `FieldValue`s: candidate status IDs, title, description, assignee person ID or none, due date) and `Push::Comment`. Return `Applied` with the created comment ID or resulting status ID, `Rejected` for permanent refusals, `Unavailable` for credential or permission problems, and an error for transient failures.
6. Implement `comments` to list an item's comments, oldest first, as `RemoteComment`s, and `account` to return the integration account's remote user ID. Generic code uses both to import comments and to recognize comments an earlier push already posted.

Messages that reach connection status, `push_error`, or logs must be static text or HTTP status codes, never remote bodies or credentials. Use `tracker::http_client` for requests and keep responses bounded.

On the frontend, add the kind to `TrackerProviderKind` in `web/app/lib/types.ts` and an entry to `trackerProviders` in `web/app/lib/trackers.ts` naming the provider and its URL and token labels. Add those locale keys (`tracker.<kind>.url`, `urlHint`, `token`, `tokenHint`) to both `web/app/locales/en.ts` and `pl.ts`. The wizard renders field toggles from the server descriptor and never hardcodes capabilities.

OpenProject references: [API introduction](https://www.openproject.org/docs/api/introduction/), [work packages](https://www.openproject.org/docs/api/endpoints/work-packages/), [activities](https://www.openproject.org/docs/api/endpoints/activities/), [collections](https://www.openproject.org/docs/api/collections/), and [users](https://www.openproject.org/docs/api/endpoints/users/).
