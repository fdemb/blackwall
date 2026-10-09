export function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

export const simulationId = (n: number): ReturnType<typeof crypto.randomUUID> =>
  `22222222-2222-4222-8222-${n.toString(16).padStart(12, "0")}`;
