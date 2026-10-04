import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { useIsMutating, useQuery, useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { lower, useLiveQuery } from "@tanstack/react-db";
import { ApiError } from "./api";
import { createCommandRunner } from "./commands";
import { workspaceDb, type WorkspaceDb } from "./db";
import { keys, refreshWorkspace, reportQuery, workspaceQuery } from "./query-client";
import { changeFeedQuery } from "./sync";
import { useSession } from "./session";
import { useToast } from "~/components/ui/toast";
import { useT } from "./i18n";
import type {
  Command,
  EntityVersions,
  Id,
  IssueInput,
  MemberProfile,
  Report,
  Role,
  Stage,
  Team,
  Workspace,
} from "./types";

interface Ctx {
  ws: Workspace;
  /** The workspace's TanStack DB collections. */
  db: WorkspaceDb;
  members: MemberProfile[];
  report: Report;
  role: Role;
  canWrite: boolean;
  canAdmin: boolean;
  me: Id;
  member: (id: Id | null | undefined) => MemberProfile | undefined;
  team: (id: Id) => Team | undefined;
  stage: (id: Id) => Stage | undefined;
  /**
   * Sends a command. Its local effect shows at once and rolls back if the server refuses.
   * `quiet` skips the error toast, for forms that show the failure beside their own controls.
   */
  run: (
    command: Command,
    opts?: { quiet?: boolean; expectedVersions?: EntityVersions },
  ) => Promise<Id | null>;
  /** Refetches everything, after changes the feed can't describe such as imports. */
  reload: () => Promise<void>;
  /** Number of writes waiting on the server. */
  pending: number;
  /** True while the last background refresh failed, so the data on screen may be old. */
  offline: boolean;
  retrySync: () => void;
  upload: (issueId: Id, file: File, commentId?: Id) => Promise<void>;
  unread: number;
  create: {
    open: boolean;
    defaults: Partial<IssueInput>;
    show: (defaults?: Partial<IssueInput>) => void;
    hide: () => void;
  };
}
const WorkspaceCtx = createContext<Ctx | null>(null);

/** Workspace records from the collections, in the order the API lists them. */
function useWorkspaceRecords(db: WorkspaceDb) {
  const name = useSuspenseQuery(workspaceQuery(db.id)).data.workspace.name;
  const report = useSuspenseQuery(reportQuery(db.id)).data;
  const teams = useLiveQuery({ query: (q) => q.from({ t: db.teams }).orderBy(({ t }) => t.name) });
  const labels = useLiveQuery({
    query: (q) => q.from({ l: db.labels }).orderBy(({ l }) => l.name),
  });
  const projects = useLiveQuery({
    query: (q) => q.from({ p: db.projects }).orderBy(({ p }) => p.name),
  });
  const milestones = useLiveQuery({
    query: (q) => q.from({ m: db.milestones }).orderBy(({ m }) => m.name),
  });
  const sprints = useLiveQuery({
    query: (q) => q.from({ s: db.sprints }).orderBy(({ s }) => s.starts_at),
  });
  const views = useLiveQuery({ query: (q) => q.from({ v: db.views }).orderBy(({ v }) => v.name) });
  const invitations = useLiveQuery({
    query: (q) => q.from({ i: db.invitations }).orderBy(({ i }) => i.expires_at, "desc"),
  });
  const alerts = useLiveQuery({ query: (q) => q.from({ a: db.alert_preferences }) });
  const integrations = useLiveQuery({
    query: (q) => q.from({ i: db.integrations }).orderBy(({ i }) => i.name),
  });
  const members = useLiveQuery({
    query: (q) => q.from({ m: db.members }).orderBy(({ m }) => lower(m.display_name)),
  });
  const ws = useMemo<Workspace>(
    () => ({
      id: db.id,
      name,
      members: (members.data ?? []).map((m) => ({
        user_id: m.id,
        role: m.role,
        version: m.version,
      })),
      teams: teams.data ?? [],
      labels: labels.data ?? [],
      projects: projects.data ?? [],
      milestones: milestones.data ?? [],
      sprints: sprints.data ?? [],
      views: views.data ?? [],
      invitations: invitations.data ?? [],
      alert_preferences: alerts.data ?? [],
      integrations: integrations.data ?? [],
    }),
    [
      db.id,
      name,
      members.data,
      teams.data,
      labels.data,
      projects.data,
      milestones.data,
      sprints.data,
      views.data,
      invitations.data,
      alerts.data,
      integrations.data,
    ],
  );
  return { ws, members: members.data ?? [], report };
}

export function WorkspaceProvider({ id, children }: { id: Id; children: ReactNode }) {
  const { profile } = useSession();
  const toast = useToast();
  const t = useT();
  const client = useQueryClient();
  const db = workspaceDb(id, client);
  const { ws, members, report } = useWorkspaceRecords(db);
  const feed = useQuery(changeFeedQuery(client, db));
  const pending = useIsMutating({ mutationKey: keys.commands(id) });
  const runner = useMemo(
    () => createCommandRunner(client, db, profile.id),
    [client, db, profile.id],
  );
  const [createState, setCreate] = useState<{ open: boolean; defaults: Partial<IssueInput> }>({
    open: false,
    defaults: {},
  });
  const role = ws.members.find((m) => m.user_id === profile.id)?.role ?? "viewer";

  const reload = useCallback(() => refreshWorkspace(client, id), [client, id]);

  /** The optimistic effect is already rolled back; refetch in case the server moved on. */
  const fail = useCallback(
    (e: unknown, quiet?: boolean) => {
      void reload().catch(() => undefined);
      const err = !(e instanceof ApiError)
        ? new Error(t("error.network"))
        : e.status === 409
          ? new ApiError(t("error.conflict"), 409)
          : new ApiError(e.message || t("error.generic"), e.status);
      if (!quiet) toast.error(err.message);
      return err;
    },
    [reload, t, toast],
  );

  const run = useCallback<Ctx["run"]>(
    (command, opts) =>
      runner.command(command, opts?.expectedVersions).then(
        (res) => res.result.id,
        (e: unknown) => {
          throw fail(e, opts?.quiet);
        },
      ),
    [runner, fail],
  );

  const upload = useCallback<Ctx["upload"]>(
    (issueId, file, commentId) =>
      runner.upload(issueId, file, commentId).then(
        () => undefined,
        (e: unknown) => {
          const err = fail(e, true);
          toast.error(`${file.name}: ${err.message}`);
          throw err;
        },
      ),
    [runner, fail, toast],
  );

  const value = useMemo<Ctx>(() => {
    const stages = new Map(ws.teams.flatMap((tm) => tm.stages.map((s) => [s.id, s] as const)));
    const people = new Map(members.map((m) => [m.id, m]));
    return {
      ws,
      db,
      members,
      report,
      role,
      canWrite: role !== "viewer",
      canAdmin: role === "owner" || role === "admin",
      me: profile.id,
      member: (uid) => (uid ? people.get(uid) : undefined),
      team: (tid) => ws.teams.find((tm) => tm.id === tid),
      stage: (sid) => stages.get(sid),
      run,
      reload,
      pending,
      offline: feed.isError,
      retrySync: () => void feed.refetch(),
      upload,
      unread: report.inbox_unread,
      create: {
        ...createState,
        show: (defaults = {}) => {
          if (role !== "viewer") setCreate({ open: true, defaults });
        },
        hide: () => setCreate({ open: false, defaults: {} }),
      },
    };
  }, [ws, db, members, report, role, profile.id, run, reload, pending, feed, upload, createState]);

  return <WorkspaceCtx value={value}>{children}</WorkspaceCtx>;
}

export function useWorkspace() {
  const v = useContext(WorkspaceCtx);
  if (!v) throw new Error("WorkspaceProvider missing");
  return v;
}
