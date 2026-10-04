import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { useQueryClient, useSuspenseQuery } from "@tanstack/react-query";
import { ApiError, collectPages, workspaces } from "./api";
import { applyChanges, knownVersions, patchIssues } from "./changes";
import { commandEntityIds, expectedVersions } from "./entity-versions";
import { collectionQuery, keys, membersQuery, reportQuery, workspaceQuery } from "./query-client";
import { useSession } from "./session";
import { useToast } from "~/components/ui/toast";
import { useT } from "./i18n";
import type {
  ChangeFeed,
  Command,
  CommandResult,
  EntityVersions,
  Id,
  IssueInput,
  Issue,
  MemberProfile,
  Report,
  Role,
  Stage,
  Team,
  Workspace,
} from "./types";

/** How often to ask for other people's changes while the tab is visible. */
const POLL_MS = 5000;

/** Change-feed cursors by workspace. A cursor is taken before the first load, so nothing slips between. */
const cursors = new Map<Id, string>();

export async function startChangeFeed(ws: Id) {
  if (!cursors.has(ws)) cursors.set(ws, (await workspaces.changes(ws)).cursor);
}

interface Ctx {
  ws: Workspace;
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
   * `optimistic` updates every cached copy of the issues it changes until the server answers.
   * `quiet` skips the error toast, for forms that show the failure beside their own controls.
   */
  run: (
    command: Command,
    opts?: {
      optimistic?: (issue: Issue) => Issue;
      quiet?: boolean;
      expectedVersions?: EntityVersions;
    },
  ) => Promise<Id | null>;
  /** Refetches everything on screen, after changes the feed can't describe such as imports. */
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

type Operation = { key: string; versions?: EntityVersions };

/** Reads the workspace's records from the query cache. The route loader has already fetched them. */
function useWorkspaceRecords(id: Id) {
  const workspace = useSuspenseQuery(workspaceQuery(id)).data.workspace;
  const members = useSuspenseQuery(membersQuery(id)).data;
  const report = useSuspenseQuery(reportQuery(id)).data;
  const teams = useSuspenseQuery(collectionQuery(id, "teams")).data;
  const labels = useSuspenseQuery(collectionQuery(id, "labels")).data;
  const projects = useSuspenseQuery(collectionQuery(id, "projects")).data;
  const milestones = useSuspenseQuery(collectionQuery(id, "milestones")).data;
  const sprints = useSuspenseQuery(collectionQuery(id, "sprints")).data;
  const views = useSuspenseQuery(collectionQuery(id, "views")).data;
  const invitations = useSuspenseQuery(collectionQuery(id, "invitations")).data;
  const alerts = useSuspenseQuery(collectionQuery(id, "alert_preferences")).data;
  const integrations = useSuspenseQuery(collectionQuery(id, "integrations")).data;
  const ws = useMemo<Workspace>(
    () => ({
      id,
      name: workspace.name,
      members: members.map((m) => ({ user_id: m.id, role: m.role, version: m.version })),
      teams,
      labels,
      projects,
      milestones,
      sprints,
      views,
      invitations,
      alert_preferences: alerts,
      integrations,
    }),
    [
      id,
      workspace,
      members,
      teams,
      labels,
      projects,
      milestones,
      sprints,
      views,
      invitations,
      alerts,
      integrations,
    ],
  );
  return { ws, members, report };
}

export function WorkspaceProvider({ id, children }: { id: Id; children: ReactNode }) {
  const { profile } = useSession();
  const toast = useToast();
  const t = useT();
  const client = useQueryClient();
  const { ws, members, report } = useWorkspaceRecords(id);
  const [createState, setCreate] = useState<{ open: boolean; defaults: Partial<IssueInput> }>({
    open: false,
    defaults: {},
  });
  const commandKeys = useRef(new Map<string, Operation>());
  const uploadKeys = useRef(new WeakMap<File, Map<string, Operation>>());
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const inFlight = useRef(0);
  const [pending, setPending] = useState(0);
  const [offline, setOffline] = useState(false);
  const role = ws.members.find((m) => m.user_id === profile.id)?.role ?? "viewer";

  const reload = useCallback(
    () => client.invalidateQueries({ queryKey: keys.all(id) }),
    [client, id],
  );

  const enqueue = useCallback(<T,>(job: () => Promise<T>) => {
    inFlight.current += 1;
    setPending((n) => n + 1);
    const next = queue.current.then(job, job);
    queue.current = next
      .catch(() => undefined)
      .finally(() => {
        inFlight.current -= 1;
        setPending((n) => n - 1);
      });
    return next;
  }, []);

  const describe = useCallback(
    (e: unknown) => {
      if (!(e instanceof ApiError)) return new Error(t("error.network"));
      if (e.status === 409) return new ApiError(t("error.conflict"), 409);
      return new ApiError(e.message || t("error.generic"), e.status);
    },
    [t],
  );

  /** A failed write leaves guesses in the cache, so everything on screen is fetched again. */
  const recover = useCallback(
    async (e: unknown, quiet?: boolean) => {
      await reload().catch(() => undefined);
      const err = describe(e);
      if (!quiet) toast.error(err.message);
      return err;
    },
    [reload, describe, toast],
  );

  const polling = useRef(false);
  const poll = useCallback(async () => {
    // A pending write's optimistic state would flicker back to the server's older copy.
    if (document.visibilityState === "hidden" || inFlight.current > 0 || polling.current) return;
    polling.current = true;
    try {
      const since = cursors.get(id);
      const feed: ChangeFeed = await workspaces.changes(id, since);
      cursors.set(id, feed.cursor);
      if (since === undefined || feed.reset) await reload();
      else applyChanges(client, id, feed.changes);
      setOffline(false);
    } catch {
      setOffline(true);
    } finally {
      polling.current = false;
    }
  }, [client, id, reload]);

  useEffect(() => {
    const timer = setInterval(() => void poll(), POLL_MS);
    const wake = () => void poll();
    addEventListener("focus", wake);
    addEventListener("online", wake);
    document.addEventListener("visibilitychange", wake);
    return () => {
      clearInterval(timer);
      removeEventListener("focus", wake);
      removeEventListener("online", wake);
      document.removeEventListener("visibilitychange", wake);
    };
  }, [poll]);

  /** Versions of the records a command touches, including ones only the server can list. */
  const versionsFor = useCallback(
    async (command: Command) => {
      const known = knownVersions(client, id);
      if (command.type === "set_role" || command.type === "remove_member")
        return expectedVersions([command.user_id], known.memberships);
      if (command.type === "configure_alerts")
        return expectedVersions([profile.id], known.preferences);
      let ids = commandEntityIds(command, profile.id);
      const fetched: EntityVersions = {};
      const remember = (records: { id: Id; version: number }[]) => {
        for (const record of records) fetched[record.id] = record.version;
        return records.map((record) => record.id);
      };
      if (command.type === "complete_sprint")
        ids = [
          ...ids,
          ...remember(
            await collectPages((offset) =>
              workspaces.issues(id, { sprint_id: command.id }, offset),
            ),
          ),
        ];
      if (command.type === "delete_stage") {
        const pages = await Promise.all(
          [false, true].map((trash) =>
            collectPages((offset) =>
              workspaces.issues(id, { stage_id: command.id, trash }, offset),
            ),
          ),
        );
        ids = [...ids, ...remember(pages.flat())];
      }
      if (command.type === "mark_all_notifications_read") {
        const all = await collectPages((offset) =>
          workspaces.resource(id, "notifications", { offset }),
        );
        remember(all);
        ids = all.filter((n) => !n.read_at).map((n) => n.id);
      }
      return expectedVersions(ids, { ...known.records, ...fetched });
    },
    [client, id, profile.id],
  );

  const settle = useCallback(
    (res: CommandResult) => {
      applyChanges(client, id, res.changes);
      return res;
    },
    [client, id],
  );

  const run = useCallback<Ctx["run"]>(
    (command, opts) => {
      if (opts?.optimistic) patchIssues(client, id, opts.optimistic);
      const identity = JSON.stringify(command);
      const operation = commandKeys.current.get(identity) ?? { key: crypto.randomUUID() };
      commandKeys.current.set(identity, operation);
      return enqueue(async () => {
        let res;
        try {
          operation.versions ??= { ...(await versionsFor(command)), ...opts?.expectedVersions };
          res = settle(await workspaces.command(id, operation.versions, command, operation.key));
        } catch (e) {
          // A rejected request can't succeed with the same key; a lost response can.
          if (e instanceof ApiError && e.status < 500) commandKeys.current.delete(identity);
          throw await recover(e, opts?.quiet);
        }
        commandKeys.current.delete(identity);
        return res.result.id;
      });
    },
    [client, id, enqueue, versionsFor, settle, recover],
  );

  const upload = useCallback(
    (issueId: Id, file: File, commentId?: Id) =>
      enqueue(async () => {
        const target = commentId ?? issueId;
        const keyed = uploadKeys.current.get(file) ?? new Map<string, Operation>();
        uploadKeys.current.set(file, keyed);
        const operation = keyed.get(target) ?? { key: crypto.randomUUID() };
        keyed.set(target, operation);
        try {
          if (!operation.versions) {
            const known = knownVersions(client, id).records;
            if (known[issueId] === undefined)
              known[issueId] = (await workspaces.issue(id, issueId)).version;
            operation.versions = expectedVersions([target], known);
          }
          settle(
            await workspaces.upload(
              id,
              issueId,
              operation.versions,
              file,
              commentId,
              operation.key,
            ),
          );
        } catch (e) {
          if (e instanceof ApiError && e.status < 500) keyed.delete(target);
          const err = await recover(e, true);
          toast.error(`${file.name}: ${err.message}`);
          throw err;
        }
        keyed.delete(target);
      }),
    [client, id, enqueue, settle, recover, toast],
  );

  const value = useMemo<Ctx>(() => {
    const stages = new Map(ws.teams.flatMap((tm) => tm.stages.map((s) => [s.id, s] as const)));
    const people = new Map(members.map((m) => [m.id, m]));
    return {
      ws,
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
      offline,
      retrySync: () => void poll(),
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
  }, [
    ws,
    members,
    report,
    role,
    profile.id,
    run,
    reload,
    upload,
    createState,
    pending,
    offline,
    poll,
  ]);

  return <WorkspaceCtx value={value}>{children}</WorkspaceCtx>;
}

export function useWorkspace() {
  const v = useContext(WorkspaceCtx);
  if (!v) throw new Error("WorkspaceProvider missing");
  return v;
}
