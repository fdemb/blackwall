import { describe, expect, it } from "vite-plus/test";
import { usageLevel } from "./usage";

describe("usage level", () => {
  it("warns from 80% of a limit and marks a reached limit full", () => {
    expect(usageLevel({ resource: "issues", used: 39_999, limit: 50_000 })).toBe("ok");
    expect(usageLevel({ resource: "issues", used: 40_000, limit: 50_000 })).toBe("near");
    expect(usageLevel({ resource: "issues", used: 50_000, limit: 50_000 })).toBe("full");
  });

  it("never warns without a limit", () => {
    expect(usageLevel({ resource: "comments", used: 9_000_000, limit: null })).toBe("ok");
  });
});
