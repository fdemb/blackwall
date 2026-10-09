import { describe, expect, expectTypeOf, it } from "vite-plus/test";
import type { Command } from "../../lib/types";
import { normalize } from "../records";
import type { DeepReadonly } from "../store";
import { MEMBER, TEAM, mutate, seedStore, snapshotIssues } from "./fixtures";
import { MUTATORS, ONLINE_ONLY, createReplay } from "./index";
import type { MutatorName } from "./index";
import type { ArgsOf } from "./common";

/** Every non-online-only command this task covers must have a mutator. */
const TASK_COMMANDS = [
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
] as const satisfies readonly Command["type"][];

type Missing = Exclude<(typeof TASK_COMMANDS)[number], MutatorName>;
type AssertComplete = Missing extends never ? true : false;
const complete: AssertComplete = true;

describe("mutator registry", () => {
  it("registers every command of this task", () => {
    expect(complete).toBe(true);
    for (const name of TASK_COMMANDS) expect(name in MUTATORS).toBe(true);
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
        priority: "normal",
        labels: [],
        estimate: null,
        deadline: null,
        project_id: null,
        milestone_id: null,
        sprint_id: null,
        parent_id: null,
        dependencies: [],
        position: 0,
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
