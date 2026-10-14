import { describe, expect, it, vi } from "vite-plus/test";
import {
  CREATE_STAGE,
  availableProjects,
  canVisit,
  configChanged,
  configSnapshot,
  connectBody,
  connectChanged,
  draftProblem,
  findCreatedConnection,
  initialDraft,
  isAmbiguousFailure,
  mappableEmails,
  resolveProjects,
  setDirection,
  setProjectTeam,
  setStatusStage,
  stepError,
  supportedOptions,
  toggleProject,
  unsupportedHint,
  type WizardDraft,
} from "./tracker-wizard";
import { ApiError } from "./api";
import type { TrackerConnection, TrackerProvider, Team } from "./types";

const connection: TrackerConnection = {
  id: "c1",
  provider: "openproject",
  name: "OpenProject",
  base_url: "https://op.example",
  enabled: true,
  generation: 3,
  options: { title: { import: true, export: false } },
  projects: [{ project_id: "7", team_id: "team-a", stage_mapping: { "1": "stage-a" } }],
  cached_projects: [{ id: "8", name: "Website" }],
  cached_statuses: [
    { id: "1", name: "New", is_closed: false },
    { id: "2", name: "Closed", is_closed: true },
  ],
  cached_people: [
    { id: "p1", name: "Ann", email: "ann@example.com" },
    { id: "p2", name: "Hidden", email: null },
  ],
  people_mapping: { "bob@example.com": "member-b" },
  status: "idle",
  last_error: "",
  last_checked_at: null,
  last_synced_at: null,
};

const provider: TrackerProvider = {
  kind: "openproject",
  name: "OpenProject",
  fields: { title: { import: true, export: true }, parent: { import: true, export: false } },
  defaults: {},
};

const draft = (change: Partial<WizardDraft> = {}): WizardDraft => ({
  ...initialDraft(connection),
  ...change,
});

describe("tracker wizard validation", () => {
  it("requires a token only for new connections", () => {
    const fresh = initialDraft(null);
    expect(stepError("connect", fresh, true)).toBe("tracker.wizard.needName");
    expect(stepError("connect", { ...fresh, name: "OP" }, true)).toBe("tracker.wizard.needUrl");
    const filled = { ...fresh, name: "OP", base_url: "https://op.example" };
    expect(stepError("connect", filled, true)).toBe("tracker.wizard.needToken");
    expect(stepError("connect", filled, false)).toBeNull();
  });

  it("blocks leaving Projects until every checked project has a team", () => {
    const projects = toggleProject(draft().projects, "8", true);
    expect(stepError("projects", draft({ projects }), false)).toBe("tracker.wizard.needTeam");
    expect(canVisit("statuses", draft({ projects }), true)).toBe(false);
    expect(canVisit("projects", draft({ projects }), true)).toBe(true);
    const mapped = setProjectTeam(projects, "8", "team-b");
    expect(stepError("projects", draft({ projects: mapped }), false)).toBeNull();
    expect(canVisit("review", draft({ projects: mapped }), true)).toBe(true);
  });

  it("only lets a new connection move forward through Connect", () => {
    expect(canVisit("connect", initialDraft(null), false)).toBe(true);
    expect(canVisit("projects", draft(), false)).toBe(false);
  });
});

describe("tracker wizard draft edits", () => {
  it("keeps the stage mapping when a project is re-checked and drops it on a team change", () => {
    const projects = draft().projects;
    expect(toggleProject(projects, "7", true)).toBe(projects);
    expect(toggleProject(projects, "7", false)).toEqual([]);
    expect(setProjectTeam(projects, "7", "team-a")[0]?.stage_mapping).toEqual({ "1": "stage-a" });
    expect(setProjectTeam(projects, "7", "team-b")[0]).toEqual({
      project_id: "7",
      team_id: "team-b",
    });
    expect(setStatusStage(projects, "7", "1", null)[0]?.stage_mapping).toEqual({});
    expect(setStatusStage(projects, "7", "2", "stage-b")[0]?.stage_mapping).toEqual({
      "1": "stage-a",
      "2": "stage-b",
    });
  });

  it("lists mapped projects that discovery no longer returns and every mappable email", () => {
    expect(availableProjects(connection, connection.projects)).toEqual([
      { id: "8", name: "Website" },
      { id: "7", name: "7" },
    ]);
    expect(mappableEmails(connection, connection.people_mapping)).toEqual([
      "ann@example.com",
      "bob@example.com",
    ]);
  });

  it("never saves a direction the provider doesn't support", () => {
    let options = setDirection({}, "title", "export", true);
    options = setDirection(options, "parent", "export", true);
    const saved = supportedOptions(options, provider);
    expect(saved.title).toEqual({ import: false, export: true });
    expect(saved.parent).toEqual({ import: false, export: false });
    expect(saved.comments).toEqual({ import: false, export: false });
    expect(unsupportedHint({ import: true, export: true })).toBeNull();
    expect(unsupportedHint({ import: true, export: false })).toBe("tracker.unsupportedSend");
    expect(unsupportedHint({ import: false, export: false })).toBe("tracker.unsupportedBoth");
  });

  it("sends the token only when typed and notices URL changes", () => {
    expect(connectBody(draft())).toEqual({ name: "OpenProject", base_url: "https://op.example" });
    expect(connectBody(draft({ token: " secret " })).token).toBe("secret");
    expect(connectChanged(connection, draft({ base_url: "https://op.example/" }))).toBe(false);
    expect(connectChanged(connection, draft({ base_url: "https://other.example" }))).toBe(true);
    expect(connectChanged(connection, draft({ token: "x" }))).toBe(true);
  });
});

describe("resolving created stages", () => {
  const team: Team = {
    id: "team-a",
    version: 1,
    name: "Core",
    key: "CORE",
    members: [],
    archive_after_days: null,
    icon: "users",
    color: "blue",
    stages: [{ id: "stage-new", version: 1, name: "new", kind: "backlog", position: 2 }],
  };

  it("reuses a stage with the same name and creates each missing stage once", async () => {
    const create = vi.fn(async () => "stage-closed");
    const resolved = await resolveProjects(
      [
        {
          project_id: "7",
          team_id: "team-a",
          stage_mapping: { "1": CREATE_STAGE, "2": CREATE_STAGE },
        },
        { project_id: "8", team_id: "team-a", stage_mapping: { "2": CREATE_STAGE } },
      ],
      connection.cached_statuses,
      [team],
      create,
      "missing",
    );
    expect(resolved).toEqual([
      {
        project_id: "7",
        team_id: "team-a",
        stage_mapping: { "1": "stage-new", "2": "stage-closed" },
      },
      { project_id: "8", team_id: "team-a", stage_mapping: { "2": "stage-closed" } },
    ]);
    expect(create).toHaveBeenCalledTimes(1);
    expect(create).toHaveBeenCalledWith({
      team_id: "team-a",
      name: "Closed",
      kind: "done",
      position: 3,
    });
  });

  it("fails when a team or status is gone", async () => {
    const create = vi.fn(async () => "x");
    await expect(
      resolveProjects([{ project_id: "7", team_id: null }], [], [team], create, "missing"),
    ).rejects.toThrow("missing");
    await expect(
      resolveProjects(
        [{ project_id: "7", team_id: "team-a", stage_mapping: { "9": CREATE_STAGE } }],
        connection.cached_statuses,
        [team],
        create,
        "missing",
      ),
    ).rejects.toThrow("missing");
    expect(create).not.toHaveBeenCalled();
  });
});

describe("recovering a lost create response", () => {
  const fresh = { ...connection, id: "c2", base_url: "https://op.example/path" };
  const draft = { name: " OpenProject ", base_url: "https://OP.example/path/" };

  it("adopts only a new connection with the same provider, name, and URL", () => {
    const known = new Set(["c1"]);
    expect(findCreatedConnection([connection, fresh], known, "openproject", draft)).toBe(fresh);
    expect(
      findCreatedConnection([connection, fresh], new Set(["c1", "c2"]), "openproject", draft),
    ).toBeUndefined();
    expect(
      findCreatedConnection([{ ...fresh, name: "Other" }], known, "openproject", draft),
    ).toBeUndefined();
    expect(
      findCreatedConnection(
        [{ ...fresh, base_url: "https://op.example/other" }],
        known,
        "openproject",
        draft,
      ),
    ).toBeUndefined();
  });

  it("treats network errors and 5xx as ambiguous, 4xx as definite", () => {
    expect(isAmbiguousFailure(new TypeError("Failed to fetch"))).toBe(true);
    expect(isAmbiguousFailure(new ApiError("Bad Gateway", 502))).toBe(true);
    expect(isAmbiguousFailure(new ApiError("invalid", 400))).toBe(false);
  });
});

describe("detecting edits made elsewhere", () => {
  it("ignores status, caches, timestamps, and key order", () => {
    const snapshot = configSnapshot(connection);
    expect(configChanged(snapshot, connection)).toBe(false);
    expect(
      configChanged(snapshot, {
        ...connection,
        status: "syncing",
        last_error: "boom",
        last_synced_at: "2026-01-01T00:00:00Z",
        cached_people: [],
        generation: 4,
        options: { title: { export: false, import: true } },
      }),
    ).toBe(false);
    expect(configChanged(null, connection)).toBe(false);
  });

  it("notices changed projects, people, options, name, URL, or enabled", () => {
    const snapshot = configSnapshot(connection);
    for (const change of [
      { projects: [] },
      { people_mapping: {} },
      { options: {} },
      { name: "Renamed" },
      { base_url: "https://other.example" },
      { enabled: false },
    ])
      expect(configChanged(snapshot, { ...connection, ...change })).toBe(true);
  });
});

describe("checking references before saving", () => {
  const team: Team = {
    id: "team-a",
    version: 1,
    name: "Core",
    key: "CORE",
    members: [],
    archive_after_days: null,
    icon: "users",
    color: "blue",
    stages: [{ id: "stage-a", version: 1, name: "New", kind: "backlog", position: 1 }],
  };
  const members = new Set(["member-b"]);
  const check = (change: Partial<WizardDraft>, teams = [team]) =>
    draftProblem(draft(change), connection.cached_statuses, teams, members);

  it("accepts a draft whose references all exist", () => {
    expect(check({})).toBeNull();
    expect(
      check({
        projects: [{ project_id: "7", team_id: "team-a", stage_mapping: { "2": CREATE_STAGE } }],
      }),
    ).toBeNull();
  });

  it("points at the step that fixes a missing team, stage, status, or person", () => {
    expect(check({}, [])).toEqual({ step: "projects", error: "tracker.wizard.needTeam" });
    expect(check({ projects: [{ project_id: "7", team_id: null }] })?.step).toBe("projects");
    expect(
      check({ projects: [{ project_id: "7", team_id: "team-a", stage_mapping: { "1": "gone" } }] }),
    ).toEqual({ step: "statuses", error: "tracker.wizard.missingStage" });
    expect(
      check({
        projects: [{ project_id: "7", team_id: "team-a", stage_mapping: { "9": CREATE_STAGE } }],
      }),
    ).toEqual({ step: "statuses", error: "tracker.wizard.missingStatus" });
    expect(check({ people: { "ann@example.com": "gone" } })).toEqual({
      step: "people",
      error: "tracker.wizard.missingPerson",
    });
  });
});
