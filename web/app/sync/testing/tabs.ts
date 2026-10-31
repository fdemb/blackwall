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
  /** Holds back the next message of this type, from any tab, until the call it returns. */
  delay(type: TabMessage["type"]): () => void;
  /** Messages of this type posted so far, dropped or not. */
  sent(type: TabMessage["type"]): number;
}

interface Endpoint {
  name: string;
  closed: boolean;
  listeners: Set<(event: { data: TabMessage }) => void>;
}

type Delivery = { to: Endpoint; message: TabMessage };
type Delay = { type: TabMessage["type"]; held: Delivery[] | null };

interface LockState {
  held: boolean;
  waiting: Array<() => void>;
}

export function createTabHub(): TabHub {
  const locks = new Map<string, LockState>();
  const endpoints = new Set<Endpoint>();
  const queue: Delivery[] = [];
  const drops: Array<{ type: TabMessage["type"]; count: number }> = [];
  const delays: Delay[] = [];
  const posted: TabMessage["type"][] = [];
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
          posted.push(message.type);
          const drop = drops.find((entry) => entry.type === message.type && entry.count > 0);
          if (drop) {
            drop.count -= 1;
            return;
          }
          const deliveries: Delivery[] = [];
          for (const other of endpoints)
            if (other !== endpoint && other.name === name) deliveries.push({ to: other, message });
          const delayed = delays.find((entry) => entry.type === message.type && !entry.held);
          if (delayed) {
            delayed.held = deliveries;
            return;
          }
          queue.push(...deliveries);
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
    delay: (type) => {
      const entry: Delay = { type, held: null };
      delays.push(entry);
      return () => {
        delays.splice(delays.indexOf(entry), 1);
        queue.push(...(entry.held ?? []));
        schedule();
      };
    },
    sent: (type) => posted.filter((kind) => kind === type).length,
  };
}
