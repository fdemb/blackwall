import { describe, expect, it } from "vite-plus/test";
import { filterMembers, roleCounts, type MemberEntry } from "./members";

const rows: MemberEntry[] = [
  { user_id: "1", role: "owner", display_name: "Filip Dembicki", email: "filip@exea.pl" },
  { user_id: "2", role: "admin", display_name: "Anna Wiśniewska", email: "anna@exea.pl" },
  { user_id: "3", role: "admin", display_name: "Piotr Zieliński", email: "piotr@exea.pl" },
  { user_id: "4", role: "member", display_name: "Paweł Łukasik", email: "pawel@example.com" },
  { user_id: "5", role: "viewer", display_name: "Ola Kamińska", email: "ola@exea.pl" },
];
const ids = (list: MemberEntry[]) => list.map((row) => row.user_id);

describe("filterMembers", () => {
  it("keeps everyone in order when no filter or query is set", () => {
    expect(ids(filterMembers(rows, "all", ""))).toEqual(["1", "2", "3", "4", "5"]);
  });

  it("keeps only the chosen role", () => {
    expect(ids(filterMembers(rows, "admin", ""))).toEqual(["2", "3"]);
    expect(ids(filterMembers(rows, "owner", ""))).toEqual(["1"]);
  });

  it("matches the name or the email, ignoring case and surrounding spaces", () => {
    expect(ids(filterMembers(rows, "all", "  ANNA "))).toEqual(["2"]);
    expect(ids(filterMembers(rows, "all", "example.com"))).toEqual(["4"]);
  });

  it("matches Polish names typed without accents", () => {
    expect(ids(filterMembers(rows, "all", "wisniewska"))).toEqual(["2"]);
    expect(ids(filterMembers(rows, "all", "lukasik"))).toEqual(["4"]);
  });

  it("applies the role and the query together", () => {
    expect(ids(filterMembers(rows, "admin", "piotr"))).toEqual(["3"]);
    expect(filterMembers(rows, "viewer", "piotr")).toEqual([]);
  });
});

describe("roleCounts", () => {
  it("counts everyone and each role", () => {
    expect(roleCounts(rows)).toEqual({ all: 5, owner: 1, admin: 2, member: 1, viewer: 1 });
  });
});
