import { useEffect, useEffectEvent, useRef, useState } from "react";
import {
  Autocomplete,
  Button as RACButton,
  DialogTrigger,
  Dialog as RACDialog,
  Form,
  Input,
  SearchField as RACSearch,
  useFilter,
  type Key as AriaKey,
} from "react-aria-components";
import {
  Archive,
  Bookmark,
  CalendarDays,
  CalendarPlus,
  ChevronLeft,
  ChevronRight,
  CircleDashed,
  CircleDot,
  Folder,
  Hash,
  History,
  LayoutList,
  Link2,
  ListFilter,
  Loader2,
  PenLine,
  Search,
  SignalHigh,
  Tag,
  UserRound,
  Users,
  Workflow,
  X,
  Zap,
} from "lucide-react";
import { Button } from "~/components/ui/button";
import { DatePicker } from "~/components/ui/date-picker";
import { Dialog, useDialogDirty } from "~/components/ui/dialog";
import { SearchField, TextField } from "~/components/ui/field";
import { Switch } from "~/components/ui/toggles";
import { Menu, MenuItem, MenuPopover, MenuSeparator, MenuTrigger } from "~/components/ui/menu";
import { Popover } from "~/components/ui/popover";
import { Avatar } from "~/components/ui/avatar";
import { useToast } from "~/components/ui/toast";
import {
  addClause,
  clause,
  clausesOf,
  effectiveFilter,
  pinnedValue,
  relativeDay,
  removeClause,
  replaceClause,
} from "~/lib/filters";
import { FIELD_KIND, isComparison, opsFor, relativeDays } from "~/lib/issue-filter";
import { fullDate, PRIORITIES } from "~/lib/format";
import { useI18n, type Key } from "~/lib/i18n";
import { usePending } from "~/lib/use-pending";
import { useWorkspace } from "~/lib/workspace";
import { cn } from "~/lib/utils";
import type {
  FilterClause,
  FilterField,
  FilterOp,
  FilterValue,
  IssueFilter,
  IssueSort,
  StageKind,
} from "~/lib/types";
import { PriorityIcon, StageIcon } from "./icons";
import { TeamIcon } from "./team-icon";
import { LabelDot } from "./pickers";
import type { GroupBy } from "./issue-list";

/** What a page can keep out of the bar: fields it scopes itself, and the archive toggle. */
export type HiddenFilter = FilterField | "archived";

interface Choice {
  id: string;
  label: string;
  icon?: React.ReactNode;
}

/** Fields the bar offers, in menu order. Parent and dependencies are API-only. */
const FIELDS: FilterField[] = [
  "assignee",
  "created_by",
  "stage_id",
  "stage_kind",
  "priority",
  "labels",
  "project_id",
  "sprint_id",
  "team_id",
  "deadline",
  "estimate",
  "created_at",
  "updated_at",
];

const FIELD_LABEL: Record<FilterField, Key> = {
  assignee: "field.assignee",
  created_by: "field.creator",
  team_id: "field.team",
  stage_id: "filter.status",
  stage_kind: "field.stageKind",
  priority: "field.priority",
  labels: "field.labels",
  project_id: "field.project",
  sprint_id: "field.sprint",
  parent_id: "field.parent",
  dependencies: "field.dependencies",
  estimate: "field.estimate",
  deadline: "field.deadline",
  created_at: "field.created",
  updated_at: "field.updated",
};

const FIELD_ICON: Record<FilterField, React.ReactNode> = {
  assignee: <UserRound />,
  created_by: <PenLine />,
  team_id: <Users />,
  stage_id: <CircleDot />,
  stage_kind: <CircleDashed />,
  priority: <SignalHigh />,
  labels: <Tag />,
  project_id: <Folder />,
  sprint_id: <Zap />,
  parent_id: <Workflow />,
  dependencies: <Link2 />,
  estimate: <Hash />,
  deadline: <CalendarDays />,
  created_at: <CalendarPlus />,
  updated_at: <History />,
};

/** The label of a null value, for fields that can be empty. */
const NONE_LABEL: Partial<Record<FilterField, Key>> = {
  assignee: "assignee.none",
  created_by: "filter.none.created_by",
  labels: "filter.none.labels",
  project_id: "filter.none.project_id",
  sprint_id: "filter.none.sprint_id",
  parent_id: "filter.none.parent_id",
  dependencies: "filter.none.dependencies",
  estimate: "filter.none.estimate",
  deadline: "filter.none.deadline",
};

const STAGE_KINDS: StageKind[] = ["backlog", "planned", "active", "done", "cancelled"];
const NONE = "__none";
const ARCHIVED = "__archived";

function opLabel(field: FilterField, op: FilterOp, count: number): Key {
  const kind = FIELD_KIND[field];
  const set = field === "labels" || field === "dependencies";
  switch (op) {
    case "is":
      if (set) return count > 1 ? "filter.op.includesAny" : "filter.op.includes";
      return count > 1 ? "filter.op.isAny" : "filter.op.is";
    case "is_not":
      if (set) return "filter.op.excludes";
      return count > 1 ? "filter.op.isNotAny" : "filter.op.isNot";
    case "lt":
      return kind === "time" ? "filter.op.before" : "filter.op.lessThan";
    case "lte":
      return kind === "time" ? "filter.op.onOrBefore" : "filter.op.atMost";
    case "gt":
      return kind === "time" ? "filter.op.after" : "filter.op.moreThan";
    case "gte":
      return kind === "time" ? "filter.op.onOrAfter" : "filter.op.atLeast";
  }
}

export function FilterBar({
  filter,
  onChange,
  hide = [],
  groupBy,
  onGroupBy,
  saveable = true,
  sortable = true,
  scope,
}: {
  filter: IssueFilter;
  onChange: (f: IssueFilter) => void;
  hide?: readonly HiddenFilter[];
  groupBy?: GroupBy;
  onGroupBy?: (g: GroupBy) => void;
  saveable?: boolean;
  /** Off where the order is fixed, like board columns ordered by hand. */
  sortable?: boolean;
  /** Filters the page adds on top of the person's own (the team on a team list). They are saved with the view. */
  scope?: IssueFilter;
}) {
  const { t } = useI18n();
  const set = (patch: Partial<IssueFilter>) => onChange({ ...filter, ...patch });
  const where = clausesOf(filter);
  const team = pinnedValue(filter, "team_id") ?? pinnedValue(scope ?? {}, "team_id");

  return (
    <div className="flex flex-wrap items-center gap-1.5 px-4 pb-2">
      <SearchFilter value={filter.search} onChange={(search) => set({ search })} />
      <AddFilter
        hide={hide}
        team={team}
        archived={Boolean(filter.archived)}
        onAdd={(next) => onChange(addClause(filter, next))}
        onArchived={() => set({ archived: true })}
      />
      {where.map((c, i) =>
        hide.includes(c.field) ? null : (
          <ClauseChip
            key={i}
            clause={c}
            team={team}
            onChange={(next) => onChange(replaceClause(filter, i, next))}
            onRemove={() => onChange(removeClause(filter, i))}
          />
        ),
      )}
      {filter.archived && !hide.includes("archived") && (
        <Chip>
          <span className="flex items-center gap-1.5 pl-2 pr-1">
            <Archive aria-hidden className="size-3.5 text-muted-foreground" />
            {t("filter.archived")}
          </span>
          <RemoveButton
            label={t("filter.archived")}
            onPress={() => {
              const { archived: _, ...rest } = filter;
              onChange(rest);
            }}
          />
        </Chip>
      )}
      <div className="ml-auto flex items-center gap-1.5">
        {onGroupBy && groupBy && (
          <ChoiceMenu
            label={t(`group.${groupBy}`)}
            icon={<LayoutList />}
            selected={groupBy}
            options={(["stage", "priority", "assignee", "none"] as const).map((g) => ({
              id: g,
              label: t(`group.${g}`),
            }))}
            onPick={(k) => onGroupBy(k as GroupBy)}
          />
        )}
        {sortable && (
          <ChoiceMenu
            label={`${t("sort.label")}: ${t(`sort.${filter.sort ?? "position"}`)}`}
            selected={filter.sort ?? "position"}
            options={(["position", "priority", "deadline", "updated"] as const).map((s) => ({
              id: s,
              label: t(`sort.${s}`),
            }))}
            onPick={(k) => set({ sort: k as IssueSort })}
          />
        )}
        {saveable && <SaveViewAction filter={filter} scope={scope} groupBy={groupBy} />}
      </div>
    </div>
  );
}

/** Filter bar that can always save the current filter as a view. Prefer this over `saveable`. */
export function SaveableFilterBar(props: Omit<React.ComponentProps<typeof FilterBar>, "saveable">) {
  return <FilterBar {...props} saveable />;
}

function Chip({ children }: { children: React.ReactNode }) {
  return (
    <span className="inline-flex h-7 items-stretch overflow-hidden rounded-md border border-border bg-card font-medium text-foreground">
      {children}
    </span>
  );
}

const segment =
  "flex items-center gap-1 px-1.5 outline-none hover:bg-accent focus-visible:bg-accent data-[pressed]:bg-accent";

function RemoveButton({ label, onPress }: { label: string; onPress: () => void }) {
  const { t } = useI18n();
  return (
    <button
      type="button"
      aria-label={`${t("action.remove")}: ${label}`}
      onClick={onPress}
      className="grid w-6 place-items-center border-l border-border outline-none hover:bg-accent focus-visible:bg-accent pointer-coarse:w-8"
    >
      <X aria-hidden className="size-3" />
    </button>
  );
}

/** One clause as `field · op · values · ×`. The op and values segments open their own editors. */
function ClauseChip({
  clause: c,
  team,
  onChange,
  onRemove,
}: {
  clause: FilterClause;
  team: string | undefined;
  onChange: (next: FilterClause) => void;
  onRemove: () => void;
}) {
  const { t } = useI18n();
  const labels = useValueLabels();
  const names = c.values.map((v) => labels(c.field, v));
  const summary =
    names.length > 2 ? t("filter.nValues", { count: names.length }) : names.join(", ");
  const [editing, setEditing] = useState(false);
  // Comparisons take one value, so a clause with several offers only the set ops.
  const ops = opsFor(c.field).filter((op) => c.values.length === 1 || !isComparison(op));
  return (
    <Chip>
      <span className="flex items-center gap-1.5 pl-2 pr-0.5 text-muted-foreground [&_svg]:size-3.5">
        {FIELD_ICON[c.field]}
        {t(FIELD_LABEL[c.field])}
      </span>
      <MenuTrigger>
        <RACButton
          className={cn(segment, "text-muted-foreground")}
          aria-label={`${t(FIELD_LABEL[c.field])}: ${t(opLabel(c.field, c.op, c.values.length))}`}
        >
          {t(opLabel(c.field, c.op, c.values.length))}
        </RACButton>
        <MenuPopover placement="bottom start">
          <Menu
            aria-label={t(FIELD_LABEL[c.field])}
            selectionMode="single"
            selectedKeys={[c.op]}
            onAction={(k) => onChange(withOp(c, k as FilterOp))}
          >
            {ops.map((op) => (
              <MenuItem key={op} id={op}>
                {t(opLabel(c.field, op, c.values.length))}
              </MenuItem>
            ))}
          </Menu>
        </MenuPopover>
      </MenuTrigger>
      <DialogTrigger isOpen={editing} onOpenChange={setEditing}>
        <RACButton
          className={cn(segment, "max-w-56 pr-2")}
          aria-label={`${t(FIELD_LABEL[c.field])}: ${summary}`}
        >
          <span className="truncate">{summary}</span>
        </RACButton>
        <Popover placement="bottom start" className="w-64 overscroll-contain">
          <RACDialog aria-label={t(FIELD_LABEL[c.field])} className="outline-none">
            <ValuePicker
              field={c.field}
              current={c}
              team={team}
              onPick={(next, done) => {
                onChange(next);
                if (done) setEditing(false);
              }}
            />
          </RACDialog>
        </Popover>
      </DialogTrigger>
      <RemoveButton label={`${t(FIELD_LABEL[c.field])} ${summary}`} onPress={onRemove} />
    </Chip>
  );
}

/** The clause under a new op. A comparison keeps one non-null value, or a sensible one. */
function withOp(c: FilterClause, op: FilterOp): FilterClause {
  if (!isComparison(op)) return { ...c, op };
  const kept = c.values.find((v): v is string => v !== null);
  const fallback = { priority: "normal", number: "0", time: relativeDay(0) } as const;
  const kind = FIELD_KIND[c.field];
  const value =
    kept ?? (kind === "priority" || kind === "number" || kind === "time" ? fallback[kind] : "");
  return { ...c, op, values: [value] };
}

const SEARCH_DEBOUNCE_MS = 250;

/** Typing updates the field at once but the list only after a pause, since each refilter re-renders it. */
function SearchFilter({
  value,
  onChange,
}: {
  value: string | undefined;
  onChange: (v: string | undefined) => void;
}) {
  const { t } = useI18n();
  const [text, setText] = useState(value ?? "");
  const sent = useRef(value);
  const commit = useEffectEvent((v: string | undefined) => {
    sent.current = v;
    onChange(v);
  });
  // Take changes made elsewhere, like clearing all filters.
  useEffect(() => {
    if (value === sent.current) return;
    sent.current = value;
    setText(value ?? "");
  }, [value]);
  useEffect(() => {
    const next = text || undefined;
    if (next === sent.current) return;
    const id = setTimeout(() => commit(next), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(id);
  }, [text]);
  return (
    <SearchField
      aria-label={t("action.search")}
      placeholder={t("filter.search")}
      value={text}
      onChange={setText}
      className="w-full sm:w-48"
      inputClassName="h-7 pointer-coarse:h-9"
    />
  );
}

function ChoiceMenu({
  label,
  icon,
  selected,
  options,
  onPick,
}: {
  label: string;
  icon?: React.ReactNode;
  selected: string;
  options: Choice[];
  onPick: (id: string) => void;
}) {
  return (
    <MenuTrigger>
      <Button variant="ghost" size="sm">
        {icon}
        {label}
      </Button>
      <MenuPopover placement="bottom end">
        <Menu
          selectionMode="single"
          selectedKeys={[selected]}
          onAction={(k) => onPick(String(k))}
          aria-label={label}
        >
          {options.map((o) => (
            <MenuItem key={o.id} id={o.id}>
              {o.label}
            </MenuItem>
          ))}
        </Menu>
      </MenuPopover>
    </MenuTrigger>
  );
}

/** Names for clause values: people, stages, labels, dates and the rest. */
function useValueLabels() {
  const { t, lang } = useI18n();
  const { ws, members } = useWorkspace();
  const nameOf = (items: readonly { id: string; name: string }[], id: string) =>
    items.find((item) => item.id === id)?.name ?? "?";
  return (field: FilterField, value: FilterValue): string => {
    if (value === null) {
      const key = NONE_LABEL[field];
      return key ? t(key) : "—";
    }
    switch (field) {
      case "assignee":
      case "created_by":
        return members.find((m) => m.id === value)?.display_name ?? "?";
      case "team_id":
        return nameOf(ws.teams, value);
      case "stage_id":
        return nameOf(
          ws.teams.flatMap((x) => x.stages),
          value,
        );
      case "stage_kind":
        return STAGE_KINDS.includes(value as StageKind)
          ? t(`stage.kind.${value as StageKind}`)
          : value;
      case "priority":
        return PRIORITIES.includes(value as never)
          ? t(`priority.${value as (typeof PRIORITIES)[number]}`)
          : value;
      case "labels":
        return nameOf(ws.labels, value);
      case "project_id":
        return nameOf(ws.projects, value);
      case "sprint_id":
        return nameOf(ws.sprints, value);
      case "parent_id":
      case "dependencies":
        return `#${value.slice(0, 8)}`;
      case "estimate":
        return value;
      case "deadline":
      case "created_at":
      case "updated_at": {
        const days = relativeDays(value);
        if (days === undefined) return fullDate(value, lang);
        if (days === 0) return t("filter.todayValue");
        return days > 0
          ? t("filter.inDays", { count: days })
          : t("filter.daysAgo", { count: -days });
      }
    }
  };
}

/** The pickable values of an enumerable field. Empty for fields edited by date or number. */
function useChoices(team: string | undefined): (field: FilterField) => Choice[] {
  const { t } = useI18n();
  const { ws, members } = useWorkspace();
  const none = (field: FilterField): Choice[] => {
    const key = NONE_LABEL[field];
    return key ? [{ id: NONE, label: t(key) }] : [];
  };
  return (field) => {
    switch (field) {
      case "assignee":
      case "created_by":
        return [
          ...none(field),
          ...members.map((m) => ({
            id: m.id,
            label: m.display_name,
            icon: <Avatar name={m.display_name} src={m.avatar_url} size={16} />,
          })),
        ];
      case "stage_id": {
        const teams = ws.teams.filter((x) => !team || x.id === team);
        const multi = teams.length > 1;
        return teams.flatMap((x) =>
          [...x.stages]
            .sort((a, b) => a.position - b.position)
            .map((s) => ({
              id: s.id,
              label: multi ? `${s.name} · ${x.name}` : s.name,
              icon: <StageIcon kind={s.kind} />,
            })),
        );
      }
      case "stage_kind":
        return STAGE_KINDS.map((k) => ({
          id: k,
          label: t(`stage.kind.${k}`),
          icon: <StageIcon kind={k} />,
        }));
      case "priority":
        return PRIORITIES.map((p) => ({
          id: p,
          label: t(`priority.${p}`),
          icon: <PriorityIcon priority={p} />,
        }));
      case "labels":
        return [
          ...none(field),
          ...ws.labels.map((l) => ({
            id: l.id,
            label: l.name,
            icon: <LabelDot color={l.color} />,
          })),
        ];
      case "project_id":
        return [...none(field), ...ws.projects.map((p) => ({ id: p.id, label: p.name }))];
      case "sprint_id":
        return [
          ...none(field),
          ...ws.sprints
            .filter((s) => (!team || s.team_id === team) && s.state !== "archived")
            .map((s) => ({ id: s.id, label: s.name })),
        ];
      case "team_id":
        return ws.teams.map((x) => ({ id: x.id, label: x.name, icon: <TeamIcon team={x} /> }));
      default:
        return [];
    }
  };
}

interface Preset {
  label: Key;
  op: FilterOp;
  value: FilterValue;
}

/** Quick picks for date fields. Relative days keep a saved view current. */
function presetsFor(field: FilterField): Preset[] {
  if (field === "deadline")
    return [
      { label: "filter.today", op: "lte", value: relativeDay(0) },
      { label: "filter.week", op: "lte", value: relativeDay(7) },
      { label: "filter.month", op: "lte", value: relativeDay(30) },
      { label: "filter.overdue", op: "lt", value: relativeDay(-1) },
      { label: "filter.none.deadline", op: "is", value: null },
    ];
  return [
    { label: "filter.recent.today", op: "gte", value: relativeDay(-1) },
    { label: "filter.recent.week", op: "gte", value: relativeDay(-7) },
    { label: "filter.recent.month", op: "gte", value: relativeDay(-30) },
    { label: "filter.recent.older", op: "lt", value: relativeDay(-30) },
  ];
}

/**
 * Picks values for one field. Adding a filter picks one value and closes; editing a chip toggles
 * values in place. Dates offer presets and a calendar, estimates a number.
 */
function ValuePicker({
  field,
  current,
  team,
  onPick,
}: {
  field: FilterField;
  /** The clause being edited, or none when adding. */
  current?: FilterClause;
  team: string | undefined;
  onPick: (next: FilterClause, done: boolean) => void;
}) {
  const { t } = useI18n();
  const { contains } = useFilter({ sensitivity: "base" });
  const choices = useChoices(team)(field);
  const kind = FIELD_KIND[field];
  const op = current?.op ?? "is";
  const keyOf = (v: FilterValue) => v ?? NONE;
  const valueOf = (k: AriaKey): FilterValue => (k === NONE ? null : String(k));

  if (kind === "time") {
    const comparison = current && isComparison(current.op) ? current.op : undefined;
    const absolute = current?.values.find(
      (v): v is string => v !== null && relativeDays(v) === undefined,
    );
    return (
      <div className="flex flex-col">
        <Menu
          aria-label={t(FIELD_LABEL[field])}
          onAction={(k) => {
            const preset = presetsFor(field)[Number(k)]!;
            onPick(clause(field, preset.op, [preset.value]), true);
          }}
        >
          {presetsFor(field).map((p, i) => (
            <MenuItem key={p.label} id={i}>
              {t(p.label)}
            </MenuItem>
          ))}
        </Menu>
        <div className="border-t border-border p-2">
          <DatePicker
            aria-label={t("filter.customDate")}
            placeholder={t("filter.customDate")}
            value={absolute ?? null}
            clearable={false}
            onChange={(iso) => {
              if (!iso) return;
              onPick(
                clause(field, comparison ?? (field === "deadline" ? "lte" : "gte"), [iso]),
                true,
              );
            }}
          />
        </div>
      </div>
    );
  }

  if (kind === "number") {
    return (
      <EstimateForm
        initial={current?.values.find((v): v is string => v !== null) ?? ""}
        onSubmit={(value) => onPick(clause(field, isComparison(op) ? op : "is", [value]), true)}
        onNone={() => onPick(clause(field, "is", [null]), true)}
      />
    );
  }

  const editing = current !== undefined && !isComparison(op);
  const selectedKeys = editing ? current.values.map(keyOf) : [];
  return (
    <Autocomplete filter={contains}>
      <div className="flex items-center gap-1 border-b border-border p-1.5">
        <RACSearch
          autoFocus
          aria-label={t(FIELD_LABEL[field])}
          className="relative flex flex-1 items-center"
        >
          <Search
            aria-hidden
            className="pointer-events-none absolute left-2 size-3.5 text-muted-foreground"
          />
          <Input
            placeholder={t(FIELD_LABEL[field])}
            className="h-8 w-full rounded bg-transparent pl-7 pr-2 outline-none placeholder:text-muted-foreground/70 focus-visible:ring-2 focus-visible:ring-ring/60 [&::-webkit-search-cancel-button]:hidden"
          />
        </RACSearch>
      </div>
      <Menu
        aria-label={t(FIELD_LABEL[field])}
        items={choices}
        className="max-h-64 overflow-auto overscroll-contain"
        selectionMode={editing ? "multiple" : "none"}
        selectedKeys={selectedKeys}
        disallowEmptySelection
        onSelectionChange={(keys) => {
          if (!editing || keys === "all") return;
          const values = [...keys].map(valueOf);
          if (values.length) onPick({ ...current, values }, false);
        }}
        onAction={editing ? undefined : (k) => onPick(clause(field, "is", [valueOf(k)]), true)}
        renderEmptyState={() => (
          <p className="px-2 py-1.5 text-muted-foreground">{t("filter.noValues")}</p>
        )}
      >
        {(o) => (
          <MenuItem id={o.id} textValue={o.label}>
            {o.icon}
            <span className="truncate">{o.label}</span>
          </MenuItem>
        )}
      </Menu>
    </Autocomplete>
  );
}

function EstimateForm({
  initial,
  onSubmit,
  onNone,
}: {
  initial: string;
  onSubmit: (value: string) => void;
  onNone: () => void;
}) {
  const { t } = useI18n();
  const [value, setValue] = useState(initial);
  const valid = /^\d{1,10}$/.test(value) && Number(value) <= 4294967295;
  return (
    <Form
      className="flex flex-col gap-2 p-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) onSubmit(value);
      }}
    >
      <TextField
        aria-label={t("field.estimate")}
        value={value}
        onChange={setValue}
        inputMode="numeric"
        autoFocus
        placeholder={t("field.estimate")}
      />
      <div className="flex justify-between gap-2">
        <Button variant="ghost" size="sm" onPress={onNone}>
          {t("filter.none.estimate")}
        </Button>
        <Button type="submit" variant="primary" size="sm" isDisabled={!valid}>
          {t("action.apply")}
        </Button>
      </div>
    </Form>
  );
}

/** Two steps: pick what to filter by, then its value. Keeps long people and project lists out of one menu. */
function AddFilter({
  hide,
  team,
  archived,
  onAdd,
  onArchived,
}: {
  hide: readonly HiddenFilter[];
  team: string | undefined;
  archived: boolean;
  onAdd: (next: FilterClause) => void;
  onArchived: () => void;
}) {
  const { t } = useI18n();
  const choices = useChoices(team);
  const [open, setOpen] = useState(false);
  const [field, setField] = useState<FilterField | null>(null);
  const fields = FIELDS.filter((f) => {
    if (hide.includes(f)) return false;
    const kind = FIELD_KIND[f];
    return kind === "time" || kind === "number" || choices(f).length > 0;
  });
  // A yes/no filter, so it applies at once instead of opening a second step.
  const offerArchived = !hide.includes("archived") && !archived;

  return (
    <DialogTrigger
      isOpen={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setField(null);
      }}
    >
      <Button variant="secondary" size="sm">
        <ListFilter aria-hidden />
        {t("filter.add")}
      </Button>
      <Popover placement="bottom start" className="w-64 overscroll-contain">
        <RACDialog aria-label={t("filter.add")} className="outline-none">
          {field === null ? (
            // A menu inside a popover closes it on action by default, which would hide the second step.
            <Menu
              aria-label={t("filter.add")}
              shouldCloseOnSelect={false}
              onAction={(k) => {
                if (k === ARCHIVED) {
                  onArchived();
                  setOpen(false);
                } else setField(k as FilterField);
              }}
            >
              {fields.map((f) => (
                <MenuItem key={f} id={f}>
                  {FIELD_ICON[f]}
                  <span className="flex-1">{t(FIELD_LABEL[f])}</span>
                  <ChevronRight aria-hidden className="size-3.5" />
                </MenuItem>
              ))}
              {offerArchived && <MenuSeparator />}
              {offerArchived && (
                <MenuItem id={ARCHIVED}>
                  <Archive aria-hidden />
                  {t("filter.archivedOnly")}
                </MenuItem>
              )}
            </Menu>
          ) : (
            <>
              <div className="flex items-center gap-1 border-b border-border px-1.5 py-1">
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t("filter.back")}
                  onPress={() => setField(null)}
                >
                  <ChevronLeft aria-hidden />
                </Button>
                <span className="flex items-center gap-1.5 text-muted-foreground [&_svg]:size-3.5">
                  {FIELD_ICON[field]}
                  {t(FIELD_LABEL[field])}
                </span>
              </div>
              <ValuePicker
                field={field}
                team={team}
                onPick={(next, done) => {
                  onAdd(next);
                  if (done) setOpen(false);
                }}
              />
            </>
          )}
        </RACDialog>
      </Popover>
    </DialogTrigger>
  );
}

/**
 * Save-as-view button and dialog. Composed by `FilterBar` when `saveable` is set, or by
 * `SaveableFilterBar`. The open state stays here: only this button reads it, so lifting it into a
 * `FilterBarProvider` would add indirection without sharing.
 */
function SaveViewAction({
  filter,
  scope,
  groupBy,
}: {
  filter: IssueFilter;
  scope?: IssueFilter;
  groupBy?: GroupBy;
}) {
  const { t } = useI18n();
  const { canWrite } = useWorkspace();
  const [saving, setSaving] = useState(false);
  return (
    <>
      <Button variant="ghost" size="sm" onPress={() => setSaving(true)}>
        <Bookmark aria-hidden />
        {t("view.save")}
      </Button>
      <Dialog
        title={t("view.save")}
        description={t("view.saveSub")}
        size="sm"
        isOpen={saving}
        onOpenChange={setSaving}
      >
        {(close) => (
          <SaveViewForm
            close={close}
            filter={effectiveFilter(filter, scope, groupBy)}
            canShare={canWrite}
          />
        )}
      </Dialog>
    </>
  );
}

function SaveViewForm({
  close,
  filter,
  canShare,
}: {
  close: () => void;
  filter: IssueFilter;
  canShare: boolean;
}) {
  const { t } = useI18n();
  const { run } = useWorkspace();
  const toast = useToast();
  const { pending, error, guard } = usePending();
  const [name, setName] = useState("");
  const [shared, setShared] = useState(false);
  useDialogDirty(name !== "");
  return (
    <Form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        void guard(async () => {
          await run(
            { type: "save_view", name: name.trim(), shared: canShare && shared, filter },
            { quiet: true },
          );
          toast.show(t("view.saved"));
          close();
        });
      }}
    >
      <TextField label={t("field.name")} value={name} onChange={setName} autoFocus isRequired />
      {canShare ? (
        <Switch isSelected={shared} onChange={setShared}>
          {t("view.share")}
        </Switch>
      ) : (
        <p className=" text-muted-foreground">{t("view.personalOnly")}</p>
      )}
      {error && (
        <p role="alert" className=" text-destructive">
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
          isDisabled={!name.trim() || pending}
          aria-busy={pending || undefined}
        >
          {pending && <Loader2 aria-hidden className="animate-spin" />}
          {pending ? t("action.saving") : t("action.save")}
        </Button>
      </div>
    </Form>
  );
}
