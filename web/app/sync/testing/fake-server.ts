import type { Attachment, Command, MemberProfile, Profile, Role } from "../../lib/types";
import { MUTATORS, MutationError, ONLINE_ONLY } from "../mutators";
import type { Mutator } from "../mutators";
import { requireAdmin } from "../mutators/common";
import { BOOTSTRAP_ENTITIES, ENTITIES, parseTimestamp } from "../records";
import type { Change, Entity, RecordOf, SyncWorkspace } from "../records";
import { FakeClock } from "./clock";
import { applyServerOnlyEffects } from "./effects";
import { commandArgs, object, uuid } from "./commands";
import { extractPushJson } from "./push-json";
import { EventConnection } from "./events";
import type { EventTiming } from "./events";
import { Tables } from "./tables";
import type { Pair } from "./tables";
import type { DeepReadonly } from "../store";

export type Route = "me" | "bootstrap" | "pull" | "push" | "scope" | "events";
export type Fault =
  | { kind: "delay"; route?: Route; milliseconds: number | readonly [number, number] }
  | {
      kind: "response_delay";
      route?: "pull" | "bootstrap" | "scope" | "push";
      milliseconds: number | readonly [number, number];
    }
  | { kind: "drop_response"; route?: Route }
  | { kind: "duplicate_push" }
  | {
      kind: "unavailable";
      route: "push" | "pull" | "bootstrap" | "scope" | "events";
      after?: number;
    }
  | { kind: "truncate_bootstrap"; afterRecords?: number }
  | { kind: "cut_bootstrap"; byte: number }
  | { kind: "close_events"; afterMs: number }
  | { kind: "reset_pull" };

export interface FakeServerOptions {
  /** Return a number in [0, 1). Tests own and seed the generator. */
  random?: () => number;
  at?: string;
  pageSize?: number;
  horizon?: number;
  sessionLifetimeMs?: number;
  events?: Partial<EventTiming>;
  onPush?: (input: { clientId: string; mutations: readonly Mutation[]; previous: number }) => void;
  onResult?: (clientId: string, result: MutationResult) => void;
  onFault?: (route: string, fault: Fault) => void;
}
interface WorkspaceState {
  tables: Tables;
  nextIssueNumber: number;
}
interface ClientState {
  workspace: string;
  user: string;
  last_mutation_id: number;
  updatedAt: number;
}
interface Session {
  user: string;
  session_id: string;
  expires: number;
  csrf: string;
}
interface LogRow extends Pair {
  user: string | null;
}
interface Transaction {
  id: number;
  workspace: string;
  rows: LogRow[];
  roles: string[];
}
interface Mutation {
  id: number;
  name: string;
  args: unknown;
  at: string;
}
export type MutationResult =
  | { id: number; status: "applied" | "duplicate" }
  | { id: number; status: "rejected"; error: { status: number; message: string } };
export interface PushResponse {
  last_mutation_id: number;
  results: MutationResult[];
}
export interface PullResponse {
  cursor: string;
  more: boolean;
  reset: boolean;
  last_mutation_id: number | null;
  changes: Change[];
}

const SESSION_LIFETIME = 30 * 24 * 60 * 60 * 1000;
const mutators = new Map<string, Mutator<unknown>>(
  Object.entries(MUTATORS) as [string, Mutator<unknown>][],
);
const onlineOnly = new Set<string>(ONLINE_ONLY);

export function createFakeServer(options: FakeServerOptions = {}): FakeServer {
  return new FakeServer(options);
}

export class FakeServer {
  private readonly clock: FakeClock;
  private readonly users = new Map<string, Profile>();
  private readonly workspaces = new Map<string, WorkspaceState>();
  private readonly sessions = new Map<string, Session>();
  private readonly uploaders = new Map<string, string>();
  private readonly sourceLinks = new Map<
    string,
    { issue: string; workspace: string; url: string; title: string }
  >();
  private readonly clients = new Map<string, ClientState>();
  private readonly history: Transaction[] = [];
  private readonly faults: Fault[] = [];
  private readonly streams = new Map<EventConnection, string>();
  private readonly pageSize: number;
  private readonly timing: EventTiming;
  private horizon: number;
  private txid = 1;
  private sequence = 0;
  private requests: Promise<void> = Promise.resolve();

  constructor(private readonly options: FakeServerOptions) {
    this.clock = new FakeClock(options.at ?? "2026-10-09T12:00:00Z");
    this.pageSize = options.pageSize ?? 1000;
    if (!Number.isSafeInteger(this.pageSize) || this.pageSize < 1)
      throw new Error("pageSize must be positive");
    this.horizon = options.horizon ?? 0;
    this.timing = {
      coalesceMs: 250,
      keepaliveMs: 15_000,
      lifetimeMs: 30 * 60_000,
      ...options.events,
    };
    if (Object.values(this.timing).some((ms) => !Number.isFinite(ms) || ms <= 0))
      throw new Error("event durations must be positive");
  }

  now = (): string => this.clock.now();
  advance = (milliseconds: number): void => this.clock.advance(milliseconds);
  schedule = (milliseconds: number, run: () => void): (() => void) =>
    this.clock.schedule(milliseconds, run);
  private id(): string {
    for (;;) {
      const id = `00000000-0000-4000-8000-${(++this.sequence).toString(16).padStart(12, "0")}`;
      if (!this.takenId(id)) return id;
    }
  }
  private sourceId(): string {
    for (;;) {
      const id = this.id();
      // Hidden source ids have no insertion-order guarantee, even with deterministic fixtures.
      const prefix = (Math.imul(this.sequence, 0x9e3779b1) >>> 0).toString(16).padStart(8, "0");
      const sourceId = `${prefix}${id.slice(8)}`;
      if (!this.takenId(sourceId)) return sourceId;
    }
  }
  private takenId(id: string): boolean {
    if (this.users.has(id) || this.workspaces.has(id) || this.sourceLinks.has(id)) return true;
    for (const state of this.workspaces.values()) {
      for (const entity of ENTITIES) if (state.tables.get(entity, id)) return true;
      for (const team of state.tables.all("teams"))
        if (team.stages.some((stage) => stage.id === id)) return true;
      for (const issue of state.tables.all("issues"))
        if (issue.attachments.some((attachment) => attachment.id === id)) return true;
      for (const comment of state.tables.all("comments"))
        if (comment.attachments.some((attachment) => attachment.id === id)) return true;
    }
    return false;
  }

  addUser(input: Partial<Profile> = {}): Profile {
    const id = input.id ?? this.id();
    const profile: Profile = {
      id,
      email: `${id}@example.test`,
      display_name: id,
      avatar_url: null,
      contact: "",
      language: "en",
      theme: "system",
      alerts: { assignments: true, replies: true, changes: true, deadlines: true },
      ...structuredClone(input),
    };
    if (this.users.has(id)) throw new Error("user already exists");
    this.users.set(id, profile);
    return structuredClone(profile);
  }

  addWorkspace(input: Partial<SyncWorkspace> = {}): SyncWorkspace {
    const record = { id: input.id ?? this.id(), name: "Workspace", version: 1, ...input };
    if (this.workspaces.has(record.id)) throw new Error("workspace already exists");
    const state = { tables: new Tables(), nextIssueNumber: 1 };
    this.workspaces.set(record.id, state);
    const tx = new Tables(state.tables);
    tx.put("workspace", record);
    this.commit(record.id, tx);
    return structuredClone(record);
  }

  addMember(workspace: string, user: string | Profile, role: Role = "member"): MemberProfile {
    const id = typeof user === "string" ? user : user.id;
    const profile = this.users.get(id);
    if (!profile) throw new Error("unknown user");
    const state = this.workspace(workspace);
    if (state.tables.get("members", id)) throw new Error("member already exists");
    const { email, display_name, avatar_url, contact } = profile;
    const member = { id, role, version: 1, email, display_name, avatar_url, contact, team_ids: [] };
    const tx = new Tables(state.tables);
    tx.put("members", member);
    this.commit(workspace, tx);
    return structuredClone(member);
  }

  login(user: string | Profile): string {
    const id = typeof user === "string" ? user : user.id;
    if (!this.users.has(id)) throw new Error("unknown user");
    const token = `fake-token-${this.id()}`;
    this.sessions.set(token, {
      user: id,
      session_id: this.id(),
      csrf: `fake-csrf-${this.id()}`,
      expires: this.clock.milliseconds() + (this.options.sessionLifetimeMs ?? SESSION_LIFETIME),
    });
    return token;
  }
  csrfToken(token: string): string {
    const session = this.sessions.get(token);
    if (!session) throw new Error("unknown session");
    return session.csrf;
  }
  rotateCsrf(token: string, csrf = `fake-csrf-${this.id()}`): string {
    const session = this.sessions.get(token);
    if (!session) throw new Error("unknown session");
    session.csrf = csrf;
    return csrf;
  }
  logout(token: string): void {
    this.sessions.delete(token);
  }

  setRole(workspace: string, user: string, role: Role): void {
    const tx = new Tables(this.workspace(workspace).tables);
    const member = tx.get("members", user);
    if (!member) throw new MutationError(404, "not found");
    tx.put("members", { ...member, role, version: member.version + 1 });
    this.commit(workspace, tx);
  }

  removeMember(workspace: string, user: string): void {
    const tx = new Tables(this.workspace(workspace).tables);
    if (!tx.get("members", user)) throw new MutationError(404, "not found");
    this.removeFromTables(tx, user);
    this.commit(workspace, tx);
  }

  /** Seed server-built rows or fixtures; one call is one committed transaction. */
  seed<E extends Entity>(
    entity: E,
    records: readonly RecordOf[E][],
    workspace = this.onlyWorkspace(),
  ): void {
    const state = this.workspace(workspace);
    const tx = new Tables(state.tables);
    for (const record of records) tx.put(entity, record as DeepReadonly<RecordOf[E]>);
    this.commit(workspace, tx);
    for (const issue of tx.all("issues"))
      state.nextIssueNumber = Math.max(state.nextIssueNumber, (issue.number ?? 0) + 1);
  }

  /** Upload fixtures retain private uploader ownership, absent from sync records. */
  uploadAttachment(
    actor: string | Profile,
    issueId: string,
    attachment: Attachment,
    workspace = this.onlyWorkspace(),
  ): void {
    const user = typeof actor === "string" ? actor : actor.id;
    this.authorize(workspace, user);
    const state = this.workspace(workspace);
    const issue = state.tables.get("issues", issueId);
    if (!issue || issue.deleted_at !== null) throw new MutationError(404, "not found");
    if (this.takenId(attachment.id)) throw new MutationError(409, "id already exists");
    const tx = new Tables(state.tables);
    tx.put("issues", {
      ...issue,
      version: issue.version + 1,
      attachments: [...issue.attachments, attachment].sort((a, b) => a.id.localeCompare(b.id)),
    });
    this.uploaders.set(attachment.id, user);
    this.commit(workspace, tx);
  }

  /** Seed the hidden UUID used by ORDER BY source_links.id. */
  seedSourceLink(
    id: string,
    issueId: string,
    link: { url: string; title: string },
    workspace = this.onlyWorkspace(),
  ): void {
    const state = this.workspace(workspace);
    const issue = state.tables.get("issues", issueId);
    if (!issue) throw new MutationError(404, "not found");
    if (this.takenId(id)) throw new MutationError(409, "id already exists");
    this.sourceLinks.set(id, { ...link, issue: issueId, workspace });
    const tx = new Tables(state.tables);
    tx.put("issues", { ...issue, source_links: this.orderedSourceLinks(issueId, workspace) });
    this.commit(workspace, tx);
  }

  private orderedSourceLinks(issue: string, workspace: string): { url: string; title: string }[] {
    return [...this.sourceLinks]
      .filter(([, row]) => row.issue === issue && row.workspace === workspace)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([, { url, title }]) => ({ url, title }));
  }

  records<E extends Entity>(
    entity: E,
    actor?: string,
    workspace = this.onlyWorkspace(),
  ): RecordOf[E][] {
    const state = this.workspace(workspace);
    const user = actor ?? state.tables.all("members").find((member) => member.role === "owner")?.id;
    return state.tables.all(entity).flatMap((row) => {
      const id =
        entity === "alert_preferences" && "user_id" in row
          ? row.user_id
          : "id" in row
            ? row.id
            : "";
      const rendered = this.render(entity, id, user, workspace);
      return rendered === null ? [] : [rendered];
    });
  }

  record<E extends Entity>(
    entity: E,
    id: string,
    actor?: string,
    workspace = this.onlyWorkspace(),
  ): RecordOf[E] | null {
    const user =
      actor ??
      this.workspace(workspace)
        .tables.all("members")
        .find((member) => member.role === "owner")?.id;
    return this.render(entity, id, user, workspace);
  }

  clientState(clientId: string): { last_mutation_id: number } {
    return { last_mutation_id: this.clients.get(clientId)?.last_mutation_id ?? 0 };
  }
  inject(fault: Fault): void {
    this.faults.push(structuredClone(fault));
  }
  clearFaults(): void {
    this.faults.length = 0;
  }
  advanceHorizon(txid = this.txid): void {
    if (!Number.isSafeInteger(txid) || txid < this.horizon || txid > this.txid)
      throw new Error("invalid horizon");
    this.horizon = txid;
    const retained = this.history.filter((tx) => tx.id >= txid);
    this.history.splice(0, this.history.length, ...retained);
  }
  pruneClients(): void {
    for (const [id, client] of this.clients)
      if (this.clock.milliseconds() - client.updatedAt > SESSION_LIFETIME) this.clients.delete(id);
  }
  close(): void {
    for (const stream of this.streams.keys()) stream.close();
  }

  run(
    actor: string | Profile,
    command: Command,
    workspace = this.onlyWorkspace(),
  ): { result: { id: string | null }; changes: Change[] } {
    const user = typeof actor === "string" ? actor : actor.id;
    return this.execute(user, command.type, commandArgs(command.type, command), workspace);
  }

  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const request = new Request(
      typeof input === "string" ? new URL(input, "http://fake.test") : input,
      init,
    );
    request.signal.throwIfAborted();
    const url = new URL(request.url);
    const matched = /^\/api\/workspaces\/([^/]+)\/sync\/(bootstrap|pull|push|scope|events)$/.exec(
      url.pathname,
    );
    const route = url.pathname === "/api/me" ? "me" : matched?.[2];
    if (!route || (route === "push" ? request.method !== "POST" : request.method !== "GET"))
      return json({ error: "not found" }, 404);
    const faults = this.takeFaults(route);
    for (const fault of faults) this.options.onFault?.(route, structuredClone(fault));
    const delay = faults.find((fault) => fault.kind === "delay");
    if (delay?.kind === "delay") {
      const duration = this.delayDuration(delay.milliseconds);
      await this.wait(duration, request.signal);
    }
    const task = this.requests.then(() => this.handle(request, url, matched, route, faults));
    this.requests = task.then(
      () => {},
      () => {},
    );
    let response = await task;
    const cut = faults.find((fault) => fault.kind === "cut_bootstrap");
    if (cut?.kind === "cut_bootstrap" && response.ok) {
      const bytes = new Uint8Array(await response.arrayBuffer());
      response = new Response(bytes.slice(0, cut.byte), { headers: response.headers });
    }
    const delayed = faults.find((fault) => fault.kind === "response_delay");
    if (delayed?.kind !== "response_delay") return response;
    const duration = this.delayDuration(delayed.milliseconds);
    if (route !== "bootstrap" || !response.body) {
      await this.wait(duration, request.signal);
      return response;
    }
    const reader = response.body.getReader();
    const ready = this.wait(duration, request.signal);
    const body = new ReadableStream<Uint8Array>({
      async pull(controller) {
        try {
          await ready;
          const chunk = await reader.read();
          if (chunk.done) controller.close();
          else controller.enqueue(chunk.value);
        } catch (error) {
          controller.error(error);
          await reader.cancel(error);
        }
      },
      cancel(reason) {
        return reader.cancel(reason);
      },
    });
    return new Response(body, { status: response.status, headers: response.headers });
  };

  private async handle(
    request: Request,
    url: URL,
    matched: RegExpExecArray | null,
    route: string,
    faults: Fault[],
  ): Promise<Response> {
    request.signal.throwIfAborted();
    let response: Response;
    try {
      const authorization = request.headers.get("authorization");
      const bearer = authorization?.startsWith("Bearer ") ? authorization.slice(7) : undefined;
      const cookie = request.headers
        .get("cookie")
        ?.split(";")
        .map((part) => part.trim())
        .find((part) => part.startsWith("blackwall_session="))
        ?.slice("blackwall_session=".length);
      const session = this.sessions.get(bearer ?? cookie ?? "");
      if (!session || session.expires <= this.clock.milliseconds())
        throw new MutationError(401, "authentication required");
      if (
        !bearer &&
        request.method !== "GET" &&
        request.headers.get("X-CSRF-Token") !== session.csrf
      )
        throw new MutationError(403, "permission denied");
      if (route === "me")
        response = json({ ...this.users.get(session.user), session_id: session.session_id }, 200, {
          "X-CSRF-Token": session.csrf,
        });
      else {
        const workspace = uuid(matched?.[1], "workspace_id");
        const payload: unknown = route === "push" ? await extractPushJson(request) : null;
        const clientId = uuid(
          route === "push" && object(payload)
            ? payload.client_id
            : url.searchParams.get("client_id"),
          "client_id",
        );
        const mutations = route === "push" ? parseMutations(payload) : [];
        this.authorize(workspace, session.user);
        this.checkClient(clientId, workspace, session.user);
        const unavailable = faults.find((fault) => fault.kind === "unavailable");
        if (route === "push") {
          const after = unavailable?.kind === "unavailable" ? (unavailable.after ?? 0) : undefined;
          const pushed = this.push(workspace, session.user, clientId, mutations, after);
          if (faults.some((fault) => fault.kind === "duplicate_push") && pushed.status === 200)
            this.push(workspace, session.user, clientId, mutations);
          response = json(pushed.body, pushed.status);
        } else if (unavailable)
          response = json({ error: "service unavailable" }, 503, { "retry-after": "5" });
        else if (route === "pull")
          response = json(
            this.pull(
              workspace,
              session.user,
              clientId,
              url.searchParams.get("cursor"),
              faults.some((fault) => fault.kind === "reset_pull"),
            ),
          );
        else if (route === "bootstrap") {
          const truncated = faults.find((fault) => fault.kind === "truncate_bootstrap");
          response = this.bootstrap(
            workspace,
            session.user,
            clientId,
            truncated?.kind === "truncate_bootstrap" ? (truncated.afterRecords ?? 0) : undefined,
          );
        } else if (route === "scope")
          response = json(this.scope(workspace, session.user, url.searchParams));
        else {
          const stream = new EventConnection(this.clock, this.timing, request.signal, () =>
            this.streams.delete(stream),
          );
          this.streams.set(stream, workspace);
          const early = faults.find((fault) => fault.kind === "close_events");
          if (early?.kind === "close_events")
            this.clock.schedule(early.afterMs, () => stream.close());
          response = stream.response;
        }
      }
    } catch (error) {
      if (!(error instanceof MutationError)) throw error;
      response = json({ error: error.message }, error.status);
    }
    if (faults.some((fault) => fault.kind === "drop_response")) {
      await response.body?.cancel();
      throw new TypeError("Failed to fetch: injected lost response");
    }
    return response;
  }

  private workspace(id: string): WorkspaceState {
    const state = this.workspaces.get(id);
    if (!state) throw new MutationError(403, "permission denied");
    return state;
  }
  private onlyWorkspace(): string {
    if (this.workspaces.size !== 1)
      throw new Error("specify workspace when the fake has multiple workspaces");
    const id = this.workspaces.keys().next().value;
    if (id === undefined) throw new Error("fake has no workspace");
    return id;
  }
  private authorize(workspace: string, actor: string): Role {
    const member = this.workspace(workspace).tables.get("members", actor);
    if (!member) throw new MutationError(403, "permission denied");
    return member.role;
  }
  private checkClient(id: string, workspace: string, actor: string): void {
    const client = this.clients.get(id);
    if (client && (client.workspace !== workspace || client.user !== actor))
      throw new MutationError(400, "client_id belongs to another user or workspace");
    // Rust read-only endpoints check ownership without registering a new row.
  }
  private takeFaults(route: string): Fault[] {
    const taken: Fault[] = [];
    const kinds = new Set<string>();
    for (let index = 0; index < this.faults.length;) {
      const fault = this.faults[index];
      if (
        fault.kind === "response_delay" &&
        !["pull", "bootstrap", "scope", "push"].includes(route)
      ) {
        index += 1;
        continue;
      }
      const target =
        fault.kind === "delay" ||
        fault.kind === "response_delay" ||
        fault.kind === "drop_response" ||
        fault.kind === "unavailable"
          ? fault.route
          : fault.kind === "truncate_bootstrap" || fault.kind === "cut_bootstrap"
            ? "bootstrap"
            : fault.kind === "close_events"
              ? "events"
              : fault.kind === "reset_pull"
                ? "pull"
                : "push";
      if ((!target || target === route) && !kinds.has(fault.kind)) {
        taken.push(fault);
        kinds.add(fault.kind);
        this.faults.splice(index, 1);
      } else index += 1;
    }
    return taken;
  }
  private delayDuration(milliseconds: number | readonly [number, number]): number {
    return typeof milliseconds === "number"
      ? milliseconds
      : milliseconds[0] +
          Math.floor((this.options.random?.() ?? 0) * (milliseconds[1] - milliseconds[0] + 1));
  }
  private wait(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve, reject) => {
      const abort = () => {
        cancel();
        reject(signal.reason);
      };
      const cancel = this.clock.schedule(ms, () => {
        signal.removeEventListener("abort", abort);
        resolve();
      });
      signal.addEventListener("abort", abort, { once: true });
      if (signal.aborted) abort();
    });
  }
  private render<E extends Entity>(
    entity: E,
    id: string,
    actor: string | undefined,
    workspace: string,
  ): RecordOf[E] | null {
    const tables = this.workspace(workspace).tables;
    const role = actor === undefined ? undefined : tables.get("members", actor)?.role;
    const row = tables.get(entity, id);
    if (!row || !role) return null;
    if (
      entity === "views" &&
      "shared" in row &&
      !row.shared &&
      "owner" in row &&
      row.owner !== actor
    )
      return null;
    if (
      (entity === "notifications" || entity === "alert_preferences") &&
      "user_id" in row &&
      row.user_id !== actor
    )
      return null;
    if (
      (entity === "invitations" || entity === "integrations") &&
      role !== "owner" &&
      role !== "admin"
    )
      return null;
    return structuredClone(row) as RecordOf[E];
  }

  private commit(workspace: string, tables: Tables): Transaction {
    const state = this.workspace(workspace);
    const roles: string[] = [];
    const rows: LogRow[] = [];
    for (const pair of tables.touched.values()) {
      const before = state.tables.get(pair.entity, pair.id);
      const after = tables.get(pair.entity, pair.id);
      const row = after ?? before;
      let user: string | null = null;
      if (pair.entity === "views" && row && "owner" in row) {
        const wasShared = before && "shared" in before && before.shared;
        const isShared = after && "shared" in after && after.shared;
        if (!wasShared && !isShared && typeof row.owner === "string") user = row.owner;
      } else if (
        (pair.entity === "notifications" || pair.entity === "alert_preferences") &&
        row &&
        "user_id" in row
      )
        user = row.user_id;
      if (pair.entity === "members") {
        const oldRole = before && "role" in before ? before.role : undefined;
        const newRole = after && "role" in after ? after.role : undefined;
        if (oldRole !== newRole) roles.push(pair.id);
      }
      rows.push({ ...pair, user });
    }
    const transaction = { id: this.txid++, workspace, rows, roles };
    state.tables = tables;
    this.history.push(transaction);
    if (rows.length > 0)
      for (const [stream, ws] of this.streams) if (ws === workspace) stream.poke();
    return transaction;
  }

  private execute(
    actor: string,
    name: string,
    args: Record<string, unknown>,
    workspace: string,
  ): { result: { id: string | null }; changes: Change[] } {
    const role = this.authorize(workspace, actor);
    const state = this.workspace(workspace);
    const tx = new Tables(state.tables);
    args = this.allocateServerIds(name, args);
    this.reserveIds(name, args);
    if (
      (name === "add_comment" && tx.all("comments").length >= 20_000) ||
      (name === "save_view" && tx.all("views").length >= 5000)
    ) {
      throw new MutationError(400, "workspace capacity reached");
    }
    if (name === "add_comment" && Array.isArray(args.attachments)) {
      for (const attachment of args.attachments) {
        if (object(attachment) && this.uploaders.get(String(attachment.id)) !== actor) {
          throw new MutationError(400, "attachment must be uploaded to this issue first");
        }
      }
    }
    if (name === "set_role" || name === "remove_member") {
      requireAdmin(role);
      const user = uuid(args.user_id, "user_id");
      const member = tx.get("members", user);
      if (!member) throw new MutationError(403, "permission denied");
      const targetRole = args.role;
      if ((member.role === "owner" || targetRole === "owner") && role !== "owner")
        throw new MutationError(403, "permission denied");
      if (
        member.role === "owner" &&
        (name === "remove_member" || targetRole !== "owner") &&
        tx.all("members").filter((m) => m.role === "owner").length === 1
      )
        throw new MutationError(409, "workspace must retain an owner");
      if (name === "remove_member") this.removeFromTables(tx, user);
      else {
        if (
          targetRole !== "owner" &&
          targetRole !== "admin" &&
          targetRole !== "member" &&
          targetRole !== "viewer"
        )
          throw new MutationError(400, "invalid role");
        tx.put("members", { ...member, role: targetRole });
      }
    } else if (name === "add_attachment" || name === "attach_comment_file")
      throw new MutationError(400, "use the attachment upload endpoint");
    else if (onlineOnly.has(name)) throw new MutationError(400, "not supported by the fake");
    else {
      const mutator = mutators.get(name);
      if (!mutator) throw new MutationError(400, `unknown command ${name}`);
      // The fake reuses client mutators, so it cannot catch mutator bugs. Contract
      // tests against the real Rust server must compare predictions with pulls.
      mutator(tx, args, { actor, at: this.now(), mode: "admit" });
    }
    const id =
      typeof args.id === "string"
        ? args.id
        : object(args.input) && typeof args.input.id === "string"
          ? args.input.id
          : typeof args.issue_id === "string"
            ? args.issue_id
            : typeof args.user_id === "string"
              ? args.user_id
              : null;
    const nextNumber = applyServerOnlyEffects({
      tx,
      before: state.tables,
      nextIssueNumber: state.nextIssueNumber,
      actor,
      name,
      args,
      id,
      now: this.now,
      generateId: () => this.id(),
      users: this.users,
    });
    if (
      name === "add_source_link" &&
      typeof args.issue_id === "string" &&
      typeof args.url === "string" &&
      typeof args.title === "string"
    ) {
      const issue = tx.get("issues", args.issue_id);
      const old = state.tables.get("issues", args.issue_id);
      if (
        issue &&
        old &&
        !old.source_links.some((link) => link.url === args.url && link.title === args.title)
      ) {
        for (const link of old.source_links) {
          if (
            ![...this.sourceLinks.values()].some(
              (row) =>
                row.issue === issue.id &&
                row.workspace === workspace &&
                row.url === link.url &&
                row.title === link.title,
            )
          )
            this.sourceLinks.set(this.id(), { ...link, issue: issue.id, workspace });
        }
        this.sourceLinks.set(this.sourceId(), {
          url: args.url,
          title: args.title,
          issue: issue.id,
          workspace,
        });
        tx.put("issues", { ...issue, source_links: this.orderedSourceLinks(issue.id, workspace) });
      }
    }
    const committed = this.commit(workspace, tx);
    state.nextIssueNumber = nextNumber;
    return {
      result: { id },
      changes: committed.rows
        .filter((row) => row.user === null || row.user === actor)
        .map(({ entity, id: key }) => ({
          entity,
          id: key,
          record: this.render(entity, key, actor, workspace),
        })),
    };
  }

  private allocateServerIds(name: string, args: Record<string, unknown>): Record<string, unknown> {
    if (!mutators.has(name)) return args;
    if (name === "create_issue" && object(args.input))
      return { ...args, input: { ...args.input, id: args.input.id ?? this.id() } };
    if (name.startsWith("create_") || ["save_view", "add_comment", "log_time"].includes(name)) {
      return {
        ...args,
        id: args.id ?? this.id(),
        ...(name === "create_team" && !args.default_stage_ids
          ? { default_stage_ids: Array.from({ length: 4 }, () => this.id()) }
          : {}),
      };
    }
    return args;
  }

  private reserveIds(name: string, args: Record<string, unknown>): void {
    if (!name.startsWith("create_") && !["save_view", "add_comment", "log_time"].includes(name))
      return;
    const input = object(args.input) ? args.input : args;
    const ids = [
      input.id,
      ...(Array.isArray(args.default_stage_ids) ? args.default_stage_ids : []),
    ];
    const seen = new Set<string>();
    for (const value of ids) {
      if (value === undefined) continue;
      const id = uuid(value, "id");
      if (seen.has(id)) throw new MutationError(409, "id already exists");
      seen.add(id);
      if (this.takenId(id)) throw new MutationError(409, "id already exists");
    }
  }

  private removeFromTables(tx: Tables, user: string): void {
    tx.delete("members", user);
    for (const team of tx.all("teams"))
      if (team.members.includes(user))
        tx.put("teams", {
          ...team,
          version: team.version + 1,
          members: team.members.filter((id) => id !== user),
        });
    for (const issue of tx.all("issues"))
      if (issue.followers.includes(user) || issue.assignee === user)
        tx.put("issues", {
          ...issue,
          version: issue.version + 1,
          updated_at: this.now(),
          assignee: issue.assignee === user ? null : issue.assignee,
          followers: issue.followers.filter((id) => id !== user),
        });
  }

  private push(
    workspace: string,
    actor: string,
    clientId: string,
    mutations: Mutation[],
    after?: number,
  ): { status: number; body: PushResponse } {
    this.options.onPush?.({
      clientId,
      mutations: structuredClone(mutations),
      previous: this.clientState(clientId).last_mutation_id,
    });
    const body: PushResponse = {
      last_mutation_id: this.clientState(clientId).last_mutation_id,
      results: [],
    };
    for (const mutation of mutations) {
      if (after !== undefined && body.results.length >= after) return { status: 503, body };
      this.authorize(workspace, actor);
      let client = this.clients.get(clientId);
      if (!client) {
        client = {
          workspace,
          user: actor,
          last_mutation_id: 0,
          updatedAt: this.clock.milliseconds(),
        };
        this.clients.set(clientId, client);
      }
      if (mutation.id <= client.last_mutation_id)
        body.results.push({ id: mutation.id, status: "duplicate" });
      else {
        try {
          this.execute(actor, mutation.name, commandArgs(mutation.name, mutation.args), workspace);
          body.results.push({ id: mutation.id, status: "applied" });
        } catch (error) {
          if (!(error instanceof MutationError) && !(error instanceof TypeError)) throw error;
          body.results.push({
            id: mutation.id,
            status: "rejected",
            error: {
              status: error instanceof MutationError ? error.status : 400,
              message: error instanceof MutationError ? error.message : "invalid command arguments",
            },
          });
          this.txid += 1; // Rejection still commits the client high-water mark.
        }
        client.last_mutation_id = mutation.id;
      }
      client.updatedAt = this.clock.milliseconds();
      body.last_mutation_id = client.last_mutation_id;
      this.options.onResult?.(clientId, structuredClone(body.results[body.results.length - 1]));
    }
    return { status: 200, body };
  }

  private pull(
    workspace: string,
    actor: string,
    clientId: string,
    cursor: string | null,
    forced: boolean,
  ): PullResponse {
    const result: PullResponse = {
      cursor: `${this.txid}:${this.txid}:`,
      more: false,
      reset: false,
      last_mutation_id: null,
      changes: [],
    };
    if (cursor === null) return forced ? { ...result, reset: true } : result;
    const requested = parseCursor(cursor, this.txid);
    const window = this.history.filter(
      (tx) =>
        tx.workspace === workspace && (tx.id >= requested.xmax || requested.xip.includes(tx.id)),
    );
    if (forced || requested.xmin < this.horizon || window.some((tx) => tx.roles.includes(actor)))
      return { ...result, reset: true };
    const pairs = new Map<string, Pair>();
    let included = 0;
    let scanned = 0;
    for (const tx of window) {
      const rows = tx.rows.filter((row) => row.user === null || row.user === actor);
      if (!rows.length) continue;
      const merged = new Map(pairs);
      for (const row of rows) merged.set(`${row.entity}:${row.id}`, row);
      if (merged.size > this.pageSize || scanned > 20_000) {
        if (included === 0) return { ...result, reset: true };
        const xmax = Math.max(requested.xmax, tx.id);
        const xip = requested.xip.filter((id) => id >= tx.id);
        result.cursor = `${xip[0] ?? xmax}:${xmax}:${xip.join(",")}`;
        result.more = true;
        break;
      }
      for (const [key, pair] of merged) pairs.set(key, pair);
      included += 1;
      scanned += rows.length;
    }
    result.changes = [...pairs.values()]
      .sort((a, b) =>
        a.entity < b.entity ? -1 : a.entity > b.entity ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0,
      )
      .map(({ entity, id }) => ({ entity, id, record: this.render(entity, id, actor, workspace) }));
    result.last_mutation_id = result.more ? null : this.clientState(clientId).last_mutation_id;
    return result;
  }

  private bootstrap(
    workspace: string,
    actor: string,
    clientId: string,
    truncate?: number,
  ): Response {
    const lines: object[] = [
      {
        cursor: `${this.txid}:${this.txid}:`,
        last_mutation_id: this.clientState(clientId).last_mutation_id,
        schema: 1,
      },
    ];
    for (const entity of BOOTSTRAP_ENTITIES)
      for (const record of this.records(entity, actor, workspace).sort((a, b) => {
        const idA = "id" in a ? a.id : a.user_id;
        const idB = "id" in b ? b.id : b.user_id;
        return idA < idB ? -1 : idA > idB ? 1 : 0;
      }))
        lines.push({ entity, record });
    const count = lines.length - 1;
    if (truncate === undefined) lines.push({ end: true, records: count });
    else lines.splice(Math.max(0, truncate) + 1);
    const encoder = new TextEncoder();
    let index = 0;
    const body = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (index < lines.length)
          controller.enqueue(encoder.encode(`${JSON.stringify(lines[index++])}\n`));
        else controller.close();
      },
    });
    return new Response(body, { headers: { "content-type": "application/x-ndjson" } });
  }

  private scope(workspace: string, actor: string, params: URLSearchParams): { records: object[] } {
    const entity = params.get("entity");
    if (entity !== "comments" && entity !== "activity")
      throw new MutationError(400, "entity must be comments or activity");
    const key = entity === "comments" ? "issue_id" : "entity_id";
    const id = uuid(params.get(key), key);
    return {
      records: this.records(entity, actor, workspace)
        .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .filter((record) =>
          key === "issue_id"
            ? "issue_id" in record && record.issue_id === id
            : "entity_id" in record && record.entity_id === id,
        ),
    };
  }
}

function json(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return Response.json(body, { status, headers });
}

function parseMutations(payload: unknown): Mutation[] {
  if (
    !object(payload) ||
    !Array.isArray(payload.mutations) ||
    payload.mutations.length < 1 ||
    payload.mutations.length > 100
  )
    throw new MutationError(400, "push 1 to 100 mutations");
  let previous = 0;
  return payload.mutations.map((value: unknown) => {
    if (
      !object(value) ||
      typeof value.id !== "number" ||
      !Number.isSafeInteger(value.id) ||
      value.id <= previous
    )
      throw new MutationError(400, "mutation ids must be positive and strictly increasing");
    if (typeof value.name !== "string" || typeof value.at !== "string")
      throw new MutationError(400, "invalid mutation shape");
    try {
      parseTimestamp(value.at, true);
    } catch {
      throw new MutationError(400, "invalid mutation timestamp");
    }
    previous = value.id;
    return { id: value.id, name: value.name, args: value.args, at: value.at };
  });
}

function parseCursor(
  text: string,
  snapshot: number,
): { xmin: number; xmax: number; xip: number[] } {
  const parts = text.split(":");
  const integers = [parts[0], parts[1], ...(parts[2] ? parts[2].split(",") : [])];
  if (
    parts.length !== 3 ||
    integers.some((part) => !/^\d+$/.test(part) || !Number.isSafeInteger(Number(part)))
  )
    throw new MutationError(400, "cursor must be a cursor from this server");
  const [xmin, xmax, ...xip] = integers.map(Number);
  if (
    xmin > xmax ||
    xmax > snapshot ||
    xip.length > 10_000 ||
    (xip[0] ?? xmax) !== xmin ||
    xip.some((id, index) => id >= xmax || (index > 0 && id <= xip[index - 1]))
  )
    throw new MutationError(400, "cursor must be a cursor from this server");
  return { xmin, xmax, xip };
}
