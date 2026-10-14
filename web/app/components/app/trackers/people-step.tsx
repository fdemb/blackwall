import { useI18n } from "~/lib/i18n";
import { useWorkspace } from "~/lib/workspace";
import { trackerProviderName } from "~/lib/trackers";
import { mappableEmails, setPerson } from "~/lib/tracker-wizard";
import { NullableSelect } from "../pickers";
import { Discovery } from "./discovery";
import type { StepProps } from "./wizard";

export function PeopleStep({ draft, update, connection, pending }: StepProps) {
  const { members } = useWorkspace();
  const { t } = useI18n();
  const people = connection?.cached_people ?? [];
  const provider = trackerProviderName(connection?.provider ?? "");
  const emails = mappableEmails(connection, draft.people);
  const hidden = people.filter((person) => !person.email);
  const memberOptions = members.map((member) => ({
    id: member.id,
    label: `${member.display_name} (${member.email})`,
  }));
  return (
    <div className="space-y-3">
      <p className="text-xs text-muted-foreground">{t("tracker.peopleHint")}</p>
      <Discovery
        connection={connection}
        hasItems={people.length > 0}
        empty={t("tracker.noPeople")}
      />
      {emails.length > 0 && (
        <div className="grid gap-x-4 gap-y-2 sm:grid-cols-2">
          {emails.map((email) => {
            const match = members.find((member) => member.email.toLowerCase() === email);
            const mapped = draft.people[email];
            const options =
              mapped && !members.some((member) => member.id === mapped)
                ? [...memberOptions, { id: mapped, label: t("tracker.missingPerson") }]
                : memberOptions;
            return (
              <NullableSelect
                key={email}
                label={email}
                value={mapped}
                noneLabel={
                  match
                    ? t("tracker.automaticPerson", { name: match.display_name })
                    : t("tracker.unassigned")
                }
                options={options}
                isDisabled={pending}
                onChange={(id) => update({ people: setPerson(draft.people, email, id) })}
              />
            );
          })}
        </div>
      )}
      {hidden.length > 0 && (
        <p className="text-xs text-muted-foreground">
          {t("tracker.hiddenEmails", {
            provider,
            names: hidden.map((person) => person.name).join(", "),
          })}
        </p>
      )}
    </div>
  );
}
