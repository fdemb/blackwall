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
import { ApiError, workspaces } from "./api";
import { useSession } from "./session";
import { useToast } from "~/components/ui/toast";
import { useT } from "./i18n";
import type { Command, Id, Issue, MemberProfile, Role, Stage, Team, Workspace } from "./types";

interface Ctx {
  ws: Workspace;
  revision: number;
  members: MemberProfile[];
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
    opts?: { optimistic?: (ws: Workspace) => Workspace; quiet?: boolean },
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
  initial: { revision: number; workspace: Workspace; members: MemberProfile[] };
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
  const revisionRef = useRef(initial.revision);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const inFlight = useRef(0);
  const [pending, setPending] = useState(0);
  const [offline, setOffline] = useState(false);
  const id = state.workspace.id;
  const canWriteNow =
    state.workspace.members.find((m) => m.user_id === profile.id)?.role !== "viewer";

  useEffect(() => {
    setState(initial);
    revisionRef.current = initial.revision;
  }, [initial]);

  const reload = useCallback(async () => {
    const [w, members] = await Promise.all([workspaces.get(id), workspaces.members(id)]);
    revisionRef.current = w.revision;
    setState({ revision: w.revision, workspace: w.workspace, members });
  }, [id]);

  // Serialize writes: each command carries the revision the previous one produced.
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

  // Teammates' changes arrive by polling the cheap workspace list for a newer revision.
  const poll = useCallback(async () => {
    if (document.visibilityState === "hidden" || inFlight.current > 0) return;
    try {
      const list = await workspaces.list();
      const mine = list.find((w) => w.id === id);
      if (mine && mine.revision > revisionRef.current && inFlight.current === 0) await reload();
      setOffline(false);
    } catch {
      setOffline(true);
    }
  }, [id, reload]);
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
      if (opts?.optimistic) setState((s) => ({ ...s, workspace: opts.optimistic!(s.workspace) }));
      return enqueue(async () => {
        let res;
        try {
          res = await workspaces.command(id, revisionRef.current, command);
        } catch (e) {
          await reload().catch(() => undefined);
          const err = describe(e);
          if (!opts?.quiet) toast.error(err.message);
          throw err;
        }
        revisionRef.current = res.revision;
        await refreshAfterWrite();
        return res.result.id;
      });
    },
    [enqueue, id, reload, refreshAfterWrite, describe, toast],
  );

  const upload = useCallback(
    (issueId: Id, file: File, commentId?: Id) =>
      enqueue(async () => {
        let res;
        try {
          res = await workspaces.upload(id, issueId, revisionRef.current, file, commentId);
        } catch (e) {
          await reload().catch(() => undefined);
          const err = describe(e);
          toast.error(`${file.name}: ${err.message}`);
          throw err;
        }
        revisionRef.current = res.revision;
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
      revision: state.revision,
      members: state.members,
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
      unread: ws.notifications.filter((n) => !n.read_at).length,
      create: {
        ...createState,
        show: (defaults = {}) => {
          if (canWriteNow) setCreate({ open: true, defaults });
        },
        hide: () => setCreate({ open: false, defaults: {} }),
      },
    };
  }, [state, profile.id, run, reload, upload, createState, pending, offline, poll, canWriteNow]);

  return <WorkspaceCtx value={value}>{children}</WorkspaceCtx>;
}

export function useWorkspace() {
  const v = useContext(WorkspaceCtx);
  if (!v) throw new Error("WorkspaceProvider missing");
  return v;
}
