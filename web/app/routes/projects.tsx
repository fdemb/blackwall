import { useState } from "react";
import { Form } from "react-aria-components";
import { Link } from "react-router";
import { FolderKanban, Plus } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Dialog } from "~/components/ui/dialog";
import { TextField } from "~/components/ui/field";
import { Checkbox } from "~/components/ui/toggles";
import { EmptyState, Page, PageHeader, Scroll } from "~/components/app/page";
import { ProgressBar } from "~/components/app/progress";
import { isDone } from "~/lib/filters";
import { useT } from "~/lib/i18n";
import { useWorkspace } from "~/lib/workspace";
import type { Id, Project } from "~/lib/types";

export default function Projects() {
  const t = useT();
  const { ws, canWrite } = useWorkspace();
  const [open, setOpen] = useState(false);
  return (
    <Page>
      <PageHeader title={t("nav.projects")} icon={<FolderKanban className="size-4 text-muted-foreground" />} actions={canWrite && <Button variant="primary" size="sm" onPress={() => setOpen(true)}><Plus />{t("project.new")}</Button>} />
      <Scroll>
        {ws.projects.length === 0 ? (
          <EmptyState icon={<FolderKanban />} title={t("project.emptyTitle")} description={t("project.emptySub")} action={canWrite && <Button variant="primary" onPress={() => setOpen(true)}>{t("project.new")}</Button>} />
        ) : (
          <ul className="grid gap-3 p-4 sm:grid-cols-2 xl:grid-cols-3">
            {ws.projects.map((p) => {
              const issues = ws.issues.filter((i) => i.project_id === p.id && !i.deleted_at);
              const done = issues.filter((i) => isDone(ws, i)).length;
              return (
                <li key={p.id}>
                  <Link to={`/${ws.id}/projects/${p.id}`} className="group block rounded-xl border border-border bg-card p-4 shadow-xs outline-none transition hover:border-primary/40 hover:shadow-md focus-visible:ring-2 focus-visible:ring-ring/60">
                    <h2 className="font-semibold tracking-tight group-hover:text-primary">{p.name}</h2>
                    <p className="mt-1 line-clamp-2 min-h-10 text-[13px] text-muted-foreground">{p.description || t("project.noDescription")}</p>
                    <div className="mt-3 flex items-center gap-3 text-xs text-muted-foreground">
                      <ProgressBar value={done} total={issues.length} className="flex-1" label={p.name} />
                      <span className="tabular-nums">{done}/{issues.length}</span>
                    </div>
                    <p className="mt-2 truncate text-xs text-muted-foreground">{p.team_ids.map((id) => ws.teams.find((x) => x.id === id)?.name).filter(Boolean).join(", ") || t("project.allTeams")}</p>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </Scroll>
      <Dialog title={t("project.new")} size="md" isOpen={open} onOpenChange={setOpen}>{(close) => <ProjectForm close={close} />}</Dialog>
    </Page>
  );
}

export function ProjectForm({ project, close }: { project?: Project; close: () => void }) {
  const t = useT();
  const { ws, run } = useWorkspace();
  const [name, setName] = useState(project?.name ?? "");
  const [description, setDescription] = useState(project?.description ?? "");
  const [teams, setTeams] = useState<Id[]>(project?.team_ids ?? []);
  return (
    <Form className="flex flex-col gap-4" onSubmit={async (e) => {
      e.preventDefault();
      const body = { name: name.trim(), description: description.trim(), team_ids: teams };
      await (project ? run({ type: "update_project", id: project.id, ...body }) : run({ type: "create_project", ...body })).then(close).catch(() => {});
    }}>
      <TextField label={t("field.name")} value={name} onChange={setName} autoFocus isRequired />
      <TextField label={t("field.description")} value={description} onChange={setDescription} multiline rows={3} />
      <fieldset>
        <legend className="mb-1.5 text-xs font-medium text-muted-foreground">{t("project.teams")}</legend>
        <div className="flex flex-col gap-2">
          {ws.teams.map((tm) => (
            <Checkbox key={tm.id} isSelected={teams.includes(tm.id)} onChange={(on) => setTeams(on ? [...teams, tm.id] : teams.filter((x) => x !== tm.id))}>{tm.name}</Checkbox>
          ))}
          {ws.teams.length === 0 && <p className="text-xs text-muted-foreground">{t("project.noTeams")}</p>}
        </div>
      </fieldset>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onPress={close}>{t("action.cancel")}</Button>
        <Button type="submit" variant="primary" isDisabled={!name.trim()}>{t("action.save")}</Button>
      </div>
    </Form>
  );
}
