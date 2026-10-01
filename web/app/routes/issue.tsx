import { useEffect, useRef, useState } from "react";
import { FileTrigger, Form } from "react-aria-components";
import { Link, Navigate, useNavigate, useParams } from "react-router";
import {
  Bell, BellOff, ChevronLeft, Clock, Download, ExternalLink, FileText, Link2, Lock, MoreHorizontal, Paperclip, Pencil, Plus, Trash2, X,
} from "lucide-react";
import { Avatar } from "~/components/ui/avatar";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { DatePicker } from "~/components/ui/date-picker";
import { Dialog } from "~/components/ui/dialog";
import { Input, TextField } from "~/components/ui/field";
import { Menu, MenuItem, MenuPopover, MenuTrigger } from "~/components/ui/menu";
import { useToast } from "~/components/ui/toast";
import { Markdown, MarkdownEditor, mentionsIn } from "~/components/app/markdown";
import { IssuePicker } from "~/components/app/issue-picker";
import { StageIcon } from "~/components/app/icons";
import { TimeForm } from "~/components/app/time-form";
import { AssigneePicker, LabelsPicker, NullableSelect, PriorityPicker, StagePicker } from "~/components/app/pickers";
import { EmptyState, Page } from "~/components/app/page";
import { isDone, stageOf } from "~/lib/filters";
import { bytes, formatMinutes, fullDate, issueKey, parseMinutes, relativeTime } from "~/lib/format";
import { useI18n } from "~/lib/i18n";
import { useWorkspace } from "~/lib/workspace";
import { cn } from "~/lib/utils";
import type { Comment, Id, Issue, IssuePatch, TimeEntry } from "~/lib/types";

export default function IssuePage() {
  const { issueId, ws: wsId } = useParams();
  const { issue: find, ws } = useWorkspace();
  const t = useI18n().t;
  const issue = find(issueId!);
  if (!issue || issue.deleted_at)
    return issue?.deleted_at ? (
      <Page><EmptyState icon={<Trash2 />} title={t("issue.deleted")} description={t("issue.deletedSub")} action={<Link className="text-primary hover:underline" to={`/${wsId}/trash`}>{t("nav.trash")}</Link>} /></Page>
    ) : (
      <Navigate to={`/${ws.id}/my-issues`} replace />
    );
  return <IssueView key={issue.id} issue={issue} />;
}

function IssueView({ issue }: { issue: Issue }) {
  const { t, lang } = useI18n();
  const nav = useNavigate();
  const toast = useToast();
  const { ws, me, run, team, canWrite, member } = useWorkspace();
  const tm = team(issue.team_id);
  const patch = (p: IssuePatch) => run({ type: "update_issue", id: issue.id, patch: p }).catch(() => {});
  const following = issue.followers.includes(me);
  const subs = ws.issues.filter((i) => i.parent_id === issue.id && !i.deleted_at);
  const parent = ws.issues.find((i) => i.id === issue.parent_id);
  const projectMilestones = ws.milestones.filter((m) => m.project_id === issue.project_id);
  const sprints = ws.sprints.filter((s) => s.team_id === issue.team_id && (s.state === "planned" || s.state === "active" || s.id === issue.sprint_id));
  const [title, setTitle] = useState(issue.title);
  useEffect(() => setTitle(issue.title), [issue.title]);
  const [confirm, setConfirm] = useState(false);
  const loggedTotal = ws.time_entries.filter((e) => e.issue_id === issue.id).reduce((a, e) => a + e.minutes, 0);

  return (
    <Page className="overflow-hidden">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4">
        <Link to={`/${ws.id}/team/${issue.team_id}?layout=list`} aria-label={t("action.back")} className="-ml-1 grid size-7 place-items-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"><ChevronLeft className="size-4" /></Link>
        <span className="text-[13px] text-muted-foreground">{tm?.name}</span>
        <span className="text-muted-foreground/50">/</span>
        <span className="text-[13px] font-medium tabular-nums">{issueKey(issue.number)}</span>
        <div className="ml-auto flex items-center gap-1">
          <Button variant="ghost" size="sm" onPress={() => run({ type: "follow", issue_id: issue.id, following: !following }).catch(() => {})}>
            {following ? <BellOff /> : <Bell />}{following ? t("issue.unfollow") : t("issue.follow")}
          </Button>
          <MenuTrigger>
            <Button variant="ghost" size="icon-lg" aria-label={t("action.more")}><MoreHorizontal /></Button>
            <MenuPopover placement="bottom end">
              <Menu onAction={(k) => {
                if (k === "copy") navigator.clipboard.writeText(location.href).then(() => toast.show(t("issue.linkCopied")));
                if (k === "delete") setConfirm(true);
              }}>
                <MenuItem id="copy"><Link2 />{t("issue.copyLink")}</MenuItem>
                {canWrite && <MenuItem id="delete"><Trash2 />{t("action.delete")}</MenuItem>}
              </Menu>
            </MenuPopover>
          </MenuTrigger>
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col overflow-y-auto lg:flex-row lg:overflow-visible">
        <div className="min-w-0 flex-1 lg:overflow-y-auto">
          <div className="mx-auto max-w-3xl space-y-8 px-6 py-8">
            {parent && (
              <Link to={`/${ws.id}/issue/${parent.id}`} className="inline-flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground">
                <span className="tabular-nums">{issueKey(parent.number)}</span><span className="truncate">{parent.title}</span>
              </Link>
            )}
            <input
              aria-label={t("field.title")}
              value={title}
              readOnly={!canWrite}
              maxLength={200}
              onChange={(e) => setTitle(e.target.value)}
              onBlur={() => title.trim() && title !== issue.title && patch({ title: title.trim() })}
              onKeyDown={(e) => { if (e.key === "Enter") (e.target as HTMLInputElement).blur(); if (e.key === "Escape") setTitle(issue.title); }}
              className="-mx-2 block w-[calc(100%+1rem)] rounded-md bg-transparent px-2 py-1 text-2xl font-semibold tracking-tight outline-none hover:bg-muted/60 focus:bg-muted/60 focus:ring-2 focus:ring-ring/40"
            />
            <Description issue={issue} onSave={(description) => patch({ description })} />
            <Subtasks issue={issue} subs={subs} />
            <Dependencies issue={issue} />
            <Attachments issue={issue} />
            <TimeSection issue={issue} total={loggedTotal} />
            <Discussion issue={issue} />
            <IssueActivity issue={issue} />
          </div>
        </div>

        <aside aria-label={t("issue.properties")} className="w-full shrink-0 space-y-1 border-t border-border p-4 lg:w-72 lg:overflow-y-auto lg:border-l lg:border-t-0">
          <Prop label={t("field.stage")}><StagePicker variant="ghost" isDisabled={!canWrite} teamId={issue.team_id} value={issue.stage_id} onChange={(id) => patch({ stage_id: id })} /></Prop>
          <Prop label={t("field.priority")}><PriorityPicker variant="ghost" isDisabled={!canWrite} value={issue.priority} onChange={(priority) => patch({ priority })} /></Prop>
          <Prop label={t("field.assignee")}>
            <AssigneePicker variant="ghost" isDisabled={!canWrite} teamId={issue.team_id} value={issue.assignee} onChange={(id) => patch(id ? { assignee: id } : { clear_assignee: true })} />
          </Prop>
          <Prop label={t("field.labels")}><LabelsPicker isDisabled={!canWrite} value={issue.labels} onChange={(labels) => patch({ labels })} /></Prop>
          <Prop label={t("field.deadline")}>
            <DatePicker variant="ghost" isDisabled={!canWrite} placeholder={t("deadline.none")} value={issue.deadline} onChange={(d) => patch(d ? { deadline: d } : { clear_deadline: true })} />
          </Prop>
          <Prop label={t("field.estimate")}>
            <EstimateField value={issue.estimate} disabled={!canWrite} onCommit={(v) => patch(v === null ? { clear_estimate: true } : { estimate: v })} />
          </Prop>
          <div className="my-3 h-px bg-border" />
          <Prop label={t("field.project")}>
            <NullableSelect variant="ghost" isDisabled={!canWrite} noneLabel={t("project.none")} value={issue.project_id} options={ws.projects.map((p) => ({ id: p.id, label: p.name }))}
              onChange={(id) => patch(id ? { project_id: id, clear_milestone: true } : { clear_project: true, clear_milestone: true })} />
          </Prop>
          {issue.project_id && (
            <Prop label={t("field.milestone")}>
              <NullableSelect variant="ghost" isDisabled={!canWrite} noneLabel={t("milestone.none")} value={issue.milestone_id} options={projectMilestones.map((m) => ({ id: m.id, label: m.name }))}
                onChange={(id) => patch(id ? { milestone_id: id } : { clear_milestone: true })} />
            </Prop>
          )}
          <Prop label={t("field.sprint")}>
            <NullableSelect variant="ghost" isDisabled={!canWrite} noneLabel={t("sprint.none")} value={issue.sprint_id} options={sprints.map((s) => ({ id: s.id, label: s.name }))}
              onChange={(id) => patch(id ? { sprint_id: id } : { clear_sprint: true })} />
          </Prop>
          <Prop label={t("issue.parent")}>
            {parent ? (
              <div className="flex items-center gap-1 px-2 py-1 text-[13px]">
                <Link to={`/${ws.id}/issue/${parent.id}`} className="min-w-0 flex-1 truncate hover:underline"><span className="tabular-nums text-muted-foreground">{issueKey(parent.number)}</span> {parent.title}</Link>
                {canWrite && <Button variant="ghost" size="icon" aria-label={t("action.remove")} onPress={() => patch({ clear_parent: true })}><X /></Button>}
              </div>
            ) : (
              <IssuePicker exclude={[issue.id, ...subs.map((s) => s.id)]} onPick={(id) => patch({ parent_id: id })} trigger={<Button variant="ghost" isDisabled={!canWrite} className="h-7 w-full justify-start px-2 font-normal text-muted-foreground"><Plus />{t("issue.setParent")}</Button>} />
            )}
          </Prop>
          {issue.source_links.length > 0 && (
            <>
              <div className="my-3 h-px bg-border" />
              <Prop label={t("issue.sourceLinks")}>
                <ul className="space-y-1 px-2">
                  {issue.source_links.map((l) => (
                    <li key={l.url}><a href={l.url} target="_blank" rel="noreferrer noopener" className="flex items-center gap-1.5 text-[13px] text-primary hover:underline"><ExternalLink className="size-3.5 shrink-0" /><span className="truncate">{l.title || l.url}</span></a></li>
                  ))}
                </ul>
              </Prop>
            </>
          )}
          <div className="my-3 h-px bg-border" />
          <dl className="space-y-1 px-2 text-xs text-muted-foreground">
            <div className="flex justify-between"><dt>{t("issue.created")}</dt><dd>{fullDate(issue.created_at, lang)}</dd></div>
            <div className="flex justify-between"><dt>{t("issue.updated")}</dt><dd>{relativeTime(issue.updated_at, lang)}</dd></div>
            {issue.followers.length > 0 && (
              <div className="flex items-center justify-between"><dt>{t("issue.followers")}</dt>
                <dd className="flex -space-x-1">{issue.followers.slice(0, 5).map((f) => { const m = member(f); return m ? <Avatar key={f} name={m.display_name} src={m.avatar_url} size={16} className="ring-2 ring-background" /> : null; })}</dd>
              </div>
            )}
          </dl>
        </aside>
      </div>

      <Dialog title={t("issue.deleteTitle")} description={t("issue.deleteSub")} size="sm" isOpen={confirm} onOpenChange={setConfirm}>
        {(close) => (
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onPress={close}>{t("action.cancel")}</Button>
            <Button variant="destructive" onPress={() => run({ type: "delete_issue", id: issue.id }).then(() => { close(); toast.show(t("issue.movedToTrash")); nav(`/${ws.id}/team/${issue.team_id}?layout=list`); }).catch(() => {})}>{t("action.delete")}</Button>
          </div>
        )}
      </Dialog>
    </Page>
  );
}

function Prop({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[84px_1fr] items-center gap-1">
      <span className="px-2 text-xs text-muted-foreground">{label}</span>
      <div className="min-w-0">{children}</div>
    </div>
  );
}

function EstimateField({ value, disabled, onCommit }: { value: number | null; disabled: boolean; onCommit: (v: number | null) => void }) {
  const t = useI18n().t;
  const [v, setV] = useState(value?.toString() ?? "");
  useEffect(() => setV(value?.toString() ?? ""), [value]);
  return (
    <Input
      aria-label={t("field.estimate")}
      type="number"
      min={0}
      max={1000}
      disabled={disabled}
      value={v}
      placeholder={t("estimate.none")}
      onChange={(e) => setV(e.target.value)}
      onBlur={() => { const n = v === "" ? null : Number(v); if (n !== value) onCommit(n); }}
      className="h-7 border-transparent bg-transparent shadow-none hover:bg-muted focus:bg-card"
    />
  );
}

function Section({ title, icon, action, children }: { title: string; icon?: React.ReactNode; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section>
      <div className="mb-2 flex items-center gap-2">
        {icon}
        <h2 className="text-[13px] font-semibold">{title}</h2>
        <div className="ml-auto">{action}</div>
      </div>
      {children}
    </section>
  );
}

function Description({ issue, onSave }: { issue: Issue; onSave: (d: string) => void }) {
  const t = useI18n().t;
  const { canWrite } = useWorkspace();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(issue.description);
  if (editing)
    return (
      <div className="space-y-2">
        <MarkdownEditor label={t("field.description")} value={draft} onChange={setDraft} autoFocus minRows={8} onSubmit={() => { onSave(draft); setEditing(false); }} />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onPress={() => { setDraft(issue.description); setEditing(false); }}>{t("action.cancel")}</Button>
          <Button variant="primary" onPress={() => { onSave(draft); setEditing(false); }}>{t("action.save")}</Button>
        </div>
      </div>
    );
  return (
    <div
      role={canWrite ? "button" : undefined}
      tabIndex={canWrite ? 0 : undefined}
      aria-label={canWrite ? t("issue.editDescription") : undefined}
      onClick={(e) => { if (canWrite && !(e.target as HTMLElement).closest("a")) { setDraft(issue.description); setEditing(true); } }}
      onKeyDown={(e) => { if (canWrite && e.key === "Enter") { setDraft(issue.description); setEditing(true); } }}
      className={cn("-mx-3 min-h-16 rounded-lg px-3 py-2 outline-none", canWrite && "cursor-text hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring/50")}
    >
      <Markdown text={issue.description} empty={canWrite ? t("issue.addDescription") : t("issue.noDescription")} />
    </div>
  );
}

function Subtasks({ issue, subs }: { issue: Issue; subs: Issue[] }) {
  const { t } = useI18n();
  const { ws, run, canWrite } = useWorkspace();
  const [adding, setAdding] = useState(false);
  const [title, setTitle] = useState("");
  const done = subs.filter((s) => isDone(ws, s)).length;
  const submit = async () => {
    if (!title.trim()) return setAdding(false);
    const first = [...(ws.teams.find((x) => x.id === issue.team_id)?.stages ?? [])].sort((a, b) => a.position - b.position)[0];
    await run({ type: "create_issue", input: { title: title.trim(), team_id: issue.team_id, stage_id: first?.id, parent_id: issue.id, project_id: issue.project_id, sprint_id: issue.sprint_id } }).catch(() => {});
    setTitle("");
  };
  if (!subs.length && !canWrite) return null;
  return (
    <Section title={t("issue.subtasks")} action={subs.length > 0 && <span className="text-xs tabular-nums text-muted-foreground">{done}/{subs.length}</span>}>
      {subs.length > 0 && (
        <div className="mb-2 h-1 overflow-hidden rounded-full bg-border"><div className="h-full rounded-full bg-primary transition-[width]" style={{ width: `${(done / subs.length) * 100}%` }} /></div>
      )}
      <ul className="divide-y divide-border/70 rounded-lg border border-border">
        {subs.map((s) => {
          const st = stageOf(ws, s);
          return (
            <li key={s.id}>
              <Link to={`/${ws.id}/issue/${s.id}`} className="flex h-9 items-center gap-2.5 px-3 text-[13px] hover:bg-muted/60">
                {st && <StageIcon kind={st.kind} />}
                <span className="w-14 tabular-nums text-muted-foreground">{issueKey(s.number)}</span>
                <span className={cn("flex-1 truncate", isDone(ws, s) && "text-muted-foreground line-through")}>{s.title}</span>
              </Link>
            </li>
          );
        })}
        {canWrite && (
          <li>
            {adding ? (
              <Form className="flex items-center gap-2 px-3 py-1.5" onSubmit={(e) => { e.preventDefault(); void submit(); }}>
                <Input autoFocus aria-label={t("issue.subtaskTitle")} value={title} onChange={(e) => setTitle(e.target.value)} onKeyDown={(e) => e.key === "Escape" && setAdding(false)} placeholder={t("issue.subtaskPlaceholder")} className="h-7 border-0 shadow-none focus:ring-0" />
                <Button type="submit" size="sm" variant="subtle">{t("action.add")}</Button>
              </Form>
            ) : (
              <button type="button" onClick={() => setAdding(true)} className="flex h-9 w-full items-center gap-2 px-3 text-[13px] text-muted-foreground hover:bg-muted/60 hover:text-foreground"><Plus className="size-3.5" />{t("issue.addSubtask")}</button>
            )}
          </li>
        )}
      </ul>
    </Section>
  );
}

function Dependencies({ issue }: { issue: Issue }) {
  const t = useI18n().t;
  const { ws, run, canWrite } = useWorkspace();
  const blockers = issue.dependencies.map((id) => ws.issues.find((i) => i.id === id)).filter((i): i is Issue => Boolean(i && !i.deleted_at));
  const blocking = ws.issues.filter((i) => !i.deleted_at && i.dependencies.includes(issue.id));
  const set = (dependencies: Id[]) => run({ type: "update_issue", id: issue.id, patch: { dependencies } }).catch(() => {});
  if (!blockers.length && !blocking.length && !canWrite) return null;
  return (
    <Section
      title={t("issue.dependencies")}
      icon={<Lock className="size-3.5 text-muted-foreground" />}
      action={canWrite && <IssuePicker exclude={[issue.id, ...issue.dependencies]} onPick={(id) => set([...issue.dependencies, id])} trigger={<Button variant="ghost" size="sm"><Plus />{t("issue.addBlocker")}</Button>} />}
    >
      {blockers.length === 0 && blocking.length === 0 && <p className="text-[13px] text-muted-foreground">{t("issue.noDependencies")}</p>}
      <ul className="space-y-1">
        {blockers.map((b) => (
          <li key={b.id} className="flex items-center gap-2 text-[13px]">
            <Badge tone={isDone(ws, b) ? "success" : "danger"}>{isDone(ws, b) ? t("issue.resolved") : t("issue.blockedBy")}</Badge>
            <Link to={`/${ws.id}/issue/${b.id}`} className="min-w-0 flex-1 truncate hover:underline"><span className="tabular-nums text-muted-foreground">{issueKey(b.number)}</span> {b.title}</Link>
            {canWrite && <Button variant="ghost" size="icon" aria-label={t("action.remove")} onPress={() => set(issue.dependencies.filter((d) => d !== b.id))}><X /></Button>}
          </li>
        ))}
        {blocking.map((b) => (
          <li key={b.id} className="flex items-center gap-2 text-[13px]">
            <Badge tone="warning">{t("issue.blocks")}</Badge>
            <Link to={`/${ws.id}/issue/${b.id}`} className="min-w-0 flex-1 truncate hover:underline"><span className="tabular-nums text-muted-foreground">{issueKey(b.number)}</span> {b.title}</Link>
          </li>
        ))}
      </ul>
    </Section>
  );
}

export function attachmentUrl(wsId: Id, id: Id) {
  return `/api/workspaces/${wsId}/attachments/${id}`;
}

function AttachmentChip({ wsId, a, onRemove }: { wsId: Id; a: { id: Id; name: string; size: number }; onRemove?: () => void }) {
  const t = useI18n().t;
  return (
    <li className="group flex items-center gap-2 rounded-lg border border-border bg-card px-2.5 py-1.5 text-[13px]">
      <FileText className="size-4 shrink-0 text-muted-foreground" />
      <a href={attachmentUrl(wsId, a.id)} download={a.name} className="min-w-0 flex-1 truncate hover:underline">{a.name}</a>
      <span className="text-xs text-muted-foreground">{bytes(a.size)}</span>
      <a href={attachmentUrl(wsId, a.id)} download={a.name} aria-label={t("action.download")} className="text-muted-foreground hover:text-foreground"><Download className="size-3.5" /></a>
      {onRemove && <button type="button" aria-label={t("action.remove")} onClick={onRemove} className="text-muted-foreground hover:text-destructive"><X className="size-3.5" /></button>}
    </li>
  );
}

function Attachments({ issue }: { issue: Issue }) {
  const t = useI18n().t;
  const { ws, run, upload, canWrite } = useWorkspace();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  if (!issue.attachments.length && !canWrite) return null;
  return (
    <Section
      title={t("issue.attachments")}
      icon={<Paperclip className="size-3.5 text-muted-foreground" />}
      action={canWrite && (
        <FileTrigger allowsMultiple onSelect={async (list) => {
          if (!list) return;
          setBusy(true);
          for (const f of Array.from(list)) {
            if (f.size > 5 * 1024 * 1024) { toast.error(t("attachments.tooLarge", { name: f.name })); continue; }
            await upload(issue.id, f).catch(() => {});
          }
          setBusy(false);
        }}>
          <Button variant="ghost" size="sm" isDisabled={busy}><Plus />{t("attachments.add")}</Button>
        </FileTrigger>
      )}
    >
      {issue.attachments.length === 0 ? <p className="text-[13px] text-muted-foreground">{t("attachments.none")}</p> : (
        <ul className="grid gap-1.5 sm:grid-cols-2">
          {issue.attachments.map((a) => (
            <AttachmentChip key={a.id} wsId={ws.id} a={a} onRemove={canWrite ? () => run({ type: "remove_attachment", issue_id: issue.id, attachment_id: a.id }).catch(() => {}) : undefined} />
          ))}
        </ul>
      )}
    </Section>
  );
}

function TimeSection({ issue, total }: { issue: Issue; total: number }) {
  const { t, lang } = useI18n();
  const { ws, me, run, member, canWrite, canAdmin } = useWorkspace();
  const entries = ws.time_entries.filter((e) => e.issue_id === issue.id).sort((a, b) => +new Date(b.logged_at) - +new Date(a.logged_at));
  const [editing, setEditing] = useState<TimeEntry | "new" | null>(null);
  return (
    <Section
      title={t("time.title")}
      icon={<Clock className="size-3.5 text-muted-foreground" />}
      action={<div className="flex items-center gap-2">{total > 0 && <span className="text-xs tabular-nums text-muted-foreground">{t("time.total", { time: formatMinutes(total) })}</span>}{canWrite && <Button variant="ghost" size="sm" onPress={() => setEditing("new")}><Plus />{t("time.log")}</Button>}</div>}
    >
      {entries.length === 0 ? <p className="text-[13px] text-muted-foreground">{t("time.none")}</p> : (
        <ul className="divide-y divide-border/70 rounded-lg border border-border">
          {entries.map((e) => {
            const m = member(e.user_id);
            return (
              <li key={e.id} className="group flex items-center gap-2.5 px-3 py-2 text-[13px]">
                <Avatar name={m?.display_name ?? "?"} src={m?.avatar_url} size={18} />
                <span className="w-16 font-medium tabular-nums">{formatMinutes(e.minutes)}</span>
                <span className="min-w-0 flex-1 truncate text-muted-foreground">{e.note}</span>
                <span className="text-xs tabular-nums text-muted-foreground">{fullDate(e.logged_at, lang)}</span>
                {(e.user_id === me || canAdmin) && (
                  <span className="flex opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">
                    <Button variant="ghost" size="icon" aria-label={t("action.edit")} onPress={() => setEditing(e)}><Pencil /></Button>
                    <Button variant="ghost" size="icon" aria-label={t("action.delete")} onPress={() => run({ type: "delete_time", id: e.id }).catch(() => {})}><Trash2 /></Button>
                  </span>
                )}
              </li>
            );
          })}
        </ul>
      )}
      <Dialog title={editing === "new" ? t("time.log") : t("time.edit")} size="sm" isOpen={editing !== null} onOpenChange={(o) => !o && setEditing(null)}>
        {(close) => <TimeForm issueId={issue.id} entry={editing === "new" ? null : editing} close={close} />}
      </Dialog>
    </Section>
  );
}

function Discussion({ issue }: { issue: Issue }) {
  const { t, lang } = useI18n();
  const { ws, me, members, member, run, upload, canWrite, canAdmin } = useWorkspace();
  const comments = ws.comments.filter((c) => c.issue_id === issue.id).sort((a, b) => +new Date(a.created_at) - +new Date(b.created_at));
  const [body, setBody] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [editId, setEditId] = useState<Id | null>(null);
  const [editBody, setEditBody] = useState("");
  const end = useRef<HTMLDivElement>(null);

  const post = async () => {
    if (!body.trim()) return;
    setBusy(true);
    try {
      const id = await run({ type: "add_comment", issue_id: issue.id, body: body.trim(), mentions: mentionsIn(body, members), attachments: [] });
      if (id) for (const f of files) await upload(issue.id, f, id).catch(() => {});
      setBody("");
      setFiles([]);
      requestAnimationFrame(() => end.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
    } catch { /* toast shown */ }
    setBusy(false);
  };

  return (
    <Section title={t("issue.discussion")} action={<span className="text-xs tabular-nums text-muted-foreground">{comments.length}</span>}>
      <ol className="space-y-5">
        {comments.map((c: Comment) => {
          const m = member(c.author);
          const mine = c.author === me;
          return (
            <li key={c.id} className="group flex gap-3">
              <Avatar name={m?.display_name ?? "?"} src={m?.avatar_url} size={28} />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2 text-[13px]">
                  <Link to={`/${ws.id}/people/${c.author}`} className="font-semibold hover:underline">{m?.display_name ?? t("person.unknown")}</Link>
                  <time dateTime={c.created_at} title={new Date(c.created_at).toLocaleString(lang)} className="text-xs text-muted-foreground">{relativeTime(c.created_at, lang)}</time>
                  {c.edited_at && <span className="text-xs text-muted-foreground">({t("comment.edited")})</span>}
                  {(mine || canAdmin) && editId !== c.id && (
                    <span className="ml-auto flex opacity-0 group-hover:opacity-100 group-focus-within:opacity-100">
                      {mine && <Button variant="ghost" size="icon" aria-label={t("action.edit")} onPress={() => { setEditId(c.id); setEditBody(c.body); }}><Pencil /></Button>}
                      <Button variant="ghost" size="icon" aria-label={t("action.delete")} onPress={() => run({ type: "delete_comment", id: c.id }).catch(() => {})}><Trash2 /></Button>
                    </span>
                  )}
                </div>
                {editId === c.id ? (
                  <div className="mt-1.5 space-y-2">
                    <MarkdownEditor label={t("comment.edit")} value={editBody} onChange={setEditBody} autoFocus minRows={3} onSubmit={() => undefined} />
                    <div className="flex justify-end gap-2">
                      <Button variant="ghost" onPress={() => setEditId(null)}>{t("action.cancel")}</Button>
                      <Button variant="primary" isDisabled={!editBody.trim()} onPress={() => run({ type: "edit_comment", id: c.id, body: editBody.trim(), mentions: mentionsIn(editBody, members) }).then(() => setEditId(null)).catch(() => {})}>{t("action.save")}</Button>
                    </div>
                  </div>
                ) : (
                  <Markdown text={c.body} className="mt-0.5 text-[13.5px]" />
                )}
                {c.attachments.length > 0 && (
                  <ul className="mt-2 grid gap-1.5 sm:grid-cols-2">{c.attachments.map((a) => <AttachmentChip key={a.id} wsId={ws.id} a={a} />)}</ul>
                )}
              </div>
            </li>
          );
        })}
      </ol>
      <div ref={end} />
      {canWrite ? (
        <div className={cn("space-y-2", comments.length > 0 && "mt-5")}>
          <MarkdownEditor label={t("comment.new")} value={body} onChange={setBody} placeholder={t("comment.placeholder")} minRows={3} onSubmit={post} />
          {files.length > 0 && (
            <ul className="flex flex-wrap gap-1.5">
              {files.map((f, i) => (
                <li key={i} className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted px-2 py-1 text-xs">
                  <Paperclip className="size-3" />{f.name}
                  <button type="button" aria-label={t("action.remove")} onClick={() => setFiles((l) => l.filter((_, j) => j !== i))}><X className="size-3" /></button>
                </li>
              ))}
            </ul>
          )}
          <div className="flex items-center justify-between">
            <FileTrigger allowsMultiple onSelect={(l) => l && setFiles((f) => [...f, ...Array.from(l)])}>
              <Button variant="ghost" size="sm"><Paperclip />{t("attachments.add")}</Button>
            </FileTrigger>
            <div className="flex items-center gap-2">
              <span className="hidden text-xs text-muted-foreground sm:block">{t("comment.hint")}</span>
              <Button variant="primary" isDisabled={!body.trim() || busy} onPress={post}>{t("comment.send")}</Button>
            </div>
          </div>
        </div>
      ) : null}
    </Section>
  );
}

function IssueActivity({ issue }: { issue: Issue }) {
  const { t, lang } = useI18n();
  const { ws, member } = useWorkspace();
  const items = ws.activity.filter((a) => a.entity_id === issue.id).slice(-15).reverse();
  if (!items.length) return null;
  return (
    <Section title={t("activity.title")}>
      <ul className="space-y-1.5 border-l border-border pl-4">
        {items.map((a) => (
          <li key={a.id} className="text-xs text-muted-foreground">
            <span className="font-medium text-foreground">{member(a.actor)?.display_name ?? t("person.unknown")}</span> {activityLabel(t, a.action)} · {relativeTime(a.at, lang)}
          </li>
        ))}
      </ul>
    </Section>
  );
}

export function activityLabel(t: ReturnType<typeof useI18n>["t"], action: string) {
  const key = `activity.${action}` as Parameters<typeof t>[0];
  const text = t(key);
  return text === key ? action.replaceAll("_", " ").replace(/\./g, " ") : text;
}
