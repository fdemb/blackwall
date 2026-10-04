import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Disclosure, DisclosurePanel, FileTrigger, Form, Heading } from "react-aria-components";
import { Link, Navigate, useLocation, useNavigate, useParams } from "react-router";
import {
  ArchiveRestore,
  Bell,
  BellOff,
  CalendarDays,
  CalendarRange,
  ChevronLeft,
  ChevronRight,
  ChevronsUp,
  CircleCheck,
  CircleDot,
  CirclePlus,
  Clock,
  Download,
  ExternalLink,
  FileText,
  Flag,
  FolderKanban,
  Gauge,
  GitFork,
  Link2,
  Loader2,
  Lock,
  MoreHorizontal,
  Paperclip,
  Pencil,
  Plus,
  Signal,
  Tag,
  Trash2,
  UserRound,
  X,
  type LucideIcon,
} from "lucide-react";
import { Avatar } from "~/components/ui/avatar";
import { Button } from "~/components/ui/button";
import { DatePicker } from "~/components/ui/date-picker";
import { Dialog } from "~/components/ui/dialog";
import { Input } from "~/components/ui/field";
import { ConfirmDialog } from "~/components/app/confirm";
import { SaveStatus } from "~/components/app/save-status";
import { Menu, MenuItem, MenuPopover, MenuTrigger } from "~/components/ui/menu";
import { useToast } from "~/components/ui/toast";
import { Markdown, MarkdownEditor, mentionsIn } from "~/components/app/markdown";
import { IssuePicker } from "~/components/app/issue-picker";
import { StageIcon } from "~/components/app/icons";
import { TimeForm } from "~/components/app/time-form";
import {
  AssigneePicker,
  LabelsPicker,
  NullableSelect,
  PriorityPicker,
  StagePicker,
} from "~/components/app/pickers";
import { EmptyState, Page, TeamCrumb } from "~/components/app/page";
import { isDone, stageOf } from "~/lib/filters";
import { bytes, formatMinutes, fullDate, issueKey, MAX_UPLOAD, relativeTime } from "~/lib/format";
import { useDocumentTitle } from "~/lib/title";
import { useI18n, isTranslationKey, type Key } from "~/lib/i18n";
import { useMediaQuery } from "~/lib/media";
import { usePending } from "~/lib/use-pending";
import {
  useActivity,
  useComments,
  useIssueDetail,
  useTimeEntries,
  type IssueDetail,
} from "~/lib/queries";
import { QueryStatus } from "~/components/app/query-status";
import { useWorkspace } from "~/lib/workspace";
import { cn } from "~/lib/utils";
import type { Activity, Comment, Id, Issue, IssuePatch, TimeEntry } from "~/lib/types";

/** Row actions hide until hover on devices that can hover, and stay visible on touch. */
const revealOnHover =
  "[@media(hover:hover)]:opacity-0 group-hover:opacity-100 group-focus-within:opacity-100";
const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent);
const modKey = IS_MAC ? "⌘" : "Ctrl";
const WS_RUN = /\s+/g;
const NEWLINE = /\n/g;

export default function IssuePage() {
  const { issueId, ws: wsId } = useParams();
  const { ws } = useWorkspace();
  const detail = useIssueDetail(issueId!);
  const issue = detail.issue;
  if (detail.missing) return <Navigate to={`/${ws.id}/my-issues`} replace />;
  if (!issue || detail.error)
    return (
      <Page>
        <QueryStatus query={{ ...detail, hasMore: false, loadMore: detail.retry }} />
      </Page>
    );
  if (issue.deleted_at) return <DeletedIssue issue={issue} wsId={wsId!} />;
  return <IssueView key={issue.id} issue={issue} detail={detail} />;
}

/** A link to a trashed issue still says which issue it was and offers the way back. */
function DeletedIssue({ issue, wsId }: { issue: Issue; wsId: string }) {
  const { t } = useI18n();
  const { run, canWrite } = useWorkspace();
  const toast = useToast();
  useDocumentTitle(`${issueKey(issue.number)} ${issue.title}`);
  return (
    <Page>
      <EmptyState
        icon={<Trash2 />}
        title={`${issueKey(issue.number)} ${issue.title}`}
        description={`${t("issue.deleted")}. ${canWrite ? t("issue.deletedSub") : ""}`.trim()}
        action={
          <div className="flex items-center gap-3">
            {canWrite && (
              <Button
                variant="primary"
                onPress={() =>
                  run({ type: "restore_issue", id: issue.id })
                    .then(() => toast.show(t("issue.restored")))
                    .catch(() => {})
                }
              >
                <ArchiveRestore />
                {t("issue.restore")}
              </Button>
            )}
            <Link className="text-primary hover:underline" to={`/${wsId}/trash`}>
              {t("nav.trash")}
            </Link>
          </div>
        }
      />
    </Page>
  );
}

function IssueView({ issue, detail }: { issue: Issue; detail: IssueDetail }) {
  const { t } = useI18n();
  const nav = useNavigate();
  const location = useLocation();
  const toast = useToast();
  const { ws, me, run, team, canWrite } = useWorkspace();
  const wide = useMediaQuery("(min-width: 1024px)");
  const tm = team(issue.team_id);
  useDocumentTitle(`${issueKey(issue.number)} ${issue.title}`);
  // Resolves to whether the save landed, so editors can keep a draft that didn't.
  const patch = (p: IssuePatch, version = issue.version) =>
    run(
      { type: "update_issue", id: issue.id, patch: p },
      { expectedVersions: { [issue.id]: version } },
    ).then(
      () => true,
      () => false,
    );
  const following = issue.followers.includes(me);
  const subs = detail.children.filter((i) => !i.deleted_at);
  const parent = detail.parent;
  const blockers = detail.blockers.filter((i) => !i.deleted_at);
  const blocking = detail.dependents.filter((i) => !i.deleted_at);
  const addBlocker = (id: Id) => patch({ dependencies: [...issue.dependencies, id] });
  const uploader = useUploader(issue.id);
  const [addingSubtask, setAddingSubtask] = useState(false);
  const [confirm, setConfirm] = useState(false);
  // Go back to wherever the issue was opened from. A fresh tab has no history, so use the team list.
  const goBack = () =>
    location.key === "default" ? nav(`/${ws.id}/team/${issue.team_id}`) : nav(-1);
  const chip = "h-7 w-auto rounded-full border border-border px-2.5";

  return (
    <Page className="overflow-hidden">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4">
        <Button
          variant="ghost"
          size="icon"
          aria-label={t("action.back")}
          className="-ml-1"
          onPress={goBack}
        >
          <ChevronLeft />
        </Button>
        {tm && (
          <>
            <TeamCrumb team={tm} wsId={ws.id} />
            <span aria-hidden="true" className="text-muted-foreground/50">
              /
            </span>
          </>
        )}
        <span className="text-[13px] font-medium tabular-nums">{issueKey(issue.number)}</span>
        <div className="ml-auto flex items-center gap-1">
          <SaveStatus />
          <Button
            variant="ghost"
            size="sm"
            onPress={() =>
              run({ type: "follow", issue_id: issue.id, following: !following }).catch(() => {})
            }
          >
            {following ? <BellOff /> : <Bell />}
            {following ? t("issue.unfollow") : t("issue.follow")}
          </Button>
          <MenuTrigger>
            <Button variant="ghost" size="icon-lg" aria-label={t("action.more")}>
              <MoreHorizontal />
            </Button>
            <MenuPopover placement="bottom end">
              <Menu
                onAction={(k) => {
                  if (k === "copy")
                    void navigator.clipboard
                      .writeText(window.location.href)
                      .then(() => toast.show(t("issue.linkCopied")));
                  if (k === "delete") setConfirm(true);
                }}
              >
                <MenuItem id="copy">
                  <Link2 />
                  {t("issue.copyLink")}
                </MenuItem>
                {canWrite && (
                  <MenuItem id="delete">
                    <Trash2 />
                    {t("action.delete")}
                  </MenuItem>
                )}
              </Menu>
            </MenuPopover>
          </MenuTrigger>
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        <div className="min-w-0 flex-1 overflow-y-auto">
          <div className="mx-auto max-w-3xl px-6 py-8">
            <h1 className="sr-only">
              {t("issue.titleHeading", { key: issueKey(issue.number), title: issue.title })}
            </h1>
            <div className="space-y-3">
              {parent && (
                <div className="group flex items-center gap-1 text-xs text-muted-foreground">
                  <Link
                    to={`/${ws.id}/issue/${parent.id}`}
                    className="inline-flex min-w-0 items-center gap-1.5 hover:text-foreground"
                  >
                    <span className="tabular-nums">{issueKey(parent.number)}</span>
                    <span className="truncate">{parent.title}</span>
                  </Link>
                  {canWrite && (
                    <Button
                      variant="ghost"
                      size="icon"
                      className={cn("size-5", revealOnHover)}
                      aria-label={t("issue.removeParent")}
                      onPress={() => patch({ clear_parent: true })}
                    >
                      <X className="size-3" />
                    </Button>
                  )}
                </div>
              )}
              <TitleField issue={issue} onSave={(title, version) => patch({ title }, version)} />
              <div className="flex flex-wrap items-center gap-1.5">
                <StagePicker
                  variant="ghost"
                  className="w-auto"
                  triggerClassName={chip}
                  isDisabled={!canWrite}
                  teamId={issue.team_id}
                  value={issue.stage_id}
                  onChange={(id) => patch({ stage_id: id })}
                />
                <PriorityPicker
                  variant="ghost"
                  className="w-auto"
                  triggerClassName={chip}
                  isDisabled={!canWrite}
                  value={issue.priority}
                  onChange={(priority) => patch({ priority })}
                />
                <AssigneePicker
                  variant="ghost"
                  className="w-auto"
                  triggerClassName={chip}
                  isDisabled={!canWrite}
                  teamId={issue.team_id}
                  value={issue.assignee}
                  onChange={(id) => patch(id ? { assignee: id } : { clear_assignee: true })}
                />
              </div>
            </div>
            {!wide && (
              <Disclosure className="mt-4 rounded-lg border border-border">
                {({ isExpanded }) => (
                  <>
                    <Heading>
                      <Button
                        slot="trigger"
                        variant="ghost"
                        className="h-9 w-full justify-start px-3"
                      >
                        {t("issue.allProperties")}
                        <ChevronRight
                          className={cn(
                            "ml-auto size-3.5 transition-transform",
                            isExpanded && "rotate-90",
                          )}
                        />
                      </Button>
                    </Heading>
                    <DisclosurePanel>
                      <div className="space-y-1 border-t border-border p-2">
                        <Properties
                          issue={issue}
                          hasParent={Boolean(parent)}
                          excludeIds={subs.map((s) => s.id)}
                        />
                      </div>
                    </DisclosurePanel>
                  </>
                )}
              </Disclosure>
            )}

            <div className="mt-6 space-y-8">
              <div className="space-y-2">
                <Description
                  issue={issue}
                  onSave={(description, version) => patch({ description }, version)}
                />
                {canWrite && (
                  <div className="flex flex-wrap gap-1">
                    {!subs.length && !addingSubtask && (
                      <Button variant="ghost" size="sm" onPress={() => setAddingSubtask(true)}>
                        <Plus />
                        {t("issue.addSubtask")}
                      </Button>
                    )}
                    {!blockers.length && !blocking.length && (
                      <IssuePicker
                        exclude={[issue.id, ...issue.dependencies]}
                        onPick={addBlocker}
                        trigger={
                          <Button variant="ghost" size="sm">
                            <Lock />
                            {t("issue.addBlocker")}
                          </Button>
                        }
                      />
                    )}
                    {!issue.attachments.length && <AttachButton uploader={uploader} />}
                  </div>
                )}
              </div>
              {(subs.length > 0 || addingSubtask) && (
                <Subtasks
                  issue={issue}
                  subs={subs}
                  adding={addingSubtask}
                  setAdding={setAddingSubtask}
                />
              )}
              {(blockers.length > 0 || blocking.length > 0) && (
                <Dependencies
                  issue={issue}
                  blockers={blockers}
                  blocking={blocking}
                  onAdd={addBlocker}
                />
              )}
              {issue.attachments.length > 0 && <Attachments issue={issue} uploader={uploader} />}
              <Timeline issue={issue} />
            </div>
          </div>
        </div>

        {wide && (
          <aside
            aria-label={t("issue.properties")}
            className="w-72 shrink-0 space-y-1 overflow-y-auto border-l border-border p-4"
          >
            <Properties
              issue={issue}
              hasParent={Boolean(parent)}
              excludeIds={subs.map((s) => s.id)}
            />
          </aside>
        )}
      </div>

      <ConfirmDialog
        title={t("issue.deleteTitle")}
        description={t("issue.deleteSub")}
        isOpen={confirm}
        onOpenChange={setConfirm}
        onConfirm={async () => {
          await run({ type: "delete_issue", id: issue.id }, { quiet: true });
          toast.show(t("issue.movedToTrash"), {
            label: t("action.undo"),
            run: () => void run({ type: "restore_issue", id: issue.id }).catch(() => {}),
          });
          void goBack();
        }}
      />
    </Page>
  );
}

function Properties({
  issue,
  hasParent,
  excludeIds,
}: {
  issue: Issue;
  hasParent: boolean;
  excludeIds: Id[];
}) {
  const { t, lang } = useI18n();
  const { ws, run, canWrite, member } = useWorkspace();
  const patch = (p: IssuePatch, version = issue.version) =>
    run(
      { type: "update_issue", id: issue.id, patch: p },
      { expectedVersions: { [issue.id]: version } },
    ).then(
      () => true,
      () => false,
    );
  const projectMilestones = ws.milestones.filter((m) => m.project_id === issue.project_id);
  const sprints = ws.sprints.filter(
    (s) =>
      s.team_id === issue.team_id &&
      (s.state === "planned" || s.state === "active" || s.id === issue.sprint_id),
  );
  const followers = issue.followers.map(member).filter((m) => m !== undefined);
  return (
    <>
      <Prop label={t("field.labels")}>
        <LabelsPicker
          isDisabled={!canWrite}
          value={issue.labels}
          onChange={(labels) => patch({ labels })}
        />
      </Prop>
      <Prop label={t("field.deadline")}>
        <DatePicker
          variant="ghost"
          aria-label={t("field.deadline")}
          isDisabled={!canWrite}
          placeholder={t("deadline.none")}
          value={issue.deadline}
          onChange={(d) => patch(d ? { deadline: d } : { clear_deadline: true })}
        />
      </Prop>
      <Prop label={t("field.estimate")}>
        <EstimateField
          value={issue.estimate}
          version={issue.version}
          disabled={!canWrite}
          onCommit={(v, version) =>
            patch(v === null ? { clear_estimate: true } : { estimate: v }, version)
          }
        />
      </Prop>
      <TimeProp issue={issue} />
      <div className="my-3 h-px bg-border" />
      <Prop label={t("field.project")}>
        <NullableSelect
          variant="ghost"
          isDisabled={!canWrite}
          noneLabel={t("project.none")}
          value={issue.project_id}
          options={ws.projects.map((p) => ({ id: p.id, label: p.name }))}
          onChange={(id) =>
            patch(
              id
                ? { project_id: id, clear_milestone: true }
                : { clear_project: true, clear_milestone: true },
            )
          }
        />
      </Prop>
      {issue.project_id && (
        <Prop label={t("field.milestone")}>
          <NullableSelect
            variant="ghost"
            isDisabled={!canWrite}
            noneLabel={t("milestone.none")}
            value={issue.milestone_id}
            options={projectMilestones.map((m) => ({ id: m.id, label: m.name }))}
            onChange={(id) => patch(id ? { milestone_id: id } : { clear_milestone: true })}
          />
        </Prop>
      )}
      <Prop label={t("field.sprint")}>
        <NullableSelect
          variant="ghost"
          isDisabled={!canWrite}
          noneLabel={t("sprint.none")}
          value={issue.sprint_id}
          options={sprints.map((s) => ({ id: s.id, label: s.name }))}
          onChange={(id) => patch(id ? { sprint_id: id } : { clear_sprint: true })}
        />
      </Prop>
      {!hasParent && canWrite && (
        <Prop label={t("issue.parent")}>
          <IssuePicker
            exclude={[issue.id, ...excludeIds]}
            onPick={(id) => patch({ parent_id: id })}
            trigger={
              <Button
                variant="ghost"
                className="h-7 w-full justify-start px-2 font-normal text-muted-foreground"
              >
                <Plus />
                {t("issue.setParent")}
              </Button>
            }
          />
        </Prop>
      )}
      {issue.source_links.length > 0 && (
        <>
          <div className="my-3 h-px bg-border" />
          <Prop label={t("issue.sourceLinks")}>
            <ul className="space-y-1 px-2">
              {issue.source_links.map((l) => (
                <li key={l.url}>
                  <a
                    href={l.url}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="flex items-center gap-1.5 text-[13px] text-primary hover:underline"
                  >
                    <ExternalLink className="size-3.5 shrink-0" />
                    <span className="truncate">{l.title || l.url}</span>
                  </a>
                </li>
              ))}
            </ul>
          </Prop>
        </>
      )}
      <div className="my-3 h-px bg-border" />
      <dl className="space-y-1 px-2 text-xs text-muted-foreground">
        <div className="flex justify-between">
          <dt>{t("issue.created")}</dt>
          <dd>{fullDate(issue.created_at, lang)}</dd>
        </div>
        <div className="flex justify-between">
          <dt>{t("issue.updated")}</dt>
          <dd>{relativeTime(issue.updated_at, lang)}</dd>
        </div>
        {followers.length > 0 && (
          <div className="flex items-center justify-between">
            <dt>{t("issue.followers")}</dt>
            <dd
              className="flex items-center gap-1.5"
              title={followers.map((m) => m.display_name).join(", ")}
            >
              <span className="flex -space-x-1">
                {followers.slice(0, 5).map((m) => (
                  <Avatar
                    key={m.id}
                    name={m.display_name}
                    src={m.avatar_url}
                    size={16}
                    named
                    className="ring-2 ring-background"
                  />
                ))}
              </span>
              {followers.length > 5 && (
                <span className="tabular-nums">+{followers.length - 5}</span>
              )}
            </dd>
          </div>
        )}
      </dl>
    </>
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

function EstimateField({
  value,
  version,
  disabled,
  onCommit,
}: {
  value: number | null;
  version: number;
  disabled: boolean;
  onCommit: (v: number | null, version: number) => void;
}) {
  const { t } = useI18n();
  const [v, setV] = useState(value?.toString() ?? "");
  const field = useRef<HTMLInputElement>(null);
  const baseVersion = useRef(version);
  useEffect(() => {
    if (document.activeElement !== field.current) setV(value?.toString() ?? "");
  }, [value]);
  return (
    <div className="relative">
      <Input
        ref={field}
        aria-label={t("field.estimate")}
        type="number"
        min={0}
        max={1000}
        inputMode="numeric"
        disabled={disabled}
        value={v}
        placeholder={t("estimate.none")}
        onFocus={() => {
          baseVersion.current = version;
        }}
        onChange={(e) => setV(e.target.value)}
        onBlur={() => {
          const n = v === "" ? null : Number(v);
          if (n !== value) onCommit(n, baseVersion.current);
        }}
        className="h-7 border-transparent bg-transparent pr-9 shadow-none hover:bg-muted focus:bg-card"
      />
      {v !== "" && (
        <span className="pointer-events-none absolute inset-y-0 right-2.5 flex items-center text-xs text-muted-foreground">
          {t("estimate.unit")}
        </span>
      )}
    </div>
  );
}

type TimeView = { kind: "closed" } | { kind: "list" } | { kind: "form"; entry: TimeEntry | null };

function TimeProp({ issue }: { issue: Issue }) {
  const { t, lang } = useI18n();
  const { me, run, member, canWrite, canAdmin, report } = useWorkspace();
  const entries = useTimeEntries(issue.id).items;
  const total = report.issues.find((total) => total.id === issue.id)?.minutes ?? 0;
  const [view, setView] = useState<TimeView>({ kind: "closed" });
  const [deleting, setDeleting] = useState<Id | null>(null);
  if (!entries.length && !canWrite) return null;
  const title =
    view.kind === "form" ? (view.entry ? t("time.edit") : t("time.log")) : t("time.title");
  return (
    <Prop label={t("time.title")}>
      <Button
        variant="ghost"
        className="h-7 w-full justify-start px-2 font-normal"
        onPress={() => setView(entries.length ? { kind: "list" } : { kind: "form", entry: null })}
      >
        {entries.length ? (
          <span className="tabular-nums text-foreground">{formatMinutes(total)}</span>
        ) : (
          <span className="flex items-center gap-1.5 text-muted-foreground">
            <Plus />
            {t("time.log")}
          </span>
        )}
      </Button>
      <Dialog
        title={title}
        description={
          view.kind === "list" ? t("time.total", { time: formatMinutes(total) }) : undefined
        }
        size={view.kind === "list" ? "md" : "sm"}
        isOpen={view.kind !== "closed"}
        onOpenChange={(open) => {
          if (!open) {
            setView({ kind: "closed" });
            setDeleting(null);
          }
        }}
      >
        {view.kind === "form" ? (
          <TimeForm
            issueId={issue.id}
            entry={view.entry}
            close={() => setView(entries.length ? { kind: "list" } : { kind: "closed" })}
          />
        ) : (
          <div className="space-y-3">
            <ul className="-mx-1 max-h-80 divide-y divide-border/70 overflow-y-auto">
              {entries.map((e) => {
                const m = member(e.user_id);
                return (
                  <li
                    key={e.id}
                    className="group flex min-h-11 items-center gap-2.5 px-1 py-1.5 text-[13px]"
                  >
                    {deleting === e.id ? (
                      <>
                        <span className="flex-1">{t("time.deleteTitle")}</span>
                        <Button variant="ghost" size="sm" onPress={() => setDeleting(null)}>
                          {t("action.cancel")}
                        </Button>
                        <Button
                          variant="destructive"
                          size="sm"
                          onPress={() =>
                            run({ type: "delete_time", id: e.id })
                              .then(() => setDeleting(null))
                              .catch(() => {})
                          }
                        >
                          {t("action.delete")}
                        </Button>
                      </>
                    ) : (
                      <>
                        <Avatar name={m?.display_name ?? "?"} src={m?.avatar_url} size={18} />
                        <span className="w-16 font-medium tabular-nums">
                          {formatMinutes(e.minutes)}
                        </span>
                        <span className="min-w-0 flex-1 truncate text-muted-foreground">
                          {e.note}
                        </span>
                        <span className="text-xs tabular-nums text-muted-foreground">
                          {fullDate(e.logged_at, lang)}
                        </span>
                        {(e.user_id === me || canAdmin) && (
                          <span className={cn("flex", revealOnHover)}>
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label={t("action.edit")}
                              onPress={() => setView({ kind: "form", entry: e })}
                            >
                              <Pencil />
                            </Button>
                            <Button
                              variant="ghost"
                              size="icon"
                              aria-label={t("action.delete")}
                              onPress={() => setDeleting(e.id)}
                            >
                              <Trash2 />
                            </Button>
                          </span>
                        )}
                      </>
                    )}
                  </li>
                );
              })}
            </ul>
            {canWrite && (
              <div className="flex justify-end">
                <Button onPress={() => setView({ kind: "form", entry: null })}>
                  <Plus />
                  {t("time.log")}
                </Button>
              </div>
            )}
          </div>
        )}
      </Dialog>
    </Prop>
  );
}

function Section({
  title,
  icon,
  action,
  children,
}: {
  title: string;
  icon?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="mb-2 flex min-h-7 items-center gap-2">
        {icon}
        <h2 className="text-[13px] font-semibold">{title}</h2>
        <div className="ml-auto">{action}</div>
      </div>
      {children}
    </section>
  );
}

function TitleField({
  issue,
  onSave,
}: {
  issue: Issue;
  onSave: (title: string, version: number) => void;
}) {
  const { t } = useI18n();
  const { canWrite } = useWorkspace();
  const [title, setTitle] = useState(issue.title);
  const baseVersion = useRef(issue.version);
  const ref = useRef<HTMLTextAreaElement>(null);
  // A teammate's edit shouldn't overwrite a title you are in the middle of typing.
  useEffect(() => {
    if (document.activeElement !== ref.current) setTitle(issue.title);
  }, [issue.title]);
  const fit = () => {
    const el = ref.current;
    if (!el) return;
    // Batch the measure+write in a frame so typing doesn't force a sync layout each keystroke.
    requestAnimationFrame(() => {
      if (ref.current !== el) return;
      el.style.height = "auto";
      el.style.height = `${el.scrollHeight}px`;
    });
  };
  useLayoutEffect(fit, [title]);
  useEffect(() => {
    addEventListener("resize", fit, { passive: true });
    return () => removeEventListener("resize", fit);
  }, []);
  const commit = () => {
    const next = title.replace(WS_RUN, " ").trim();
    if (!next) return setTitle(issue.title);
    setTitle(next);
    if (next !== issue.title) onSave(next, baseVersion.current);
  };
  return (
    <textarea
      ref={ref}
      rows={1}
      aria-label={t("field.title")}
      value={title}
      readOnly={!canWrite}
      maxLength={200}
      onFocus={() => {
        baseVersion.current = issue.version;
      }}
      onChange={(e) => setTitle(e.target.value.replace(NEWLINE, " "))}
      onBlur={commit}
      onKeyDown={(e) => {
        if (e.key === "Enter") {
          e.preventDefault();
          e.currentTarget.blur();
        }
        if (e.key === "Escape") setTitle(issue.title);
      }}
      className={cn(
        "-mx-2 block w-[calc(100%+1rem)] resize-none overflow-hidden rounded-md bg-transparent px-2 py-1 text-2xl font-semibold leading-snug tracking-tight outline-none",
        canWrite &&
          "hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:ring-2 focus-visible:ring-ring/40",
      )}
    />
  );
}

/** Descriptions that failed to save, by issue, so reopening the editor brings the text back. */
const failedDrafts = new Map<Id, string>();

function Description({
  issue,
  onSave,
}: {
  issue: Issue;
  onSave: (d: string, version: number) => Promise<boolean>;
}) {
  const { t } = useI18n();
  const { canWrite } = useWorkspace();
  // null while not editing.
  const [draft, setDraft] = useState<string | null>(failedDrafts.get(issue.id) ?? null);
  const [saving, setSaving] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const busy = useRef(false);
  const baseVersion = useRef(issue.version);
  const box = useRef<HTMLDivElement>(null);
  const latest = useRef({ draft, saved: issue.description, version: issue.version, onSave });
  useEffect(() => {
    latest.current = { draft, saved: issue.description, version: issue.version, onSave };
  });
  const dirty = draft !== null && draft !== issue.description;

  // The editor closes only once the server has the text. A failed save leaves it open with the draft intact.
  const commit = async () => {
    const { draft: d, saved, onSave: save } = latest.current;
    if (d === null || busy.current) return;
    if (d === saved) {
      failedDrafts.delete(issue.id);
      return setDraft(null);
    }
    busy.current = true;
    setSaving(true);
    if (failedDrafts.has(issue.id)) baseVersion.current = latest.current.version;
    const ok = await save(d, baseVersion.current);
    busy.current = false;
    setSaving(false);
    if (ok) {
      failedDrafts.delete(issue.id);
      latest.current.draft = null;
      setDraft(null);
    } else {
      failedDrafts.set(issue.id, d);
    }
  };
  const cancel = () => (dirty ? setDiscarding(true) : setDraft(null));
  const discard = () => {
    failedDrafts.delete(issue.id);
    latest.current.draft = null;
    setDraft(null);
  };
  // Leaving the page mid-edit saves the draft, and keeps it for next time if that fails.
  useEffect(
    () => () => {
      const { draft: d, saved, onSave: save } = latest.current;
      if (d !== null && d !== saved && !busy.current)
        void save(d, baseVersion.current).then((ok) =>
          ok ? failedDrafts.delete(issue.id) : failedDrafts.set(issue.id, d),
        );
    },
    [issue.id],
  );
  useEffect(() => {
    if (!dirty) return;
    const warn = (e: BeforeUnloadEvent) => e.preventDefault();
    addEventListener("beforeunload", warn);
    return () => removeEventListener("beforeunload", warn);
  }, [dirty]);

  if (draft !== null)
    return (
      <div
        ref={box}
        className="space-y-2"
        onBlur={() =>
          setTimeout(() => {
            // Save when focus leaves the editor for the page. Ignore window switches and the mention menu.
            // Safari doesn't focus clicked buttons, so a pointer still over the editor means a click inside it.
            const el = document.activeElement;
            if (
              !box.current ||
              !document.hasFocus() ||
              box.current.contains(el) ||
              box.current.matches(":hover") ||
              el?.closest("[role=menu], [role=dialog], [role=alertdialog]")
            )
              return;
            void commit();
          })
        }
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            cancel();
          }
        }}
      >
        <MarkdownEditor
          label={t("field.description")}
          value={draft}
          onChange={setDraft}
          autoFocus
          minRows={8}
          onSubmit={() => void commit()}
        />
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onPress={cancel}>
            {t("action.cancel")}
          </Button>
          <Button variant="primary" isDisabled={saving} onPress={() => void commit()}>
            {saving ? t("action.saving") : t("action.save")}
          </Button>
        </div>
        <ConfirmDialog
          title={t("draft.discardTitle")}
          description={t("draft.discardSub")}
          confirmLabel={t("draft.discard")}
          isOpen={discarding}
          onOpenChange={setDiscarding}
          onConfirm={async () => discard()}
        />
      </div>
    );
  // Kept a div (not a <button>) because rendered Markdown can contain links,
  // which must not live inside a button. Space opens the editor like Enter does.
  return (
    <div
      role={canWrite ? "button" : undefined}
      tabIndex={canWrite ? 0 : undefined}
      aria-label={canWrite ? t("issue.editDescription") : undefined}
      onClick={(e) => {
        // Let people follow links and select text without opening the editor.
        if (
          !canWrite ||
          (e.target instanceof Element && e.target.closest("a")) ||
          getSelection()?.isCollapsed === false
        )
          return;
        baseVersion.current = issue.version;
        setDraft(issue.description);
      }}
      onKeyDown={(e) => {
        if (canWrite && (e.key === "Enter" || e.key === " ")) {
          e.preventDefault();
          baseVersion.current = issue.version;
          setDraft(issue.description);
        }
      }}
      className={cn(
        "-mx-3 min-h-16 rounded-lg px-3 py-2 outline-none",
        canWrite && "cursor-text hover:bg-muted/50 focus-visible:ring-2 focus-visible:ring-ring/50",
      )}
    >
      <Markdown
        text={issue.description}
        empty={canWrite ? t("issue.addDescription") : t("issue.noDescription")}
      />
    </div>
  );
}

function IssueRow({ issue, trailing }: { issue: Issue; trailing?: React.ReactNode }) {
  const { ws, member } = useWorkspace();
  const st = stageOf(ws, issue);
  const assignee = member(issue.assignee);
  return (
    <li className="group flex h-9 items-center gap-2.5 px-3 text-[13px] hover:bg-muted/60">
      <Link
        to={`/${ws.id}/issue/${issue.id}`}
        className="flex min-w-0 flex-1 items-center gap-2.5 self-stretch"
      >
        {st && <StageIcon kind={st.kind} />}
        <span className="w-14 shrink-0 tabular-nums text-muted-foreground">
          {issueKey(issue.number)}
        </span>
        <span className={cn("truncate", isDone(ws, issue) && "text-muted-foreground line-through")}>
          {issue.title}
        </span>
      </Link>
      {assignee && (
        <Avatar name={assignee.display_name} src={assignee.avatar_url} size={18} named />
      )}
      {trailing}
    </li>
  );
}

function Subtasks({
  issue,
  subs,
  adding,
  setAdding,
}: {
  issue: Issue;
  subs: Issue[];
  adding: boolean;
  setAdding: (v: boolean) => void;
}) {
  const { t } = useI18n();
  const { ws, run, canWrite } = useWorkspace();
  const [title, setTitle] = useState("");
  const { pending, guard } = usePending();
  const done = subs.filter((s) => isDone(ws, s)).length;
  // The title is cleared only after the issue exists. If the request fails it stays for another try.
  const submit = () =>
    guard(async () => {
      if (!title.trim()) return setAdding(false);
      const first = [...(ws.teams.find((x) => x.id === issue.team_id)?.stages ?? [])].sort(
        (a, b) => a.position - b.position,
      )[0];
      await run({
        type: "create_issue",
        input: {
          title: title.trim(),
          team_id: issue.team_id,
          stage_id: first?.id,
          parent_id: issue.id,
          project_id: issue.project_id,
          sprint_id: issue.sprint_id,
        },
      });
      setTitle("");
    }).catch(() => {});
  return (
    <Section
      title={t("issue.subtasks")}
      action={
        subs.length > 0 && (
          <span className="text-xs tabular-nums text-muted-foreground">
            {done}/{subs.length}
          </span>
        )
      }
    >
      {subs.length > 0 && (
        <div className="mb-2 h-1 overflow-hidden rounded-full bg-border">
          <div
            className="h-full w-full origin-left rounded-full bg-primary transition-transform"
            style={{ transform: `scaleX(${subs.length ? done / subs.length : 0})` }}
          />
        </div>
      )}
      <ul className="divide-y divide-border/70 rounded-lg border border-border">
        {subs.map((s) => (
          <IssueRow key={s.id} issue={s} />
        ))}
        {canWrite && (
          <li>
            {adding ? (
              <Form
                className="flex items-center gap-2 px-3 py-1.5"
                onSubmit={(e) => {
                  e.preventDefault();
                  void submit();
                }}
              >
                <Input
                  autoFocus
                  aria-label={t("issue.subtaskTitle")}
                  value={title}
                  onChange={(e) => setTitle(e.target.value)}
                  onKeyDown={(e) => e.key === "Escape" && setAdding(false)}
                  onBlur={() => !title.trim() && setAdding(false)}
                  placeholder={t("issue.subtaskPlaceholder")}
                  className="h-7 border-0 shadow-none focus:ring-0"
                />
                <Button type="submit" size="sm" variant="subtle" isDisabled={pending}>
                  {t("action.add")}
                </Button>
              </Form>
            ) : (
              <button
                type="button"
                onClick={() => setAdding(true)}
                className="flex h-9 w-full items-center gap-2 px-3 text-[13px] text-muted-foreground hover:bg-muted/60 hover:text-foreground"
              >
                <Plus className="size-3.5" />
                {t("issue.addSubtask")}
              </button>
            )}
          </li>
        )}
      </ul>
    </Section>
  );
}

function Dependencies({
  issue,
  blockers,
  blocking,
  onAdd,
}: {
  issue: Issue;
  blockers: Issue[];
  blocking: Issue[];
  onAdd: (id: Id) => void;
}) {
  const { t } = useI18n();
  const { run, canWrite } = useWorkspace();
  const remove = (id: Id) =>
    run({
      type: "update_issue",
      id: issue.id,
      patch: { dependencies: issue.dependencies.filter((d) => d !== id) },
    }).catch(() => {});
  const group = (title: string, list: Issue[], removable: boolean) =>
    list.length > 0 && (
      <div>
        <h3 className="mb-1 text-xs text-muted-foreground">{title}</h3>
        <ul className="divide-y divide-border/70 rounded-lg border border-border">
          {list.map((b) => (
            <IssueRow
              key={b.id}
              issue={b}
              trailing={
                removable &&
                canWrite && (
                  <Button
                    variant="ghost"
                    size="icon"
                    className={revealOnHover}
                    aria-label={t("action.remove")}
                    onPress={() => remove(b.id)}
                  >
                    <X />
                  </Button>
                )
              }
            />
          ))}
        </ul>
      </div>
    );
  return (
    <Section
      title={t("issue.dependencies")}
      icon={<Lock className="size-3.5 text-muted-foreground" />}
      action={
        canWrite && (
          <IssuePicker
            exclude={[issue.id, ...issue.dependencies]}
            onPick={onAdd}
            trigger={
              <Button variant="ghost" size="sm">
                <Plus />
                {t("issue.addBlocker")}
              </Button>
            }
          />
        )
      }
    >
      <div className="space-y-3">
        {group(t("issue.blockedBy"), blockers, true)}
        {group(t("issue.blocks"), blocking, false)}
      </div>
    </Section>
  );
}

export function attachmentUrl(wsId: Id, id: Id) {
  return `/api/workspaces/${wsId}/attachments/${id}`;
}

function useUploader(issueId: Id) {
  const { t } = useI18n();
  const { upload } = useWorkspace();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const pick = async (list: FileList | null) => {
    if (!list) return;
    setBusy(true);
    try {
      const files = Array.from(list);
      const tooLarge = files.filter((f) => f.size > MAX_UPLOAD);
      for (const f of tooLarge) toast.error(t("attachments.tooLarge", { name: f.name }));
      await Promise.all(
        files.filter((f) => f.size <= MAX_UPLOAD).map((f) => upload(issueId, f).catch(() => {})),
      );
    } finally {
      setBusy(false);
    }
  };
  return { busy, pick };
}
type Uploader = ReturnType<typeof useUploader>;

function AttachButton({ uploader }: { uploader: Uploader }) {
  const { t } = useI18n();
  return (
    <FileTrigger allowsMultiple onSelect={(list) => void uploader.pick(list)}>
      <Button variant="ghost" size="sm" isDisabled={uploader.busy}>
        {uploader.busy ? <Loader2 aria-hidden className="animate-spin" /> : <Paperclip />}
        {uploader.busy ? t("attachments.uploading") : t("attachments.add")}
      </Button>
    </FileTrigger>
  );
}

function AttachmentChip({
  wsId,
  a,
  onRemove,
}: {
  wsId: Id;
  a: { id: Id; name: string; size: number };
  onRemove?: () => void;
}) {
  const { t } = useI18n();
  return (
    <li className="group flex items-center gap-2 rounded-lg border border-border bg-card px-2.5 py-1.5 text-[13px]">
      <FileText className="size-4 shrink-0 text-muted-foreground" />
      <a
        href={attachmentUrl(wsId, a.id)}
        download={a.name}
        className="min-w-0 flex-1 truncate hover:underline"
      >
        {a.name}
      </a>
      <span className="text-xs text-muted-foreground">{bytes(a.size)}</span>
      <a
        href={attachmentUrl(wsId, a.id)}
        download={a.name}
        aria-label={t("action.download")}
        className="text-muted-foreground hover:text-foreground"
      >
        <Download className="size-3.5" />
      </a>
      {onRemove && (
        <button
          type="button"
          aria-label={t("action.remove")}
          onClick={onRemove}
          className="text-muted-foreground hover:text-destructive"
        >
          <X className="size-3.5" />
        </button>
      )}
    </li>
  );
}

function Attachments({ issue, uploader }: { issue: Issue; uploader: Uploader }) {
  const { t } = useI18n();
  const { ws, run, canWrite } = useWorkspace();
  return (
    <Section
      title={t("issue.attachments")}
      icon={<Paperclip className="size-3.5 text-muted-foreground" />}
      action={canWrite && <AttachButton uploader={uploader} />}
    >
      <ul className="grid gap-1.5 sm:grid-cols-2">
        {issue.attachments.map((a) => (
          <AttachmentChip
            key={a.id}
            wsId={ws.id}
            a={a}
            onRemove={
              canWrite
                ? () =>
                    run({
                      type: "remove_attachment",
                      issue_id: issue.id,
                      attachment_id: a.id,
                    }).catch(() => {})
                : undefined
            }
          />
        ))}
      </ul>
    </Section>
  );
}

/** Issue events worth showing in the timeline. Comments render on their own. */
const EVENTS: Partial<Record<string, { label: Key; icon: LucideIcon }>> = {
  create_issue: { label: "timeline.create_issue", icon: CirclePlus },
  update_issue: { label: "timeline.update_issue", icon: Pencil },
  move_issue: { label: "timeline.move_issue", icon: CircleDot },
  restore_issue: { label: "timeline.restore_issue", icon: ArchiveRestore },
  issue_completed: { label: "timeline.issue_completed", icon: CircleCheck },
  add_attachment: { label: "timeline.add_attachment", icon: Paperclip },
  remove_attachment: { label: "timeline.remove_attachment", icon: Paperclip },
  add_source_link: { label: "timeline.add_source_link", icon: Link2 },
  log_time: { label: "timeline.log_time", icon: Clock },
  update_time: { label: "timeline.update_time", icon: Clock },
};
const FIELDS: Partial<Record<string, { label: Key; icon: LucideIcon }>> = {
  title: { label: "field.title", icon: Pencil },
  description: { label: "field.description", icon: Pencil },
  stage: { label: "field.stage", icon: CircleDot },
  assignee: { label: "field.assignee", icon: UserRound },
  priority: { label: "field.priority", icon: Signal },
  labels: { label: "field.labels", icon: Tag },
  estimate: { label: "field.estimate", icon: Gauge },
  deadline: { label: "field.deadline", icon: CalendarDays },
  project: { label: "field.project", icon: FolderKanban },
  milestone: { label: "field.milestone", icon: Flag },
  sprint: { label: "field.sprint", icon: CalendarRange },
  parent: { label: "issue.parent", icon: GitFork },
  dependencies: { label: "issue.dependencies", icon: Lock },
};
const PAGE = 30;

type TimelineItem =
  | { kind: "comment"; at: string; comment: Comment }
  | { kind: "event"; at: string; event: Activity };

function Timeline({ issue }: { issue: Issue }) {
  const { t } = useI18n();
  const [limit, setLimit] = useState(PAGE);
  const comments = useComments(issue.id);
  const activity = useActivity(issue.id);
  const time = useTimeEntries(issue.id);
  const entries = new Map(time.items.map((e) => [e.id, e]));
  const items = [
    ...comments.items.map((c): TimelineItem => ({ kind: "comment", at: c.created_at, comment: c })),
    ...activity.items
      .filter(
        (a) =>
          a.entity_id !== null &&
          EVENTS[a.action] &&
          (a.entity_id === issue.id || entries.has(a.entity_id)),
      )
      .map((a): TimelineItem => ({ kind: "event", at: a.at, event: a })),
  ].sort((a, b) => +new Date(a.at) - +new Date(b.at));
  const hidden = Math.max(0, items.length - limit);
  const loadingTimeline = (comments.loading || activity.loading) && items.length === 0;
  return (
    <Section title={t("activity.title")}>
      {loadingTimeline && (
        <div aria-busy="true" className="space-y-3">
          {[0, 1].map((i) => (
            <div key={i} className="flex items-center gap-3">
              <span className="size-7 shrink-0 animate-pulse rounded-full bg-muted" />
              <span className="h-12 flex-1 animate-pulse rounded-lg bg-muted" />
            </div>
          ))}
        </div>
      )}
      {items.length > 0 && (
        // The line sits behind the list. Event dots ride on it and comment cards cover it.
        <ol className="relative space-y-3 before:absolute before:inset-y-3 before:left-3.5 before:w-px before:-translate-x-1/2 before:bg-border">
          {hidden > 0 && (
            <li className="relative flex items-center gap-3">
              <TimelineDot>
                <ChevronsUp />
              </TimelineDot>
              <Button
                variant="ghost"
                size="sm"
                className="-ml-1.5"
                onPress={() => setLimit((l) => l + PAGE)}
              >
                {t("timeline.older", { n: Math.min(hidden, PAGE) })}
              </Button>
            </li>
          )}
          {items
            .slice(hidden)
            .map((item) =>
              item.kind === "comment" ? (
                <CommentItem key={item.comment.id} comment={item.comment} />
              ) : (
                <EventItem key={item.event.id} event={item.event} entries={entries} />
              ),
            )}
        </ol>
      )}
      <QueryStatus query={comments} />
      <QueryStatus query={activity} />
      <Composer issue={issue} hasItems={items.length > 0} />
    </Section>
  );
}

function TimelineDot({ className, children }: { className?: string; children: React.ReactNode }) {
  // The outer box keeps the row height and the dot centered on the line; only the dot itself is small.
  return (
    <span className="grid size-7 shrink-0 place-items-center">
      <span
        className={cn(
          "grid size-5 place-items-center rounded-full border border-border bg-background text-muted-foreground [&_svg]:size-3",
          className,
        )}
      >
        {children}
      </span>
    </span>
  );
}

function EventItem({ event, entries }: { event: Activity; entries: Map<Id, TimeEntry> }) {
  const { t, lang } = useI18n();
  const { member } = useWorkspace();
  const fields = (event.fields ?? []).flatMap((f) => FIELDS[f] ?? []);
  const entry = event.entity_id ? entries.get(event.entity_id) : undefined;
  const meta = EVENTS[event.action];
  const label =
    event.action === "update_issue" && fields.length
      ? t("timeline.changed", {
          fields: fields.map((f) => t(f.label).toLocaleLowerCase(lang)).join(", "),
        })
      : event.action === "log_time" && entry
        ? t("timeline.log_time", { time: formatMinutes(entry.minutes) })
        : meta
          ? t(meta.label)
          : activityLabel(t, event.action);
  // A single-field change shows that field's icon; several fields fall back to the generic edit icon.
  const Icon = (fields.length === 1 ? fields[0].icon : meta?.icon) ?? Pencil;
  return (
    <li className="relative flex items-center gap-3 text-xs text-muted-foreground">
      <TimelineDot className={cn(event.action === "issue_completed" && "text-success")}>
        <Icon />
      </TimelineDot>
      <span className="min-w-0">
        <span className="font-medium text-foreground">
          {member(event.actor)?.display_name ?? t("person.unknown")}
        </span>{" "}
        {label} ·{" "}
        <time dateTime={event.at} title={new Date(event.at).toLocaleString(lang)}>
          {relativeTime(event.at, lang)}
        </time>
      </span>
    </li>
  );
}

function CommentItem({ comment: c }: { comment: Comment }) {
  const { t, lang } = useI18n();
  const { ws, me, members, member, run, canAdmin } = useWorkspace();
  const editVersion = useRef(c.version);
  const retryEdit = useRef(false);
  const [editBody, setEditBody] = useState<string | null>(null);
  const [confirm, setConfirm] = useState(false);
  const [discarding, setDiscarding] = useState(false);
  const m = member(c.author);
  const mine = c.author === me;
  const cancelEdit = () =>
    editBody !== null && editBody !== c.body ? setDiscarding(true) : setEditBody(null);
  const save = () => {
    if (!editBody?.trim()) return;
    run(
      {
        type: "edit_comment",
        id: c.id,
        body: editBody.trim(),
        mentions: mentionsIn(editBody, members),
      },
      { expectedVersions: { [c.id]: retryEdit.current ? c.version : editVersion.current } },
    )
      .then(() => setEditBody(null))
      .catch(() => {
        retryEdit.current = true;
      });
  };
  return (
    // The avatar takes the timeline dot's slot, so it sits on the line and the card lines up with event text.
    <li className="group relative flex gap-3">
      <span className="flex w-7 shrink-0 justify-center pt-[7px]">
        <Avatar
          name={m?.display_name ?? "?"}
          src={m?.avatar_url}
          size={24}
          className="ring-4 ring-background"
        />
      </span>
      <div className="min-w-0 flex-1 rounded-lg border border-border bg-card shadow-xs">
        <div className="flex h-9 items-center gap-1.5 pl-3.5 pr-1 text-[13px]">
          <Link
            to={`/${ws.id}/people/${c.author}`}
            className="truncate font-semibold hover:underline"
          >
            {m?.display_name ?? t("person.unknown")}
          </Link>
          <time
            dateTime={c.created_at}
            title={new Date(c.created_at).toLocaleString(lang)}
            className="shrink-0 text-xs text-muted-foreground"
          >
            {relativeTime(c.created_at, lang)}
          </time>
          {c.edited_at && (
            <span className="shrink-0 text-xs text-muted-foreground">· {t("comment.edited")}</span>
          )}
          {(mine || canAdmin) && editBody === null && (
            <span className={cn("ml-auto flex", revealOnHover)}>
              {mine && (
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={t("action.edit")}
                  onPress={() => {
                    editVersion.current = c.version;
                    retryEdit.current = false;
                    setEditBody(c.body);
                  }}
                >
                  <Pencil />
                </Button>
              )}
              <Button
                variant="ghost"
                size="icon"
                aria-label={t("action.delete")}
                onPress={() => setConfirm(true)}
              >
                <Trash2 />
              </Button>
            </span>
          )}
        </div>
        <div className="-mt-0.5 px-3.5 pb-2.5">
          {editBody !== null ? (
            <div
              className="space-y-2"
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  e.stopPropagation();
                  cancelEdit();
                }
              }}
            >
              <MarkdownEditor
                label={t("comment.edit")}
                value={editBody}
                onChange={setEditBody}
                autoFocus
                minRows={3}
                onSubmit={save}
              />
              <ConfirmDialog
                title={t("draft.discardTitle")}
                description={t("draft.discardSub")}
                confirmLabel={t("draft.discard")}
                isOpen={discarding}
                onOpenChange={setDiscarding}
                onConfirm={async () => setEditBody(null)}
              />
              <div className="flex justify-end gap-2">
                <Button variant="ghost" onPress={cancelEdit}>
                  {t("action.cancel")}
                </Button>
                <Button variant="primary" isDisabled={!editBody.trim()} onPress={save}>
                  {t("action.save")}
                </Button>
              </div>
            </div>
          ) : (
            <Markdown text={c.body} className="text-[13.5px] leading-[1.6]" />
          )}
          {c.attachments.length > 0 && (
            <ul className="mt-3 grid gap-1.5 sm:grid-cols-2">
              {c.attachments.map((a) => (
                <AttachmentChip key={a.id} wsId={ws.id} a={a} />
              ))}
            </ul>
          )}
        </div>
      </div>
      <ConfirmDialog
        title={t("comment.deleteTitle")}
        isOpen={confirm}
        onOpenChange={setConfirm}
        onConfirm={() => run({ type: "delete_comment", id: c.id }, { quiet: true })}
      />
    </li>
  );
}

function Composer({ issue, hasItems }: { issue: Issue; hasItems: boolean }) {
  const { t } = useI18n();
  const { members, run, upload, canWrite } = useWorkspace();
  const toast = useToast();
  const [body, setBody] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  // Set when the comment was posted but some files weren't, so a retry attaches them to that comment.
  const [retry, setRetry] = useState<{ commentId: Id; files: File[] } | null>(null);
  const { pending: busy, error, guard } = usePending();
  const box = useRef<HTMLDivElement>(null);
  if (!canWrite) return null;

  const uploadAll = async (commentId: Id, list: File[]) => {
    const failed: File[] = [];
    await Promise.all(list.map((f) => upload(issue.id, f, commentId).catch(() => failed.push(f))));
    setRetry(failed.length ? { commentId, files: failed } : null);
    return failed;
  };

  const addFiles = (list: FileList | null) => {
    if (!list) return;
    const ok = Array.from(list).filter((f) => {
      if (f.size <= MAX_UPLOAD) return true;
      toast.error(t("attachments.tooLarge", { name: f.name }));
      return false;
    });
    setFiles((l) => [...l, ...ok]);
  };
  const post = () =>
    guard(async () => {
      if (!body.trim()) return;
      const id = await run(
        {
          type: "add_comment",
          issue_id: issue.id,
          body: body.trim(),
          mentions: mentionsIn(body, members),
          attachments: [],
        },
        { quiet: true },
      );
      // The comment exists now. Clear the text so it can't be posted twice, and keep any file that failed.
      setBody("");
      setFiles([]);
      if (id && files.length) {
        const failed = await uploadAll(id, files);
        if (failed.length)
          toast.error(t("attachments.someFailed", { n: failed.length, total: files.length }));
      }
      requestAnimationFrame(() =>
        box.current?.scrollIntoView({ block: "nearest", behavior: "smooth" }),
      );
    });
  const retryUpload = () =>
    guard(async () => {
      if (retry) await uploadAll(retry.commentId, retry.files);
    });

  return (
    <div ref={box} className={cn("space-y-2", hasItems && "mt-6")}>
      <MarkdownEditor
        label={t("comment.new")}
        value={body}
        onChange={setBody}
        placeholder={t("comment.placeholder")}
        minRows={3}
        onSubmit={post}
      />
      {files.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {files.map((f, i) => (
            <li
              key={i}
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted px-2 py-1 text-xs"
            >
              <Paperclip className="size-3" />
              {f.name}
              <button
                type="button"
                aria-label={t("action.remove")}
                disabled={busy}
                onClick={() => setFiles((l) => l.filter((_, j) => j !== i))}
              >
                <X className="size-3" />
              </button>
            </li>
          ))}
        </ul>
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      {retry && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-2 rounded-md border border-destructive/40 px-3 py-2 text-xs"
        >
          <span className="flex-1">
            {t("attachments.retryNote", { n: retry.files.length })}{" "}
            {retry.files.map((f) => f.name).join(", ")}
          </span>
          <Button size="sm" variant="secondary" isDisabled={busy} onPress={retryUpload}>
            {t("attachments.retry")}
          </Button>
          <Button size="sm" variant="ghost" onPress={() => setRetry(null)}>
            {t("action.dismiss")}
          </Button>
        </div>
      )}
      <div className="flex items-center justify-between">
        <FileTrigger allowsMultiple onSelect={addFiles}>
          <Button variant="ghost" size="sm" isDisabled={busy}>
            <Paperclip />
            {t("attachments.add")}
          </Button>
        </FileTrigger>
        <div className="flex items-center gap-2">
          <span className="hidden text-xs text-muted-foreground sm:block">
            {t("comment.hint", { key: modKey })}
          </span>
          <Button variant="primary" isDisabled={!body.trim() || busy} onPress={post}>
            {busy && <Loader2 aria-hidden className="animate-spin" />}
            {busy ? t("comment.sending") : t("comment.send")}
          </Button>
        </div>
      </div>
    </div>
  );
}

function activityLabel(t: ReturnType<typeof useI18n>["t"], action: string) {
  const key = `activity.${action}`;
  return isTranslationKey(key) ? t(key) : action.replaceAll("_", " ").replace(/\./g, " ");
}
