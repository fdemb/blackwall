import { safeGet, safeSet } from "./storage";

const key = (ws: string) => `bw-last-path:v1:${ws}`;

/** Records the last app page so "Back to app" in settings returns there. */
export function rememberAppPath(ws: string, path: string) {
  safeSet("session", key(ws), path);
}

export function lastAppPath(ws: string) {
  return safeGet("session", key(ws)) ?? `/${ws}/my-issues`;
}
