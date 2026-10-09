import type { TabChannel, TabLocks } from "../engine-types";
import type { TabMessage } from "../tabs";

/**
 * Stand-ins for navigator.locks and BroadcastChannel, shared by the engines of one browser.
 * Lock callbacks and deliveries run on microtasks, so they never run inside the caller.
 */
export interface TabHub {
  locks: TabLocks;
  channel: (name: string) => TabChannel;
  /** Stops deliveries until release(). Queued messages keep their order. */
  hold(): void;
  release(): void;
  /** Discards the next `count` messages of this type, whichever tab sends them. */
  drop(type: TabMessage["type"], count?: number): void;
}

interface Endpoint {
  name: string;
  closed: boolean;
  listeners: Set<(event: { data: TabMessage }) => void>;
}

interface LockState {
  held: boolean;
  waiting: Array<() => void>;
}

export function createTabHub(): TabHub {
  const locks = new Map<string, LockState>();
  const endpoints = new Set<Endpoint>();
  const queue: Array<{ to: Endpoint; message: TabMessage }> = [];
  const drops: Array<{ type: TabMessage["type"]; count: number }> = [];
  let held = false;
  let draining = false;

  const stateOf = (name: string): LockState => {
    const state = locks.get(name) ?? { held: false, waiting: [] };
    locks.set(name, state);
    return state;
  };
  const grant = (name: string) => {
    const state = stateOf(name);
    if (state.held) return;
    const next = state.waiting.shift();
    if (!next) return;
    state.held = true;
    next();
  };

  const schedule = () => {
    if (held || draining || queue.length === 0) return;
    draining = true;
    queueMicrotask(() => {
      try {
        while (!held && queue.length > 0) {
          const item = queue.shift();
          if (!item || item.to.closed) continue;
          for (const listener of [...item.to.listeners])
            listener({ data: structuredClone(item.message) });
        }
      } finally {
        draining = false;
      }
    });
  };

  return {
    locks: {
      request: (name, callback) =>
        new Promise<void>((resolve, reject) => {
          stateOf(name).waiting.push(() => {
            Promise.resolve()
              .then(callback)
              .then(resolve, reject)
              .finally(() => {
                stateOf(name).held = false;
                grant(name);
              });
          });
          grant(name);
        }),
    },
    channel: (name) => {
      const endpoint: Endpoint = { name, closed: false, listeners: new Set() };
      endpoints.add(endpoint);
      return {
        postMessage(message) {
          if (endpoint.closed) throw new Error("channel is closed");
          const drop = drops.find((entry) => entry.type === message.type && entry.count > 0);
          if (drop) {
            drop.count -= 1;
            return;
          }
          for (const other of endpoints)
            if (other !== endpoint && other.name === name) queue.push({ to: other, message });
          schedule();
        },
        addEventListener: (_type, listener) => {
          endpoint.listeners.add(listener);
        },
        removeEventListener: (_type, listener) => {
          endpoint.listeners.delete(listener);
        },
        close: () => {
          endpoint.closed = true;
          endpoints.delete(endpoint);
        },
      };
    },
    hold: () => {
      held = true;
    },
    release: () => {
      held = false;
      schedule();
    },
    drop: (type, count = 1) => {
      drops.push({ type, count });
    },
  };
}
