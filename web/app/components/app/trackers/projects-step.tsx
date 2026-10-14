import { Checkbox } from "~/components/ui/toggles";
import { Select } from "~/components/ui/select";
import { useI18n } from "~/lib/i18n";
import { useWorkspace } from "~/lib/workspace";
import { trackerProviderName } from "~/lib/trackers";
import { availableProjects, setProjectTeam, toggleProject } from "~/lib/tracker-wizard";
import { Discovery } from "./discovery";
import type { StepProps } from "./wizard";

export function ProjectsStep({ draft, update, connection, pending }: StepProps) {
  const { ws } = useWorkspace();
  const { t } = useI18n();
  const projects = availableProjects(connection, draft.projects);
  const provider = trackerProviderName(connection?.provider ?? "");
  const teams = ws.teams.map((team) => ({ id: team.id, label: team.name }));
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">{t("tracker.projectsHint", { provider })}</p>
      <Discovery
        connection={connection}
        hasItems={projects.length > 0}
        empty={t("tracker.noProjects")}
      />
      {projects.length > 0 && (
        <ul className="divide-y divide-border rounded-lg border border-border">
          {projects.map((project) => {
            const mapping = draft.projects.find((p) => p.project_id === project.id);
            return (
              <li key={project.id} className="flex flex-wrap items-center gap-3 px-3 py-2">
                <Checkbox
                  className="min-w-0 flex-1 basis-48"
                  isSelected={mapping !== undefined}
                  isDisabled={pending}
                  onChange={(checked) =>
                    update({ projects: toggleProject(draft.projects, project.id, checked) })
                  }
                >
                  <span className="truncate">{project.name}</span>
                </Checkbox>
                {mapping && (
                  <Select
                    aria-label={t("tracker.teamFor", { name: project.name })}
                    className="w-48"
                    options={teams}
                    selectedKey={mapping.team_id}
                    placeholder={t("tracker.chooseTeam")}
                    isDisabled={pending}
                    isInvalid={!mapping.team_id}
                    onSelectionChange={(team) =>
                      update({
                        projects: setProjectTeam(draft.projects, project.id, String(team)),
                      })
                    }
                  />
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
