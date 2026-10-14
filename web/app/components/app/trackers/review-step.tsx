import { useI18n } from "~/lib/i18n";
import { useWorkspace } from "~/lib/workspace";
import { trackerProviderName } from "~/lib/trackers";
import {
  CREATE_STAGE,
  TRACKER_FIELDS,
  availableProjects,
  direction,
  supportedOptions,
} from "~/lib/tracker-wizard";
import type { StepProps } from "./wizard";

export function ReviewStep({ draft, connection, provider }: StepProps) {
  const { ws } = useWorkspace();
  const { t } = useI18n();
  const name = trackerProviderName(provider?.kind ?? connection?.provider ?? "");
  const names = new Map(availableProjects(connection, draft.projects).map((p) => [p.id, p.name]));
  const options = provider ? supportedOptions(draft.options, provider) : draft.options;
  const fields = (key: "import" | "export") =>
    TRACKER_FIELDS.filter((field) => direction(options, field)[key])
      .map((field) => t(`tracker.field.${field}`))
      .join(", ") || t("tracker.nothing");
  const overrides = Object.keys(draft.people).length;
  return (
    <div className="space-y-4 text-[13px]">
      <dl className="grid grid-cols-[minmax(0,10rem)_1fr] gap-x-4 gap-y-2">
        <dt className="text-muted-foreground">{t("tracker.connection")}</dt>
        <dd className="min-w-0 break-all">
          {draft.name} · <span className="text-muted-foreground">{draft.base_url}</span>
        </dd>
        <dt className="text-muted-foreground">{t("tracker.step.projects")}</dt>
        <dd>
          {draft.projects.length === 0 ? (
            t("tracker.noMappedProjects")
          ) : (
            <ul className="space-y-1">
              {draft.projects.map((project) => {
                const mapped = Object.values(project.stage_mapping ?? {});
                const created = mapped.filter((stage) => stage === CREATE_STAGE).length;
                return (
                  <li key={project.project_id}>
                    {names.get(project.project_id) ?? project.project_id} →{" "}
                    {ws.teams.find((team) => team.id === project.team_id)?.name}
                    <span className="text-muted-foreground">
                      {mapped.length > 0 &&
                        ` · ${t("tracker.review.mapped", { count: mapped.length })}`}
                      {created > 0 && ` · ${t("tracker.review.created", { count: created })}`}
                    </span>
                  </li>
                );
              })}
            </ul>
          )}
        </dd>
        <dt className="text-muted-foreground">{t("tracker.step.people")}</dt>
        <dd>
          {overrides > 0
            ? t("tracker.review.people", { count: overrides })
            : t("tracker.review.peopleAuto")}
        </dd>
        <dt className="text-muted-foreground">{t("tracker.import", { provider: name })}</dt>
        <dd>{fields("import")}</dd>
        <dt className="text-muted-foreground">{t("tracker.send", { provider: name })}</dt>
        <dd>{fields("export")}</dd>
      </dl>
      <p className="text-xs text-muted-foreground">
        {t("tracker.review.hint", { provider: name })}
      </p>
    </div>
  );
}
