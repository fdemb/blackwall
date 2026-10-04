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
import { ApiError, collectPages, workspaces } from "./api";
import { loadWorkspaceData, type WorkspaceData } from "./workspace-data";
import { commandEntityIds, entityVersions, expectedVersions } from "./entity-versions";
import { useSession } from "./session";
import { useToast } from "~/components/ui/toast";
import { useT } from "./i18n";
import type {
  Command,
  EntityVersions,
  Id,
  Issue,
  MemberProfile,
  Report,
  Role,
  Stage,
  Team,
  Workspace,
} from "./types";

interface Ctx {
  ws: Workspace;
  syncGeneration: number;
  cache: (patch: Partial<Workspace> | ((ws: Workspace) => Partial<Workspace>)) => void;
  members: MemberProfile[];
  report: Report;
  role: Role;
  canWrite: boolean;
  canAdmin: boolean;
  me: Id;
  member: (id: Id | null | undefined) => MemberProfile | undefined;
  team: (id: Id) => Team | undefined;
  stage: (id: Id) => Stage | undefined;
  issue: (id: Id) => Issue | undefined;
  /** `quiet` skips the error toast, for forms that show the failure beside their own controls. */
  run: (
    command: Command,
    opts?: {
      optimistic?: (ws: Workspace) => Workspace;
      quiet?: boolean;
      expectedVersions?: EntityVersions;
    },
  ) => Promise<Id | null>;
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
    defaults: Partial<import("./types").IssueInput>;
    show: (defaults?: Partial<import("./types").IssueInput>) => void;
    hide: () => void;
  };
}
const WorkspaceCtx = createContext<Ctx | null>(null);

export function WorkspaceProvider({
  initial,
  children,
}: {
  initial: WorkspaceData;
  children: ReactNode;
}) {
  const { profile } = useSession();
  const toast = useToast();
  const t = useT();
  const [state, setState] = useState(initial);
  const [createState, setCreate] = useState<{
    open: boolean;
    defaults: Partial<import("./types").IssueInput>;
  }>({ open: false, defaults: {} });
  const versionsRef = useRef(entityVersions(initial.workspace));
  const [syncGeneration, setSyncGeneration] = useState(0);
  const cache = useCallback(
    (patch: Partial<Workspace> | ((ws: Workspace) => Partial<Workspace>)) => {
      setState((state) => {
        const workspace = {
          ...state.workspace,
          ...(typeof patch === "function" ? patch(state.workspace) : patch),
        };
        for (const [id, version] of Object.entries(entityVersions(workspace))) {
          versionsRef.current[id] = Math.max(versionsRef.current[id] ?? 0, version);
        }
        return { ...state, workspace };
      });
    },
    [],
  );
  const membershipVersions = useRef(
    Object.fromEntries(initial.workspace.members.map((member) => [member.user_id, member.version])),
  );
  const preferenceVersions = useRef(
    Object.fromEntries(
      initial.workspace.alert_preferences.map((prefs) => [prefs.user_id, prefs.version]),
    ),
  );
  const commandKeys = useRef(new Map<string, { key: string; versions?: EntityVersions }>());
  const uploadKeys = useRef(
    new WeakMap<File, Map<string, { key: string; versions?: EntityVersions }>>(),
  );
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const inFlight = useRef(0);
  const [pending, setPending] = useState(0);
  const [offline, setOffline] = useState(false);
  const id = state.workspace.id;
  const canWriteNow =
    (state.workspace.members.find((m) => m.user_id === profile.id)?.role ?? "viewer") !== "viewer";

  useEffect(() => {
    setState(initial);
    versionsRef.current = entityVersions(initial.workspace);
  }, [initial]);

  const reload = useCallback(async () => {
    const data = await loadWorkspaceData(id);
    membershipVersions.current = Object.fromEntries(
      data.workspace.members.map((member) => [member.user_id, member.version]),
    );
    preferenceVersions.current = Object.fromEntries(
      data.workspace.alert_preferences.map((prefs) => [prefs.user_id, prefs.version]),
    );
    setState((state) => {
      const workspace = {
        ...state.workspace,
        ...data.workspace,
        issues: state.workspace.issues,
        comments: state.workspace.comments,
        time_entries: state.workspace.time_entries,
        activity: state.workspace.activity,
        notifications: state.workspace.notifications,
      };
      for (const [id, version] of Object.entries(entityVersions(workspace))) {
        versionsRef.current[id] = Math.max(versionsRef.current[id] ?? 0, version);
      }
      return { ...data, workspace };
    });
    setSyncGeneration((n) => n + 1);
  }, [id]);

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

  /** The write already succeeded, so a failed refresh must not read as a failed save. */
  const refreshAfterWrite = useCallback(
    () =>
      reload().catch(() =>
        toast.error(t("error.refresh"), {
          label: t("action.retry"),
          run: () => void reload().catch(() => undefined),
        }),
      ),
    [reload, toast, t],
  );
  const describe = useCallback(
    (e: unknown) => {
      if (!(e instanceof ApiError)) return new Error(t("error.network"));
      if (e.status === 409) return new ApiError(t("error.conflict"), 409);
      return new ApiError(e.message || t("error.generic"), e.status);
    },
    [t],
  );

  const poll = useCallback(async () => {
    if (document.visibilityState === "hidden" || inFlight.current > 0) return;
    try {
      await reload();
      setOffline(false);
    } catch {
      setOffline(true);
    }
  }, [reload]);
  useEffect(() => {
    const timer = setInterval(() => void poll(), 15000);
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

  const run = useCallback<Ctx["run"]>(
    (command, opts) => {
      const optimistic = opts?.optimistic;
      if (optimistic) setState((s) => ({ ...s, workspace: optimistic(s.workspace) }));
      const commandIdentity = JSON.stringify(command);
      const operation = commandKeys.current.get(commandIdentity) ?? {
        key: crypto.randomUUID(),
        versions: undefined,
      };
      commandKeys.current.set(commandIdentity, operation);
      return enqueue(async () => {
        let res;
        try {
          let ids = commandEntityIds(command, profile.id);
          if (command.type === "complete_sprint") {
            const issues = await collectPages((offset) =>
              workspaces.issues(id, { sprint_id: command.id }, offset),
            );
            for (const issue of issues) versionsRef.current[issue.id] = issue.version;
            ids = [...ids, ...issues.map((issue) => issue.id)];
          }
          if (command.type === "delete_stage") {
            const stagePages = await Promise.all([
              collectPages((offset) => workspaces.issues(id, { stage_id: command.id }, offset)),
              collectPages((offset) =>
                workspaces.issues(id, { stage_id: command.id, trash: true }, offset),
              ),
            ]);
            const issues = stagePages.flat();
            for (const issue of issues) versionsRef.current[issue.id] = issue.version;
            ids = [...ids, ...issues.map((issue) => issue.id)];
          }
          if (command.type === "mark_all_notifications_read") {
            const notifications = await collectPages((offset) =>
              workspaces.resource(id, "notifications", { offset }),
            );
            for (const notification of notifications)
              versionsRef.current[notification.id] = notification.version;
            ids = notifications
              .filter((notification) => !notification.read_at)
              .map((notification) => notification.id);
          }
          const versions =
            command.type === "set_role" || command.type === "remove_member"
              ? membershipVersions.current
              : command.type === "configure_alerts"
                ? preferenceVersions.current
                : versionsRef.current;
          operation.versions ??= { ...expectedVersions(ids, versions), ...opts?.expectedVersions };
          res = await workspaces.command(id, operation.versions, command, operation.key);
          if (command.type === "set_role" || command.type === "remove_member")
            membershipVersions.current = { ...membershipVersions.current, ...res.versions };
          if (command.type === "configure_alerts")
            preferenceVersions.current = { ...preferenceVersions.current, ...res.versions };
        } catch (e) {
          if (e instanceof ApiError && e.status < 500) commandKeys.current.delete(commandIdentity);
          await reload().catch(() => undefined);
          const err = describe(e);
          if (!opts?.quiet) toast.error(err.message);
          throw err;
        }
        commandKeys.current.delete(commandIdentity);
        versionsRef.current = { ...versionsRef.current, ...res.versions };
        await refreshAfterWrite();
        return res.result.id;
      });
    },
    [enqueue, id, profile.id, reload, refreshAfterWrite, describe, toast],
  );

  const upload = useCallback(
    (issueId: Id, file: File, commentId?: Id) =>
      enqueue(async () => {
        const target = commentId ?? issueId;
        const keys =
          uploadKeys.current.get(file) ??
          new Map<string, { key: string; versions?: EntityVersions }>();
        uploadKeys.current.set(file, keys);
        const operation = keys.get(target) ?? { key: crypto.randomUUID(), versions: undefined };
        keys.set(target, operation);
        let res;
        try {
          if (versionsRef.current[issueId] === undefined) {
            const issue = await workspaces.issue(id, issueId);
            versionsRef.current[issueId] = issue.version;
          }
          operation.versions ??= expectedVersions([commentId ?? issueId], versionsRef.current);
          res = await workspaces.upload(
            id,
            issueId,
            operation.versions,
            file,
            commentId,
            operation.key,
          );
        } catch (e) {
          if (e instanceof ApiError && e.status < 500) keys.delete(target);
          await reload().catch(() => undefined);
          const err = describe(e);
          toast.error(`${file.name}: ${err.message}`);
          throw err;
        }
        keys.delete(target);
        versionsRef.current = { ...versionsRef.current, ...res.versions };
        await refreshAfterWrite();
      }),
    [enqueue, id, reload, refreshAfterWrite, describe, toast],
  );

  const value = useMemo<Ctx>(() => {
    const ws = state.workspace;
    const role = ws.members.find((m) => m.user_id === profile.id)?.role ?? "viewer";
    const stages = new Map(ws.teams.flatMap((tm) => tm.stages.map((s) => [s.id, s] as const)));
    return {
      ws,
      syncGeneration,
      cache,
      members: state.members,
      report: state.report,
      role,
      canWrite: role !== "viewer",
      canAdmin: role === "owner" || role === "admin",
      me: profile.id,
      member: (uid) => (uid ? state.members.find((m) => m.id === uid) : undefined),
      team: (tid) => ws.teams.find((tm) => tm.id === tid),
      stage: (sid) => stages.get(sid),
      issue: (iid) => ws.issues.find((i) => i.id === iid),
      run,
      reload,
      pending,
      offline,
      retrySync: () => void poll(),
      upload,
      unread: state.report.inbox_unread,
      create: {
        ...createState,
        show: (defaults = {}) => {
          if (canWriteNow) setCreate({ open: true, defaults });
        },
        hide: () => setCreate({ open: false, defaults: {} }),
      },
    };
  }, [
    state,
    syncGeneration,
    cache,
    profile.id,
    run,
    reload,
    upload,
    createState,
    pending,
    offline,
    poll,
    canWriteNow,
  ]);

  return <WorkspaceCtx value={value}>{children}</WorkspaceCtx>;
}

export function useWorkspace() {
  const v = useContext(WorkspaceCtx);
  if (!v) throw new Error("WorkspaceProvider missing");
  return v;
}
