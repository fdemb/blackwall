import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vite-plus/test";
import { IssueKey, issueKeyWidth } from "./issue-key";

const keys = (...values: string[]) => values.map((key) => ({ key }));

describe("issue key sizing", () => {
  it("pads every team's key to the most digits, regardless of order", () => {
    expect(issueKeyWidth(keys("ENG-1000000", "ENG-9", "OPS-10"))).toBe("ENG-0000000 OPS-0000000");
    expect(issueKeyWidth(keys("OPS-10", "ENG-9", "ENG-1000000"))).toBe("ENG-0000000 OPS-0000000");
    expect(issueKeyWidth([])).toBe("");
  });

  it("stacks one invisible sizer per team so the widest key sets the width", () => {
    const html = renderToStaticMarkup(<IssueKey value="WW-9" width="IIII-0 WW-0" />);
    expect(html).toContain('aria-hidden="true" class="invisible col-start-1 row-start-1">IIII-0<');
    expect(html).toContain('aria-hidden="true" class="invisible col-start-1 row-start-1">WW-0<');
    expect(html).toContain('class="col-start-1 row-start-1">WW-9</span>');
    expect(html).toContain("shrink-0 whitespace-nowrap tabular-nums");
  });

  it("keeps standalone keys intact even without a shared width", () => {
    const html = renderToStaticMarkup(<IssueKey value="ENG-123456789" />);
    expect(html).toContain(">ENG-123456789</span>");
    expect(html).not.toContain("invisible");
  });
});
