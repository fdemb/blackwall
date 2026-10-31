import type { EngineClock } from "./engine-types";

export class Cancelled extends Error {
  constructor() {
    super("Sync work cancelled");
  }
}

/** A pull that keeps failing with protocol errors asks for a fresh bootstrap instead of blocking. */
export class Resync extends Error {
  constructor() {
    super("Sync state needs a fresh download");
  }
}

/** Queue failures reach the caller without poisoning subsequent work. */
export class SerialQueue {
  private tail: Promise<unknown> = Promise.resolve();

  run<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work);
    this.tail = result.catch(() => undefined);
    return result;
  }

  async drain(): Promise<void> {
    await this.tail;
  }
}

/** Release the caller on abort even when an injected transport ignores it. */
export function cancellable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  let abort = () => {};
  const result = new Promise<T>((resolve, reject) => {
    abort = () => reject(new Cancelled());
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
    void work.then(resolve, reject);
  });
  return result.finally(() => signal.removeEventListener("abort", abort));
}

export async function pause(clock: EngineClock, milliseconds: number, signal: AbortSignal) {
  let cancel = () => {};
  const work = new Promise<void>((resolve) => {
    cancel = clock.schedule(milliseconds, resolve);
  });
  try {
    await cancellable(work, signal);
  } finally {
    cancel();
  }
}

/** The longest wait a Retry-After can ask for. A wrong wall clock turns an HTTP date into hours. */
const MAX_RETRY_AFTER_MS = 5 * 60_000;

/**
 * A per-engine seeded generator; ids and user actions do not change jitter. The result is a
 * duration. An HTTP-date Retry-After is turned into one here, once, against the wall clock, and
 * callers track the wait with the monotonic clock from then on.
 */
export function backoff(
  seed: string,
  clock: EngineClock,
): (attempt: number, retryAfter?: number | string | null) => number {
  let state = 2166136261;
  for (const char of seed) state = Math.imul(state ^ char.charCodeAt(0), 16777619) >>> 0;
  return (attempt, retryAfter) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const cap = Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5));
    const requested =
      typeof retryAfter === "string"
        ? Date.parse(retryAfter) - Date.parse(clock.now())
        : (retryAfter ?? 0) * 1000;
    return Math.max(
      cap * (0.5 + state / 0x1_0000_0000 / 2),
      Math.min(Number.isNaN(requested) ? 0 : requested, MAX_RETRY_AFTER_MS),
    );
  };
}
