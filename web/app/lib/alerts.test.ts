import { describe, expect, it } from "vite-plus/test";
import { alertSwitch, storedAlerts } from "./alerts";

describe("alert switches", () => {
  it("falls back to the server defaults, with change emails off", () => {
    const prefs = storedAlerts({ reply: false });
    expect(prefs.reply).toBe(false);
    expect(prefs.email_reply).toBe(true);
    expect(prefs.email_change).toBe(false);
  });

  it("turns the email switch off and locks it while the inbox switch is off", () => {
    const prefs = storedAlerts({ assignment: false, email_assignment: true });
    expect(alertSwitch(prefs, "inbox", "assignment")).toEqual({
      field: "assignment",
      selected: false,
      disabled: false,
    });
    expect(alertSwitch(prefs, "email", "assignment")).toEqual({
      field: "email_assignment",
      selected: false,
      disabled: true,
    });
  });

  it("restores the saved email choice when the inbox switch returns", () => {
    const prefs = storedAlerts({ assignment: true, email_assignment: true });
    expect(alertSwitch(prefs, "email", "assignment")).toEqual({
      field: "email_assignment",
      selected: true,
      disabled: false,
    });
  });
});
