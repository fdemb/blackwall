import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
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
  run: (command: Command, opts?: { optimistic?: (ws: Workspace) => Workspace; quiet?: boolean }) => Promise<Id | null>;
  reload: () => Promise<void>;
  upload: (issueId: Id, file: File, commentId?: Id) => Promise<void>;
  unread: number;
  create: { open: boolean; defaults: Partial<import("./types").IssueInput>; show: (defaults?: Partial<import("./types").IssueInput>) => void; hide: () => void };
}
const WorkspaceCtx = createContext<Ctx | null>(null);

export function WorkspaceProvider({
  initial, children,
}: { initial: { revision: number; workspace: Workspace; members: MemberProfile[] }; children: ReactNode }) {
  const { profile } = useSession();
  const toast = useToast();
  const t = useT();
  const [state, setState] = useState(initial);
  const [createState, setCreate] = useState<{ open: boolean; defaults: Partial<import("./types").IssueInput> }>({ open: false, defaults: {} });
  const revisionRef = useRef(initial.revision);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const id = state.workspace.id;

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
    const next = queue.current.then(job, job);
    queue.current = next.catch(() => undefined);
    return next;
  }, []);

  const run = useCallback<Ctx["run"]>(
    (command, opts) => {
      if (opts?.optimistic) setState((s) => ({ ...s, workspace: opts.optimistic!(s.workspace) }));
      return enqueue(async () => {
        try {
          const res = await workspaces.command(id, revisionRef.current, command);
          revisionRef.current = res.revision;
          await reload();
          return res.result.id;
        } catch (e) {
          await reload().catch(() => undefined);
          const err = e as ApiError;
          toast.error(err.status === 409 ? t("error.conflict") : err.message || t("error.generic"));
          throw e;
        }
      });
    },
    [enqueue, id, reload, toast, t],
  );

  const upload = useCallback(
    (issueId: Id, file: File, commentId?: Id) =>
      enqueue(async () => {
        try {
          const res = await workspaces.upload(id, issueId, revisionRef.current, file, commentId);
          revisionRef.current = res.revision;
          await reload();
        } catch (e) {
          await reload().catch(() => undefined);
          toast.error((e as Error).message);
          throw e;
        }
      }),
    [enqueue, id, reload, toast],
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
      upload,
      unread: ws.notifications.filter((n) => !n.read_at).length,
      create: {
        ...createState,
        show: (defaults = {}) => setCreate({ open: true, defaults }),
        hide: () => setCreate({ open: false, defaults: {} }),
      },
    };
  }, [state, profile.id, run, reload, upload, createState]);

  return <WorkspaceCtx value={value}>{children}</WorkspaceCtx>;
}

export function useWorkspace() {
  const v = useContext(WorkspaceCtx);
  if (!v) throw new Error("WorkspaceProvider missing");
  return v;
}
