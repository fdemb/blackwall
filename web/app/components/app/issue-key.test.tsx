import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { IssueKey, issueKeyLength } from "./issue-key";

describe("issue key sizing", () => {
  it("fits the longest displayed key regardless of issue order", () => {
    expect(issueKeyLength([{ number: 1000000 }, { number: 9 }, { number: 10 }])).toBe(10);
    expect(issueKeyLength([{ number: 9 }, { number: 10 }, { number: 1000000 }])).toBe(10);
    expect(issueKeyLength([])).toBe(0);
  });

  it("recomputes the length when results change", () => {
    expect(issueKeyLength([{ number: 99 }])).toBe(5);
    expect(issueKeyLength([{ number: 99 }, { number: 100 }])).toBe(6);
    expect(issueKeyLength([{ number: 1 }])).toBe(4);
  });

  it("reserves the same font-measured space for short and long keys", () => {
    const length = issueKeyLength([{ number: 9 }, { number: 1234567 }]);
    for (const number of [9, 1234567]) {
      const html = renderToStaticMarkup(<IssueKey number={number} length={length} />);
      expect(html).toContain(
        'aria-hidden="true" class="invisible col-start-1 row-start-1">BW-0000000',
      );
      expect(html).toContain(`class="col-start-1 row-start-1">BW-${number}</span>`);
      expect(html).toContain("shrink-0 whitespace-nowrap tabular-nums");
    }
  });

  it("keeps standalone keys intact even without a shared length", () => {
    const html = renderToStaticMarkup(<IssueKey number={123456789} />);
    expect(html).toContain(">BW-123456789</span>");
    expect(html).not.toContain("truncate");
  });
});
