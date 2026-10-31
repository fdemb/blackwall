import { redirect } from "react-router";
import { ApiError, auth, workspaces } from "./api";
import { safeGet, safeRemove, safeSet } from "./storage";
import {
  acceptSession,
  expireSession,
  rememberWorkspaces,
  rememberedWorkspaces,
  restoreSession,
} from "./session-replicas";
import type { SessionProfile } from "../sync/transport";
import type { WorkspaceSummary } from "./types";

let meRequests = 0;
let newestMe: Promise<SessionProfile | null> = Promise.resolve(null);

export function currentProfile(): Promise<SessionProfile | null> {
  const sequence = (meRequests += 1);
  newestMe = readProfile(sequence);
  return newestMe;
}

// Only the newest /internal-api/me may change the session. An older reply that lands last answers with
// the newest one, so it can't delete the replicas of the session the newest reply started.
async function readProfile(sequence: number): Promise<SessionProfile | null> {
  try {
    const profile = await auth.me();
    if (sequence !== meRequests) return newestMe;
    const accepted = await acceptSession(profile, () => sequence === meRequests);
    return accepted ?? (sequence === meRequests ? null : newestMe);
  } catch (e) {
    if (sequence !== meRequests) return newestMe;
    if (e instanceof ApiError && e.status === 401) {
      await expireSession(() => sequence === meRequests);
      return null;
    }
    const restored = unavailable(e) ? restoreSession() : null;
    if (restored) return restored;
    throw e;
  }
}

/** The server could not be reached or failed, as opposed to answering about the session. */
function unavailable(e: unknown) {
  return e instanceof TypeError || (e instanceof ApiError && e.status >= 500);
}

export function signInFor(url: string): string {
  const { pathname, search } = new URL(url);
  const next = pathname + search;
  return next === "/" ? "/login" : `/login?next=${encodeURIComponent(next)}`;
}

export function sameOriginPathOrHome(next: string | null, origin = window.location.origin): string {
  if (!next?.startsWith("/")) return "/";
  const url = new URL(next, origin);
  // Dot segments can resolve to a protocol-relative path such as `//evil.com`.
  if (url.origin !== origin || url.pathname.startsWith("//")) return "/";
  return url.pathname + url.search + url.hash;
}

export const LAST_WS = "bw-last-workspace:v1";

export function readLastWs() {
  return safeGet("local", LAST_WS);
}

export function writeLastWs(id: string) {
  safeSet("local", LAST_WS, id);
}

export function clearLastWs() {
  safeRemove("local", LAST_WS);
}

type Landing = { profile: SessionProfile; list: WorkspaceSummary[] };

// The authed layout and the workspace route load together; they share one request pair.
let landingRequest: Promise<Landing> | null = null;

export function landing(): Promise<Landing> {
  landingRequest ??= loadLanding().finally(() => {
    landingRequest = null;
  });
  return landingRequest;
}

async function loadLanding(): Promise<Landing> {
  const profile = await currentProfile();
  if (!profile) throw redirect("/login");
  try {
    const list = await workspaces.list();
    rememberWorkspaces(list);
    return { profile, list };
  } catch (e) {
    const list = unavailable(e) ? rememberedWorkspaces() : null;
    if (list) return { profile, list };
    throw e;
  }
}

/**
 * The workspace a URL names: by slug, or by id for links from before slugs. Reads the remembered
 * list first, so a known workspace opens offline, then asks the server about new ones.
 */
export async function findWorkspace(ref: string): Promise<WorkspaceSummary | undefined> {
  const named = (list: WorkspaceSummary[]) => list.find((w) => w.slug === ref || w.id === ref);
  return named(rememberedWorkspaces() ?? []) ?? named((await landing()).list);
}
