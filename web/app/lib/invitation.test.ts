import { describe, expect, it } from "vite-plus/test";
import { invitationFromNext } from "./invitation";

const workspace = "11111111-1111-4111-8111-000000000001";

describe("invitationFromNext", () => {
  it("reads the workspace and token from an invitation link", () => {
    expect(invitationFromNext(`/welcome?workspace=${workspace}&token=tok%2Fen%2B1`)).toEqual({
      workspace_id: workspace,
      token: "tok/en+1",
    });
  });

  it.each([
    null,
    "",
    "/",
    `/welcome?workspace=${workspace}`,
    "/welcome?token=abc",
    `/acme/issues?workspace=${workspace}&token=abc`,
    `https://evil.example/welcome?workspace=${workspace}&token=abc`,
    `//evil.example/welcome?workspace=${workspace}&token=abc`,
  ])("finds no invitation in %s", (next) => {
    expect(invitationFromNext(next)).toBeNull();
  });
});
