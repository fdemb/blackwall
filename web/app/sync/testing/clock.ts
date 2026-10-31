/**
 * Explicit time for request delays, sessions and event streams. No wall-clock timers. `now` is the
 * client's wall clock, which `jump` can move in either direction. `monotonic` never does.
 */
export class FakeClock {
  private time: number;
  private skew = 0;
  private sequence = 0;
  private readonly timers = new Map<number, { at: number; run: () => void }>();

  constructor(at: string) {
    this.time = Date.parse(at);
    if (!Number.isFinite(this.time)) throw new Error("invalid clock timestamp");
  }

  now(): string {
    return new Date(this.time + this.skew).toISOString();
  }

  /** Milliseconds since an arbitrary start. Unaffected by `jump`. */
  monotonic(): number {
    return this.time;
  }

  /** Moves the wall clock without moving timers, like a user or NTP correcting the system time. */
  jump(ms: number): void {
    if (!Number.isFinite(ms)) throw new Error("clock must jump by a finite duration");
    this.skew += ms;
  }

  milliseconds(): number {
    return this.time;
  }

  schedule(ms: number, run: () => void): () => void {
    if (!Number.isFinite(ms) || ms < 0) throw new Error("invalid timer duration");
    const id = ++this.sequence;
    this.timers.set(id, { at: this.time + ms, run });
    return () => this.timers.delete(id);
  }

  advance(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) throw new Error("clock must advance by a finite duration");
    const target = this.time + ms;
    for (;;) {
      const next = [...this.timers].sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!next || next[1].at > target) break;
      this.time = next[1].at;
      this.timers.delete(next[0]);
      next[1].run();
    }
    this.time = target;
  }
}
