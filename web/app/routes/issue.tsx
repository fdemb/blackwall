import { useState } from "react";
import { Disclosure, DisclosurePanel, Heading } from "react-aria-components";
import { Link, Navigate, useLocation, useNavigate, useParams } from "react-router";
import {
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
import { IssuePicker } from "~/components/app/issue-picker";
import { AssigneePicker, PriorityPicker, StagePicker } from "~/components/app/pickers";
import { EmptyState, Page, TeamCrumb } from "~/components/app/page";
import { issueKey } from "~/lib/format";
import { IssueKey } from "~/components/app/issue-key";
import { useDocumentTitle } from "~/lib/title";
import { useI18n } from "~/lib/i18n";
import { useIssueDetail, type IssueDetail } from "~/lib/queries";
import { QueryStatus } from "~/components/app/query-status";
import { useWorkspace } from "~/lib/workspace";
import { cn } from "~/lib/utils";
import { issueCapabilities } from "~/lib/ownership";
import { OpenProjectNotice } from "~/components/app/issue-parts";
import type { Id, Issue, IssuePatch } from "~/lib/types";
import { Properties } from "~/components/app/issue-properties";
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
  const { issueId, ws: wsId } = useParams();
  const { ws } = useWorkspace();
  const location = useLocation();
  const inInbox = location.pathname.startsWith(`/${ws.id}/inbox/`);
  const detail = useIssueDetail(issueId!);
  const issue = detail.issue;
  if (detail.missing)
    return (
      <Navigate
        to={inInbox ? `/${ws.id}/inbox${location.search}` : `/${ws.id}/my-issues`}
        replace
      />
    );
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
  const { run, canWrite: workspaceCanWrite } = useWorkspace();
  const canWrite = workspaceCanWrite && issueCapabilities(issue).edit;
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
  const { ws, me, run, team, canWrite: workspaceCanWrite } = useWorkspace();
  const canWrite = workspaceCanWrite && issueCapabilities(issue).edit;
  const inInbox = location.pathname.startsWith(`/${ws.id}/inbox/`);
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
    inInbox
      ? nav(`/${ws.id}/inbox${location.search}`, { preventScrollReset: true })
      : location.key === "default"
        ? nav(`/${ws.id}/team/${issue.team_id}`)
        : nav(-1);
  const chip = "h-7 w-auto rounded-full border border-border px-2.5";

  return (
    <Page className="@container/issue min-w-0 overflow-hidden">
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
        <IssueKey number={issue.number} className="text-[13px] font-medium" />
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
            <OpenProjectNotice issue={issue} />
            <div className="space-y-3">
              {parent && (
                <div className="group flex items-center gap-1 text-xs text-muted-foreground">
                  <Link
                    to={`/${ws.id}/issue/${parent.id}`}
                    className="inline-flex min-w-0 items-center gap-1.5 hover:text-foreground"
                  >
                    <IssueKey number={parent.number} />
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
            <Disclosure className="mt-4 rounded-lg border border-border @min-[64rem]/issue:hidden">
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

        <aside
          aria-label={t("issue.properties")}
          className="hidden w-72 shrink-0 space-y-1 overflow-y-auto border-l border-border p-4 @min-[64rem]/issue:block"
        >
          <Properties
            issue={issue}
            hasParent={Boolean(parent)}
            excludeIds={subs.map((s) => s.id)}
          />
        </aside>
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
