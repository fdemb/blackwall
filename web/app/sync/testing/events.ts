import { FakeClock } from "./clock";

export interface EventTiming {
  coalesceMs: number;
  keepaliveMs: number;
  lifetimeMs: number;
}

const encoder = new TextEncoder();

function pokeChunk(data: object): Uint8Array {
  return encoder.encode(`event: poke\ndata: ${JSON.stringify(data)}\n\n`);
}

/** A capacity-one poke queue, including the trailing edge of a commit burst. */
export class EventConnection {
  readonly response: Response;
  private controller?: ReadableStreamDefaultController<Uint8Array>;
  private closed = false;
  private lastSend: number;
  private pending = false;
  private pokeQueued = true;
  /** The newest txid of the coalescing window, null once a wildcard joined it, or none yet. */
  private window?: number | null;
  /** A stamped poke the reader had no room for, sent when it reads, so no txid is lost. */
  private missed: Uint8Array | null = null;
  private cancelTrailing?: () => void;
  private cancelKeepalive?: () => void;
  private readonly cancelLifetime: () => void;
  private readonly abort: () => void;

  constructor(
    private readonly clock: FakeClock,
    private readonly timing: EventTiming,
    private readonly signal: AbortSignal,
    private readonly onClose: () => void,
    /** Stamps pokes with their txid and this epoch, as the Rust server does. */
    private readonly epoch?: string,
  ) {
    this.lastSend = clock.milliseconds();
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        this.controller = controller;
        controller.enqueue(pokeChunk({}));
      },
      pull: (controller) => {
        this.pokeQueued = false;
        if (this.missed === null) return;
        controller.enqueue(this.missed);
        this.missed = null;
        this.pokeQueued = (controller.desiredSize ?? 0) <= 0;
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

  poke(txid?: number): void {
    if (this.closed) return;
    this.window =
      this.window === null || txid === undefined ? null : Math.max(this.window ?? txid, txid);
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
    const txid = this.window;
    this.window = undefined;
    const stamped = this.epoch !== undefined && typeof txid === "number";
    const chunk = pokeChunk(stamped ? { txid, epoch: this.epoch } : {});
    if (!this.pokeQueued) {
      this.controller?.enqueue(chunk);
      this.pokeQueued = (this.controller?.desiredSize ?? 0) <= 0;
    } else if (this.epoch !== undefined) this.missed = chunk;
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
