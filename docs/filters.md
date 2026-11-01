# Issue filters

One filter object drives the issue list API, the local replica query and saved views. The server
stores it as JSON on `saved_views.filter`, and the client predicts that stored form exactly, so the
rules below bind both sides.

## Shape

```json
{
  "where": [
    { "field": "assignee", "op": "is", "values": ["<user uuid>", null] },
    { "field": "priority", "op": "gte", "values": ["high"] },
    { "field": "deadline", "op": "lte", "values": ["+7d"] }
  ],
  "search": "login",
  "trash": false,
  "archived": false,
  "ids": null,
  "sort": "position",
  "group_by": null,
  "after": null,
  "projection": "full"
}
```

`where` is a list of clauses. Every clause must hold for an issue to match. Inside one clause the
values are alternatives: `is` with two values reads "is either of". An absent `where` is an empty
list. An explicit `null` is rejected.

`search`, `trash`, `archived`, `sort`, `group_by`, `ids`, `after` and `projection` keep their
previous meaning. `ids`, `after` and `projection` are REST-only and the replica ignores them.

On `GET /internal-api/workspaces/{id}/issues` the `where` parameter carries the JSON array as a string:

```
GET /internal-api/workspaces/{id}/issues?where=[{"field":"stage_kind","op":"is_not","values":["done","cancelled"]}]
```

## Fields

| field | values | `null` means | ops |
| --- | --- | --- | --- |
| `assignee` | user ids | unassigned | is, is_not |
| `created_by` | user ids | no recorded creator | is, is_not |
| `team_id` | team ids | not allowed | is, is_not |
| `stage_id` | stage ids | not allowed | is, is_not |
| `stage_kind` | `backlog` `planned` `active` `done` `cancelled` | not allowed | is, is_not |
| `priority` | `none` `low` `normal` `high` `urgent` | not allowed | is, is_not, lt, lte, gt, gte |
| `labels` | label ids | no labels | is, is_not |
| `project_id` | project ids | no project | is, is_not |
| `milestone_id` | milestone ids | no milestone | is, is_not |
| `sprint_id` | sprint ids | no sprint | is, is_not |
| `parent_id` | issue ids | top-level issue | is, is_not |
| `dependencies` | issue ids | no dependencies | is, is_not |
| `estimate` | non-negative integers as decimal strings | no estimate | all |
| `deadline` | timestamp or relative day | no deadline | all |
| `created_at` | timestamp or relative day | not allowed | all |
| `updated_at` | timestamp or relative day | not allowed | all |

Values are always JSON strings or `null`. The server stores them as sent: it validates but does
not reformat UUIDs or timestamps.

`labels` and `dependencies` hold sets. `is` matches an issue that carries any listed id, `is_not`
one that carries none. `null` stands for the empty set.

`stage_kind` reads the kind of the issue's stage. `stage_kind is_not done, cancelled` is the open
filter.

Priority orders `none < low < normal < high < urgent`, so `priority gte high` is high or urgent.

## Operators

`is` matches when the field equals any value. For `null` it matches an empty field. `is_not` is the
exact complement over the same values, so `assignee is_not <alice>` also matches unassigned issues.

`lt`, `lte`, `gt` and `gte` take exactly one value, never `null`, and never match an empty field.

## Relative days

A date value of the form `+7d`, `-30d` or `+0d` resolves when the filter runs to the end of the day
that many days from today. `deadline lte +0d` is "due by the end of today", `deadline lt -1d` is
overdue, `updated_at gte -7d` is "touched in the last seven days". The client uses the local
calendar day, the server the UTC day. Saved views keep the relative form, so they stay current.

Absolute values are RFC 3339 timestamps with an offset.

## Limits and errors

- at most 32 clauses, each with 1 to 200 values
- a comparison with zero, several or null values is rejected
- an op the field does not support is rejected
- a value that does not parse for its field is rejected

Every rejection is a 400 with a message that names the problem. The client raises the same message
from `filterIssues` and from the `save_view` and `update_view` mutators, so admission fails the way
the server would.

## Scope filters in the UI

Pages add their own clauses on top of the person's filter: the team page adds `team_id is <team>`,
its Active view adds `stage_kind is planned, active`, its Backlog view adds `stage_kind is backlog`,
and its All issues view adds nothing more. The filter bar hides those fields, and a person's clause
on a scoped field is dropped before the scope's clause is appended. Saving a view stores the merged
filter.

The board leaves collapsed columns out of its list with `stage_id is_not <collapsed stages>`, and
counts their issues with `stage_id is <collapsed stages>`. Both clauses go on after the merge, so a
stage filter of the person's own still applies.
