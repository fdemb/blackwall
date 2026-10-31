import { describe, expect, it } from "vite-plus/test";
import { mergePokes, pokeCovered } from "./cursor";

const EPOCH = "6f1c0b8e2d9a4c7fa3e51b2d8c04a9f7";
const OTHER = "0123456789abcdef0123456789abcdef";

describe("pokeCovered", () => {
  it("skips a txid below xmax of the same epoch with nothing in flight", () => {
    expect(pokeCovered(`${EPOCH}@812:812:`, { txid: 811, epoch: EPOCH })).toBe(true);
    expect(pokeCovered(`${EPOCH}@700:812:`, { txid: 3, epoch: EPOCH })).toBe(true);
  });

  it("pulls for a txid at or above xmax", () => {
    expect(pokeCovered(`${EPOCH}@812:812:`, { txid: 812, epoch: EPOCH })).toBe(false);
    expect(pokeCovered(`${EPOCH}@812:812:`, { txid: 900, epoch: EPOCH })).toBe(false);
  });

  it("pulls when the cursor lists in-flight transactions", () => {
    expect(pokeCovered(`${EPOCH}@805:812:805`, { txid: 811, epoch: EPOCH })).toBe(false);
    expect(pokeCovered(`${EPOCH}@805:812:805,810`, { txid: 800, epoch: EPOCH })).toBe(false);
  });

  it("pulls for a partial cursor or a malformed snapshot", () => {
    expect(pokeCovered(`${EPOCH}@812:812::812.7`, { txid: 811, epoch: EPOCH })).toBe(false);
    expect(pokeCovered(`${EPOCH}@invalid:812:`, { txid: 3, epoch: EPOCH })).toBe(false);
    expect(pokeCovered(`${EPOCH}@812:x:`, { txid: 3, epoch: EPOCH })).toBe(false);
    expect(pokeCovered(`${EPOCH}@900:812:`, { txid: 3, epoch: EPOCH })).toBe(false);
    expect(pokeCovered(`${EPOCH}@812:812`, { txid: 3, epoch: EPOCH })).toBe(false);
  });

  it("pulls for another epoch, a wildcard, or a cursor without an epoch", () => {
    expect(pokeCovered(`${EPOCH}@812:812:`, { txid: 3, epoch: OTHER })).toBe(false);
    expect(pokeCovered(`${EPOCH}@812:812:`, {})).toBe(false);
    expect(pokeCovered(`${EPOCH}@812:812:`, { txid: 3 })).toBe(false);
    expect(pokeCovered("812:812:", { txid: 3, epoch: EPOCH })).toBe(false);
    expect(pokeCovered(null, { txid: 3, epoch: EPOCH })).toBe(false);
  });
});

describe("mergePokes", () => {
  it("keeps the newer txid of one epoch and widens anything else to a wildcard", () => {
    expect(mergePokes(null, { txid: 4, epoch: EPOCH })).toEqual({ txid: 4, epoch: EPOCH });
    expect(mergePokes({ txid: 9, epoch: EPOCH }, { txid: 4, epoch: EPOCH })).toEqual({
      txid: 9,
      epoch: EPOCH,
    });
    expect(mergePokes({ txid: 9, epoch: EPOCH }, { txid: 4, epoch: OTHER })).toEqual({});
    expect(mergePokes({}, { txid: 4, epoch: EPOCH })).toEqual({});
    expect(mergePokes({ txid: 4, epoch: EPOCH }, {})).toEqual({});
  });
});
