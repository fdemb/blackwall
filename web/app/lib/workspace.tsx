import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useToast } from "~/components/ui/toast";
import { EngineProvider, useEngine, useSyncStatus, useView } from "../sync/react";
import { OutdatedError, type EngineStatus, type SyncEngine } from "../sync/engine";
import { NetworkError, UnavailableError } from "../sync/transport";
import { createdLabel } from "../sync/mutators";
import { byDisplayName, byExpiryDesc, byName, byPosition, bySprintStart, byUserId } from "./order";
import { useSession } from "./session";
import type { Command, EntityVersions, IssueInput, Workspace } from "./types";
import {
  uploadFile,
  OnlineRequiredError,
  runCommand,
  uuidsIn,
  watchRejections,
  watchOutdated,
  whenConfirmed,
} from "./workspace-commands";
import { useI18n } from "./i18n";
import { issueKey } from "./format";

export interface RunOptions {
  quiet?: boolean;
  // Older editors still capture versions. Sync writes use field-level last-writer-wins.
  expectedVersions?: EntityVersions;
}
export interface UploadOptions {
  commentId?: string;
  // Callers that report a batch's failures themselves stay quiet, so each failure is not toasted twice.
  quiet?: boolean;
}

/** Why edits can't reach the server right now, or null when sync is healthy. */
export type SyncProblem = "offline" | "unreachable" | "blocked" | "error" | null;

function syncProblem(status: EngineStatus): SyncProblem {
  const error = status.lastError;
  if (!status.online) return "offline";
  if (status.blocked) return "blocked";
  if (error instanceof NetworkError || error instanceof UnavailableError) return "unreachable";
  return error && !(error instanceof OutdatedError) ? "error" : null;
}

function useWorkspaceValue() {
  const engine = useEngine();
  const { profile } = useSession();
  const toast = useToast();
  const { t } = useI18n();
  const status = useSyncStatus();
  const records = useView(
    (store) => {
      const row = store.all("workspace")[0];
      if (!row) throw new Error("Workspace replica missing");
      const members = store
        .all("members")
        .map((member) => ({ ...member, team_ids: [...member.team_ids] }))
        .sort(byDisplayName);
      const ws: Workspace = {
        id: row.id,
        name: row.name,
        slug: row.slug,
        members: members
          .map(({ id, role, version }) => ({ user_id: id, role, version }))
          .sort(byUserId),
        teams: store
          .all("teams")
          .map((team) => ({
            ...team,
            members: [...team.members],
            stages: [...team.stages].sort(byPosition),
          }))
          .sort(byName),
        labels: [...store.all("labels")].sort(byName),
        projects: store
          .all("projects")
          .map((project) => ({ ...project, team_ids: [...project.team_ids] }))
          .sort(byName),
        milestones: [...store.all("milestones")].sort(byName),
        sprints: [...store.all("sprints")].sort(bySprintStart),
        invitations: [...store.all("invitations")].sort(byExpiryDesc),
        views: [...store.all("views")].sort(byName),
        alert_preferences: [...store.all("alert_preferences")].sort(byUserId),
        integrations: [...store.all("integrations")].sort(byName),
      };
      return { ws, members };
    },
    [
      "workspace",
      "members",
      "teams",
      "labels",
      "projects",
      "milestones",
      "sprints",
      "invitations",
      "views",
      "alert_preferences",
      "integrations",
    ],
    [],
  );
  const { ws, members } = records;
  const role = members.find((member) => member.id === profile.id)?.role ?? "viewer";
  const unread = useView(
    (store) =>
      store.all("notifications").filter((notification) => notification.read_at === null).length,
    ["notifications"],
    [],
  );
  useEffect(
    () =>
      watchRejections(engine, (rejection) => {
        const name = createdLabel(rejection.command);
        toast.error(
          name === null
            ? rejection.message
            : t("error.createRejected", { name, message: rejection.message }),
        );
      }),
    [engine, toast, t],
  );
  useEffect(
    () => watchOutdated(engine, () => toast.error(t("error.outdated"))),
    [engine, toast, t],
  );
  const describeError = useCallback(
    (error: unknown) => {
      if (error instanceof OutdatedError) return t("error.outdated");
      if (error instanceof OnlineRequiredError) return t("error.onlineRequired");
      return error instanceof Error ? error.message : String(error);
    },
    [t],
  );

  const run = useCallback(
    async (command: Command, opts: RunOptions = {}) => {
      try {
        return await runCommand(engine, command);
      } catch (error) {
        // Synced edits return before the server answers, so their rejections arrive only as engine
        // events. Anything thrown here (admission, online commands) has no event and is shown now.
        if (!opts.quiet) toast.error(describeError(error));
        throw error instanceof OutdatedError ? new OutdatedError(describeError(error)) : error;
      }
    },
    [engine, toast, describeError],
  );
  const upload = useCallback(
    async (issueId: string, file: File, opts: UploadOptions = {}) => {
      try {
        return await uploadFile(engine, ws.id, issueId, file, opts.commentId);
      } catch (error) {
        if (!opts.quiet) toast.error(describeError(error));
        throw error instanceof OutdatedError ? new OutdatedError(describeError(error)) : error;
      }
    },
    [engine, ws.id, toast, describeError],
  );
  // REST writes that send record ids wait here until the server has those records.
  const confirmed = useCallback((body: unknown) => whenConfirmed(engine, uuidsIn(body)), [engine]);
  const [createState, setCreateState] = useState<{ open: boolean; defaults: Partial<IssueInput> }>({
    open: false,
    defaults: {},
  });
  const show = useCallback(
    (defaults: Partial<IssueInput> = {}) => setCreateState({ open: true, defaults }),
    [],
  );
  const hide = useCallback(() => setCreateState((state) => ({ ...state, open: false })), []);
  const create = useMemo(() => ({ ...createState, show, hide }), [createState, show, hide]);
  const resolveRejection = useCallback((id: number) => engine.resolveRejection(id), [engine]);
  // What issue URLs name an issue by: its key, read at call time. The issue route also accepts
  // the id. A shareable link keeps the id until the server confirms the number, because another
  // client may take the predicted one.
  const issueRef = useCallback(
    (id: string, shareable = false) => {
      const issue = engine.store.get("issues", id);
      const team = issue && engine.store.get("teams", issue.team_id);
      if (!issue || !team || (shareable && !engine.store.baseGet("issues", id))) return id;
      return issueKey(team.key, issue.number);
    },
    [engine],
  );
  const issuePath = useCallback(
    (id: string) => `/${ws.slug}/issue/${issueRef(id)}`,
    [ws.slug, issueRef],
  );
  const retrySync = useCallback(async () => {
    await engine.start();
    engine.unblock();
    await engine.pull();
  }, [engine]);
  return {
    ws,
    members,
    role,
    canWrite: role !== "viewer",
    canAdmin: role === "owner" || role === "admin",
    me: profile.id,
    member: (id: string | null | undefined) => members.find((member) => member.id === id),
    team: (id: string) => ws.teams.find((team) => team.id === id),
    issueRef,
    issuePath,
    stage: (id: string) => ws.teams.flatMap((team) => team.stages).find((stage) => stage.id === id),
    unread,
    pending: status.pending,
    rejected: status.rejected.length,
    unresolved: status.unresolved,
    resolveRejection,
    offline: !status.online,
    syncProblem: syncProblem(status),
    syncError: status.lastError,
    retrySync,
    reload: retrySync,
    run,
    upload,
    confirmed,
    create,
  };
}

const WorkspaceContext = createContext<ReturnType<typeof useWorkspaceValue> | null>(null);
export function WorkspaceProvider({
  engine,
  children,
}: {
  engine: SyncEngine;
  children: ReactNode;
}) {
  return (
    <EngineProvider engine={engine}>
      <WorkspaceState>{children}</WorkspaceState>
    </EngineProvider>
  );
}
function WorkspaceState({ children }: { children: ReactNode }) {
  const value = useWorkspaceValue();
  return <WorkspaceContext value={value}>{children}</WorkspaceContext>;
}
export function useWorkspace() {
  const workspace = useContext(WorkspaceContext);
  if (!workspace) throw new Error("WorkspaceProvider missing");
  return workspace;
}
