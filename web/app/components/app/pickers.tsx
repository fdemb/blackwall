import { useState } from "react";
import {
  Button as RACButton,
  DialogTrigger,
  ListBox,
  ListBoxItem,
  composeRenderProps,
} from "react-aria-components";
import { Check, Tag, User } from "lucide-react";
import { Select, type Option } from "~/components/ui/select";
import { Popover } from "~/components/ui/popover";
import { Button } from "~/components/ui/button";
import { Avatar } from "~/components/ui/avatar";
import { cn, selectedIds } from "~/lib/utils";
import { PRIORITIES } from "~/lib/format";
import { useT } from "~/lib/i18n";
import { useWorkspace } from "~/lib/workspace";
import type { Id, Priority } from "~/lib/types";
import { PriorityIcon, StageIcon } from "./icons";

const NONE = "__none";

interface PickProps {
  label?: string;
  value: Id | null | undefined;
  onChange: (id: Id | null) => void;
  variant?: "field" | "ghost";
  isDisabled?: boolean;
  placeholder?: string;
  className?: string;
  triggerClassName?: string;
}

/** Select with an explicit "none" entry that maps to null. */
export function NullableSelect({
  options,
  noneLabel,
  noneIcon,
  value,
  onChange,
  ...rest
}: PickProps & { options: Option[]; noneLabel: string; noneIcon?: React.ReactNode }) {
  const all: Option[] = [{ id: NONE, label: noneLabel, icon: noneIcon }, ...options];
  return (
    <Select
      {...rest}
      options={all}
      selectedKey={value ?? NONE}
      onSelectionChange={(k) => onChange(k === NONE ? null : (k as Id))}
      aria-label={rest.label ?? noneLabel}
    />
  );
}

export function PriorityPicker({
  value,
  onChange,
  ...rest
}: Omit<PickProps, "value" | "onChange"> & { value: Priority; onChange: (p: Priority) => void }) {
  const t = useT();
  const options = PRIORITIES.map((p) => ({
    id: p,
    label: t(`priority.${p}`),
    icon: <PriorityIcon priority={p} />,
  }));
  return (
    <Select
      {...rest}
      options={options}
      selectedKey={value}
      onSelectionChange={(k) => onChange(k as Priority)}
      aria-label={rest.label ?? t("field.priority")}
    />
  );
}

export function AssigneePicker({ teamId, ...rest }: PickProps & { teamId?: Id }) {
  const t = useT();
  const { members, team } = useWorkspace();
  const ids = teamId ? team(teamId)?.members : undefined;
  const pool =
    ids && ids.length
      ? (() => {
          const wanted = new Set(ids);
          return members.filter((m) => wanted.has(m.id) || m.id === rest.value);
        })()
      : members;
  const options = pool.map((m) => ({
    id: m.id,
    label: m.display_name,
    icon: <Avatar name={m.display_name} src={m.avatar_url} size={16} />,
  }));
  return (
    <NullableSelect
      {...rest}
      options={options}
      noneLabel={t("assignee.none")}
      noneIcon={<User className="size-4 text-muted-foreground" />}
    />
  );
}

export function StagePicker({
  teamId,
  value,
  onChange,
  ...rest
}: Omit<PickProps, "value" | "onChange"> & {
  teamId: Id;
  value: Id | null | undefined;
  onChange: (id: Id) => void;
}) {
  const t = useT();
  const { team } = useWorkspace();
  const stages = [...(team(teamId)?.stages ?? [])].sort((a, b) => a.position - b.position);
  const options = stages.map((s) => ({
    id: s.id,
    label: s.name,
    icon: <StageIcon kind={s.kind} />,
  }));
  return (
    <Select
      {...rest}
      options={options}
      selectedKey={value ?? undefined}
      onSelectionChange={(k) => onChange(k as Id)}
      aria-label={rest.label ?? t("field.stage")}
    />
  );
}

export function LabelDot({ color, className }: { color: string; className?: string }) {
  return (
    <span
      className={cn("inline-block size-2 shrink-0 rounded-full", className)}
      style={{ background: color }}
    />
  );
}

/** Labels picker as a form field. Prefer this over `variant="field"` so the mode is explicit. */
export function FieldLabelsPicker({
  value,
  onChange,
  isDisabled,
}: {
  value: Id[];
  onChange: (ids: Id[]) => void;
  isDisabled?: boolean;
}) {
  return (
    <LabelsPickerBase value={value} onChange={onChange} variant="field" isDisabled={isDisabled} />
  );
}

/** Labels picker as a borderless trigger. Prefer this over `variant="ghost"` so the mode is explicit. */
export function GhostLabelsPicker({
  value,
  onChange,
  isDisabled,
}: {
  value: Id[];
  onChange: (ids: Id[]) => void;
  isDisabled?: boolean;
}) {
  return (
    <LabelsPickerBase value={value} onChange={onChange} variant="ghost" isDisabled={isDisabled} />
  );
}

export function LabelsPicker({
  value,
  onChange,
  variant = "ghost",
  isDisabled,
}: {
  value: Id[];
  onChange: (ids: Id[]) => void;
  variant?: "field" | "ghost";
  isDisabled?: boolean;
}) {
  return (
    <LabelsPickerBase value={value} onChange={onChange} variant={variant} isDisabled={isDisabled} />
  );
}

function LabelsPickerBase({
  value,
  onChange,
  variant = "ghost",
  isDisabled,
}: {
  value: Id[];
  onChange: (ids: Id[]) => void;
  variant?: "field" | "ghost";
  isDisabled?: boolean;
}) {
  const t = useT();
  const { ws } = useWorkspace();
  const [open, setOpen] = useState(false);
  const wanted = new Set(value);
  const chosen = ws.labels.filter((l) => wanted.has(l.id));
  return (
    <DialogTrigger isOpen={open} onOpenChange={setOpen}>
      <Button
        variant={variant === "ghost" ? "ghost" : "secondary"}
        isDisabled={isDisabled}
        className={cn(
          "w-full justify-start gap-1.5 font-normal",
          variant === "ghost"
            ? "h-auto min-h-7 flex-wrap px-2 py-1 text-foreground"
            : "min-h-8 px-2.5",
        )}
      >
        {chosen.length === 0 ? (
          <span className="flex items-center gap-2 text-muted-foreground">
            <Tag aria-hidden className="size-3.5" />
            {t("labels.none")}
          </span>
        ) : (
          chosen.map((l) => (
            <span
              key={l.id}
              className="inline-flex items-center gap-1.5 rounded-full border border-border px-2 py-0.5 text-[11px]"
            >
              <LabelDot color={l.color} />
              {l.name}
            </span>
          ))
        )}
      </Button>
      <Popover placement="bottom start" className="min-w-52">
        <ListBox
          aria-label={t("field.labels")}
          selectionMode="multiple"
          selectedKeys={new Set(value)}
          onSelectionChange={(keys) => onChange(selectedIds(keys, ws.labels))}
          items={ws.labels}
          renderEmptyState={() => (
            <p className="px-3 py-2 text-xs text-muted-foreground">{t("labels.empty")}</p>
          )}
          className="max-h-72 overflow-auto p-1 outline-none"
        >
          {(l) => (
            <ListBoxItem
              id={l.id}
              textValue={l.name}
              className={composeRenderProps("", (c) =>
                cn(
                  "flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-[13px] outline-none focus:bg-accent",
                  c,
                ),
              )}
            >
              {({ isSelected }) => (
                <>
                  <LabelDot color={l.color} />
                  <span className="flex-1 truncate">{l.name}</span>
                  {isSelected && <Check className="size-3.5 text-primary" />}
                </>
              )}
            </ListBoxItem>
          )}
        </ListBox>
      </Popover>
    </DialogTrigger>
  );
}

export function MultiMemberPicker({
  value,
  onChange,
  pool,
}: {
  value: Id[];
  onChange: (ids: Id[]) => void;
  pool?: Id[];
}) {
  const t = useT();
  const { members } = useWorkspace();
  const list = pool
    ? (() => {
        const wanted = new Set(pool);
        return members.filter((m) => wanted.has(m.id));
      })()
    : members;
  return (
    <DialogTrigger>
      <Button variant="secondary" className="min-h-8 w-full justify-start px-2.5 font-normal">
        {value.length ? (
          <span className="flex -space-x-1">
            {value.slice(0, 6).map((id) => {
              const m = members.find((x) => x.id === id);
              return m ? (
                <Avatar
                  key={id}
                  name={m.display_name}
                  src={m.avatar_url}
                  size={18}
                  className="ring-2 ring-card"
                />
              ) : null;
            })}
          </span>
        ) : (
          <span className="text-muted-foreground">{t("team.pickMembers")}</span>
        )}
        {value.length > 0 && (
          <span className="text-muted-foreground">{t("count.members", { n: value.length })}</span>
        )}
      </Button>
      <Popover placement="bottom start" className="min-w-56">
        <ListBox
          aria-label={t("nav.people")}
          selectionMode="multiple"
          selectedKeys={new Set(value)}
          onSelectionChange={(k) => onChange(selectedIds(k, list))}
          items={list}
          className="max-h-72 overflow-auto p-1 outline-none"
        >
          {(m) => (
            <ListBoxItem
              id={m.id}
              textValue={m.display_name}
              className="flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 text-[13px] outline-none focus:bg-accent"
            >
              {({ isSelected }) => (
                <>
                  <Avatar name={m.display_name} src={m.avatar_url} size={18} />
                  <span className="flex-1 truncate">{m.display_name}</span>
                  {isSelected && <Check className="size-3.5 text-primary" />}
                </>
              )}
            </ListBoxItem>
          )}
        </ListBox>
      </Popover>
    </DialogTrigger>
  );
}
export { RACButton };
