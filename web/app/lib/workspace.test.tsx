import "fake-indexeddb/auto";
import { IDBFactory } from "fake-indexeddb";
import { useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  createMemoryRouter,
  MemoryRouter,
  Outlet,
  Route,
  Routes,
  RouterProvider,
} from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import General from "../routes/settings-general";
import Members, { InvitationLink } from "../routes/settings-members";
import Security from "../routes/settings-security";
import { Sidebar } from "../components/app/sidebar";
import { AttachButton, useUploader } from "../components/app/issue-content";
import { IssueBoard } from "../components/app/issue-board";
import { useQueueState } from "../components/app/workbench";
import { IssueList } from "../components/app/issue-list";
import { OfflineBanner } from "../components/app/offline-banner";
import { SaveStatus } from "../components/app/save-status";
import { CoreProperties } from "../components/app/issue-properties";
import { Timeline } from "../components/app/issue-timeline";
import { QueryStatus } from "../components/app/query-status";
import { ToastProvider, useToast } from "../components/ui/toast";
import { createEngine, SCHEMA, type SyncEngine } from "../sync/engine";
import { makeIssue, makeTeam, NOW } from "../sync/fixtures";
import { MutationError } from "../sync/mutators";
import { IDB_VERSION, IndexedDBReplicaStorage } from "../sync/persistence/idb";
import type { ReplicaStorage } from "../sync/persistence/types";
import { MemoryReplicaStorage } from "../sync/persistence/memory";
import { createTransport } from "../sync/transport";
import { useRecord, useSyncStatus, useView } from "../sync/react";
import { I18nProvider } from "./i18n";
import {
  countedIssue,
  useActivity,
  useComments,
  useIssueDetail,
  useIssues,
  useNotifications,
  useTimeEntries,
} from "./queries";
import { queryClient } from "./query-client";
import { useIssueCount } from "./stats";
import { SessionProvider } from "./session";
import { WorkspaceProvider, useWorkspace } from "./workspace";
import type { Language, Profile, Role, TrackerLink } from "./types";
import type { ReactNode } from "react";

const profile: Profile = {
  id: "user",
  email: "user@example.com",
  display_name: "Ada",
  avatar_url: null,
  contact: "",
  language: "en",
  theme: "system",
};
const engines: SyncEngine[] = [];
async function fixture({
  online = false,
  otherMember = false,
  storage = new MemoryReplicaStorage(),
  teamId = "team-1",
  role = "owner",
  scopes = ["comments", "activity"],
}: {
  online?: boolean;
  otherMember?: boolean;
  storage?: ReplicaStorage;
  teamId?: string;
  role?: Role;
  scopes?: readonly ("comments" | "activity")[];
} = {}) {
  const replica = await storage.open({
    userId: profile.id,
    workspaceId: "workspace",
    schema: SCHEMA,
  });
  const team = { ...makeTeam(teamId), members: [profile.id] };
  team.stages[0].kind = "planned";
  await replica.writeBootstrap({
    cursor: "1:1:",
    lastMutationId: 0,
    serverSchema: SCHEMA,
    entities: ["workspace", "members", "teams", "issues", "notifications", "time_entries"],
    records: {
      workspace: [{ id: "workspace", name: "Replica workspace", slug: "workspace", version: 1 }],
      members: [
        {
          id: profile.id,
          email: profile.email,
          display_name: profile.display_name,
          avatar_url: null,
          contact: "",
          role,
          version: 1,
          team_ids: [team.id],
        },
        ...(otherMember
          ? [
              {
                id: "other",
                email: "grace@example.com",
                display_name: "Grace",
                avatar_url: null,
                contact: "",
                role: "member" as const,
                version: 1,
                team_ids: [team.id],
              },
            ]
          : []),
      ],
      teams: [team],
      issues: [
        makeIssue("issue", {
          team_id: teamId,
          title: "Replica issue",
          number: 42,
          parent_id: "parent",
          dependencies: ["blocker"],
        }),
        makeIssue("parent", { team_id: teamId }),
        makeIssue("child", { team_id: teamId, parent_id: "issue", stage_id: "stage-done" }),
        makeIssue("blocker", { team_id: teamId }),
        makeIssue("dependent", { team_id: teamId, dependencies: ["issue"] }),
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
  if (scopes.includes("comments"))
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
  if (scopes.includes("activity"))
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
    workspaceId: "workspace",
    actor: profile.id,
    schema: SCHEMA,
    randomId: () => crypto.randomUUID(),
    clock: { now: () => NOW, schedule: () => () => {} },
    signals: { getOnline: () => online, subscribe: () => () => {} },
  });
  engines.push(engine);
  await engine.open();
  return engine;
}
function render(engine: SyncEngine, children: ReactNode, language: Language = "en") {
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <I18nProvider initial={language}>
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
  const liveIssues = useIssueCount();
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
        liveIssues,
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
  it("assembles all workspace fields and local hooks from disk while offline", async () => {
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
      liveIssues: 5,
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
    // The board scopes its query with a team clause, and clause values must be UUIDs.
    const teamId = "11111111-1111-4111-8111-000000000001";
    const engine = await fixture({ teamId });
    const html = render(
      engine,
      <MemoryRouter initialEntries={[`/workspace/team/${teamId}`]}>
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
                  workspaces: [
                    { id: "workspace", name: "Replica workspace", slug: "workspace", version: 1 },
                  ],
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
    expect(html).toContain("TEAM-42");
    expect(html).toContain("Waiting to sync");
    expect(html).toContain("lucide-wifi-off");
    expect(html).not.toContain("Load more");
  });
});

function CoreProbe({ synced = false }: { synced?: boolean }) {
  const { issue } = useIssueDetail("issue");
  if (!issue) return null;
  const tracker: TrackerLink | null = synced
    ? {
        provider: "openproject",
        connection_id: "conn",
        remote_id: "7",
        project_id: "9",
        status_name: "New",
        url: "https://op.example.com/work_packages/7",
      }
    : null;
  return <CoreProperties issue={{ ...issue, tracker }} />;
}

describe("issue team picker", () => {
  it("offers every team and stays fixed for synced issues", async () => {
    const engine = await fixture();
    const teamButton = (html: string) => buttonTags(html, 'aria-label="Team"');
    const local = render(engine, <CoreProbe />);
    expect(local).toContain('<option value="team-1" selected="">Team</option>');
    expect(teamButton(local)).toHaveLength(1);
    expect(teamButton(local)[0]).not.toContain('disabled=""');
    expect(teamButton(render(engine, <CoreProbe synced />))[0]).toContain('disabled=""');
  });
});

/** The opening tag of each button whose markup contains the label. */
function buttonTags(html: string, label: string): string[] {
  return html
    .split("<button")
    .slice(1)
    .map((part) => part.slice(0, part.indexOf("</button>")))
    .filter((part) => part.includes(label))
    .map((part) => part.slice(0, part.indexOf(">") + 1));
}

function AttachProbe() {
  const uploader = useUploader("issue");
  return <AttachButton uploader={uploader} />;
}

describe("online-only controls", () => {
  it.each([false, true])(
    "disables connection-only controls while offline (online: %s)",
    async (online) => {
      const engine = await fixture({ online, otherMember: true });
      const router = createMemoryRouter([{ path: "/", Component: Members }]);
      const members = render(engine, <RouterProvider router={router} />);
      const attach = render(engine, <AttachProbe />);
      // Disabled exactly while offline. The class list has `disabled:` variants, so match the attribute.
      const expectGated = (html: string, label: string) => {
        const tags = buttonTags(html, label);
        expect(tags, label).toHaveLength(1);
        expect(/ disabled=""/.test(tags[0]), label).toBe(!online);
      };
      expectGated(members, "Invite people");
      expectGated(members, "Role of Grace");
      expectGated(members, "More actions: Grace");
      expectGated(attach, "Attach files");
    },
  );
});

describe("members list", () => {
  it("shows each member's teams", async () => {
    const engine = await fixture({ otherMember: true });
    const router = createMemoryRouter([{ path: "/", Component: Members }]);
    const html = render(engine, <RouterProvider router={router} />);
    const row = (name: string) => html.split('role="row"').find((r) => r.includes(`>${name}<`))!;
    expect(row("Ada")).toContain(">TEAM<");
    expect(row("Ada")).not.toContain("No teams");
    expect(row("Grace")).toContain("No teams");
    expect(row("Grace")).not.toContain(">TEAM<");
  });
});

describe("workspace settings", () => {
  it("lets the only owner rename and hand over the workspace, but not leave it", async () => {
    const engine = await fixture({ online: true, otherMember: true });
    const router = createMemoryRouter([{ path: "/", Component: General }]);
    const html = render(engine, <RouterProvider router={router} />);
    expect(html).toContain('value="Replica workspace"');
    expect(html).toContain('value="workspace"');
    expect(html).toContain("Transfer ownership");
    expect(html).toContain("You&#x27;re the only owner.");
    expect(html).toContain("Changes apply to everyone in the workspace.");
    expect(/ disabled=""/.test(buttonTags(html, "Leave")[0])).toBe(true);
  });

  it("describes the URL field with the broken-links warning", async () => {
    const engine = await fixture({ online: true });
    const router = createMemoryRouter([{ path: "/", Component: General }]);
    const html = render(engine, <RouterProvider router={router} />);
    const input = /<input[^>]*value="workspace"[^>]*>/.exec(html)?.[0] ?? "";
    const ids = /aria-describedby="([^"]*)"/.exec(input)?.[1].split(" ") ?? [];
    const description = ids
      .map((id) => new RegExp(`id="${id}"[^>]*>([^<]*)<`).exec(html)?.[1] ?? "")
      .join(" ");
    expect(description).toContain("Changing it breaks links that use the old address.");
  });

  it("shows members the workspace read-only and lets them leave", async () => {
    const engine = await fixture({ online: true, otherMember: true, role: "member" });
    const router = createMemoryRouter([{ path: "/", Component: General }]);
    const html = render(engine, <RouterProvider router={router} />);
    expect(html).toContain("Replica workspace");
    expect(html).toContain("2 members");
    expect(html).not.toContain("<input");
    expect(html).not.toContain("Transfer ownership");
    expect(html).not.toContain("Changes apply to everyone in the workspace.");
    expect(/ disabled=""/.test(buttonTags(html, "Leave")[0])).toBe(false);
  });
});

describe("invitation link", () => {
  it("shows a copyable link that opens the welcome page with the workspace and token", async () => {
    vi.stubGlobal("window", {
      ...globalThis.window,
      location: { origin: "https://bw.example.com" },
    });
    const engine = await fixture({ online: true });
    const html = render(engine, <InvitationLink token="a/b+c=" />);
    expect(html).toContain(
      "https://bw.example.com/welcome?workspace=workspace&amp;token=a%2Fb%2Bc%3D",
    );
    expect(buttonTags(html, "Copy link")).toHaveLength(1);
    vi.unstubAllGlobals();
  });
});

describe("security settings", () => {
  it.each([false, true])(
    "lists sessions and offers sign-out for the other ones (online: %s)",
    async (online) => {
      const engine = await fixture({ online });
      queryClient.setQueryData(
        ["sessions"],
        [
          {
            id: "here",
            created_at: NOW,
            last_seen_at: NOW,
            user_agent: "Mozilla/5.0 (X11; Linux x86_64; rv:139.0) Gecko/20100101 Firefox/139.0",
            current: true,
          },
          {
            id: "phone",
            created_at: NOW,
            last_seen_at: null,
            user_agent: null,
            current: false,
          },
        ],
      );
      const router = createMemoryRouter([{ path: "/", Component: Security }]);
      const html = render(engine, <RouterProvider router={router} />);
      expect(html).toContain("Firefox on Linux");
      expect(html).toContain("This browser");
      expect(html).toContain("Unknown device");
      expect(buttonTags(html, "Sign out: Firefox on Linux")).toHaveLength(0);
      const revoke = buttonTags(html, "Sign out: Unknown device");
      expect(revoke).toHaveLength(1);
      expect(/ disabled=""/.test(revoke[0])).toBe(!online);
      expect(buttonTags(html, "Sign out other sessions")).toHaveLength(1);
    },
  );
});

type Upload = ReturnType<typeof useWorkspace>["upload"];
type Toast = ReturnType<typeof useToast>;
function UploadProbeComponent({ observe }: { observe: (upload: Upload, toast: Toast) => void }) {
  const { upload } = useWorkspace();
  observe(upload, useToast());
  return null;
}
/** Renders the workspace offline and returns the upload callback with the toast API it reports to. */
function uploadAndToast(engine: SyncEngine) {
  let seen: { upload: Upload; toast: Toast } | undefined;
  render(engine, <UploadProbeComponent observe={(upload, toast) => (seen = { upload, toast })} />);
  return seen!;
}

describe("upload failures", () => {
  it("reports an offline upload with one toast", async () => {
    const engine = await fixture();
    const { upload, toast } = uploadAndToast(engine);
    const error = vi.spyOn(toast, "error");
    await expect(upload("issue", new File(["x"], "a.txt"))).rejects.toThrow("online connection");
    expect(error).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith(
      "This needs a connection to the server. Reconnect, then try again.",
    );
  });
  it("leaves reporting to a caller that passes quiet", async () => {
    const engine = await fixture();
    const { upload, toast } = uploadAndToast(engine);
    const error = vi.spyOn(toast, "error");
    await expect(upload("issue", new File(["x"], "a.txt"), { quiet: true })).rejects.toThrow(
      "online connection",
    );
    expect(error).not.toHaveBeenCalled();
  });
});

type Run = ReturnType<typeof useWorkspace>["run"];
function RunProbeComponent({ observe }: { observe: (run: Run, toast: Toast) => void }) {
  const { run } = useWorkspace();
  observe(run, useToast());
  return null;
}

describe("online command failures", () => {
  it("reports a server rejection with one toast, since online commands emit no rejection event", async () => {
    const engine = await fixture({ online: true });
    vi.spyOn(engine, "runOnline").mockRejectedValue(new MutationError(403, "Owners only"));
    let seen: { run: Run; toast: Toast } | undefined;
    render(engine, <RunProbeComponent observe={(run, toast) => (seen = { run, toast })} />);
    if (!seen) throw new Error("Workspace callbacks missing");
    const error = vi.spyOn(seen.toast, "error");
    await expect(seen.run({ type: "set_role", user_id: "user", role: "viewer" })).rejects.toThrow(
      "Owners only",
    );
    expect(error).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledWith("Owners only");
  });
});

describe("outdated workspace", () => {
  it.each(["en", "pl"] satisfies Language[])(
    "rejects edits and uses the existing toast in %s",
    async (language) => {
      const database = new IDBFactory();
      const engine = await fixture({
        storage: new IndexedDBReplicaStorage({ indexedDB: database }),
      });
      const upgraded = await new IndexedDBReplicaStorage({
        indexedDB: database,
        version: IDB_VERSION + 1,
      }).open({
        userId: profile.id,
        workspaceId: "workspace",
        schema: SCHEMA,
      });
      try {
        let seen: { run: Run; toast: Toast } | undefined;
        render(
          engine,
          <RunProbeComponent observe={(run, toast) => (seen = { run, toast })} />,
          language,
        );
        if (!seen) throw new Error("Workspace callbacks missing");
        const notify = vi.spyOn(seen.toast, "error");
        const message =
          language === "en"
            ? "A newer version is open in another tab. Reload to continue."
            : "W innej karcie otwarto nowszą wersję. Odśwież stronę, aby kontynuować.";
        await expect(
          seen.run({ type: "update_issue", id: "issue", patch: { title: "Blocked" } }),
        ).rejects.toThrow(message);
        expect(notify).toHaveBeenCalledOnce();
        expect(notify).toHaveBeenCalledWith(message);
        expect(engine.store.get("issues", "issue")?.title).toBe("Replica issue");
        expect(engine.store.pending()).toHaveLength(0);
      } finally {
        upgraded.close();
      }
    },
  );
});

describe("issue timeline", () => {
  const timeline = (engine: SyncEngine) =>
    render(
      engine,
      <MemoryRouter>
        <Timeline issue={countedIssue(engine.store, "issue")!} />
      </MemoryRouter>,
    );

  // Static markup is the pre-mount state: the status region exists, still empty, so the text the
  // effect adds later is announced.
  const status = '<p role="status" class="sr-only"></p>';
  const skeleton = 'aria-hidden="true" class="animate-in fade-in';
  const composer = '<div class="mt-6 space-y-2">';

  it("shows cached comments on the first render without a loading state", async () => {
    const html = timeline(await fixture({ role: "viewer" }));
    expect(html).toContain("Replica comment");
    expect(html).not.toContain("animate-pulse");
    expect(html).toContain(status);
  });

  it("announces the load and holds one event row behind a delayed skeleton", async () => {
    const html = timeline(await fixture({ role: "viewer", online: true, scopes: [] }));
    expect(html).toContain(status);
    expect(html).toContain(
      '<div aria-hidden="true" class="animate-in fade-in fill-mode-both delay-300 flex min-h-7 items-center gap-3">',
    );
  });

  it("waits for activity before showing loaded comments, so the list never reorders", async () => {
    const html = timeline(await fixture({ role: "viewer", online: true, scopes: ["comments"] }));
    expect(html).not.toContain("Replica comment");
    expect(html).toContain(skeleton);
  });

  it("shows what it has when the other scope can't load offline", async () => {
    const html = timeline(await fixture({ role: "viewer", scopes: ["comments"] }));
    expect(html).toContain("Replica comment");
    expect(html).not.toContain(skeleton);
  });

  it("shows a comment the user posts while the scopes load", async () => {
    const engine = await fixture({ online: true, scopes: [] });
    await engine.mutate("add_comment", {
      issue_id: "issue",
      body: "Fresh comment",
      mentions: [],
      attachments: [],
    });
    const html = timeline(engine);
    expect(html).toContain("Fresh comment");
    expect(html).not.toContain(skeleton);
  });

  it("keeps the composer's margin while loading, empty, and loaded", async () => {
    const loading = timeline(await fixture({ online: true, scopes: [] }));
    const empty = timeline(await fixture({ scopes: [] }));
    const loaded = timeline(await fixture());
    expect(loading).toContain(skeleton);
    expect(empty).not.toContain(skeleton);
    expect(empty).not.toContain("<ol");
    expect(loaded).toContain("Replica comment");
    for (const html of [loading, empty, loaded]) {
      expect(html.split(composer)).toHaveLength(2);
      expect(html).toContain(">Comment</button>");
    }
  });
});
