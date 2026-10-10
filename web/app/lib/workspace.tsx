import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from "react";
import { useQuery } from "@tanstack/react-query";
import { useToast } from "~/components/ui/toast";
import { EngineProvider, useEngine, useSyncStatus, useView } from "../sync/react";
import { OutdatedError, type SyncEngine } from "../sync/engine";
import { createdLabel } from "../sync/mutators";
import { reportQuery, watchReportChanges } from "./query-client";
import { byDisplayName, byExpiryDesc, byName, byPosition, bySprintStart, byUserId } from "./order";
import { useSession } from "./session";
import type { Command, EntityVersions, IssueInput, Report, Workspace } from "./types";
import {
  uploadFile,
  OnlineRequiredError,
  runCommand,
  ServerRejection,
  uuidsIn,
  watchRejections,
  watchOutdated,
  whenConfirmed,
} from "./workspace-commands";
import { useI18n } from "./i18n";

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
const emptyReport: Report = {
  issue_count: 0,
  inbox_unread: 0,
  label_counts: {},
  project_stats: [],
  total_minutes: 0,
  issues: [],
  people: [],
  teams: [],
  projects: [],
  sprints: [],
  delivery: [],
};

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
  const report =
    useQuery({ ...reportQuery(ws.id), enabled: status.online, refetchOnMount: "always" }).data ??
    emptyReport;
  useEffect(() => watchReportChanges(engine.store, ws.id), [engine, ws.id]);
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
        // Server rejections already have an engine event; admission failures don't.
        if (!opts.quiet && !(error instanceof ServerRejection)) toast.error(describeError(error));
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
  const retrySync = useCallback(async () => {
    await engine.start();
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
    stage: (id: string) => ws.teams.flatMap((team) => team.stages).find((stage) => stage.id === id),
    report,
    unread,
    pending: status.pending,
    offline: !status.online,
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
