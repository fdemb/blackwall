import { describe, expect, it } from "vite-plus/test";
import { mentionedUsers } from "./mentions";

const ANA = "0d9b2c64-6f8e-4b3e-9a51-2f6a8e1c7d40";
const BO = "5d004da9-2b6b-42b5-9abc-3459b4bfc99f";

describe("mentionedUsers", () => {
  it("reads mention links only, as the server does", () => {
    const text = [
      `Ask [@Ana](mention:${ANA}).`,
      "",
      `\`[@Bo](mention:${BO})\` \\[@Bo](mention:${BO})`,
      "",
      "```",
      `[@Bo](mention:${BO})`,
      "```",
      "",
      `    [@Bo](mention:${BO})`,
      "",
      `| who |`,
      `| --- |`,
      `| [@Ana](mention:${ANA}) |`,
    ].join("\n");
    expect(mentionedUsers(text)).toEqual([ANA]);
  });
});
