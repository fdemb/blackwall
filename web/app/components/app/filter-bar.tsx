import { useState } from "react";
import { Form } from "react-aria-components";
import { Bookmark, LayoutList, ListFilter, X } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Dialog } from "~/components/ui/dialog";
import { TextField } from "~/components/ui/field";
import { Switch } from "~/components/ui/toggles";
import { Menu, MenuItem, MenuPopover, MenuTrigger, MenuSeparator, MenuSection, Header } from "~/components/ui/menu";
import { Avatar } from "~/components/ui/avatar";
import { useToast } from "~/components/ui/toast";
import { PRIORITIES } from "~/lib/format";
import { useT } from "~/lib/i18n";
import { useWorkspace } from "~/lib/workspace";
import type { IssueFilter, IssueSort } from "~/lib/types";
import { PriorityIcon } from "./icons";
import { LabelDot } from "./pickers";
import type { GroupBy } from "./issue-list";
import { SearchField } from "~/components/ui/field";

export function FilterBar({
  filter, onChange, hide = [], groupBy, onGroupBy, saveable = true,
}: { filter: IssueFilter; onChange: (f: IssueFilter) => void; hide?: (keyof IssueFilter)[]; groupBy?: GroupBy; onGroupBy?: (g: GroupBy) => void; saveable?: boolean }) {
  const t = useT();
  const { ws, members, run, canWrite } = useWorkspace();
  const toast = useToast();
  const [saving, setSaving] = useState(false);
  const set = (patch: Partial<IssueFilter>) => onChange({ ...filter, ...patch });
  const clear = (k: keyof IssueFilter) => { const n = { ...filter }; delete n[k]; onChange(n); };
  const active = (["assignee", "priority", "label_id", "project_id", "sprint_id", "due_before", "team_id"] as const).filter((k) => filter[k] && !hide.includes(k));
  const sprints = ws.sprints.filter((s) => (!filter.team_id || s.team_id === filter.team_id) && s.state !== "archived");

  const chipLabel = (k: (typeof active)[number]) => {
    switch (k) {
      case "assignee": return members.find((m) => m.id === filter.assignee)?.display_name ?? "?";
      case "priority": return t(`priority.${filter.priority!}`);
      case "label_id": return ws.labels.find((l) => l.id === filter.label_id)?.name ?? "?";
      case "project_id": return ws.projects.find((p) => p.id === filter.project_id)?.name ?? "?";
      case "sprint_id": return ws.sprints.find((s) => s.id === filter.sprint_id)?.name ?? "?";
      case "team_id": return ws.teams.find((x) => x.id === filter.team_id)?.name ?? "?";
      case "due_before": return `${t("filter.dueBefore")} ${new Date(filter.due_before!).toLocaleDateString()}`;
    }
  };

  return (
    <div className="flex flex-wrap items-center gap-1.5 px-4 pb-2">
      <SearchField aria-label={t("action.search")} placeholder={t("filter.search")} value={filter.search ?? ""} onChange={(v) => set({ search: v || undefined })} className="w-48" />
      <MenuTrigger>
        <Button variant="secondary" size="sm"><ListFilter />{t("filter.add")}</Button>
        <MenuPopover placement="bottom start">
          <Menu onAction={(k) => {
            const [kind, value] = String(k).split(":");
            if (kind === "assignee") set({ assignee: value });
            if (kind === "priority") set({ priority: value as never });
            if (kind === "label") set({ label_id: value });
            if (kind === "project") set({ project_id: value });
            if (kind === "sprint") set({ sprint_id: value });
            if (kind === "team") set({ team_id: value });
            if (kind === "due") set({ due_before: new Date(Date.now() + Number(value) * 86400000).toISOString() });
          }}>
            {!hide.includes("assignee") && (
              <MenuSection>
                <Header className="px-2 py-1 text-[11px] font-medium text-muted-foreground">{t("field.assignee")}</Header>
                {members.map((m) => <MenuItem key={m.id} id={`assignee:${m.id}`} textValue={m.display_name}><Avatar name={m.display_name} src={m.avatar_url} size={16} />{m.display_name}</MenuItem>)}
              </MenuSection>
            )}
            {!hide.includes("priority") && (
              <MenuSection>
                <MenuSeparator />
                <Header className="px-2 py-1 text-[11px] font-medium text-muted-foreground">{t("field.priority")}</Header>
                {PRIORITIES.map((p) => <MenuItem key={p} id={`priority:${p}`} textValue={t(`priority.${p}`)}><PriorityIcon priority={p} />{t(`priority.${p}`)}</MenuItem>)}
              </MenuSection>
            )}
            {!hide.includes("label_id") && ws.labels.length > 0 && (
              <MenuSection>
                <MenuSeparator />
                <Header className="px-2 py-1 text-[11px] font-medium text-muted-foreground">{t("field.labels")}</Header>
                {ws.labels.map((l) => <MenuItem key={l.id} id={`label:${l.id}`} textValue={l.name}><LabelDot color={l.color} />{l.name}</MenuItem>)}
              </MenuSection>
            )}
            {!hide.includes("project_id") && ws.projects.length > 0 && (
              <MenuSection>
                <MenuSeparator />
                <Header className="px-2 py-1 text-[11px] font-medium text-muted-foreground">{t("field.project")}</Header>
                {ws.projects.map((p) => <MenuItem key={p.id} id={`project:${p.id}`} textValue={p.name}>{p.name}</MenuItem>)}
              </MenuSection>
            )}
            {!hide.includes("sprint_id") && sprints.length > 0 && (
              <MenuSection>
                <MenuSeparator />
                <Header className="px-2 py-1 text-[11px] font-medium text-muted-foreground">{t("field.sprint")}</Header>
                {sprints.map((s) => <MenuItem key={s.id} id={`sprint:${s.id}`} textValue={s.name}>{s.name}</MenuItem>)}
              </MenuSection>
            )}
            {!hide.includes("team_id") && (
              <MenuSection>
                <MenuSeparator />
                <Header className="px-2 py-1 text-[11px] font-medium text-muted-foreground">{t("field.team")}</Header>
                {ws.teams.map((x) => <MenuItem key={x.id} id={`team:${x.id}`} textValue={x.name}>{x.name}</MenuItem>)}
              </MenuSection>
            )}
            {!hide.includes("due_before") && (
              <MenuSection>
                <MenuSeparator />
                <Header className="px-2 py-1 text-[11px] font-medium text-muted-foreground">{t("field.deadline")}</Header>
                {[[0, "filter.today"], [7, "filter.week"], [30, "filter.month"]].map(([d, k]) => <MenuItem key={k} id={`due:${d}`}>{t(k as never)}</MenuItem>)}
              </MenuSection>
            )}
          </Menu>
        </MenuPopover>
      </MenuTrigger>
      {active.map((k) => (
        <span key={k} className="inline-flex h-7 items-center gap-1 rounded-md bg-accent pl-2.5 pr-1 text-xs font-medium text-accent-foreground">
          {chipLabel(k)}
          <button type="button" aria-label={t("action.remove")} onClick={() => clear(k)} className="grid size-5 place-items-center rounded hover:bg-primary/15"><X className="size-3" /></button>
        </span>
      ))}
      <div className="ml-auto flex items-center gap-1.5">
        {onGroupBy && groupBy && (
          <MenuTrigger>
            <Button variant="ghost" size="sm"><LayoutList />{t(`group.${groupBy}`)}</Button>
            <MenuPopover placement="bottom end">
              <Menu selectionMode="single" selectedKeys={[groupBy]} onAction={(k) => onGroupBy(k as GroupBy)}>
                {(["stage", "priority", "assignee", "none"] as const).map((g) => <MenuItem key={g} id={g}>{t(`group.${g}`)}</MenuItem>)}
              </Menu>
            </MenuPopover>
          </MenuTrigger>
        )}
        <MenuTrigger>
          <Button variant="ghost" size="sm">{t("sort.label")}: {t(`sort.${filter.sort ?? "position"}`)}</Button>
          <MenuPopover placement="bottom end">
            <Menu selectionMode="single" selectedKeys={[filter.sort ?? "position"]} onAction={(k) => set({ sort: k as IssueSort })}>
              {(["position", "priority", "deadline", "updated"] as const).map((s) => <MenuItem key={s} id={s}>{t(`sort.${s}`)}</MenuItem>)}
            </Menu>
          </MenuPopover>
        </MenuTrigger>
        {saveable && canWrite && (
          <>
            <Button variant="ghost" size="sm" onPress={() => setSaving(true)}><Bookmark />{t("view.save")}</Button>
            <Dialog title={t("view.save")} description={t("view.saveSub")} size="sm" isOpen={saving} onOpenChange={setSaving}>
              {(close) => <SaveViewForm close={close} filter={filter} run={run} toast={toast} />}
            </Dialog>
          </>
        )}
      </div>
    </div>
  );
}

function SaveViewForm({ close, filter, run, toast }: { close: () => void; filter: IssueFilter; run: ReturnType<typeof useWorkspace>["run"]; toast: ReturnType<typeof useToast> }) {
  const t = useT();
  const [name, setName] = useState("");
  const [shared, setShared] = useState(false);
  return (
    <Form className="flex flex-col gap-4" onSubmit={async (e) => {
      e.preventDefault();
      const clean = { ...filter, trash: false };
      await run({ type: "save_view", name: name.trim(), shared, filter: clean }).then(() => { toast.show(t("view.saved")); close(); }).catch(() => {});
    }}>
      <TextField label={t("field.name")} value={name} onChange={setName} autoFocus isRequired />
      <Switch isSelected={shared} onChange={setShared}>{t("view.share")}</Switch>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onPress={close}>{t("action.cancel")}</Button>
        <Button type="submit" variant="primary" isDisabled={!name.trim()}>{t("action.save")}</Button>
      </div>
    </Form>
  );
}
