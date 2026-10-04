import { useState } from "react";
import { Form } from "react-aria-components";
import { Loader2 } from "lucide-react";
import { Button } from "~/components/ui/button";
import { useDialogDirty } from "~/components/ui/dialog";
import { DatePicker } from "~/components/ui/date-picker";
import { TextField } from "~/components/ui/field";
import { formatMinutes, parseMinutes } from "~/lib/format";
import { useI18n } from "~/lib/i18n";
import { usePending } from "~/lib/use-pending";
import { useWorkspace } from "~/lib/workspace";
import type { Id, TimeEntry } from "~/lib/types";

export function TimeForm({
  issueId,
  entry,
  close,
}: {
  issueId: Id;
  entry: TimeEntry | null;
  close: () => void;
}) {
  const t = useI18n().t;
  const { run } = useWorkspace();
  const [dur, setDur] = useState(entry ? formatMinutes(entry.minutes) : "");
  const [note, setNote] = useState(entry?.note ?? "");
  const [when, setWhen] = useState<string | null>(entry?.logged_at ?? new Date().toISOString());
  const { pending, error, guard } = usePending();
  useDialogDirty(
    dur !== (entry ? formatMinutes(entry.minutes) : "") || note !== (entry?.note ?? ""),
  );
  const minutes = parseMinutes(dur);
  const invalid = !minutes || minutes <= 0 || minutes > 24 * 60 || !when;
  return (
    <Form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (invalid) return;
        const body = { minutes: minutes!, note: note.trim(), logged_at: when! };
        void guard(async () => {
          await (entry
            ? run(
                { type: "update_time", id: entry.id, ...body },
                {
                  quiet: true,
                  expectedVersions: error ? undefined : { [entry.id]: entry.version },
                },
              )
            : run({ type: "log_time", issue_id: issueId, ...body }, { quiet: true }));
          close();
        });
      }}
    >
      <TextField
        label={t("time.duration")}
        description={t("time.durationHint")}
        value={dur}
        onChange={setDur}
        autoFocus
        isRequired
        inputMode="decimal"
        isInvalid={dur !== "" && minutes === null}
      />
      <TextField
        label={t("time.note")}
        value={note}
        onChange={setNote}
        placeholder={t("time.notePlaceholder")}
      />
      <DatePicker label={t("field.date")} value={when} onChange={setWhen} clearable={false} />
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onPress={close}>
          {t("action.cancel")}
        </Button>
        <Button
          type="submit"
          variant="primary"
          isDisabled={invalid || pending}
          aria-busy={pending || undefined}
        >
          {pending && <Loader2 aria-hidden className="animate-spin" />}
          {pending ? t("action.saving") : t("action.save")}
        </Button>
      </div>
    </Form>
  );
}
