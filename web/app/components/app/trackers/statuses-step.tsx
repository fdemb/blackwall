import { useI18n } from "~/lib/i18n";
import { useWorkspace } from "~/lib/workspace";
import { automaticTrackerStage, trackerProviderName } from "~/lib/trackers";
import {
  CREATE_STAGE,
  availableProjects,
  availableStatuses,
  setStatusStage,
} from "~/lib/tracker-wizard";
import { NullableSelect } from "../pickers";
import { Discovery } from "./discovery";
import type { StepProps } from "./wizard";

export function StatusesStep({ draft, update, connection, pending }: StepProps) {
  const { ws } = useWorkspace();
  const { t } = useI18n();
  const statuses = connection?.cached_statuses ?? [];
  const names = new Map(availableProjects(connection, draft.projects).map((p) => [p.id, p.name]));
  const provider = trackerProviderName(connection?.provider ?? "");
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        {t("tracker.statusesHint", { provider })} {t("tracker.automaticStages", { provider })}
      </p>
      <Discovery
        connection={connection}
        hasItems={statuses.length > 0}
        empty={t("tracker.noStatuses")}
      />
      {draft.projects.length === 0 && (
        <p className="text-sm text-muted-foreground">{t("tracker.noMappedProjects")}</p>
      )}
      {draft.projects.map((mapping) => {
        const team = ws.teams.find((team) => team.id === mapping.team_id);
        if (!team) return null;
        const project = names.get(mapping.project_id) ?? mapping.project_id;
        return (
          <section key={mapping.project_id} className="space-y-2">
            <h3 className="font-medium">
              {project} <span className="text-muted-foreground">→ {team.name}</span>
            </h3>
            <div className="grid gap-x-4 gap-y-2 sm:grid-cols-2">
              {availableStatuses(statuses, mapping).map((status) => {
                const automatic = automaticTrackerStage(status, team.stages);
                const value = mapping.stage_mapping?.[status.id];
                const options = team.stages.map((stage) => ({ id: stage.id, label: stage.name }));
                if (
                  value &&
                  value !== CREATE_STAGE &&
                  !team.stages.some((stage) => stage.id === value)
                )
                  options.push({ id: value, label: t("tracker.missingStage") });
                if (statuses.some((known) => known.id === status.id))
                  options.push({
                    id: CREATE_STAGE,
                    label: t("tracker.createStage", { name: status.name }),
                  });
                return (
                  <NullableSelect
                    key={status.id}
                    label={status.name}
                    value={value}
                    noneLabel={t("tracker.automaticStage", {
                      name: automatic?.name ?? t("tracker.missingStage"),
                    })}
                    options={options}
                    isDisabled={pending}
                    onChange={(stage) =>
                      update({
                        projects: setStatusStage(
                          draft.projects,
                          mapping.project_id,
                          status.id,
                          stage,
                        ),
                      })
                    }
                  />
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}
