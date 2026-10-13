import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { IssueKey } from "./issue-key";

describe("issue key", () => {
  it("renders one span per key, sized by the list's shared width", () => {
    const html = renderToStaticMarkup(<IssueKey value="ENG-9" width="4.5em" />);
    expect(html).toBe(
      '<span style="min-width:4.5em" class="inline-block shrink-0 whitespace-nowrap tabular-nums">ENG-9</span>',
    );
  });

  it("keeps standalone keys intact without a width", () => {
    const html = renderToStaticMarkup(<IssueKey value="ENG-123456789" />);
    expect(html).toContain(">ENG-123456789</span>");
    expect(html).not.toContain("min-width");
  });
});
