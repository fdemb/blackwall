import { beforeAll, describe, expect, it } from "vite-plus/test";
import { enabled, register, suiteName } from "./environment";
import type { User } from "./environment";
import { runRealConvergence } from "./convergence";

function integer(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`invalid ${name}`);
  return value;
}
const seeds = process.env.SYNC_FUZZ_SEED
  ? [integer("SYNC_FUZZ_SEED", 1)]
  : process.env.SYNC_FUZZ_SEEDS
    ? Array.from({ length: integer("SYNC_FUZZ_SEEDS", 3) }, (_, index) => index + 1)
    : [1, 42, 1337];

describe.skipIf(!enabled)(`${suiteName}: seeded convergence`, () => {
  let users: [User, User, User];
  beforeAll(async () => {
    users = [await register("Owner"), await register("Member"), await register("Viewer")];
  }, 30_000);
  it.each(seeds)(
    "converges seed %i with fresh actor-specific bootstraps",
    async (seed) => {
      const result = await runRealConvergence(seed, users, integer("SYNC_FUZZ_STEPS", 45));
      expect(result.accepted).toBeGreaterThan(1);
      expect(result.rejected).toBeGreaterThan(0);
      expect(result.coverage).toEqual(
        expect.arrayContaining([
          "mutation",
          "admission-rejected",
          "server-rejected",
          "offline",
          "online",
          "drop-response",
          "stop-start",
          "reload",
          "scope",
          "set-role",
          "quiescence",
        ]),
      );
    },
    90_000,
  );
});
