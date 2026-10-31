import { useEffect, useRef, useState } from "react";
import { FileTrigger } from "react-aria-components";
import { Link } from "react-router";
import {
  Archive,
  ArchiveRestore,
  ChevronsUp,
  CircleCheck,
  CircleDot,
  CirclePlus,
  Clock,
  Link2,
  Loader2,
  Paperclip,
  Pencil,
  Trash2,
  X,
  type LucideIcon,
} from "lucide-react";
import { Avatar } from "~/components/ui/avatar";
import { Button } from "~/components/ui/button";
import { ConfirmDialog } from "~/components/app/confirm";
import { useToast } from "~/components/ui/toast";
import { Markdown } from "~/components/app/markdown";
import { MarkdownEditor } from "~/components/app/editor/rich-editor";
import { formatMinutes, MAX_UPLOAD, relativeTime, sprintLabel } from "~/lib/format";
import { describeChanges, type ChangeNames } from "~/lib/activity-changes";
import { useI18n, isTranslationKey, type Key } from "~/lib/i18n";
import { usePending } from "~/lib/use-pending";
import { useActivity, useComments, useTimeEntries } from "~/lib/queries";
import { QueryStatus } from "~/components/app/query-status";
import { useWorkspace } from "~/lib/workspace";
import { cn } from "~/lib/utils";
import type { Activity, Comment, Id, Issue, TimeEntry } from "~/lib/types";
import { trackerProviderName } from "~/lib/trackers";
import { ISSUE_FIELDS } from "~/lib/issue-fields";
import { Section, revealOnHover } from "./issue-section";
import { AttachmentChip } from "./issue-content";

const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.userAgent);
const modKey = IS_MAC ? "⌘" : "Ctrl";
/** Issue events worth showing in the timeline. Comments render on their own. */
const EVENTS: Partial<Record<string, { label: Key; icon: LucideIcon }>> = {
  create_issue: { label: "timeline.create_issue", icon: CirclePlus },
  update_issue: { label: "timeline.update_issue", icon: Pencil },
  move_issue: { label: "timeline.move_issue", icon: CircleDot },
  restore_issue: { label: "timeline.restore_issue", icon: ArchiveRestore },
  archive_issue: { label: "timeline.archive_issue", icon: Archive },
  unarchive_issue: { label: "timeline.unarchive_issue", icon: ArchiveRestore },
  issue_completed: { label: "timeline.issue_completed", icon: CircleCheck },
  add_attachment: { label: "timeline.add_attachment", icon: Paperclip },
  remove_attachment: { label: "timeline.remove_attachment", icon: Paperclip },
  add_source_link: { label: "timeline.add_source_link", icon: Link2 },
  log_time: { label: "timeline.log_time", icon: Clock },
  update_time: { label: "timeline.update_time", icon: Clock },
};
const PAGE = 30;
// How long the list waits for a scope that hasn't landed before it shows what it has.
const GATE_MS = 1500;

type TimelineItem =
  | { kind: "comment"; at: string; comment: Comment }
  | { kind: "event"; at: string; event: Activity };

export function Timeline({ issue }: { issue: Issue }) {
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
  const { offline } = useWorkspace();
  // Comments and events interleave by time, so the list waits for both instead of reordering when
  // the second lands. It stops waiting for a scope that can't land soon, and for a comment the user
  // just posted. Once shown it stays, even while a bootstrap reloads the scopes. Until then a
  // skeleton the size of the creation event holds its space, invisible through a short load.
  const [waited, setWaited] = useState(false);
  const show =
    !(comments.loading || activity.loading) ||
    Boolean(comments.error || activity.error) ||
    offline ||
    waited ||
    comments.overlayOnly;
  const [ready, setReady] = useState(show);
  if (show && !ready) setReady(true);
  useEffect(() => {
    if (ready) return;
    const timer = setTimeout(() => setWaited(true), GATE_MS);
    return () => clearTimeout(timer);
  }, [ready]);
  // Screen readers announce a status region's text changes, not a region that mounts already
  // filled, so the region is always there and the text arrives after mount.
  const [announce, setAnnounce] = useState(false);
  useEffect(() => setAnnounce(!ready), [ready]);
  const listed = ready && items.length > 0;
  return (
    <Section title={t("activity.title")}>
      <p role="status" className="sr-only">
        {announce ? t("action.loading") : ""}
      </p>
      {!ready && (
        <div
          aria-hidden="true"
          className="animate-in fade-in fill-mode-both delay-300 flex min-h-7 items-center gap-3"
        >
          <span className="grid size-7 shrink-0 place-items-center">
            <span className="size-5 animate-pulse rounded-full bg-muted" />
          </span>
          <span className="h-4 w-48 animate-pulse rounded bg-muted" />
        </div>
      )}
      {listed && (
        // The line sits behind the list. Event dots ride on it and comment cards cover it.
        <ol className="relative space-y-2 before:absolute before:inset-y-3 before:left-3.5 before:w-px before:-translate-x-1/2 before:bg-border">
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
      {comments.error && <QueryStatus query={comments} />}
      {activity.error && <QueryStatus query={activity} />}
      <Composer issue={issue} />
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
  const names = useChangeNames();
  const fields = (event.fields ?? []).flatMap((f) => ISSUE_FIELDS[f] ?? []);
  const entry = event.entity_id ? entries.get(event.entity_id) : undefined;
  const meta = EVENTS[event.action];
  // Board moves before stored values have no detail to add to "moved this issue".
  const detailed =
    fields.length > 0 &&
    (event.action === "update_issue" ||
      (event.action === "move_issue" && Boolean(event.changes?.length)));
  const label = detailed
    ? describeChanges(event.fields ?? [], event.changes ?? [], { t, lang, names }).join(", ")
    : event.action === "log_time" && entry
      ? t("timeline.log_time", { time: formatMinutes(entry.minutes) })
      : meta
        ? t(meta.label)
        : activityLabel(t, event.action);
  // A single-field change shows that field's icon; several fields fall back to the generic edit icon.
  const Icon = (fields.length === 1 ? fields[0].icon : meta?.icon) ?? Pencil;
  return (
    <li className="relative flex min-h-7 items-center gap-3 text-sm text-muted-foreground">
      <TimelineDot className={cn(event.action === "issue_completed" && "text-success")}>
        <Icon />
      </TimelineDot>
      <span className="min-w-0">
        <span className="font-medium text-foreground">
          {member(event.actor)?.display_name ?? t("person.unknown")}
        </span>{" "}
        {event.via && <>{t("timeline.via", { name: event.via.name })} </>}
        {label}{" "}
        <time
          dateTime={event.at}
          title={new Date(event.at).toLocaleString(lang)}
          className="text-muted-foreground/70"
        >
          {relativeTime(event.at, lang)}
        </time>
      </span>
    </li>
  );
}

/** Current names for the ids an activity row stores. */
function useChangeNames(): ChangeNames {
  const { t } = useI18n();
  const { ws, member, team, stage, issueRef } = useWorkspace();
  return {
    team: (id) => team(id)?.name,
    stage: (id) => stage(id)?.name,
    assignee: (id) => member(id)?.display_name ?? t("person.unknown"),
    labels: (id) => ws.labels.find((l) => l.id === id)?.name,
    project: (id) => ws.projects.find((p) => p.id === id)?.name,
    milestone: (id) => ws.milestones.find((m) => m.id === id)?.name,
    sprint: (id) => {
      const sprint = ws.sprints.find((s) => s.id === id);
      return sprint && sprintLabel(sprint);
    },
    // issueRef falls back to the id itself when the issue is gone.
    parent: (id) => {
      const ref = issueRef(id);
      return ref === id ? undefined : ref;
    },
  };
}

function CommentItem({ comment: c }: { comment: Comment }) {
  const { t, lang } = useI18n();
  const { ws, me, member, run, canAdmin } = useWorkspace();
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
        mentions: [],
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
    <li className="group relative flex gap-3 py-1">
      <span className="flex w-7 shrink-0 justify-center pt-[7px]">
        <Avatar
          name={m?.display_name ?? "?"}
          src={m?.avatar_url}
          size={24}
          className="ring-4 ring-background"
        />
      </span>
      <div className="min-w-0 flex-1 rounded-lg border border-border bg-card shadow-xs">
        <div className="flex h-9 items-center gap-1.5 pl-3.5 pr-1">
          <Link
            to={`/${ws.slug}/people/${c.author}`}
            className="truncate font-medium hover:underline"
          >
            {m?.display_name ?? t("person.unknown")}
          </Link>
          <time
            dateTime={c.created_at}
            title={new Date(c.created_at).toLocaleString(lang)}
            className="shrink-0 text-sm text-muted-foreground"
          >
            {relativeTime(c.created_at, lang)}
          </time>
          {c.tracker?.provider && (
            <span className="min-w-0 truncate text-sm text-muted-foreground">
              {c.tracker.author_name
                ? t("tracker.commentVia", {
                    provider: trackerProviderName(c.tracker.provider),
                    name: c.tracker.author_name,
                  })
                : t("tracker.commentViaProvider", {
                    provider: trackerProviderName(c.tracker.provider),
                  })}
            </span>
          )}
          {c.via && (
            <span className="truncate text-sm text-muted-foreground">
              {t("timeline.via", { name: c.via.name })}
            </span>
          )}
          {c.edited_at && (
            <span className="shrink-0 text-sm text-muted-foreground">· {t("comment.edited")}</span>
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
                className="min-h-16"
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

function Composer({ issue }: { issue: Issue }) {
  const { t } = useI18n();
  const { run, upload, canWrite, offline } = useWorkspace();
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
    await Promise.all(
      list.map((f) => upload(issue.id, f, { commentId, quiet: true }).catch(() => failed.push(f))),
    );
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
          mentions: [],
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
    <div ref={box} className="mt-6 space-y-2">
      <MarkdownEditor
        label={t("comment.new")}
        value={body}
        onChange={setBody}
        placeholder={t("comment.placeholder")}
        className="min-h-16"
        onSubmit={post}
      />
      {files.length > 0 && (
        <ul className="flex flex-wrap gap-1.5">
          {files.map((f, i) => (
            <li
              key={i}
              className="inline-flex items-center gap-1.5 rounded-md border border-border bg-muted px-2 py-1 "
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
        <p role="alert" className=" text-destructive">
          {error}
        </p>
      )}
      {retry && (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-2 rounded-md border border-destructive/40 px-3 py-2 "
        >
          <span className="flex-1">
            {t("attachments.retryNote", { count: retry.files.length })}{" "}
            {retry.files.map((f) => f.name).join(", ")}
          </span>
          <Button size="sm" variant="secondary" isDisabled={busy || offline} onPress={retryUpload}>
            {t("attachments.retry")}
          </Button>
          <Button size="sm" variant="ghost" onPress={() => setRetry(null)}>
            {t("action.dismiss")}
          </Button>
        </div>
      )}
      <div className="flex items-center justify-between">
        <FileTrigger allowsMultiple onSelect={addFiles}>
          <Button variant="ghost" size="sm" isDisabled={busy || offline}>
            <Paperclip />
            {t("attachments.add")}
          </Button>
        </FileTrigger>
        <div className="flex items-center gap-2">
          <span className="hidden  text-muted-foreground sm:block">
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
