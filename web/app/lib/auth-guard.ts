import { redirect } from "react-router";
import { ApiError, auth, workspaces } from "./api";
import { safeGet, safeRemove, safeSet } from "./storage";
import { acceptSession, clearSession } from "./session-replicas";
import type { SessionProfile } from "../sync/transport";
import type { WorkspaceSummary } from "./types";

export async function currentProfile(): Promise<SessionProfile | null> {
  try {
    return await acceptSession(await auth.me());
  } catch (e) {
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
