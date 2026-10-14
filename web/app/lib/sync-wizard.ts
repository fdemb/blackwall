import { ApiError } from "./api";
import { migratedSyncStageKind } from "./sync";
import type { Key } from "./i18n";
import type {
  Id,
  SyncConnection,
  SyncConnectionInput,
  SyncDirection,
  SyncField,
  SyncMapping,
  SyncOptions,
  SyncProvider,
  SyncProviderKind,
  SyncStatus,
  Team,
} from "./types";

export const WIZARD_STEPS = [
  "connect",
  "projects",
  "statuses",
  "people",
  "fields",
  "review",
] as const;
export type WizardStep = (typeof WIZARD_STEPS)[number];

export const SYNC_FIELDS: SyncField[] = [
  "status",
  "title",
  "description",
  "assignee",
  "due_date",
  "priority",
  "parent",
  "comments",
];

/** A checked project may not have a team yet; the Projects step requires one before moving on. */
export type ProjectDraft = Omit<SyncMapping, "team_id"> & { team_id: Id | null };

export interface WizardDraft {
  name: string;
  base_url: string;
  /** Blank keeps the stored token of an existing connection. */
  token: string;
  projects: ProjectDraft[];
  people: Record<string, Id>;
  options: SyncOptions;
}

/** Stage value that creates a stage named after the remote status when the wizard saves. */
export const CREATE_STAGE = "__create__";

export function initialDraft(
  connection: SyncConnection | null,
  provider?: SyncProvider,
): WizardDraft {
  return {
    name: connection?.name ?? provider?.name ?? "",
    base_url: connection?.base_url ?? "",
    token: "",
    projects: connection?.projects ?? [],
    people: connection?.people_mapping ?? {},
    options: connection?.options ?? provider?.defaults ?? {},
  };
}

/** The first problem that keeps a step from being left, as a translation key. */
export function stepError(step: WizardStep, draft: WizardDraft, isNew: boolean): Key | null {
  switch (step) {
    case "connect":
      if (!draft.name.trim()) return "sync.wizard.needName";
      if (!draft.base_url.trim()) return "sync.wizard.needUrl";
      if (isNew && !draft.token.trim()) return "sync.wizard.needToken";
      return null;
    case "projects":
      return draft.projects.some((project) => !project.team_id) ? "sync.wizard.needTeam" : null;
    default:
      return null;
  }
}

/**
 * A new connection only moves forward with Next, because Connect creates it. A saved connection can
 * jump to any step whose earlier steps are valid.
 */
export function canVisit(target: WizardStep, draft: WizardDraft, saved: boolean) {
  const index = WIZARD_STEPS.indexOf(target);
  if (!saved) return index === 0;
  return WIZARD_STEPS.slice(0, index).every((step) => !stepError(step, draft, false));
}

export function toggleProject(projects: ProjectDraft[], id: string, checked: boolean) {
  if (!checked) return projects.filter((project) => project.project_id !== id);
  if (projects.some((project) => project.project_id === id)) return projects;
  return [...projects, { project_id: id, team_id: null }];
}

/** Changing a project's team drops its status mapping, which pointed at the old team's stages. */
export function setProjectTeam(projects: ProjectDraft[], id: string, team_id: Id | null) {
  return projects.map((project) =>
    project.project_id !== id || project.team_id === team_id
      ? project
      : { project_id: id, team_id },
  );
}

export function setStatusStage(
  projects: ProjectDraft[],
  projectId: string,
  statusId: string,
  stageId: Id | null,
) {
  return projects.map((project) => {
    if (project.project_id !== projectId) return project;
    const stage_mapping = { ...project.stage_mapping };
    if (stageId) stage_mapping[statusId] = stageId;
    else delete stage_mapping[statusId];
    return { ...project, stage_mapping };
  });
}

export function setPerson(people: Record<string, Id>, email: string, id: Id | null) {
  const next = { ...people };
  if (id) next[email] = id;
  else delete next[email];
  return next;
}

export function direction(options: SyncOptions, field: SyncField): SyncDirection {
  return options[field] ?? { import: false, export: false };
}

export function setDirection(
  options: SyncOptions,
  field: SyncField,
  key: keyof SyncDirection,
  value: boolean,
): SyncOptions {
  return { ...options, [field]: { ...direction(options, field), [key]: value } };
}

/** A note for fields the provider can't sync both ways. */
export function unsupportedHint(support: SyncDirection): Key | null {
  if (!support.import && !support.export) return "sync.unsupportedBoth";
  if (!support.import) return "sync.unsupportedImport";
  if (!support.export) return "sync.unsupportedSend";
  return null;
}

/** Turns off directions the provider does not support, so saving never asks for them. */
export function supportedOptions(options: SyncOptions, provider: SyncProvider): SyncOptions {
  return Object.fromEntries(
    SYNC_FIELDS.map((field) => {
      const want = direction(options, field);
      const support = direction(provider.fields, field);
      return [
        field,
        { import: want.import && support.import, export: want.export && support.export },
      ];
    }),
  );
}

/** Cached projects plus mapped ones that discovery no longer returns. */
export function availableProjects(connection: SyncConnection | null, projects: ProjectDraft[]) {
  const available = new Map((connection?.cached_projects ?? []).map((p) => [p.id, p.name]));
  for (const project of projects)
    if (!available.has(project.project_id)) available.set(project.project_id, project.project_id);
  return [...available].map(([id, name]) => ({ id, name }));
}

/** Cached statuses plus mapped ones that discovery no longer returns. */
export function availableStatuses(statuses: SyncStatus[], mapping: ProjectDraft) {
  const available = new Map(statuses.map((status) => [status.id, status]));
  for (const id of Object.keys(mapping.stage_mapping ?? {}))
    if (!available.has(id)) available.set(id, { id, name: id, is_closed: false });
  return [...available.values()];
}

/** Emails with a cached remote person or an override. */
export function mappableEmails(connection: SyncConnection | null, people: Record<string, Id>) {
  return [
    ...new Set([
      ...(connection?.cached_people ?? []).flatMap((person) =>
        person.email ? [person.email] : [],
      ),
      ...Object.keys(people),
    ]),
  ];
}

type CreateStage = (input: {
  team_id: Id;
  name: string;
  kind: ReturnType<typeof migratedSyncStageKind>;
  position: number;
}) => Promise<Id | null | undefined>;

/**
 * Replaces "create stage" choices with real stage ids, reusing a team stage of the same name and
 * creating each missing stage once. Throws when a status or team is gone.
 */
export async function resolveProjects(
  projects: ProjectDraft[],
  statuses: SyncStatus[],
  teams: Team[],
  createStage: CreateStage,
  missing: string,
): Promise<SyncMapping[]> {
  const created = new Map<string, Id>();
  const resolved: SyncMapping[] = [];
  for (const project of projects) {
    const team = teams.find((team) => team.id === project.team_id);
    if (!team) throw new Error(missing);
    const stage_mapping = { ...project.stage_mapping };
    for (const [statusId, stageId] of Object.entries(stage_mapping)) {
      if (stageId !== CREATE_STAGE) continue;
      const status = statuses.find((status) => status.id === statusId);
      if (!status) throw new Error(missing);
      const key = `${team.id}:${status.name.toLowerCase()}`;
      let id =
        team.stages.find((stage) => stage.name.toLowerCase() === status.name.toLowerCase())?.id ??
        created.get(key);
      if (!id) {
        const added = [...created.keys()].filter((k) => k.startsWith(`${team.id}:`)).length;
        id =
          (await createStage({
            team_id: team.id,
            name: status.name,
            kind: migratedSyncStageKind(status),
            position: Math.max(0, ...team.stages.map((stage) => stage.position)) + added + 1,
          })) ?? undefined;
        if (!id) throw new Error(missing);
        created.set(key, id);
      }
      stage_mapping[statusId] = id;
    }
    resolved.push({ project_id: project.project_id, team_id: team.id, stage_mapping });
  }
  return resolved;
}

/** Connection fields the Connect step saves; the token is sent only when typed. */
export function connectBody(draft: WizardDraft): Partial<SyncConnectionInput> {
  return {
    name: draft.name.trim(),
    base_url: draft.base_url.trim(),
    ...(draft.token.trim() ? { token: draft.token.trim() } : {}),
  };
}

/** Whether Connect changed anything the server stores. */
export function connectChanged(connection: SyncConnection, draft: WizardDraft) {
  return (
    draft.name.trim() !== connection.name ||
    normalizeBaseUrl(draft.base_url) !== connection.base_url ||
    draft.token.trim() !== ""
  );
}

/** Base URL as the server stores it: parsed, without trailing slashes. */
export function normalizeBaseUrl(value: string) {
  const trimmed = value.trim();
  try {
    return new URL(trimmed).href.replace(/\/+$/, "");
  } catch {
    return trimmed.replace(/\/+$/, "");
  }
}

/** A failure where the request may still have reached the server: network error or 5xx. */
export function isAmbiguousFailure(error: unknown) {
  return !(error instanceof ApiError) || error.status >= 500;
}

/**
 * After a create whose response was lost, the connection it made: one matching the draft that
 * didn't exist when the wizard opened.
 */
export function findCreatedConnection(
  connections: SyncConnection[],
  known: ReadonlySet<Id>,
  provider: SyncProviderKind,
  draft: Pick<WizardDraft, "name" | "base_url">,
) {
  const url = normalizeBaseUrl(draft.base_url);
  return connections.find(
    (connection) =>
      !known.has(connection.id) &&
      connection.provider === provider &&
      connection.name === draft.name.trim() &&
      normalizeBaseUrl(connection.base_url) === url,
  );
}

/** The settings a draft was initialized from. Status, caches, and timestamps change on their own. */
export function configSnapshot(connection: SyncConnection) {
  return stableJson({
    name: connection.name,
    base_url: connection.base_url,
    enabled: connection.enabled,
    projects: connection.projects,
    people_mapping: connection.people_mapping,
    options: connection.options,
  });
}

/** Whether someone else saved the connection since the draft's snapshot was taken. */
export function configChanged(snapshot: string | null, latest: SyncConnection | null | undefined) {
  return snapshot !== null && latest != null && configSnapshot(latest) !== snapshot;
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(",")}}`;
  return JSON.stringify(value ?? null);
}

/**
 * The first reference in the draft that no longer exists, with the step that fixes it. Saving checks
 * this before creating any stage, so a doomed save has no side effects.
 */
export function draftProblem(
  draft: WizardDraft,
  statuses: SyncStatus[],
  teams: Team[],
  memberIds: ReadonlySet<Id>,
): { step: WizardStep; error: Key } | null {
  for (const project of draft.projects) {
    const team = teams.find((team) => team.id === project.team_id);
    if (!team) return { step: "projects", error: "sync.wizard.needTeam" };
  }
  for (const project of draft.projects) {
    const team = teams.find((team) => team.id === project.team_id)!;
    for (const [statusId, stageId] of Object.entries(project.stage_mapping ?? {})) {
      if (stageId === CREATE_STAGE) {
        if (!statuses.some((status) => status.id === statusId))
          return { step: "statuses", error: "sync.wizard.missingStatus" };
      } else if (!team.stages.some((stage) => stage.id === stageId))
        return { step: "statuses", error: "sync.wizard.missingStage" };
    }
  }
  if (Object.values(draft.people).some((id) => !memberIds.has(id)))
    return { step: "people", error: "sync.wizard.missingPerson" };
  return null;
}
