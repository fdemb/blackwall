import { useState } from "react";
import { Disclosure, DisclosurePanel, Heading } from "react-aria-components";
import { Link, Navigate, useLocation, useNavigate, useParams } from "react-router";
import {
  Archive,
  ArchiveRestore,
  Bell,
  BellOff,
  ChevronLeft,
  ChevronRight,
  Link2,
  Lock,
  MoreHorizontal,
  Plus,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "~/components/ui/button";
import { ConfirmDialog } from "~/components/app/confirm";
import { SaveStatus } from "~/components/app/save-status";
import { Menu, MenuItem, MenuPopover, MenuTrigger } from "~/components/ui/menu";
import { useToast } from "~/components/ui/toast";
import { Tip } from "~/components/ui/tooltip";
import { IssuePicker } from "~/components/app/issue-picker";
import { AssigneePicker, PriorityPicker, StagePicker } from "~/components/app/pickers";
import { EmptyState, Page, TeamCrumb } from "~/components/app/page";
import { IssueKey } from "~/components/app/issue-key";
import { isDoneOnly } from "~/lib/filters";
import { useDocumentTitle } from "~/lib/title";
import { teamPath } from "~/lib/last-view";
import { useI18n } from "~/lib/i18n";
import { useIssueDetail, useIssueRef, type IssueDetail } from "~/lib/queries";
import { QueryStatus } from "~/components/app/query-status";
import { useWorkspace } from "~/lib/workspace";
import { cn } from "~/lib/utils";
import { issueCapabilities } from "~/lib/ownership";
import { OpenProjectNotice } from "~/components/app/issue-parts";
import type { Id, Issue } from "~/lib/types";
import { CoreProperties, Properties, useIssuePatch } from "~/components/app/issue-properties";
import {
  TitleField,
  Description,
  Subtasks,
  Dependencies,
  useUploader,
  AttachButton,
  Attachments,
} from "~/components/app/issue-content";
import { Timeline } from "~/components/app/issue-timeline";
import { revealOnHover } from "~/components/app/issue-section";

export default function IssuePage() {
  const { issueKey = "" } = useParams();
  return <IssueRoute key={issueKey} issueRef={issueKey} />;
}

/**
 * Follows the issue the URL first named. A locally created issue carries a predicted key; when a
 * pull brings a different number, the key changes and the URL is replaced with the new one.
 */
function IssueRoute({ issueRef }: { issueRef: string }) {
  const { ws } = useWorkspace();
  const location = useLocation();
  const inInbox = location.pathname.startsWith(`/${ws.slug}/inbox/`);
  const resolved = useIssueRef(issueRef);
  const [opened, setOpened] = useState(resolved);
  if (opened === undefined && resolved !== undefined) setOpened(resolved);
  const detail = useIssueDetail(opened ?? resolved ?? "");
  const issue = detail.issue;
  if (issue && issue.key !== issueRef)
    return (
      <Navigate to={location.pathname.replace(/[^/]+$/, issue.key) + location.search} replace />
    );
  if (detail.missing)
    return (
      <Navigate
        to={inInbox ? `/${ws.slug}/inbox${location.search}` : `/${ws.slug}/my-issues`}
        replace
      />
    );
  if (!issue || detail.error)
    return (
      <Page>
        <QueryStatus query={{ ...detail, hasMore: false, loadMore: detail.retry }} />
      </Page>
    );
  if (issue.deleted_at) return <RecoverableIssue issue={issue} wsSlug={ws.slug} state="deleted" />;
  if (issue.archived_at)
    return <RecoverableIssue issue={issue} wsSlug={ws.slug} state="archived" />;
  return <IssueView key={issue.id} issue={issue} detail={detail} />;
}

/** A link to an archived or trashed issue says which issue it was and offers the way back. */
function RecoverableIssue({
  issue,
  wsSlug,
  state,
}: {
  issue: Issue;
  wsSlug: string;
  state: "archived" | "deleted";
}) {
  const { t } = useI18n();
  const { run, canWrite: workspaceCanWrite } = useWorkspace();
  const toast = useToast();
  useDocumentTitle(`${issue.key} ${issue.title}`);
  const archived = state === "archived";
  // Imported issues can be unarchived but not restored from the trash.
  const canWrite = workspaceCanWrite && (archived || issueCapabilities(issue).edit);
  const subtitle = canWrite ? t(archived ? "issue.archivedSub" : "issue.deletedSub") : "";
  const recover = () =>
    run({ type: archived ? "unarchive_issue" : "restore_issue", id: issue.id })
      .then(() => toast.show(t(archived ? "issue.unarchived" : "issue.restored")))
      .catch(() => {});
  return (
    <Page>
      <EmptyState
        icon={archived ? <Archive /> : <Trash2 />}
        title={`${issue.key} ${issue.title}`}
        description={`${t(archived ? "issue.archived" : "issue.deleted")}. ${subtitle}`.trim()}
        action={
          <div className="flex items-center gap-3">
            {canWrite && (
              <Button variant="primary" onPress={recover}>
                <ArchiveRestore />
                {t(archived ? "issue.unarchive" : "issue.restore")}
              </Button>
            )}
            <Link
              className="text-primary hover:underline"
              to={`/${wsSlug}/${archived ? "archive" : "trash"}`}
            >
              {t(archived ? "nav.archive" : "nav.trash")}
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
  const { ws, me, run, team, canWrite: workspaceCanWrite } = useWorkspace();
  const canWrite = workspaceCanWrite && issueCapabilities(issue).edit;
  const inInbox = location.pathname.startsWith(`/${ws.slug}/inbox/`);
  const tm = team(issue.team_id);
  useDocumentTitle(`${issue.key} ${issue.title}`);
  const patch = useIssuePatch(issue);
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
    inInbox
      ? nav(`/${ws.slug}/inbox${location.search}`, { preventScrollReset: true })
      : location.key === "default"
        ? nav(teamPath(ws.slug, tm?.key ?? ""))
        : nav(-1);

  return (
    <Page className="@container/issue min-w-0 flex-row overflow-hidden">
      <div className="flex min-w-0 flex-1 flex-col">
        <header className="flex h-12 shrink-0 items-center gap-1.5 border-b border-border px-3">
          <Button variant="ghost" size="icon" aria-label={t("action.back")} onPress={goBack}>
            <ChevronLeft />
          </Button>
          <div className="flex min-w-0 items-center gap-1.5">
            {tm && (
              <>
                <TeamCrumb team={tm} wsSlug={ws.slug} />
                <ChevronRight
                  aria-hidden="true"
                  className="size-3.5 shrink-0 text-muted-foreground/60"
                />
              </>
            )}
            <IssueKey value={issue.key} className="font-medium" />
          </div>
          <div className="ml-auto flex items-center gap-1">
            <SaveStatus />
            <Tip label={following ? t("issue.unfollow") : t("issue.follow")}>
              <Button
                variant="ghost"
                size="icon-lg"
                aria-label={following ? t("issue.unfollow") : t("issue.follow")}
                aria-pressed={following}
                className={cn(following && "text-primary")}
                onPress={() =>
                  run({ type: "follow", issue_id: issue.id, following: !following }).catch(() => {})
                }
              >
                {following ? <BellOff /> : <Bell />}
              </Button>
            </Tip>
            <IssueMenu
              issue={issue}
              canWrite={canWrite}
              onDelete={() => setConfirm(true)}
              onArchived={goBack}
            />
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="mx-auto w-full max-w-[46rem] px-5 py-6 @min-[48rem]/issue:px-10 @min-[48rem]/issue:py-10">
            <h1 className="sr-only">
              {t("issue.titleHeading", { key: issue.key, title: issue.title })}
            </h1>
            <OpenProjectNotice issue={issue} />
            {parent && (
              <ParentLink
                parent={parent}
                canWrite={canWrite}
                onRemove={() => patch({ clear_parent: true })}
              />
            )}
            <TitleField issue={issue} onSave={(title, version) => patch({ title }, version)} />
            <TriageChips issue={issue} canWrite={canWrite} />
            <CollapsedProperties issue={issue} hasParent={Boolean(parent)} subs={subs} />

            <div className="mt-4 space-y-8">
              <div className="space-y-2">
                <Description
                  issue={issue}
                  onSave={(description, version) => patch({ description }, version)}
                />
                {canWrite && (
                  <QuickActions
                    issue={issue}
                    canAddSubtask={!subs.length && !addingSubtask}
                    canAddBlocker={!blockers.length && !blocking.length}
                    onAddSubtask={() => setAddingSubtask(true)}
                    onAddBlocker={addBlocker}
                    uploader={uploader}
                  />
                )}
              </div>
              {!canWrite &&
                workspaceCanWrite &&
                issueCapabilities(issue).add_attachment &&
                !issue.attachments.length && <AttachButton uploader={uploader} />}
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
      </div>

      <aside
        aria-label={t("issue.properties")}
        className="hidden w-[19.5rem] shrink-0 flex-col border-l border-border @min-[64rem]/issue:flex"
      >
        <div className="flex h-12 shrink-0 items-center border-b border-border px-5 text-sm font-medium text-muted-foreground">
          {t("issue.properties")}
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto px-3 py-4">
          <CoreProperties issue={issue} />
          <Properties
            issue={issue}
            hasParent={Boolean(parent)}
            excludeIds={subs.map((s) => s.id)}
          />
        </div>
      </aside>

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

/** Status, priority and assignee as chips under the title, for widths without the side panel. */
function TriageChips({ issue, canWrite }: { issue: Issue; canWrite: boolean }) {
  const patch = useIssuePatch(issue);
  const chip = "h-7 w-auto rounded-md border border-border bg-card px-2 shadow-xs";
  return (
    <div className="mt-3 flex flex-wrap items-center gap-1.5 @min-[64rem]/issue:hidden">
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
  );
}

function IssueMenu({
  issue,
  canWrite,
  onDelete,
  onArchived,
}: {
  issue: Issue;
  canWrite: boolean;
  onDelete: () => void;
  onArchived: () => unknown;
}) {
  const { t } = useI18n();
  const toast = useToast();
  const { ws, run } = useWorkspace();
  const archive = () =>
    run({ type: "archive_issue", id: issue.id }, { quiet: true }).then(() => {
      toast.show(t("bulk.archived", { count: 1 }), {
        label: t("action.undo"),
        run: () => void run({ type: "unarchive_issue", id: issue.id }).catch(() => {}),
      });
      void onArchived();
    });
  return (
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
            if (k === "delete") onDelete();
            if (k === "archive") void archive();
          }}
        >
          <MenuItem id="copy">
            <Link2 />
            {t("issue.copyLink")}
          </MenuItem>
          {canWrite && isDoneOnly(ws, issue) && (
            <MenuItem id="archive">
              <Archive />
              {t("action.archive")}
            </MenuItem>
          )}
          {canWrite && (
            <MenuItem id="delete">
              <Trash2 />
              {t("action.delete")}
            </MenuItem>
          )}
        </Menu>
      </MenuPopover>
    </MenuTrigger>
  );
}

function ParentLink({
  parent,
  canWrite,
  onRemove,
}: {
  parent: Issue;
  canWrite: boolean;
  onRemove: () => void;
}) {
  const { t } = useI18n();
  const { ws } = useWorkspace();
  return (
    <div className="group mb-2 flex items-center gap-1 text-sm text-muted-foreground">
      <Link
        to={`/${ws.slug}/issue/${parent.key}`}
        className="inline-flex min-w-0 items-center gap-1.5 rounded-md hover:text-foreground"
      >
        <IssueKey value={parent.key} />
        <span className="truncate">{parent.title}</span>
      </Link>
      {canWrite && (
        <Button
          variant="ghost"
          size="icon"
          className={cn("size-5", revealOnHover)}
          aria-label={t("issue.removeParent")}
          onPress={onRemove}
        >
          <X className="size-3" />
        </Button>
      )}
    </div>
  );
}

/** The property list behind a disclosure, for widths without the side panel. */
function CollapsedProperties({
  issue,
  hasParent,
  subs,
}: {
  issue: Issue;
  hasParent: boolean;
  subs: Issue[];
}) {
  const { t } = useI18n();
  return (
    <Disclosure className="mt-3 rounded-lg border border-border @min-[64rem]/issue:hidden">
      {({ isExpanded }) => (
        <>
          <Heading>
            <Button slot="trigger" variant="ghost" className="h-9 w-full justify-start px-3">
              {t("issue.allProperties")}
              <ChevronRight
                className={cn("ml-auto size-3.5 transition-transform", isExpanded && "rotate-90")}
              />
            </Button>
          </Heading>
          <DisclosurePanel>
            <div className="border-t border-border px-2 py-3">
              <Properties issue={issue} hasParent={hasParent} excludeIds={subs.map((s) => s.id)} />
            </div>
          </DisclosurePanel>
        </>
      )}
    </Disclosure>
  );
}

/** Shortcuts for sections that are empty, so they don't take space until used. */
function QuickActions({
  issue,
  canAddSubtask,
  canAddBlocker,
  onAddSubtask,
  onAddBlocker,
  uploader,
}: {
  issue: Issue;
  canAddSubtask: boolean;
  canAddBlocker: boolean;
  onAddSubtask: () => void;
  onAddBlocker: (id: Id) => unknown;
  uploader: ReturnType<typeof useUploader>;
}) {
  const { t } = useI18n();
  return (
    <div className="flex flex-wrap gap-1">
      {canAddSubtask && (
        <Button variant="ghost" size="sm" onPress={onAddSubtask}>
          <Plus />
          {t("issue.addSubtask")}
        </Button>
      )}
      {canAddBlocker && (
        <IssuePicker
          exclude={[issue.id, ...issue.dependencies]}
          onPick={onAddBlocker}
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
  );
}
