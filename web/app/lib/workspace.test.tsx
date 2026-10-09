import { useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Outlet, Route, Routes } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it } from "vite-plus/test";
import { Sidebar } from "../components/app/sidebar";
import { IssueBoard } from "../components/app/issue-board";
import { useQueueState } from "../components/app/workbench";
import { IssueList } from "../components/app/issue-list";
import { OfflineBanner } from "../components/app/offline-banner";
import { SaveStatus } from "../components/app/save-status";
import { QueryStatus } from "../components/app/query-status";
import { ToastProvider } from "../components/ui/toast";
import { createEngine, SCHEMA, type SyncEngine } from "../sync/engine";
import { makeIssue, makeTeam, NOW } from "../sync/fixtures";
import { MemoryReplicaStorage } from "../sync/persistence/memory";
import { createTransport } from "../sync/transport";
import { useRecord, useSyncStatus, useView } from "../sync/react";
import { I18nProvider } from "./i18n";
import {
  useActivity,
  useComments,
  useIssueDetail,
  useIssues,
  useNotifications,
  useTimeEntries,
} from "./queries";
import { queryClient, keys } from "./query-client";
import { SessionProvider } from "./session";
import { WorkspaceProvider, useWorkspace } from "./workspace";
import type { Profile, Report } from "./types";
import type { ReactNode } from "react";

const profile: Profile = {
  id: "user",
  email: "user@example.com",
  display_name: "Ada",
  avatar_url: null,
  contact: "",
  language: "en",
  theme: "system",
  alerts: { assignments: true, replies: true, changes: true, deadlines: true },
};
const report: Report = {
  issue_count: 99,
  inbox_unread: 999,
  label_counts: {},
  project_stats: [],
  total_minutes: 123,
  issues: [],
  people: [],
  teams: [],
  projects: [],
  sprints: [],
  delivery: [],
};
const engines: SyncEngine[] = [];
async function fixture() {
  const storage = new MemoryReplicaStorage();
  const replica = await storage.open({
    sessionId: "session",
    workspaceId: "workspace",
    schema: SCHEMA,
  });
  const team = { ...makeTeam(), members: [profile.id] };
  team.stages[0].kind = "planned";
  await replica.writeBootstrap({
    cursor: "1:1:",
    lastMutationId: 0,
    serverSchema: SCHEMA,
    entities: ["workspace", "members", "teams", "issues", "notifications", "time_entries"],
    records: {
      workspace: [{ id: "workspace", name: "Replica workspace", version: 1 }],
      members: [
        {
          id: profile.id,
          email: profile.email,
          display_name: profile.display_name,
          avatar_url: null,
          contact: "",
          role: "owner",
          version: 1,
          team_ids: [team.id],
        },
      ],
      teams: [team],
      issues: [
        makeIssue("issue", {
          title: "Replica issue",
          number: 42,
          parent_id: "parent",
          dependencies: ["blocker"],
        }),
        makeIssue("parent"),
        makeIssue("child", { parent_id: "issue", stage_id: "stage-done" }),
        makeIssue("blocker"),
        makeIssue("dependent", { dependencies: ["issue"] }),
      ],
      notifications: [
        {
          id: "notification",
          version: 1,
          user_id: profile.id,
          issue_id: "issue",
          kind: "assignment",
          message: "Assigned",
          read_at: null,
          created_at: NOW,
          dedup_key: "assigned",
        },
      ],
      time_entries: [
        {
          id: "time",
          version: 1,
          issue_id: "issue",
          user_id: profile.id,
          minutes: 20,
          note: "",
          logged_at: NOW,
        },
      ],
    },
  });
  await replica.writeScope({
    scope: { entity: "comments", issueId: "issue" },
    records: [
      {
        id: "comment",
        version: 1,
        issue_id: "issue",
        author: profile.id,
        body: "Replica comment",
        mentions: [],
        attachments: [],
        created_at: NOW,
        edited_at: null,
      },
    ],
  });
  await replica.writeScope({
    scope: { entity: "activity", entityId: "issue" },
    records: [
      { id: "activity", actor: profile.id, action: "created", entity_id: "issue", at: NOW },
    ],
  });
  replica.close();
  const engine = createEngine({
    storage,
    transport: createTransport({
      fetch: () => {
        throw new Error("Replica rendering must not fetch");
      },
    }),
    sessionId: "session",
    workspaceId: "workspace",
    actor: profile.id,
    schema: SCHEMA,
    randomId: () => crypto.randomUUID(),
    clock: { now: () => NOW, schedule: () => () => {} },
    signals: { getOnline: () => false, subscribe: () => () => {} },
  });
  engines.push(engine);
  await engine.open();
  queryClient.setQueryData(keys.report("workspace"), report);
  return engine;
}
function render(engine: SyncEngine, children: ReactNode) {
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <I18nProvider initial="en">
        <ToastProvider>
          <SessionProvider initial={profile}>
            <WorkspaceProvider engine={engine}>{children}</WorkspaceProvider>
          </SessionProvider>
        </ToastProvider>
      </I18nProvider>
    </QueryClientProvider>,
  );
}
afterEach(async () => {
  for (const engine of engines.splice(0)) await engine.close();
  queryClient.clear();
});

function OrderProbe() {
  const { ws, members } = useWorkspace();
  return (
    <pre>
      {JSON.stringify({
        teams: ws.teams.map((team) => team.name),
        firstStages: ws.teams[0]?.stages.map((stage) => stage.name),
        memberNames: members.map((member) => member.display_name),
        memberIds: ws.members.map((member) => member.user_id),
      })}
    </pre>
  );
}

function HookProbe() {
  const workspace = useWorkspace();
  const detail = useIssueDetail("issue");
  const issues = useIssues();
  const disabled = useIssues({ ids: "" }, false);
  const notifications = useNotifications(true);
  const comments = useComments("issue");
  const activity = useActivity("issue");
  const time = useTimeEntries("issue");
  const allTime = useTimeEntries();
  const record = useRecord("issues", "issue");
  const status = useSyncStatus();
  return (
    <pre>
      {JSON.stringify({
        workspace: workspace.ws.name,
        me: workspace.me,
        role: workspace.role,
        canWrite: workspace.canWrite,
        canAdmin: workspace.canAdmin,
        unread: workspace.unread,
        pending: workspace.pending,
        offline: workspace.offline,
        serverReport: workspace.report.issue_count,
        member: workspace.member("user")?.display_name,
        team: workspace.team("team-1")?.name,
        stage: workspace.stage("stage-todo")?.kind,
        dialogOpen: workspace.create.open,
        issue: detail.issue?.title,
        parent: detail.parent?.id,
        children: detail.children.map((row) => row.id),
        dependents: detail.dependents.map((row) => row.id),
        blockers: detail.blockers.map((row) => row.id),
        counts: [
          detail.issue?.blocked_count,
          detail.issue?.subtask_total,
          detail.issue?.subtask_completed,
        ],
        issueCount: issues.items.length,
        disabledCount: disabled.items.length,
        hasMore: issues.hasMore,
        notification: notifications.items[0]?.id,
        comment: comments.items[0]?.body,
        activity: activity.items[0]?.action,
        minutes: time.items[0]?.minutes,
        allTimeCount: allTime.items.length,
        record: record?.title,
        phase: status.phase,
      })}
    </pre>
  );
}
function ReplicaPage() {
  const issues = useIssues();
  return (
    <>
      <Sidebar onSearch={() => {}} />
      <OfflineBanner />
      <SaveStatus />
      <IssueList issues={issues.items} />
      <QueryStatus query={issues} />
    </>
  );
}

function ReplicaBoard() {
  const { ws } = useWorkspace();
  const state = useQueueState();
  return <IssueBoard team={ws.teams[0]} state={state} title="Team board" heading="Team board" />;
}

function ChangingDependencies() {
  const [updated, setUpdated] = useState(false);
  const options = { updated };
  const title = useView(
    (store) => (options.updated ? store.get("issues", "issue")?.title : "Waiting"),
    ["issues"],
    [options],
  );
  if (!updated) setUpdated(true);
  return <span>{title}</span>;
}

describe("workspace React integration without a DOM", () => {
  it("assembles all workspace fields and local hooks from disk while retaining the cached server report offline", async () => {
    const engine = await fixture();
    const html = render(engine, <HookProbe />);
    const state: unknown = JSON.parse(
      (html.match(/<pre>(.*?)<\/pre>/s)?.[1] ?? "").replaceAll("&quot;", '"'),
    );
    expect(state).toMatchObject({
      workspace: "Replica workspace",
      me: "user",
      role: "owner",
      canWrite: true,
      canAdmin: true,
      unread: 1,
      pending: 0,
      offline: true,
      serverReport: 99,
      member: "Ada",
      team: "Team",
      stage: "planned",
      dialogOpen: false,
      issue: "Replica issue",
      parent: "parent",
      children: ["child"],
      dependents: ["dependent"],
      blockers: ["blocker"],
      counts: [1, 1, 1],
      issueCount: 5,
      disabledCount: 0,
      hasMore: false,
      notification: "notification",
      comment: "Replica comment",
      activity: "created",
      minutes: 20,
      allTimeCount: 1,
      record: "Replica issue",
      phase: "ready",
    });
  });
  it("keeps server order for teams, stages and member lists", async () => {
    const engine = await fixture();
    const reversed = { ...makeTeam("team-alpha"), name: "Alpha" };
    reversed.stages.reverse();
    engine.store.applyBase([
      { entity: "teams", id: "team-zulu", record: { ...makeTeam("team-zulu"), name: "Zulu" } },
      { entity: "teams", id: "team-alpha", record: reversed },
      {
        entity: "members",
        id: "aaa",
        record: {
          id: "aaa",
          email: "bob@example.com",
          display_name: "Bob",
          avatar_url: null,
          contact: "",
          role: "member",
          version: 1,
          team_ids: [],
        },
      },
    ]);
    const html = render(engine, <OrderProbe />);
    expect(
      JSON.parse((html.match(/<pre>(.*?)<\/pre>/s)?.[1] ?? "").replaceAll("&quot;", '"')),
    ).toEqual({
      teams: ["Alpha", "Team", "Zulu"],
      firstStages: ["Todo", "Done"],
      memberNames: ["Ada", "Bob"],
      memberIds: ["aaa", "user"],
    });
  });
  it("accepts fresh dependency objects during local React rerenders", async () => {
    const engine = await fixture();
    expect(render(engine, <ChangingDependencies />)).toContain("Replica issue");
  });
  it("renders the existing issue board columns and replica counts", async () => {
    const engine = await fixture();
    const html = render(
      engine,
      <MemoryRouter initialEntries={["/workspace/team/team-1"]}>
        <ReplicaBoard />
      </MemoryRouter>,
    );
    expect(html).toContain("Team board");
    expect(html).toContain('tabular-nums text-muted-foreground">4</span>');
    expect(html).toContain("Todo");
    expect(html).toContain("Done");
  });
  it("renders the existing sidebar, issue list, offline banner, and save status from an optimistic replica", async () => {
    const engine = await fixture();
    await engine.mutate("update_issue", { id: "issue", patch: { title: "Queued issue" } });
    const html = render(
      engine,
      <MemoryRouter initialEntries={["/workspace/issues"]}>
        <Routes>
          <Route
            element={
              <Outlet
                context={{
                  workspaces: [{ id: "workspace", name: "Replica workspace", version: 1 }],
                }}
              />
            }
          >
            <Route path="/:ws/issues" element={<ReplicaPage />} />
          </Route>
        </Routes>
      </MemoryRouter>,
    );
    expect(html).toContain("Replica workspace");
    expect(html).toContain("Queued issue");
    expect(html).toContain("BW-42");
    expect(html).toContain("Saving");
    expect(html).toContain("lucide-wifi-off");
    expect(html).toContain("Ada");
    expect(html).not.toContain("Load more");
  });
});
