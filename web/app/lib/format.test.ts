import { describe, expect, it } from "vite-plus/test";
import { shortDate } from "./format";

describe("shortDate", () => {
  const year = new Date().getFullYear();

  it("leaves out the current year", () => {
    expect(shortDate(`${year}-03-15T12:00:00Z`, "en")).toBe("Mar 15");
  });

  it("shows any other year", () => {
    expect(shortDate(`${year + 1}-03-15T12:00:00Z`, "en")).toBe(`Mar 15, ${year + 1}`);
    expect(shortDate(`${year - 1}-03-15T12:00:00Z`, "en")).toBe(`Mar 15, ${year - 1}`);
  });
});
