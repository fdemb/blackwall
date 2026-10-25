import { useState } from "react";
import { Form } from "react-aria-components";
import { Link } from "react-router";
import { CalendarDays, FolderKanban, Plus } from "lucide-react";
import { Avatar } from "~/components/ui/avatar";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Dialog, useDialogDirty } from "~/components/ui/dialog";
import { SearchField, TextField } from "~/components/ui/field";
import { Menu, MenuItem, MenuPopover, MenuTrigger } from "~/components/ui/menu";
import { Tab, TabList, Tabs } from "~/components/ui/tabs";
import { Checkbox } from "~/components/ui/toggles";
import { EmptyState, Page, PageHeader, Scroll } from "~/components/app/page";
import { ProgressBar } from "~/components/app/progress";
import { fullDate } from "~/lib/format";
import { useI18n, type Key } from "~/lib/i18n";
import {
  PROJECT_HEALTH,
  PROJECT_STATUS,
  PROJECT_STATUSES,
  inScope,
  planDateTime,
  type ProjectScope,
} from "~/lib/projects";
import { usePending } from "~/lib/use-pending";
import { useProjectStats } from "~/lib/stats";
import { useWorkspace } from "~/lib/workspace";
import { cn } from "~/lib/utils";
import type { Id, IsoDate, Project, ProjectHealth, ProjectStatus } from "~/lib/types";

interface Row {
  p: Project;
  total: number;
  done: number;
  ratio: number;
  touched: number;
}

const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
function byTarget(a: IsoDate | null, b: IsoDate | null): number {
  if (a === b) return 0;
  if (a === null) return 1;
  if (b === null) return -1;
  return byText(a, b);
}
const SORTS = {
  name: { label: "project.sortName", compare: () => 0 },
  progress: { label: "project.sortProgress", compare: (a, b) => b.ratio - a.ratio },
  recent: { label: "project.sortRecent", compare: (a, b) => b.touched - a.touched },
  target: {
    label: "project.sortTarget",
    compare: (a, b) => byTarget(a.p.target_date, b.p.target_date),
  },
  status: {
    label: "project.sortStatus",
    compare: (a, b) => PROJECT_STATUSES.indexOf(a.p.status) - PROJECT_STATUSES.indexOf(b.p.status),
  },
} satisfies Record<string, { label: Key; compare: (a: Row, b: Row) => number }>;
type ProjectSort = keyof typeof SORTS;

const SCOPES = {
  open: "project.scopeOpen",
  closed: "project.scopeClosed",
  all: "project.scopeAll",
} satisfies Record<ProjectScope, Key>;

export default function Projects() {
  const { t } = useI18n();
  const { ws, canWrite } = useWorkspace();
  const projectStats = useProjectStats();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<ProjectSort>("name");
  const [scope, setScope] = useState<ProjectScope>("open");
  const rows = ws.projects.map((p): Row => {
    const stats = projectStats.get(p.id);
    const total = stats?.total ?? 0;
    const done = stats?.completed ?? 0;
    const touched = stats?.updated_at ? +new Date(stats.updated_at) : 0;
    return { p, total, done, ratio: total ? done / total : 0, touched };
  });
  const needle = q.trim().toLowerCase();
  const list = rows
    .filter(
      ({ p }) =>
        inScope(p.status, scope) &&
        (!needle || `${p.name} ${p.description}`.toLowerCase().includes(needle)),
    )
    .sort((a, b) => SORTS[sort].compare(a, b) || a.p.name.localeCompare(b.p.name));
  return (
    <Page>
      <PageHeader
        title={t("nav.projects")}
        icon={<FolderKanban className="size-4 text-muted-foreground" />}
        actions={
          canWrite && (
            <Button variant="primary" size="sm" onPress={() => setOpen(true)}>
              <Plus />
              {t("project.new")}
            </Button>
          )
        }
      >
        {ws.projects.length > 0 && (
          <div className="flex flex-wrap items-center gap-2 px-4 pb-2">
            <Tabs selectedKey={scope} onSelectionChange={(k) => setScope(k as ProjectScope)}>
              <TabList aria-label={t("project.scope")}>
                {Object.entries(SCOPES).map(([id, label]) => (
                  <Tab key={id} id={id} size="compact">
                    {t(label)}
                  </Tab>
                ))}
              </TabList>
            </Tabs>
            <SearchField
              aria-label={t("action.search")}
              placeholder={t("project.search")}
              value={q}
              onChange={setQ}
              className="w-full sm:w-56"
            />
            <MenuTrigger>
              <Button variant="ghost" size="sm">
                {t("sort.label")}: {t(SORTS[sort].label)}
              </Button>
              <MenuPopover placement="bottom start">
                <Menu
                  selectionMode="single"
                  selectedKeys={[sort]}
                  onAction={(k) => setSort(k as ProjectSort)}
                  aria-label={t("sort.label")}
                >
                  {Object.entries(SORTS).map(([id, { label }]) => (
                    <MenuItem key={id} id={id}>
                      {t(label)}
                    </MenuItem>
                  ))}
                </Menu>
              </MenuPopover>
            </MenuTrigger>
          </div>
        )}
      </PageHeader>
      <Scroll>
        {ws.projects.length === 0 ? (
          <EmptyState
            icon={<FolderKanban />}
            title={t("project.emptyTitle")}
            description={t("project.emptySub")}
            action={
              canWrite && (
                <Button variant="primary" onPress={() => setOpen(true)}>
                  {t("project.new")}
                </Button>
              )
            }
          />
        ) : list.length === 0 ? (
          <EmptyState
            icon={<FolderKanban />}
            title={t(
              needle || scope === "all"
                ? "project.noMatch"
                : scope === "open"
                  ? "project.noOpen"
                  : "project.noClosed",
            )}
            action={
              <div className="flex flex-wrap justify-center gap-2">
                {needle && <Button onPress={() => setQ("")}>{t("action.clearSearch")}</Button>}
                {scope !== "all" && (
                  <Button onPress={() => setScope("all")}>{t("project.showAll")}</Button>
                )}
              </div>
            }
          />
        ) : (
          <ul className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-3">
            {list.map(({ p, total, done }) => (
              <li key={p.id}>
                <ProjectCard project={p} total={total} done={done} />
              </li>
            ))}
          </ul>
        )}
      </Scroll>
      <Dialog title={t("project.new")} size="md" isOpen={open} onOpenChange={setOpen}>
        {(close) => <ProjectForm close={close} />}
      </Dialog>
    </Page>
  );
}

function ProjectCard({
  project: p,
  total,
  done,
}: {
  project: Project;
  total: number;
  done: number;
}) {
  const { t, lang } = useI18n();
  const { ws, member } = useWorkspace();
  const lead = p.lead_id ? member(p.lead_id) : undefined;
  return (
    <Link
      to={`/${ws.slug}/projects/${p.id}`}
      className="group block rounded-xl border border-border bg-card p-4 shadow-xs outline-none transition-colors hover:border-primary/40 hover:shadow-md focus-visible:ring-2 focus-visible:ring-ring/60"
    >
      <div className="flex items-start gap-2">
        <h2 className="min-w-0 flex-1 font-semibold tracking-tight group-hover:text-primary">
          {p.name}
        </h2>
        <ProjectStatusBadge status={p.status} />
      </div>
      <p className="mt-1 line-clamp-2 min-h-10  text-muted-foreground">
        {p.description || t("project.noDescription")}
      </p>
      <div className="mt-3 flex items-center gap-3  text-muted-foreground">
        <ProgressBar value={done} total={total} className="flex-1" label={p.name} />
        <span className="tabular-nums">
          {done}/{total}
        </span>
      </div>
      {(lead || p.health || p.target_date) && (
        <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1  text-muted-foreground">
          {p.health && <ProjectHealthLabel health={p.health} />}
          {lead && (
            <span className="flex min-w-0 items-center gap-1.5">
              <Avatar name={lead.display_name} src={lead.avatar_url} size={16} />
              <span className="sr-only">{t("project.leadBy", { name: lead.display_name })}</span>
              <span aria-hidden="true" className="truncate">
                {lead.display_name}
              </span>
            </span>
          )}
          {p.target_date && (
            <span className="flex items-center gap-1">
              <CalendarDays aria-hidden="true" className="size-3" />
              {t("project.targetOn", { date: fullDate(planDateTime(p.target_date), lang) })}
            </span>
          )}
        </div>
      )}
      <p className="mt-2 truncate  text-muted-foreground">
        {p.team_ids
          .map((id) => ws.teams.find((x) => x.id === id)?.name)
          .filter(Boolean)
          .join(", ") || t("project.allTeams")}
      </p>
    </Link>
  );
}

export function ProjectStatusBadge({ status }: { status: ProjectStatus }) {
  const { t } = useI18n();
  const info = PROJECT_STATUS[status];
  return <Badge tone={info.tone}>{t(info.label)}</Badge>;
}

export function ProjectHealthLabel({
  health,
  dotOnly,
}: {
  health: ProjectHealth;
  dotOnly?: boolean;
}) {
  const { t } = useI18n();
  const info = PROJECT_HEALTH[health];
  const dot = <span aria-hidden="true" className={cn("size-2 shrink-0 rounded-full", info.dot)} />;
  if (dotOnly) return dot;
  return (
    <span className="flex items-center gap-1.5">
      {dot}
      {t(info.label)}
    </span>
  );
}

export function ProjectForm({ project, close }: { project?: Project; close: () => void }) {
  const { t } = useI18n();
  const { ws, run } = useWorkspace();
  const [name, setName] = useState(project?.name ?? "");
  const [description, setDescription] = useState(project?.description ?? "");
  const [teams, setTeams] = useState<Id[]>(project?.team_ids ?? []);
  const { pending, error, guard } = usePending();
  useDialogDirty(
    name !== (project?.name ?? "") ||
      description !== (project?.description ?? "") ||
      teams.join() !== (project?.team_ids ?? []).join(),
  );
  return (
    <Form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        const body = { name: name.trim(), description: description.trim(), team_ids: teams };
        void guard(async () => {
          await (project
            ? run(
                { type: "update_project", id: project.id, ...body },
                {
                  quiet: true,
                  expectedVersions: error ? undefined : { [project.id]: project.version },
                },
              )
            : run({ type: "create_project", ...body }, { quiet: true }));
          close();
        });
      }}
    >
      <TextField label={t("field.name")} value={name} onChange={setName} autoFocus isRequired />
      <TextField
        label={t("field.description")}
        value={description}
        onChange={setDescription}
        multiline
        rows={3}
      />
      <fieldset>
        <legend className="mb-1.5  font-medium text-muted-foreground">{t("project.teams")}</legend>
        <div className="flex flex-col gap-2">
          {ws.teams.map((tm) => (
            <Checkbox
              key={tm.id}
              isSelected={teams.includes(tm.id)}
              onChange={(on) => setTeams(on ? [...teams, tm.id] : teams.filter((x) => x !== tm.id))}
            >
              {tm.name}
            </Checkbox>
          ))}
          {ws.teams.length === 0 && (
            <p className=" text-muted-foreground">{t("project.noTeams")}</p>
          )}
        </div>
      </fieldset>
      {error && (
        <p role="alert" className=" text-destructive">
          {error}
        </p>
      )}
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
