const key = (ws: string) => `bw-last-path:${ws}`;

/** Records the last app page so "Back to app" in settings returns there. */
export function rememberAppPath(ws: string, path: string) {
  sessionStorage.setItem(key(ws), path);
}

export function lastAppPath(ws: string) {
  return sessionStorage.getItem(key(ws)) ?? `/${ws}/my-issues`;
}
