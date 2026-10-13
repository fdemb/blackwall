import { redirect } from "react-router";
import { ApiError, auth, workspaces } from "./api";
import { safeGet, safeRemove, safeSet } from "./storage";
import { acceptSession, clearSession } from "./session-replicas";
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
    return await acceptSession(profile);
  } catch (e) {
    if (sequence !== meRequests) return newestMe;
    if (e instanceof ApiError && e.status === 401) {
      await clearSession();
      return null;
    }
    throw e;
  }
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

export async function landing(): Promise<{ profile: SessionProfile; list: WorkspaceSummary[] }> {
  const profile = await currentProfile();
  if (!profile) throw redirect("/login");
  return { profile, list: await workspaces.list() };
}
