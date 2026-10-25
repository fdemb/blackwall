import { describe, expect, it } from "vite-plus/test";
import { describeDevice } from "./device";

describe("describeDevice", () => {
  it.each([
    [
      "Mozilla/5.0 (X11; Linux x86_64; rv:139.0) Gecko/20100101 Firefox/139.0",
      { browser: "Firefox", os: "Linux" },
    ],
    [
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36 Edg/138.0.0.0",
      { browser: "Edge", os: "Windows" },
    ],
    [
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15",
      { browser: "Safari", os: "macOS" },
    ],
    [
      "Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/138.0 Mobile/15E148 Safari/604.1",
      { browser: "Chrome", os: "iOS" },
    ],
    [
      "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36",
      { browser: "Chrome", os: "Android" },
    ],
  ])("names the browser and system of %s", (agent, expected) => {
    expect(describeDevice(agent)).toEqual(expected);
  });

  it("falls back to the product token for other clients", () => {
    expect(describeDevice("curl/8.9.1")).toEqual({ browser: "curl/8.9.1", os: null });
  });

  it("returns null before the session has made a request", () => {
    expect(describeDevice(null)).toBeNull();
  });
});
