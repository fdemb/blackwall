import policy from "./ownership-policy.generated.json";
import type { Command, Id, Issue } from "./types";

const ownershipCapabilities = policy.capabilities;
const ownershipRules = policy.rules;

export function issueCapabilities(issue: Pick<Issue, "openproject">) {
  return ownershipCapabilities[issue.openproject == null ? "local" : "openproject"];
}

function valuesAt(value: unknown, path: readonly string[]): Id[] {
  if (path.length === 0) return typeof value === "string" ? [value] : [];
  const [key, ...rest] = path;
  if (key === "*") {
    return Array.isArray(value) ? value.flatMap((item: unknown) => valuesAt(item, rest)) : [];
  }
  if (key && typeof value === "object" && value !== null && key in value) {
    const field = Object.entries(value).find(([name]) => name === key)?.[1];
    return valuesAt(field, rest);
  }
  return [];
}

export function commandOwnershipTargets(command: Command): Id[] {
  return ownershipRules
    .filter((rule) => rule.command === command.type)
    .flatMap((rule) => rule.targets.flatMap((path) => valuesAt(command, path.split("/"))));
}
