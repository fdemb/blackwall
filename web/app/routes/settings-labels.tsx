import { useState } from "react";
import { Form, Radio, RadioGroup } from "react-aria-components";
import { Pencil, Tag } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Dialog, useDialogDirty } from "~/components/ui/dialog";
import { FormError, TextField } from "~/components/ui/field";
import { SettingsList, SettingsPage, SettingsSection } from "~/components/app/settings";
import { LabelDot } from "~/components/app/pickers";
import { useT, type Key } from "~/lib/i18n";
import { usePending } from "~/lib/use-pending";
import { useWorkspace } from "~/lib/workspace";
import type { Label } from "~/lib/types";

const COLORS: [string, Key][] = [
  ["#7c3aed", "color.violet"],
  ["#a78bfa", "color.lavender"],
  ["#ec4899", "color.pink"],
  ["#ef4444", "color.red"],
  ["#f97316", "color.orange"],
  ["#eab308", "color.yellow"],
  ["#22c55e", "color.green"],
  ["#14b8a6", "color.teal"],
  ["#0ea5e9", "color.blue"],
  ["#64748b", "color.slate"],
];

/** A radio group, so arrow keys move between colors and a screen reader hears each color's name. */
function ColorPicker({ value, onChange }: { value: string; onChange: (c: string) => void }) {
  const t = useT();
  // A label saved with a color outside the palette keeps showing as its own choice instead of vanishing.
  const options = COLORS.some(([c]) => c === value)
    ? COLORS.map(([c, k]) => [c, t(k)] as const)
    : [...COLORS.map(([c, k]) => [c, t(k)] as const), [value, value] as const];
  return (
    <RadioGroup
      value={value}
      onChange={onChange}
      orientation="horizontal"
      aria-label={t("labels.color")}
      className="flex flex-wrap gap-1"
    >
      {options.map(([c, name]) => (
        <Radio
          key={c}
          value={c}
          aria-label={name}
          className="group grid size-7 cursor-default place-items-center rounded-full outline-none pointer-coarse:size-9"
        >
          <span
            className="size-5 rounded-full ring-offset-2 ring-offset-background transition group-selected:ring-2 group-selected:ring-foreground group-focus-visible:ring-2 group-focus-visible:ring-ring"
            style={{ background: c }}
          />
        </Radio>
      ))}
    </RadioGroup>
  );
}

export default function Labels() {
  const t = useT();
  const { ws, run, canWrite, report } = useWorkspace();
  const [name, setName] = useState("");
  const [color, setColor] = useState(COLORS[0][0]);
  const [editing, setEditing] = useState<Label | null>(null);
  const { pending, error, guard } = usePending();
  return (
    <SettingsPage title={t("settings.labels")} description={t("labels.sub")}>
      {canWrite && (
        <SettingsSection title={t("labels.add")}>
          <Form
            className="flex flex-wrap items-end gap-3 px-4 py-4 sm:px-5 sm:py-5"
            onSubmit={(e) => {
              e.preventDefault();
              void guard(async () => {
                await run({ type: "create_label", name: name.trim(), color }, { quiet: true });
                setName("");
              });
            }}
          >
            <TextField
              className="min-w-48 flex-1"
              label={t("field.name")}
              value={name}
              onChange={setName}
              isRequired
              maxLength={40}
            />
            <div className="pb-0.5">
              <ColorPicker value={color} onChange={setColor} />
            </div>
            <Button type="submit" variant="primary" isDisabled={!name.trim() || pending}>
              {t("labels.add")}
            </Button>
            <FormError>{error}</FormError>
          </Form>
        </SettingsSection>
      )}
      <SettingsSection title={canWrite ? t("settings.labels") : undefined}>
        {ws.labels.length === 0 ? (
          <p className="flex items-center gap-2 px-4 py-4 text-[13px] text-muted-foreground sm:px-5">
            <Tag className="size-4" />
            {t("labels.empty")}
          </p>
        ) : (
          <SettingsList>
            {ws.labels.map((l) => (
              <li key={l.id} className="flex min-h-11 items-center gap-2.5 py-1.5 text-[13px]">
                <LabelDot color={l.color} className="size-2.5" />
                <span className="min-w-0 flex-1 truncate">{l.name}</span>
                <span className="text-xs tabular-nums text-muted-foreground">
                  {t("labels.used", {
                    n: report.label_counts[l.id] ?? 0,
                  })}
                </span>
                {canWrite && (
                  <Button
                    variant="ghost"
                    size="icon"
                    aria-label={`${t("labels.edit")}: ${l.name}`}
                    onPress={() => setEditing(l)}
                  >
                    <Pencil />
                  </Button>
                )}
              </li>
            ))}
          </SettingsList>
        )}
      </SettingsSection>
      <Dialog
        title={t("labels.edit")}
        size="sm"
        isOpen={editing !== null}
        onOpenChange={(o) => !o && setEditing(null)}
      >
        {(close) => editing && <EditLabel label={editing} close={close} />}
      </Dialog>
    </SettingsPage>
  );
}

function EditLabel({ label, close }: { label: Label; close: () => void }) {
  const t = useT();
  const { run } = useWorkspace();
  const { pending, error, guard } = usePending();
  const [name, setName] = useState(label.name);
  const [color, setColor] = useState(label.color);
  useDialogDirty(name !== label.name || color !== label.color);
  return (
    <Form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        void guard(async () => {
          await run(
            { type: "update_label", id: label.id, name: name.trim(), color },
            { quiet: true, expectedVersions: error ? undefined : { [label.id]: label.version } },
          );
          close();
        });
      }}
    >
      <TextField
        label={t("field.name")}
        value={name}
        onChange={setName}
        autoFocus
        isRequired
        maxLength={40}
      />
      <ColorPicker value={color} onChange={setColor} />
      <FormError>{error}</FormError>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onPress={close}>
          {t("action.cancel")}
        </Button>
        <Button type="submit" variant="primary" isDisabled={!name.trim() || pending}>
          {pending ? t("action.saving") : t("action.save")}
        </Button>
      </div>
    </Form>
  );
}
