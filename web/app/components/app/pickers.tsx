import { useState } from "react";
import {
  Autocomplete,
  Button as RACButton,
  Dialog,
  DialogTrigger,
  Input,
  ListBox,
  ListBoxItem,
  SearchField,
  composeRenderProps,
  useFilter,
} from "react-aria-components";
import { Check, Plus, Search, Tag, User } from "lucide-react";
import { Select, type Option } from "~/components/ui/select";
import { Popover } from "~/components/ui/popover";
import { Button } from "~/components/ui/button";
import { Avatar } from "~/components/ui/avatar";
import { cn, selectedIds } from "~/lib/utils";
import { PRIORITIES } from "~/lib/format";
import { useI18n } from "~/lib/i18n";
import { useWorkspace } from "~/lib/workspace";
import type { Id, Priority } from "~/lib/types";
import { PriorityIcon, StageIcon } from "./icons";

const NONE = "__none";
const CREATE = "__create";
/** Palette for new labels. Each new label takes the next color so neighbours differ. */
export const LABEL_COLORS = [
  "#7c3aed",
  "#a78bfa",
  "#ec4899",
  "#ef4444",
  "#f97316",
  "#eab308",
  "#22c55e",
  "#14b8a6",
  "#0ea5e9",
  "#64748b",
];

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
  const { t } = useI18n();
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
  const { t } = useI18n();
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
  const { t } = useI18n();
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
  trigger,
}: {
  value: Id[];
  onChange: (ids: Id[]) => void;
  variant?: "field" | "ghost";
  isDisabled?: boolean;
  /** Replaces the default chip button, for places with their own look such as board cards. */
  trigger?: React.ReactElement;
}) {
  return (
    <LabelsPickerBase
      value={value}
      onChange={onChange}
      variant={variant}
      isDisabled={isDisabled}
      trigger={trigger}
    />
  );
}

function LabelsPickerBase({
  value,
  onChange,
  variant = "ghost",
  isDisabled,
  trigger,
}: {
  value: Id[];
  onChange: (ids: Id[]) => void;
  variant?: "field" | "ghost";
  isDisabled?: boolean;
  trigger?: React.ReactElement;
}) {
  const { t } = useI18n();
  const { ws, run, canWrite } = useWorkspace();
  const { contains } = useFilter({ sensitivity: "base" });
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const wanted = new Set(value);
  const chosen = ws.labels.filter((l) => wanted.has(l.id));
  const name = q.trim();
  // Typing a name no label has yet offers to create it. The row matches the query, so filtering keeps it.
  const canCreate =
    canWrite &&
    name !== "" &&
    !ws.labels.some((l) => l.name.localeCompare(name, undefined, { sensitivity: "base" }) === 0);
  const items = canCreate
    ? [
        ...ws.labels,
        { id: CREATE, name, color: LABEL_COLORS[ws.labels.length % LABEL_COLORS.length] },
      ]
    : ws.labels;
  const create = (color: string) =>
    run({ type: "create_label", name, color })
      .then((id) => {
        if (id) onChange([...value, id]);
        setQ("");
      })
      .catch(() => {});
  return (
    <DialogTrigger
      isOpen={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setQ("");
      }}
    >
      {trigger ?? (
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
      )}
      <Popover placement="bottom start" className="w-64">
        <Dialog aria-label={t("field.labels")} className="outline-none">
          <Autocomplete inputValue={q} onInputChange={setQ} filter={contains}>
            <SearchField
              autoFocus
              aria-label={t("field.labels")}
              className="flex items-center gap-2 border-b border-border px-3"
            >
              <Search aria-hidden className="size-3.5 text-muted-foreground" />
              <Input
                placeholder={canWrite ? t("labels.searchOrCreate") : t("labels.search")}
                className="h-9 flex-1 bg-transparent outline-none placeholder:text-muted-foreground/70 [&::-webkit-search-cancel-button]:hidden"
              />
            </SearchField>
            <ListBox
              aria-label={t("field.labels")}
              selectionMode="multiple"
              selectedKeys={new Set(value)}
              onSelectionChange={(keys) => {
                // The create row toggles like any item; it never stays selected because the id is not a label.
                if (keys !== "all" && keys.has(CREATE)) {
                  const draft = items.find((l) => l.id === CREATE);
                  if (draft) void create(draft.color);
                  return;
                }
                onChange(selectedIds(keys, ws.labels));
              }}
              items={items}
              dependencies={[name]}
              renderEmptyState={() => (
                <p className="px-3 py-2 text-muted-foreground">
                  {ws.labels.length ? t("search.empty") : t("labels.empty")}
                </p>
              )}
              className="max-h-72 overflow-auto p-1 outline-none"
            >
              {(l) => (
                <ListBoxItem
                  id={l.id}
                  textValue={l.name}
                  className={composeRenderProps("", (c) =>
                    cn(
                      "flex cursor-default items-center gap-2 rounded-md px-2 py-1.5 outline-none focus:bg-accent",
                      c,
                    ),
                  )}
                >
                  {({ isSelected }) =>
                    l.id === CREATE ? (
                      <>
                        <Plus aria-hidden className="size-3.5 text-muted-foreground" />
                        <span className="flex-1 truncate">
                          {t("labels.create", { name: l.name })}
                        </span>
                        <LabelDot color={l.color} />
                      </>
                    ) : (
                      <>
                        <LabelDot color={l.color} />
                        <span className="flex-1 truncate">{l.name}</span>
                        {isSelected && <Check className="size-3.5 text-primary" />}
                      </>
                    )
                  }
                </ListBoxItem>
              )}
            </ListBox>
          </Autocomplete>
        </Dialog>
      </Popover>
    </DialogTrigger>
  );
}

export function MultiMemberPicker({
  value,
  onChange,
  pool,
  trigger,
}: {
  value: Id[];
  onChange: (ids: Id[]) => void;
  pool?: Id[];
  /** Replaces the default trigger, for places with their own look such as property rows. */
  trigger?: React.ReactElement;
}) {
  const { t } = useI18n();
  const { members } = useWorkspace();
  const list = pool
    ? (() => {
        const wanted = new Set(pool);
        return members.filter((m) => wanted.has(m.id));
      })()
    : members;
  return (
    <DialogTrigger>
      {trigger ?? (
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
            <span className="text-muted-foreground">
              {t("count.members", { count: value.length })}
            </span>
          )}
        </Button>
      )}
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
              className="flex cursor-default items-center gap-2 rounded-md px-2 py-1.5  outline-none focus:bg-accent"
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
