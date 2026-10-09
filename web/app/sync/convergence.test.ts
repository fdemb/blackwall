import { describe, expect, it, vi } from "vite-plus/test";
import { runConvergence, simulationId } from "./testing/convergence";

const defaultSeeds = [
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 19, 42, 97, 313, 1337, 0x5eed, 0xc0ffee,
];
function envInteger(name: string, fallback: number): number {
  const value = process.env[name];
  if (value === undefined) return fallback;
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number < 0) throw new Error(`invalid ${name}`);
  return number;
}
const seeds =
  process.env.SYNC_FUZZ_SEED === undefined
    ? process.env.SYNC_FUZZ_SEEDS === undefined
      ? defaultSeeds
      : Array.from({ length: envInteger("SYNC_FUZZ_SEEDS", 300) }, (_, index) => index + 1)
    : [envInteger("SYNC_FUZZ_SEED", 1)];
// Tab runs use a few seeds by default, and the same seeds as the soak when one is requested.
const tabSeeds =
  process.env.SYNC_FUZZ_SEED === undefined && process.env.SYNC_FUZZ_SEEDS === undefined
    ? [1, 2, 3, 4, 5, 6]
    : seeds;
const steps = envInteger("SYNC_FUZZ_STEPS", 90);
const coverage = new Set<string>();

async function run(seed: number, options: { tabs?: boolean } = {}) {
  let id = 1_000_000;
  const spy = vi.spyOn(crypto, "randomUUID").mockImplementation(() => simulationId(id++));
  try {
    return await runConvergence(seed, steps, options);
  } finally {
    spy.mockRestore();
  }
}

describe("sync convergence", () => {
  it.each(seeds)(
    "converges seed %i",
    async (seed) => {
      const result = await run(seed);
      for (const action of result.coverage) coverage.add(action);
      expect(result.accepted).toBeGreaterThan(0);
    },
    60_000,
  );

  it.each(tabSeeds)(
    "converges tabs of one browser, seed %i",
    async (seed) => {
      const result = await run(seed, { tabs: true });
      for (const action of result.coverage) coverage.add(action);
      expect(result.accepted).toBeGreaterThan(0);
    },
    60_000,
  );

  it("repeats the same request, action and outcome trace for a seed", async () => {
    const first = await run(42);
    const second = await run(42);
    expect(second.traceHash).toBe(first.traceHash);
    expect(second.trace).toEqual(first.trace);
  }, 60_000);

  it.skipIf(process.env.SYNC_FUZZ_SEED !== undefined || seeds.length < 12)(
    "reaches the fault, lifecycle and auth mix",
    () => {
      const required = [
        "response_delay",
        "drop_response",
        "duplicate_push",
        "unavailable",
        "cut_bootstrap",
        "truncate_bootstrap",
        "close_events",
        "reset_pull",
        "malformed-bootstrap",
        "malformed-pull",
        "malformed-scope",
        "malformed-push",
        "horizon",
        "reload",
        "lifecycle",
        "connectivity",
        "commit-boundary",
        "csrf-rotation",
        "poke-storm",
        "admission-rejected",
        ...["me", "bootstrap", "pull", "push", "scope", "events"].flatMap((route) => [
          `auth-${route}-401`,
          `auth-${route}-403`,
        ]),
      ];
      expect(required.filter((action) => !coverage.has(action))).toEqual([]);
    },
  );
});
