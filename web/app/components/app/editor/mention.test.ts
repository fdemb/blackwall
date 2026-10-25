import { describe, expect, it } from "vite-plus/test";
import { mentionedUsers, plainMentions } from "~/lib/mentions";
import { codec } from "./extensions";

const ID = "0d9b2c64-6f8e-4b3e-9a51-2f6a8e1c7d40";

describe("mention markdown", () => {
  it("round-trips a mention whose label holds markdown", () => {
    const text = `Ask [@Ana \\[ops\\] \\*K\\*](mention:${ID}) today`;
    const doc = codec.parse(text);
    expect(doc.content?.[0].content?.[1]).toEqual({
      type: "mention",
      attrs: { id: ID, label: "Ana [ops] *K*" },
    });
    expect(codec.serialize(doc)).toBe(text);
    expect(mentionedUsers(codec.serialize(doc))).toEqual([ID]);
  });

  it("leaves ordinary links as links", () => {
    const text = "See [@docs](https://example.com)";
    expect(codec.serialize(codec.parse(text))).toBe(text);
    expect(mentionedUsers(text)).toEqual([]);
  });

  it("reads as @Name where markdown shows as plain text", () => {
    expect(plainMentions(`Ask [@Ana \\[ops\\]](mention:${ID}) and [x](https://a.b)`)).toBe(
      "Ask @Ana [ops] and [x](https://a.b)",
    );
  });
});
