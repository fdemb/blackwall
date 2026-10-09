import { describe, expect, expectTypeOf, it } from "vite-plus/test";
import type { Command } from "../../lib/types";
import { normalize } from "../records";
import type { DeepReadonly } from "../store";
import { MEMBER, TEAM, mutate, seedStore, snapshotIssues } from "./fixtures";
import {
  MUTATORS,
  ONLINE_ONLY,
  admit,
  createdIds,
  createdLabel,
  createReplay,
  createsRecord,
} from "./index";
import type { MutatorName, OnlineOnly } from "./index";
import type { ArgsOf } from "./common";

/**
 * Every command in the `Command` union, plus the online-only upload commands,
 * which the frontend sends through the REST upload endpoint and which are
 * absent from the push union. The `satisfies` annotation rejects an unknown
 * name, and `AssertListed` below rejects a missing union member, so adding a
 * command to the union breaks this test until it gains a mutator or joins
 * `ONLINE_ONLY`.
 */
const ALL_COMMANDS = [
  "create_issue",
  "update_issue",
  "move_issue",
  "bulk_issues",
  "delete_issue",
  "restore_issue",
  "archive_issue",
  "unarchive_issue",
  "follow",
  "add_source_link",
  "remove_attachment",
  "create_team",
  "set_team_members",
  "set_team_archive",
  "create_stage",
  "update_stage",
  "delete_stage",
  "create_label",
  "update_label",
  "create_project",
  "update_project",
  "create_milestone",
  "update_milestone",
  "create_sprint",
  "update_sprint",
  "complete_sprint",
  "archive_sprint",
  "add_comment",
  "edit_comment",
  "delete_comment",
  "log_time",
  "update_time",
  "delete_time",
  "save_view",
  "update_view",
  "delete_view",
  "invite",
  "resend_invitation",
  "cancel_invitation",
  "set_role",
  "remove_member",
  "mark_notification_read",
  "mark_notification_unread",
  "mark_all_notifications_read",
  "configure_alerts",
  "create_integration",
  "update_integration",
  "delete_integration",
  "import_issues",
  "add_attachment",
  "attach_comment_file",
] as const satisfies readonly (Command["type"] | OnlineOnly)[];

type Missing = Exclude<Command["type"], MutatorName | OnlineOnly>;
type AssertComplete = Missing extends never ? true : false;
const complete: AssertComplete = true;

type Unlisted = Exclude<Command["type"], (typeof ALL_COMMANDS)[number]>;
type AssertListed = Unlisted extends never ? true : false;
const listed: AssertListed = true;

describe("mutator registry", () => {
  it("registers every command in the union or marks it online-only", () => {
    expect(complete).toBe(true);
    expect(listed).toBe(true);
    expect(ALL_COMMANDS.length).toBe(new Set(ALL_COMMANDS).size);
    for (const name of ALL_COMMANDS) {
      const registered = name in MUTATORS;
      const online = (ONLINE_ONLY as readonly string[]).includes(name);
      expect(registered !== online).toBe(true);
    }
  });

  it("keeps online-only commands without mutators", () => {
    expect([...ONLINE_ONLY]).toEqual([
      "invite",
      "resend_invitation",
      "create_integration",
      "set_role",
      "remove_member",
      "import_issues",
      "add_attachment",
      "attach_comment_file",
    ]);
    for (const name of ONLINE_ONLY) expect(name in MUTATORS).toBe(false);
  });

  it("rejects unknown names with a 400 and leaves the view alone", () => {
    const store = seedStore();
    const before = snapshotIssues(store);
    const id = mutate(store, "no_such_command", {});
    const error = store.replayErrors().get(id);
    expect(error?.status).toBe(400);
    expect(error?.message).toBe("unknown command no_such_command");
    expect(snapshotIssues(store)).toEqual(before);
  });

  it("rejects inherited properties like toString in both modes", () => {
    const store = seedStore();
    const before = snapshotIssues(store);
    const id = mutate(store, "toString", {});
    expect(store.replayErrors().get(id)?.status).toBe(400);
    expect(store.replayErrors().get(id)?.message).toBe("unknown command toString");
    expect(snapshotIssues(store)).toEqual(before);
    let error: unknown;
    try {
      admit(store, MEMBER, { name: "toString", args: {}, at: "2026-10-09T12:00:00.000000Z" });
    } catch (caught) {
      error = caught;
    }
    expect((error as { status?: number })?.status).toBe(400);
  });

  it("uses the mutation time and the replay actor", () => {
    const store = seedStore();
    const at = "2026-10-10T08:00:00.000000Z";
    mutate(store, "create_issue", { input: { id: "issue-actor", title: "A", team_id: TEAM } }, at);
    const created = store.get("issues", "issue-actor");
    expect(created?.created_by).toBe(MEMBER);
    expect(created?.followers).toEqual([MEMBER]);
    expect(created?.created_at).toBe(at);

    mutate(store, "delete_issue", { id: "issue-actor" }, at);
    expect(store.get("issues", "issue-actor")?.deleted_at).toBe(at);
  });

  it("matches the Command union arg types", () => {
    expectTypeOf(MUTATORS.create_issue)
      .parameter(1)
      .toEqualTypeOf<DeepReadonly<ArgsOf<"create_issue">>>();
    expectTypeOf(MUTATORS.update_issue)
      .parameter(1)
      .toEqualTypeOf<DeepReadonly<ArgsOf<"update_issue">>>();
    expectTypeOf(MUTATORS.move_issue)
      .parameter(1)
      .toEqualTypeOf<DeepReadonly<ArgsOf<"move_issue">>>();
    expectTypeOf(MUTATORS.bulk_issues)
      .parameter(1)
      .toEqualTypeOf<DeepReadonly<ArgsOf<"bulk_issues">>>();
    expectTypeOf(MUTATORS.delete_issue)
      .parameter(1)
      .toEqualTypeOf<DeepReadonly<ArgsOf<"delete_issue">>>();
    expectTypeOf(MUTATORS.restore_issue)
      .parameter(1)
      .toEqualTypeOf<DeepReadonly<ArgsOf<"restore_issue">>>();
    expectTypeOf(MUTATORS.archive_issue)
      .parameter(1)
      .toEqualTypeOf<DeepReadonly<ArgsOf<"archive_issue">>>();
    expectTypeOf(MUTATORS.unarchive_issue)
      .parameter(1)
      .toEqualTypeOf<DeepReadonly<ArgsOf<"unarchive_issue">>>();
    expectTypeOf(MUTATORS.follow).parameter(1).toEqualTypeOf<DeepReadonly<ArgsOf<"follow">>>();
    expectTypeOf(MUTATORS.add_source_link)
      .parameter(1)
      .toEqualTypeOf<DeepReadonly<ArgsOf<"add_source_link">>>();
    expectTypeOf(MUTATORS.remove_attachment)
      .parameter(1)
      .toEqualTypeOf<DeepReadonly<ArgsOf<"remove_attachment">>>();
    expectTypeOf(MUTATORS.create_team)
      .parameter(1)
      .toEqualTypeOf<DeepReadonly<ArgsOf<"create_team">>>();
    expectTypeOf(MUTATORS.set_team_members)
      .parameter(1)
      .toEqualTypeOf<DeepReadonly<ArgsOf<"set_team_members">>>();
    expectTypeOf(MUTATORS.set_team_archive)
      .parameter(1)
      .toEqualTypeOf<DeepReadonly<ArgsOf<"set_team_archive">>>();
    expectTypeOf(MUTATORS.create_stage)
      .parameter(1)
      .toEqualTypeOf<DeepReadonly<ArgsOf<"create_stage">>>();
    expectTypeOf(MUTATORS.update_stage)
      .parameter(1)
      .toEqualTypeOf<DeepReadonly<ArgsOf<"update_stage">>>();
    expectTypeOf(MUTATORS.delete_stage)
      .parameter(1)
      .toEqualTypeOf<DeepReadonly<ArgsOf<"delete_stage">>>();
    expectTypeOf(MUTATORS.create_label)
      .parameter(1)
      .toEqualTypeOf<DeepReadonly<ArgsOf<"create_label">>>();
    expectTypeOf(MUTATORS.update_label)
      .parameter(1)
      .toEqualTypeOf<DeepReadonly<ArgsOf<"update_label">>>();
    expectTypeOf(MUTATORS.create_project)
      .parameter(1)
      .toEqualTypeOf<DeepReadonly<ArgsOf<"create_project">>>();
    expectTypeOf(MUTATORS.update_project)
      .parameter(1)
      .toEqualTypeOf<DeepReadonly<ArgsOf<"update_project">>>();
    expectTypeOf(MUTATORS.create_milestone)
      .parameter(1)
      .toEqualTypeOf<DeepReadonly<ArgsOf<"create_milestone">>>();
    expectTypeOf(MUTATORS.update_milestone)
      .parameter(1)
      .toEqualTypeOf<DeepReadonly<ArgsOf<"update_milestone">>>();
    expectTypeOf(MUTATORS.create_sprint)
      .parameter(1)
      .toEqualTypeOf<DeepReadonly<ArgsOf<"create_sprint">>>();
    expectTypeOf(MUTATORS.update_sprint)
      .parameter(1)
      .toEqualTypeOf<DeepReadonly<ArgsOf<"update_sprint">>>();
    expectTypeOf(MUTATORS.complete_sprint)
      .parameter(1)
      .toEqualTypeOf<DeepReadonly<ArgsOf<"complete_sprint">>>();
    expectTypeOf(MUTATORS.archive_sprint)
      .parameter(1)
      .toEqualTypeOf<DeepReadonly<ArgsOf<"archive_sprint">>>();
    expectTypeOf(MUTATORS.add_comment)
      .parameter(1)
      .toEqualTypeOf<DeepReadonly<ArgsOf<"add_comment">>>();
    expectTypeOf(MUTATORS.edit_comment)
      .parameter(1)
      .toEqualTypeOf<DeepReadonly<ArgsOf<"edit_comment">>>();
    expectTypeOf(MUTATORS.delete_comment)
      .parameter(1)
      .toEqualTypeOf<DeepReadonly<ArgsOf<"delete_comment">>>();
    expectTypeOf(MUTATORS.log_time).parameter(1).toEqualTypeOf<DeepReadonly<ArgsOf<"log_time">>>();
    expectTypeOf(MUTATORS.update_time)
      .parameter(1)
      .toEqualTypeOf<DeepReadonly<ArgsOf<"update_time">>>();
    expectTypeOf(MUTATORS.delete_time)
      .parameter(1)
      .toEqualTypeOf<DeepReadonly<ArgsOf<"delete_time">>>();
    expectTypeOf(MUTATORS.save_view)
      .parameter(1)
      .toEqualTypeOf<DeepReadonly<ArgsOf<"save_view">>>();
    expectTypeOf(MUTATORS.update_view)
      .parameter(1)
      .toEqualTypeOf<DeepReadonly<ArgsOf<"update_view">>>();
    expectTypeOf(MUTATORS.delete_view)
      .parameter(1)
      .toEqualTypeOf<DeepReadonly<ArgsOf<"delete_view">>>();
    expectTypeOf(MUTATORS.cancel_invitation)
      .parameter(1)
      .toEqualTypeOf<DeepReadonly<ArgsOf<"cancel_invitation">>>();
    expectTypeOf(MUTATORS.mark_notification_read)
      .parameter(1)
      .toEqualTypeOf<DeepReadonly<ArgsOf<"mark_notification_read">>>();
    expectTypeOf(MUTATORS.mark_notification_unread)
      .parameter(1)
      .toEqualTypeOf<DeepReadonly<ArgsOf<"mark_notification_unread">>>();
    expectTypeOf(MUTATORS.mark_all_notifications_read)
      .parameter(1)
      .toEqualTypeOf<DeepReadonly<ArgsOf<"mark_all_notifications_read">>>();
    expectTypeOf(MUTATORS.configure_alerts)
      .parameter(1)
      .toEqualTypeOf<DeepReadonly<ArgsOf<"configure_alerts">>>();
    expectTypeOf(MUTATORS.update_integration)
      .parameter(1)
      .toEqualTypeOf<DeepReadonly<ArgsOf<"update_integration">>>();
    expectTypeOf(MUTATORS.delete_integration)
      .parameter(1)
      .toEqualTypeOf<DeepReadonly<ArgsOf<"delete_integration">>>();
    expectTypeOf<OnlineOnly>().toEqualTypeOf<
      | "invite"
      | "resend_invitation"
      | "create_integration"
      | "set_role"
      | "remove_member"
      | "import_issues"
      | "add_attachment"
      | "attach_comment_file"
    >();
  });

  it("declares the ids and the typed name of every create command", () => {
    type CreateName =
      | "create_issue"
      | "create_team"
      | "create_stage"
      | "create_label"
      | "create_project"
      | "create_milestone"
      | "create_sprint"
      | "add_comment"
      | "log_time"
      | "save_view"
      | "create_integration";
    // Typed against each command's args, so a sample that drifts from the union fails to compile.
    const samples: { [T in CreateName]: { args: ArgsOf<T>; ids: string[]; label: string | null } } =
      {
        create_issue: {
          args: { input: { id: "issue-1", title: "Bug", team_id: TEAM } },
          ids: ["issue-1"],
          label: "Bug",
        },
        create_team: {
          args: {
            id: "team-1",
            name: "Ops",
            members: [],
            default_stage_ids: ["stage-1", "stage-2"],
          },
          ids: ["team-1", "stage-1", "stage-2"],
          label: "Ops",
        },
        create_stage: {
          args: { id: "stage-1", team_id: TEAM, name: "Review", kind: "planned", position: 1 },
          ids: ["stage-1"],
          label: "Review",
        },
        create_label: {
          args: { id: "label-1", name: "Bug", color: "#f00" },
          ids: ["label-1"],
          label: "Bug",
        },
        create_project: {
          args: { id: "project-1", name: "Launch", description: "", team_ids: [TEAM] },
          ids: ["project-1"],
          label: "Launch",
        },
        create_milestone: {
          args: { id: "milestone-1", project_id: "project-1", name: "Beta", deadline: null },
          ids: ["milestone-1"],
          label: "Beta",
        },
        create_sprint: {
          args: {
            id: "sprint-1",
            team_id: TEAM,
            name: "Sprint 1",
            goal: "",
            starts_at: "2026-10-09",
            ends_at: "2026-10-16",
          },
          ids: ["sprint-1"],
          label: "Sprint 1",
        },
        add_comment: {
          args: { id: "comment-1", issue_id: "issue-1", body: "Hi", mentions: [], attachments: [] },
          ids: ["comment-1"],
          label: null,
        },
        log_time: {
          args: {
            id: "time-1",
            issue_id: "issue-1",
            minutes: 5,
            note: "",
            logged_at: "2026-10-09T12:00:00Z",
          },
          ids: ["time-1"],
          label: null,
        },
        save_view: {
          args: { id: "view-1", name: "Mine", shared: false, filter: {} },
          ids: ["view-1"],
          label: "Mine",
        },
        create_integration: {
          args: { id: "hook-1", name: "Hook", webhook_url: "https://example.test", secret: "s" },
          ids: ["hook-1"],
          label: "Hook",
        },
      };
    for (const [name, sample] of Object.entries(samples)) {
      expect(createsRecord(name), name).toBe(true);
      expect(createdIds({ name, args: sample.args }), name).toEqual(sample.ids);
      expect(createdLabel({ name, args: sample.args }), name).toBe(sample.label);
    }
    expect(createsRecord("update_issue")).toBe(false);
    expect(createdIds({ name: "update_issue", args: { id: "issue-1" } })).toEqual([]);
    expect(createdLabel(null)).toBeNull();
  });

  it("predicts whole records, not single fields", () => {
    const store = seedStore();
    mutate(store, "create_issue", { input: { id: "issue-round", title: "Round", team_id: TEAM } });
    const replayed = store.get("issues", "issue-round");
    expect(replayed).toEqual(
      normalize("issues", {
        openproject: null,
        id: "issue-round",
        version: 1,
        number: null,
        title: "Round",
        description: "",
        team_id: TEAM,
        stage_id: "stage-backlog",
        assignee: null,
        created_by: MEMBER,
        priority: "none",
        labels: [],
        estimate: null,
        deadline: null,
        project_id: null,
        milestone_id: null,
        sprint_id: null,
        parent_id: null,
        dependencies: [],
        position: 2048,
        followers: [MEMBER],
        attachments: [],
        source_links: [],
        deleted_at: null,
        archived_at: null,
        done_at: null,
        created_at: "2026-10-09T12:00:00.000000Z",
        updated_at: "2026-10-09T12:00:00.000000Z",
      }),
    );
    expect(createReplay).toBeDefined();
  });
});
