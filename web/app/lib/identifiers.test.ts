import { describe, expect, it } from "vite-plus/test";
import {
  freeTeamKey,
  isTeamKey,
  isWorkspaceSlug,
  parseIssueKey,
  slugInput,
  teamKey,
  teamKeyInput,
  workspaceSlug,
} from "./identifiers";

describe("workspace slugs", () => {
  it("suggests a hyphenated ASCII slug that avoids reserved paths", () => {
    expect(workspaceSlug("  Zespół Łódź — R&D 2026 ")).toBe("zespol-lodz-r-d-2026");
    expect(workspaceSlug("Login")).toBe("login-workspace");
    expect(workspaceSlug("x".repeat(60))).toHaveLength(48);
    expect(isWorkspaceSlug("acme-labs")).toBe(true);
    for (const slug of ["", "-acme", "acme-", "a--b", "Acme", "welcome", "a".repeat(49)])
      expect(isWorkspaceSlug(slug), slug).toBe(false);
  });

  it("keeps typed hyphens while lowercasing everything else", () => {
    expect(slugInput("My  Team-")).toBe("my-team-");
  });
});

describe("team keys", () => {
  it("suggests three letters or digits, skipping leading digits", () => {
    expect(teamKey("Engineering")).toBe("ENG");
    expect(teamKey("2nd line support")).toBe("NDL");
    expect(teamKey("Ład")).toBe("LAD");
    expect(teamKeyInput("ab-12c")).toBe("AB12");
    for (const key of ["E", "ENG", "Q4", "OPS2"]) expect(isTeamKey(key), key).toBe(true);
    for (const key of ["", "eng", "1AB", "ENGIN", "E-1"]) expect(isTeamKey(key), key).toBe(false);
  });

  it("replaces the tail with a number when the key is taken", () => {
    expect(freeTeamKey("ENG", new Set(["OPS"]))).toBe("ENG");
    expect(freeTeamKey("ENG", new Set(["ENG"]))).toBe("ENG2");
    expect(freeTeamKey("OPSX", new Set(["OPSX", "OPS2"]))).toBe("OPS3");
  });

  it("parses issue keys in any case and rejects bare or padded numbers", () => {
    expect(parseIssueKey("eng-42")).toEqual({ team: "ENG", number: 42 });
    for (const value of ["42", "ENG-042", "ENG-0", "ENGIN-1", "ENG 1"])
      expect(parseIssueKey(value), value).toBeNull();
  });
});
