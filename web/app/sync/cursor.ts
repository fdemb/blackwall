/** What a poke names: the newest commit it stands for and that commit's history, or neither. */
export interface PokeData {
  txid?: number;
  epoch?: string;
}

/**
 * Whether a cursor already covers the commit a poke names, so the pull it asks for would bring
 * nothing. A coalesced poke names only its newest txid, and an older one in the same window may
 * still be in flight in the cursor's `xip`, so only a cursor with an empty `xip` can tell.
 */
export function pokeCovered(cursor: string | null, poke: PokeData): boolean {
  if (cursor === null || poke.txid === undefined || poke.epoch === undefined) return false;
  const at = cursor.indexOf("@");
  if (at < 0 || cursor.slice(0, at) !== poke.epoch) return false;
  // Only a complete snapshot with nothing in flight: a partial cursor (`:txid.row`) still owes
  // part of a transaction, so it never covers a poke.
  const parts = cursor.slice(at + 1).split(":");
  if (parts.length !== 3) return false;
  const [xmin, xmax, xip] = parts;
  if (xip !== "" || !/^\d+$/.test(xmin) || !/^\d+$/.test(xmax)) return false;
  if (Number(xmin) > Number(xmax)) return false;
  return poke.txid < Number(xmax);
}

/** Two pokes as one: the newer txid of one history, or a wildcard when they can't be combined. */
export function mergePokes(a: PokeData | null, b: PokeData): PokeData {
  if (a === null) return b;
  if (a.epoch === undefined || a.epoch !== b.epoch) return {};
  if (a.txid === undefined || b.txid === undefined) return {};
  return { txid: Math.max(a.txid, b.txid), epoch: a.epoch };
}
