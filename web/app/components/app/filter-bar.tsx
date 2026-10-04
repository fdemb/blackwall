import { useEffect, useEffectEvent, useRef, useState } from "react";
import {
  Autocomplete,
  DialogTrigger,
  Dialog as RACDialog,
  Form,
  Input,
  SearchField as RACSearch,
  useFilter,
} from "react-aria-components";
import {
  Bookmark,
  ChevronLeft,
  ChevronRight,
  LayoutList,
  ListFilter,
  Loader2,
  Search,
  X,
} from "lucide-react";
import { Button } from "~/components/ui/button";
import { Dialog, useDialogDirty } from "~/components/ui/dialog";
import { SearchField, TextField } from "~/components/ui/field";
import { Switch } from "~/components/ui/toggles";
import { Menu, MenuItem, MenuPopover, MenuTrigger } from "~/components/ui/menu";
import { Popover } from "~/components/ui/popover";
import { Avatar } from "~/components/ui/avatar";
import { useToast } from "~/components/ui/toast";
import { effectiveFilter, endOfDay } from "~/lib/filters";
import { fullDate, PRIORITIES } from "~/lib/format";
import { useI18n, type Key } from "~/lib/i18n";
import { usePending } from "~/lib/use-pending";
import { useWorkspace } from "~/lib/workspace";
import type { Id, IssueFilter, IssueSort } from "~/lib/types";
import { PriorityIcon, StageIcon } from "./icons";
import { LabelDot } from "./pickers";
import type { GroupBy } from "./issue-list";

type Chip =
  | "assignee"
  | "unassigned"
  | "stage_id"
  | "priority"
  | "label_id"
  | "project_id"
  | "sprint_id"
  | "due_before"
  | "team_id";
type Category =
  | "assignee"
  | "stage_id"
  | "priority"
  | "label_id"
  | "project_id"
  | "sprint_id"
  | "team_id"
  | "due_before";

interface Choice {
  id: string;
  label: string;
  icon?: React.ReactNode;
}

export function FilterBar({
  filter,
  onChange,
  hide = [],
  groupBy,
  onGroupBy,
  saveable = true,
  scope,
}: {
  filter: IssueFilter;
  onChange: (f: IssueFilter) => void;
  hide?: (keyof IssueFilter)[];
  groupBy?: GroupBy;
  onGroupBy?: (g: GroupBy) => void;
  saveable?: boolean;
  /** Filters the page adds on top of the person's own (the team on a team list). They are saved with the view. */
  scope?: IssueFilter;
}) {
  const { t, lang } = useI18n();
  const { ws, members } = useWorkspace();
  const set = (patch: Partial<IssueFilter>) => onChange({ ...filter, ...patch });
  const clear = (k: Chip) => {
    const n = { ...filter };
    delete n[k];
    onChange(n);
  };
  const shown = (k: Chip) => !hide.includes(k === "unassigned" ? "assignee" : k);
  const active = (
    [
      "assignee",
      "unassigned",
      "stage_id",
      "priority",
      "label_id",
      "project_id",
      "sprint_id",
      "due_before",
      "team_id",
    ] as const
  ).filter((k) => filter[k] && shown(k));

  const chipLabel = (k: Chip) => {
    switch (k) {
      case "assignee":
        return members.find((m) => m.id === filter.assignee)?.display_name ?? "?";
      case "unassigned":
        return t("assignee.none");
      case "stage_id":
        return ws.teams.flatMap((x) => x.stages).find((s) => s.id === filter.stage_id)?.name ?? "?";
      case "priority":
        return t(`priority.${filter.priority!}`);
      case "label_id":
        return ws.labels.find((l) => l.id === filter.label_id)?.name ?? "?";
      case "project_id":
        return ws.projects.find((p) => p.id === filter.project_id)?.name ?? "?";
      case "sprint_id":
        return ws.sprints.find((s) => s.id === filter.sprint_id)?.name ?? "?";
      case "team_id":
        return ws.teams.find((x) => x.id === filter.team_id)?.name ?? "?";
      case "due_before":
        return t("filter.dueTo", { date: fullDate(filter.due_before!, lang) });
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5 px-4 pb-2">
      <SearchFilter value={filter.search} onChange={(search) => set({ search })} />
      <AddFilter filter={filter} set={set} hide={hide} />
      {active.map((k) => (
        <span
          key={k}
          className="inline-flex h-7 items-center gap-1 rounded-md bg-accent pl-2.5 pr-1 text-xs font-medium text-accent-foreground"
        >
          {chipLabel(k)}
          <button
            type="button"
            aria-label={`${t("action.remove")}: ${chipLabel(k)}`}
            onClick={() => clear(k)}
            className="grid size-5 place-items-center rounded outline-none hover:bg-primary/15 focus-visible:ring-2 focus-visible:ring-ring/60 pointer-coarse:size-7"
          >
            <X aria-hidden className="size-3" />
          </button>
        </span>
      ))}
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
        <ChoiceMenu
          label={`${t("sort.label")}: ${t(`sort.${filter.sort ?? "position"}`)}`}
          selected={filter.sort ?? "position"}
          options={(["position", "priority", "deadline", "updated"] as const).map((s) => ({
            id: s,
            label: t(`sort.${s}`),
          }))}
          onPick={(k) => set({ sort: k as IssueSort })}
        />
        {saveable && <SaveViewAction filter={filter} scope={scope} groupBy={groupBy} />}
      </div>
    </div>
  );
}

/** Filter bar that can always save the current filter as a view. Prefer this over `saveable`. */
export function SaveableFilterBar(props: Omit<React.ComponentProps<typeof FilterBar>, "saveable">) {
  return <FilterBar {...props} saveable />;
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

const CATEGORY_LABEL: Record<Category, Key> = {
  assignee: "field.assignee",
  stage_id: "filter.status",
  priority: "field.priority",
  label_id: "field.labels",
  project_id: "field.project",
  sprint_id: "field.sprint",
  team_id: "field.team",
  due_before: "field.deadline",
};

/** Two steps: pick what to filter by, then search its values. Keeps long people and project lists out of one menu. */
function AddFilter({
  filter,
  set,
  hide,
}: {
  filter: IssueFilter;
  set: (patch: Partial<IssueFilter>) => void;
  hide: (keyof IssueFilter)[];
}) {
  const { t } = useI18n();
  const { ws, members } = useWorkspace();
  const { contains } = useFilter({ sensitivity: "base" });
  const [open, setOpen] = useState(false);
  const [category, setCategory] = useState<Category | null>(null);

  const stages = ws.teams
    .filter((x) => !filter.team_id || x.id === filter.team_id)
    .flatMap((x) =>
      [...x.stages].sort((a, b) => a.position - b.position).map((s) => ({ ...s, team: x.name })),
    );
  const multiTeam = ws.teams.length > 1 && !filter.team_id;
  const sprints = ws.sprints.filter(
    (s) => (!filter.team_id || s.team_id === filter.team_id) && s.state !== "archived",
  );
  const choices: Record<Category, Choice[]> = {
    assignee: [
      { id: "__none", label: t("assignee.none") },
      ...members.map((m) => ({
        id: m.id,
        label: m.display_name,
        icon: <Avatar name={m.display_name} src={m.avatar_url} size={16} />,
      })),
    ],
    stage_id: stages.map((s) => ({
      id: s.id,
      label: multiTeam ? `${s.name} · ${s.team}` : s.name,
      icon: <StageIcon kind={s.kind} />,
    })),
    priority: PRIORITIES.map((p) => ({
      id: p,
      label: t(`priority.${p}`),
      icon: <PriorityIcon priority={p} />,
    })),
    label_id: ws.labels.map((l) => ({
      id: l.id,
      label: l.name,
      icon: <LabelDot color={l.color} />,
    })),
    project_id: ws.projects.map((p) => ({ id: p.id, label: p.name })),
    sprint_id: sprints.map((s) => ({ id: s.id, label: s.name })),
    team_id: ws.teams.map((x) => ({ id: x.id, label: x.name })),
    due_before: [
      { id: "0", label: t("filter.today") },
      { id: "7", label: t("filter.week") },
      { id: "30", label: t("filter.month") },
    ],
  };
  const categories = (Object.keys(choices) as Category[]).filter(
    (c) => !hide.includes(c) && choices[c].length > 0,
  );

  const pick = (c: Category, id: string) => {
    if (c === "assignee")
      set(
        id === "__none"
          ? { unassigned: true, assignee: undefined }
          : { assignee: id as Id, unassigned: undefined },
      );
    else if (c === "priority") set({ priority: id as never });
    else if (c === "due_before") set({ due_before: endOfDay(Number(id)) });
    else set({ [c]: id });
    setOpen(false);
  };

  return (
    <DialogTrigger
      isOpen={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) setCategory(null);
      }}
    >
      <Button variant="secondary" size="sm">
        <ListFilter aria-hidden />
        {t("filter.add")}
      </Button>
      <Popover placement="bottom start" className="w-64 overscroll-contain">
        <RACDialog aria-label={t("filter.add")} className="outline-none">
          {category === null ? (
            // A menu inside a popover closes it on action by default, which would hide the second step.
            <Menu
              aria-label={t("filter.add")}
              shouldCloseOnSelect={false}
              onAction={(k) => setCategory(k as Category)}
            >
              {categories.map((c) => (
                <MenuItem key={c} id={c}>
                  <span className="flex-1">{t(CATEGORY_LABEL[c])}</span>
                  <ChevronRight aria-hidden className="size-3.5" />
                </MenuItem>
              ))}
            </Menu>
          ) : (
            <Autocomplete filter={contains}>
              <div className="flex items-center gap-1 border-b border-border p-1.5">
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t("filter.back")}
                  onPress={() => setCategory(null)}
                >
                  <ChevronLeft aria-hidden />
                </Button>
                <RACSearch
                  autoFocus
                  aria-label={t(CATEGORY_LABEL[category])}
                  className="relative flex flex-1 items-center"
                >
                  <Search
                    aria-hidden
                    className="pointer-events-none absolute left-2 size-3.5 text-muted-foreground"
                  />
                  <Input
                    placeholder={t(CATEGORY_LABEL[category])}
                    className="h-8 w-full rounded bg-transparent pl-7 pr-2 text-[13px] outline-none placeholder:text-muted-foreground/70 focus-visible:ring-2 focus-visible:ring-ring/60 [&::-webkit-search-cancel-button]:hidden"
                  />
                </RACSearch>
              </div>
              <Menu
                aria-label={t(CATEGORY_LABEL[category])}
                items={choices[category]}
                onAction={(k) => pick(category, String(k))}
                className="max-h-64 overflow-auto overscroll-contain"
                renderEmptyState={() => (
                  <p className="px-2 py-1.5 text-xs text-muted-foreground">
                    {t("filter.noValues")}
                  </p>
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
          )}
        </RACDialog>
      </Popover>
    </DialogTrigger>
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
        <p className="text-xs text-muted-foreground">{t("view.personalOnly")}</p>
      )}
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
