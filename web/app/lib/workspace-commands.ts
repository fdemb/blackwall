import type { SyncEngine, Rejection } from "../sync/engine";
import { ONLINE_ONLY } from "../sync/mutators";
import { ApiError, workspaces } from "./api";
import { workspaceEngineSignal } from "./session-replicas";
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

export function waitForUploadTarget(
  engine: SyncEngine,
  issueId: string,
  commentId?: string,
): Promise<void> {
  const signal = workspaceEngineSignal(engine);
  return new Promise((resolve, reject) => {
    const pending = () =>
      engine.store.pending().some((mutation) => {
        const args = mutation.args;
        if (args === null || typeof args !== "object") return false;
        if (
          mutation.name === "create_issue" &&
          "input" in args &&
          args.input !== null &&
          typeof args.input === "object" &&
          "id" in args.input &&
          args.input.id === issueId
        )
          return true;
        return (
          commentId !== undefined &&
          mutation.name === "add_comment" &&
          "id" in args &&
          args.id === commentId
        );
      });
    const finish = (error?: Error) => {
      unsubscribeStore();
      unsubscribeStatus();
      unsubscribeEvents();
      signal.removeEventListener("abort", aborted);
      if (error) reject(error);
      else resolve();
    };
    const check = () => {
      if (!engine.status.get().online)
        finish(new ApiError("This command requires an online connection", 400));
      else if (!pending()) {
        if (!engine.store.get("issues", issueId))
          finish(new ApiError("Upload target not found", 404));
        else finish();
      }
    };
    const aborted = () => finish(new Error("Workspace engine closed"));
    const unsubscribeStore = engine.store.subscribe(check);
    const unsubscribeStatus = engine.status.subscribe(check);
    const unsubscribeEvents = engine.subscribe((event) => {
      if (event.type === "unauthorized" || event.type === "accessLost")
        finish(new ApiError("Upload target unavailable", 403));
    });
    signal.addEventListener("abort", aborted, { once: true });
    if (signal.aborted) aborted();
    else check();
  });
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
