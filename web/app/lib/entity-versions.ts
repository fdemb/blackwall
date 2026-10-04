import type { Command, EntityVersions, Id } from "./types";

export function commandEntityIds(command: Command, me: Id): Id[] {
  if (command.type === "bulk_issues") return command.ids;
  if ("id" in command) return [command.id];
  if (command.type === "add_comment" || command.type === "log_time") return [];
  if ("issue_id" in command) return [command.issue_id];
  if (command.type === "set_role" || command.type === "remove_member") return [command.user_id];
  if (command.type === "configure_alerts") return [me];
  return [];
}

export function expectedVersions(ids: Id[], versions: EntityVersions): EntityVersions {
  return Object.fromEntries(
    ids.flatMap((id) => (versions[id] === undefined ? [] : [[id, versions[id]]])),
  );
}
