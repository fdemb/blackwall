import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { FileTrigger, Form } from "react-aria-components";
import { Link } from "react-router";
import { Download, FileText, Loader2, Lock, Paperclip, Plus, X } from "lucide-react";
import { Avatar } from "~/components/ui/avatar";
import { Button } from "~/components/ui/button";
import { Input } from "~/components/ui/field";
import { ConfirmDialog } from "~/components/app/confirm";
import { useToast } from "~/components/ui/toast";
import { Markdown, MarkdownEditor } from "~/components/app/markdown";
import { IssuePicker } from "~/components/app/issue-picker";
import { StageIcon } from "~/components/app/icons";
import { isDone, stageOf } from "~/lib/filters";
import { bytes, MAX_UPLOAD } from "~/lib/format";
import { IssueKey, issueKeyLength } from "~/components/app/issue-key";
import { useI18n } from "~/lib/i18n";
import { usePending } from "~/lib/use-pending";
import { useWorkspace } from "~/lib/workspace";
import { cn } from "~/lib/utils";
import { issueCapabilities } from "~/lib/ownership";
import type { Id, Issue } from "~/lib/types";
import { Section, revealOnHover } from "./issue-section";

const WS_RUN = /\s+/g;
const NEWLINE = /\n/g;

export function TitleField({
  issue,
  onSave,
}: {
  issue: Issue;
  onSave: (title: string, version: number) => void;
}) {
  const { t } = useI18n();
  const { canWrite: workspaceCanWrite } = useWorkspace();
  const canWrite = workspaceCanWrite && issueCapabilities(issue).edit;
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

export function Description({
  issue,
  onSave,
}: {
  issue: Issue;
  onSave: (d: string, version: number) => Promise<boolean>;
}) {
  const { t } = useI18n();
  const { canWrite: workspaceCanWrite } = useWorkspace();
  const canWrite = workspaceCanWrite && issueCapabilities(issue).edit;
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

function IssueRow({
  issue,
  trailing,
  keyLength,
}: {
  issue: Issue;
  trailing?: React.ReactNode;
  keyLength: number;
}) {
  const { ws, member } = useWorkspace();
  const st = stageOf(ws, issue);
  const assignee = member(issue.assignee);
  return (
    <li className="group flex h-9 items-center gap-2.5 px-3  hover:bg-muted/60">
      <Link
        to={`/${ws.id}/issue/${issue.id}`}
        className="flex min-w-0 flex-1 items-center gap-2.5 self-stretch"
      >
        {st && <StageIcon kind={st.kind} />}
        <IssueKey number={issue.number} length={keyLength} className="text-muted-foreground" />
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

export function Subtasks({
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
  const { ws, run, canWrite: workspaceCanWrite } = useWorkspace();
  const canWrite = workspaceCanWrite && issueCapabilities(issue).edit;
  const [title, setTitle] = useState("");
  const { pending, guard } = usePending();
  const done = subs.filter((s) => isDone(ws, s)).length;
  const keyLength = issueKeyLength(subs);
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
          <span className=" tabular-nums text-muted-foreground">
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
          <IssueRow key={s.id} issue={s} keyLength={keyLength} />
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
                className="flex h-9 w-full items-center gap-2 px-3  text-muted-foreground hover:bg-muted/60 hover:text-foreground"
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

export function Dependencies({
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
  const { run, canWrite: workspaceCanWrite } = useWorkspace();
  const canWrite = workspaceCanWrite && issueCapabilities(issue).edit;
  const keyLength = issueKeyLength([...blockers, ...blocking]);
  const remove = (id: Id) =>
    run({
      type: "update_issue",
      id: issue.id,
      patch: { dependencies: issue.dependencies.filter((d) => d !== id) },
    }).catch(() => {});
  const group = (title: string, list: Issue[], removable: boolean) =>
    list.length > 0 && (
      <div>
        <h3 className="mb-1  text-muted-foreground">{title}</h3>
        <ul className="divide-y divide-border/70 rounded-lg border border-border">
          {list.map((b) => (
            <IssueRow
              key={b.id}
              issue={b}
              keyLength={keyLength}
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

export function useUploader(issueId: Id) {
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

export function AttachButton({ uploader }: { uploader: Uploader }) {
  const { t } = useI18n();
  const { offline } = useWorkspace();
  return (
    <FileTrigger allowsMultiple onSelect={(list) => void uploader.pick(list)}>
      <Button variant="ghost" size="sm" isDisabled={uploader.busy || offline}>
        {uploader.busy ? <Loader2 aria-hidden className="animate-spin" /> : <Paperclip />}
        {uploader.busy ? t("attachments.uploading") : t("attachments.add")}
      </Button>
    </FileTrigger>
  );
}

export function AttachmentChip({
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
    <li className="group flex items-center gap-2 rounded-lg border border-border bg-card px-2.5 py-1.5 ">
      <FileText className="size-4 shrink-0 text-muted-foreground" />
      <a
        href={attachmentUrl(wsId, a.id)}
        download={a.name}
        className="min-w-0 flex-1 truncate hover:underline"
      >
        {a.name}
      </a>
      <span className=" text-muted-foreground">{bytes(a.size)}</span>
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

export function Attachments({ issue, uploader }: { issue: Issue; uploader: Uploader }) {
  const { t } = useI18n();
  const { ws, run, canWrite: workspaceCanWrite } = useWorkspace();
  const canWrite = workspaceCanWrite && issueCapabilities(issue).remove_attachment;
  return (
    <Section
      title={t("issue.attachments")}
      icon={<Paperclip className="size-3.5 text-muted-foreground" />}
      action={
        workspaceCanWrite &&
        issueCapabilities(issue).add_attachment && <AttachButton uploader={uploader} />
      }
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
