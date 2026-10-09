import type { SyncEngine, Rejection } from "../sync/engine";
import type { DeepReadonly, PendingMutation } from "../sync/store";
import { ONLINE_ONLY } from "../sync/mutators";
import { ApiError, workspaces } from "./api";
import type { Command } from "./types";

export class ServerRejection extends ApiError {}

export async function runCommand(
  engine: SyncEngine,
  command: Command,
  settled = false,
): Promise<string | null> {
  if (command.type === "create_integration" && !command.id)
    command = { ...command, id: crypto.randomUUID() };
  const { type, ...args } = command;
  if (ONLINE_ONLY.some((name) => name === type)) {
    const result = await engine.runOnline(type, args);
    if (result.status === "rejected")
      throw new ServerRejection(result.error.message, result.error.status);
    // Online creates cannot predict their server result; create_integration supplies its id.
    return type === "create_integration" ? (command.id ?? null) : null;
  }
  const receipt = await engine.mutate(type, args);
  if (settled) {
    const outcome = await receipt.settled;
    if (outcome !== "applied") throw new ServerRejection(outcome.message, outcome.status);
  }
  return receipt.id;
}

// Creates that give their record a client-chosen id, which the server later confirms.
const CREATING = new Set([
  "create_team",
  "create_stage",
  "create_label",
  "create_project",
  "create_milestone",
  "create_sprint",
  "add_comment",
  "log_time",
  "save_view",
]);

function createdId(mutation: DeepReadonly<PendingMutation>): string | null {
  const args = mutation.args;
  if (args === null || typeof args !== "object") return null;
  if (mutation.name === "create_issue" && "input" in args && isObject(args.input))
    return typeof args.input.id === "string" ? args.input.id : null;
  if (CREATING.has(mutation.name) && "id" in args && typeof args.id === "string") return args.id;
  return null;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object";
}

const UUID = /^[\da-f]{8}-[\da-f]{4}-[\da-f]{4}-[\da-f]{4}-[\da-f]{12}$/i;
/** Every UUID string in a request body. Pending creates among them must reach the server first. */
export function uuidsIn(value: unknown): string[] {
  if (typeof value === "string") return UUID.test(value) ? [value] : [];
  if (Array.isArray(value)) return value.flatMap(uuidsIn);
  if (isObject(value)) return Object.values(value).flatMap(uuidsIn);
  return [];
}

/**
 * Resolves once no pending mutation creates any of `ids`, so the server knows them. Rejects when
 * the engine closes, access is lost, or the engine goes offline while those creates still wait.
 */
export function whenConfirmed(engine: SyncEngine, ids: Iterable<string>): Promise<void> {
  const wanted = new Set(ids);
  return new Promise((resolve, reject) => {
    const waiting = () =>
      engine.store.pending().some((mutation) => {
        const id = createdId(mutation);
        return id !== null && wanted.has(id);
      });
    const finish = (error?: Error) => {
      unsubscribeStore();
      unsubscribeStatus();
      unsubscribeEvents();
      if (error) reject(error);
      else resolve();
    };
    const check = () => {
      if (engine.isClosed()) finish(new Error("Workspace engine closed"));
      else if (!waiting()) finish();
      else if (!engine.status.get().online)
        finish(new ApiError("This command requires an online connection", 400));
    };
    const unsubscribeStore = engine.store.subscribe(check);
    const unsubscribeStatus = engine.status.subscribe(check);
    const unsubscribeEvents = engine.subscribe((event) => {
      if (event.type === "closed") finish(new Error("Workspace engine closed"));
      else if (event.type === "unauthorized" || event.type === "accessLost")
        finish(new ApiError("Workspace access lost", 403));
    });
    check();
  });
}

export async function waitForUploadTarget(
  engine: SyncEngine,
  issueId: string,
  commentId?: string,
): Promise<void> {
  await whenConfirmed(engine, commentId === undefined ? [issueId] : [issueId, commentId]);
  if (!engine.store.get("issues", issueId)) throw new ApiError("Upload target not found", 404);
}

export async function uploadFile(
  engine: SyncEngine,
  workspaceId: string,
  issueId: string,
  file: File,
  commentId?: string,
): Promise<string | null> {
  if (!engine.status.get().online)
    throw new ApiError("This command requires an online connection", 400);
  await waitForUploadTarget(engine, issueId, commentId);
  const result = await workspaces.upload(workspaceId, issueId, undefined, file, commentId);
  await engine.pull();
  return result.result.id;
}

const shownRejections = new WeakMap<SyncEngine, Set<number>>();
export function watchRejections(engine: SyncEngine, notify: (message: string) => void): () => void {
  let shown = shownRejections.get(engine);
  if (!shown) {
    shown = new Set();
    shownRejections.set(engine, shown);
  }
  const seen = shown;
  const show = (rejection: Rejection) => {
    if (seen.has(rejection.id)) return;
    seen.add(rejection.id);
    notify(rejection.message);
  };
  const unsubscribe = engine.subscribe((event) => {
    if (event.type === "rejected") show(event.rejection);
  });
  // Restored mutations can be rejected before the disk-first loader mounts the provider.
  engine.status.get().rejected.forEach(show);
  return unsubscribe;
}
