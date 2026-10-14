import { Checkbox } from "~/components/ui/toggles";
import { useI18n } from "~/lib/i18n";
import { trackerProviderName } from "~/lib/trackers";
import { TRACKER_FIELDS, direction, setDirection, unsupportedHint } from "~/lib/tracker-wizard";
import type { TrackerDirection } from "~/lib/types";
import type { StepProps } from "./wizard";

const DIRECTIONS: (keyof TrackerDirection)[] = ["import", "export"];

export function FieldsStep({ draft, update, connection, provider, pending }: StepProps) {
  const { t } = useI18n();
  const name = trackerProviderName(provider?.kind ?? connection?.provider ?? "");
  const heading = {
    import: t("tracker.import", { provider: name }),
    export: t("tracker.send", { provider: name }),
  };
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">{t("tracker.fieldsHint", { provider: name })}</p>
      <table className="w-full text-[13px]">
        <thead>
          <tr className="border-b border-border text-left text-xs text-muted-foreground">
            <th className="py-2 pr-3 font-normal">{t("tracker.field")}</th>
            {DIRECTIONS.map((key) => (
              <th key={key} className="w-36 py-2 font-normal">
                {heading[key]}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {TRACKER_FIELDS.map((field) => {
            const value = direction(draft.options, field);
            const support = direction(provider?.fields ?? {}, field);
            const label = t(`tracker.field.${field}`);
            const unsupported = unsupportedHint(support);
            return (
              <tr key={field} className="border-b border-border/70 align-top last:border-0">
                <td className="py-2 pr-3">
                  <p>{label}</p>
                  <p className="text-xs text-muted-foreground">
                    {t(`tracker.field.${field}.hint`)}
                    {unsupported && ` ${t(unsupported, { provider: name })}`}
                  </p>
                </td>
                {DIRECTIONS.map((key) => (
                  <td key={key} className="py-2">
                    <span
                      title={
                        support[key] ? undefined : t("tracker.unsupported", { provider: name })
                      }
                    >
                      <Checkbox
                        aria-label={`${heading[key]}: ${label}`}
                        isSelected={support[key] && value[key]}
                        isDisabled={pending || !support[key]}
                        onChange={(on) =>
                          update({ options: setDirection(draft.options, field, key, on) })
                        }
                      />
                    </span>
                  </td>
                ))}
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
