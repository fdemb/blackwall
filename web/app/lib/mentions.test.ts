import { describe, expect, it } from "vite-plus/test";
import cases from "./mention-cases.json";
import { mentionedUsers } from "./mentions";

describe("mentionedUsers", () => {
  it.each(cases)("reads $name as the server does", ({ markdown, mentions }) => {
    expect(mentionedUsers(markdown)).toEqual(mentions);
  });
});
