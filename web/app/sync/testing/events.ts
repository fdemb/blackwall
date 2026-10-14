import { FakeClock } from "./clock";

export interface EventTiming {
  coalesceMs: number;
  keepaliveMs: number;
  lifetimeMs: number;
}

const encoder = new TextEncoder();
const POKE = encoder.encode("event: poke\ndata: {}\n\n");

/** A capacity-one poke queue, including the trailing edge of a commit burst. */
export class EventConnection {
  readonly response: Response;
  private controller?: ReadableStreamDefaultController<Uint8Array>;
  private closed = false;
  private lastSend: number;
  private pending = false;
  private pokeQueued = true;
  private cancelTrailing?: () => void;
  private cancelKeepalive?: () => void;
  private readonly cancelLifetime: () => void;
  private readonly abort: () => void;

  constructor(
    private readonly clock: FakeClock,
    private readonly timing: EventTiming,
    private readonly signal: AbortSignal,
    private readonly onClose: () => void,
  ) {
    this.lastSend = clock.milliseconds();
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.controller = controller;
        controller.enqueue(POKE);
      },
      pull: () => {
        this.pokeQueued = false;
      },
      cancel: () => this.close(),
    });
    this.response = new Response(body, {
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      },
    });
    this.cancelLifetime = clock.schedule(timing.lifetimeMs, () => this.close());
    this.keepalive();
    this.abort = () => this.close();
    signal.addEventListener("abort", this.abort, { once: true });
    if (signal.aborted) this.close();
  }

  poke(): void {
    if (this.closed) return;
    const wait = this.lastSend + this.timing.coalesceMs - this.clock.milliseconds();
    if (wait <= 0) this.send();
    else if (!this.pending) {
      this.pending = true;
      this.cancelTrailing = this.clock.schedule(wait, () => {
        this.pending = false;
        this.send();
      });
    }
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.cancelLifetime();
    this.cancelTrailing?.();
    this.cancelKeepalive?.();
    this.signal.removeEventListener("abort", this.abort);
    // cancel() already closes the controller before invoking the source callback.
    try {
      this.controller?.close();
    } catch {
      /* Reader cancelled the stream. */
    }
    this.onClose();
  }

  private send(): void {
    if (this.closed) return;
    if (!this.pokeQueued) {
      this.controller?.enqueue(POKE);
      this.pokeQueued = (this.controller?.desiredSize ?? 0) <= 0;
    }
    this.lastSend = this.clock.milliseconds();
  }

  private keepalive(): void {
    this.cancelKeepalive = this.clock.schedule(this.timing.keepaliveMs, () => {
      if (this.closed) return;
      if ((this.controller?.desiredSize ?? 0) > 0)
        this.controller?.enqueue(encoder.encode(":\n\n"));
      this.keepalive();
    });
  }
}
