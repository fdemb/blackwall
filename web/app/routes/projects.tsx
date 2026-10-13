import { useState } from "react";
import { Form } from "react-aria-components";
import { Link } from "react-router";
import { FolderKanban, Plus } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Dialog, useDialogDirty } from "~/components/ui/dialog";
import { SearchField, TextField } from "~/components/ui/field";
import { Menu, MenuItem, MenuPopover, MenuTrigger } from "~/components/ui/menu";
import { Checkbox } from "~/components/ui/toggles";
import { EmptyState, Page, PageHeader, Scroll } from "~/components/app/page";
import { ProgressBar } from "~/components/app/progress";
import { useI18n } from "~/lib/i18n";
import { usePending } from "~/lib/use-pending";
import { useProjectStats } from "~/lib/stats";
import { useWorkspace } from "~/lib/workspace";
import type { Id, Project } from "~/lib/types";

type ProjectSort = "name" | "progress" | "recent";

export default function Projects() {
  const { t } = useI18n();
  const { ws, canWrite } = useWorkspace();
  const projectStats = useProjectStats();
  const [open, setOpen] = useState(false);
  const [q, setQ] = useState("");
  const [sort, setSort] = useState<ProjectSort>("name");
  const rows = ws.projects.map((p) => {
    const stats = projectStats.get(p.id);
    const total = stats?.total ?? 0;
    const done = stats?.completed ?? 0;
    const touched = stats?.updated_at ? +new Date(stats.updated_at) : 0;
    return { p, total, done, ratio: total ? done / total : 0, touched };
  });
  const needle = q.trim().toLowerCase();
  const list = rows
    .filter(({ p }) => !needle || `${p.name} ${p.description}`.toLowerCase().includes(needle))
    .sort(
      (a, b) =>
        (sort === "progress" ? b.ratio - a.ratio : sort === "recent" ? b.touched - a.touched : 0) ||
        a.p.name.localeCompare(b.p.name),
    );
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
        {ws.projects.length > 1 && (
          <div className="flex flex-wrap items-center gap-2 px-4 pb-2">
            <SearchField
              aria-label={t("action.search")}
              placeholder={t("project.search")}
              value={q}
              onChange={setQ}
              className="w-full sm:w-56"
            />
            <MenuTrigger>
              <Button variant="ghost" size="sm">
                {t("sort.label")}:{" "}
                {t(
                  sort === "name"
                    ? "project.sortName"
                    : sort === "progress"
                      ? "project.sortProgress"
                      : "project.sortRecent",
                )}
              </Button>
              <MenuPopover placement="bottom start">
                <Menu
                  selectionMode="single"
                  selectedKeys={[sort]}
                  onAction={(k) => setSort(k as ProjectSort)}
                  aria-label={t("sort.label")}
                >
                  <MenuItem id="name">{t("project.sortName")}</MenuItem>
                  <MenuItem id="progress">{t("project.sortProgress")}</MenuItem>
                  <MenuItem id="recent">{t("project.sortRecent")}</MenuItem>
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
            title={t("project.noMatch")}
            action={<Button onPress={() => setQ("")}>{t("action.clearSearch")}</Button>}
          />
        ) : (
          <ul className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-3">
            {list.map(({ p, total, done }) => {
              return (
                <li key={p.id}>
                  <Link
                    to={`/${ws.id}/projects/${p.id}`}
                    className="group block rounded-xl border border-border bg-card p-4 shadow-xs outline-none transition-colors hover:border-primary/40 hover:shadow-md focus-visible:ring-2 focus-visible:ring-ring/60"
                  >
                    <h2 className="font-semibold tracking-tight group-hover:text-primary">
                      {p.name}
                    </h2>
                    <p className="mt-1 line-clamp-2 min-h-10  text-muted-foreground">
                      {p.description || t("project.noDescription")}
                    </p>
                    <div className="mt-3 flex items-center gap-3  text-muted-foreground">
                      <ProgressBar value={done} total={total} className="flex-1" label={p.name} />
                      <span className="tabular-nums">
                        {done}/{total}
                      </span>
                    </div>
                    <p className="mt-2 truncate  text-muted-foreground">
                      {p.team_ids
                        .map((id) => ws.teams.find((x) => x.id === id)?.name)
                        .filter(Boolean)
                        .join(", ") || t("project.allTeams")}
                    </p>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </Scroll>
      <Dialog title={t("project.new")} size="md" isOpen={open} onOpenChange={setOpen}>
        {(close) => <ProjectForm close={close} />}
      </Dialog>
    </Page>
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
