import { useEffect, useRef, useState } from "react";
import { ExternalLink, Pencil, Plus, Trash2 } from "lucide-react";
import { Avatar } from "~/components/ui/avatar";
import { Button } from "~/components/ui/button";
import { DatePicker } from "~/components/ui/date-picker";
import { Dialog } from "~/components/ui/dialog";
import { Input } from "~/components/ui/field";
import { IssuePicker } from "~/components/app/issue-picker";
import { TimeForm } from "~/components/app/time-form";
import { LabelsPicker, NullableSelect } from "~/components/app/pickers";
import { formatMinutes, fullDate, relativeTime } from "~/lib/format";
import { useI18n } from "~/lib/i18n";
import { useTimeEntries } from "~/lib/queries";
import { useWorkspace } from "~/lib/workspace";
import { cn } from "~/lib/utils";
import type { Id, Issue, IssuePatch, TimeEntry } from "~/lib/types";
import { revealOnHover } from "./issue-section";

export function Properties({
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
