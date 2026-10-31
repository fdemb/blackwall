/**
 * Records the bootstrap a workspace navigation waits on has received, for the loading screen.
 * It lives apart from the engine so the root route can read it without loading the sync code.
 */
let received: number | null = null;
const listeners = new Set<() => void>();

export const firstLoad = {
  get: (): number | null => received,
  subscribe(listener: () => void): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  set(next: number | null): void {
    if (next === received) return;
    received = next;
    for (const listener of listeners) listener();
  },
};
