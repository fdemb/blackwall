const BROWSERS: [RegExp, string][] = [
  [/Edg(?:e|A|iOS)?\//, "Edge"],
  [/OPR\/|Opera/, "Opera"],
  [/Firefox\/|FxiOS\//, "Firefox"],
  [/Chrome\/|CriOS\//, "Chrome"],
  [/Version\/.*Safari\//, "Safari"],
];

const SYSTEMS: [RegExp, string][] = [
  [/iPhone|iPad|iPod/, "iOS"],
  [/Android/, "Android"],
  [/CrOS/, "ChromeOS"],
  [/Mac OS X|Macintosh/, "macOS"],
  [/Windows/, "Windows"],
  [/Linux/, "Linux"],
];

const match = (table: [RegExp, string][], agent: string) =>
  table.find(([pattern]) => pattern.test(agent))?.[1] ?? null;

/** Browser and operating system named by a User-Agent header, for telling sessions apart. */
export function describeDevice(agent: string | null) {
  if (!agent) return null;
  const browser = match(BROWSERS, agent);
  const os = match(SYSTEMS, agent);
  if (!browser && !os) return { browser: agent.split(" ")[0]!.slice(0, 60), os: null };
  return { browser, os };
}
