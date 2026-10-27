import { useState } from "react";
import {
  FieldError as RACFieldError,
  Form,
  Input as RACInput,
  TextField as RACTextField,
} from "react-aria-components";
import { Link, useNavigate, useRevalidator } from "react-router";
import { Copy, LogOut } from "lucide-react";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { FormError, TextField } from "~/components/ui/field";
import { Select } from "~/components/ui/select";
import { useToast } from "~/components/ui/toast";
import { ConfirmDialog } from "~/components/app/confirm";
import {
  SettingsBlock,
  SettingsFooter,
  SettingsPage,
  SettingsRow,
  SettingsSection,
} from "~/components/app/settings";
import { clearLastWs } from "~/lib/auth-guard";
import { useI18n } from "~/lib/i18n";
import { isWorkspaceSlug, slugInput } from "~/lib/identifiers";
import { useIssueCount } from "~/lib/stats";
import { usePending } from "~/lib/use-pending";
import { useWorkspace } from "~/lib/workspace";
import type { Id } from "~/lib/types";

export default function General() {
  const { t } = useI18n();
  const { role, canAdmin: canEdit } = useWorkspace();
  return (
    <SettingsPage title={t("settings.general")} description={t("settings.generalSub")}>
      <Identity canEdit={canEdit} />
      <SettingsSection title={t("settings.generalWorkspace")}>
        <WorkspaceCard canEdit={canEdit} />
      </SettingsSection>
      <SettingsSection title={t("workspace.membership")}>
        <div className="divide-y divide-border">
          {role === "owner" && <TransferOwnership />}
          <Leave />
        </div>
      </SettingsSection>
    </SettingsPage>
  );
}

function Identity({ canEdit }: { canEdit: boolean }) {
  const { t } = useI18n();
  const { ws, role } = useWorkspace();
  const issueCount = useIssueCount();
  const base = `/${ws.slug}/settings`;
  const counts: [string, string?][] = [
    [t("settings.generalMembers", { count: ws.members.length }), `${base}/members`],
    [t("settings.generalTeams", { count: ws.teams.length }), `${base}/teams`],
    [t("settings.generalProjects", { count: ws.projects.length })],
    [t("settings.generalIssues", { count: issueCount })],
  ];
  return (
    <SettingsBlock className="flex items-center gap-4">
      <div
        aria-hidden="true"
        className="flex size-14 shrink-0 items-center justify-center rounded-[14px] bg-primary-solid text-2xl font-semibold text-primary-foreground"
      >
        {ws.name.trim().charAt(0).toUpperCase()}
      </div>
      <div className="flex min-w-0 flex-1 flex-col gap-1">
        <div className="flex min-w-0 items-center gap-2">
          <h2 className="truncate text-base font-semibold">{ws.name}</h2>
          <Badge tone={canEdit ? "primary" : "neutral"}>{t(`role.${role}`)}</Badge>
        </div>
        <ul className="flex flex-wrap items-center gap-x-1.5 text-muted-foreground tabular-nums">
          {counts.map(([label, to], i) => (
            <li key={label} className="flex items-center gap-1.5">
              {i > 0 && <span aria-hidden="true">·</span>}
              {to ? (
                <Link
                  to={to}
                  className="rounded-sm underline-offset-4 outline-none hover:text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring/60"
                >
                  {label}
                </Link>
              ) : (
                label
              )}
            </li>
          ))}
        </ul>
      </div>
    </SettingsBlock>
  );
}

function WorkspaceCard({ canEdit }: { canEdit: boolean }) {
  const { t } = useI18n();
  const toast = useToast();
  const nav = useNavigate();
  const { revalidate: reloadWorkspaceList } = useRevalidator();
  const { ws, run, offline } = useWorkspace();
  const [name, setName] = useState(ws.name);
  const [slug, setSlug] = useState(ws.slug);
  const { pending, error, guard } = usePending();
  const host = typeof window === "undefined" ? "" : window.location.host;
  const slugError = isWorkspaceSlug(slug) ? "" : t("workspace.slugInvalid");
  const unchanged = name.trim() === ws.name && slug === ws.slug;
  const copyId = () =>
    navigator.clipboard.writeText(ws.id).then(
      () => toast.show(t("action.copied")),
      () => toast.error(t("error.generic")),
    );
  const rows = (
    <div className="divide-y divide-border">
      <SettingsRow
        label={t("field.name")}
        description={t(canEdit ? "settings.generalNameSub" : "settings.generalNameReadOnly")}
      >
        {(descriptionId) =>
          canEdit ? (
            <TextField
              name="name"
              aria-label={t("field.name")}
              aria-describedby={descriptionId}
              className="w-full sm:w-70"
              value={name}
              onChange={setName}
              autoComplete="off"
              isRequired
            />
          ) : (
            <p className="w-full truncate px-2.5 sm:w-70">{ws.name}</p>
          )
        }
      </SettingsRow>
      <SettingsRow
        label={t("workspace.slug")}
        description={t(canEdit ? "settings.generalUrlSub" : "settings.generalUrlReadOnly")}
      >
        {(descriptionId) =>
          canEdit ? (
            <RACTextField
              name="slug"
              aria-label={t("workspace.slug")}
              aria-describedby={descriptionId}
              className="group flex w-full flex-col sm:w-70"
              value={slug}
              onChange={(value) => setSlug(slugInput(value))}
              isInvalid={Boolean(slugError)}
              validationBehavior="aria"
              isRequired
            >
              <div className="flex h-8 overflow-hidden rounded-md border border-input bg-card shadow-xs transition-colors focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/25 hover:border-muted-foreground/40 group-data-invalid:border-destructive pointer-coarse:h-10">
                <span className="flex min-w-0 shrink items-center truncate border-r border-input bg-muted px-2.5 text-muted-foreground">
                  {host}/
                </span>
                <RACInput
                  autoComplete="off"
                  spellCheck="false"
                  className="min-w-16 flex-1 bg-transparent px-2.5 text-foreground outline-none"
                />
              </div>
              <RACFieldError className="mt-1 text-destructive">{slugError}</RACFieldError>
            </RACTextField>
          ) : (
            <p className="w-full truncate px-2.5 sm:w-70">
              {host}/{ws.slug}
            </p>
          )
        }
      </SettingsRow>
      <SettingsRow label={t("workspace.id")} description={t("settings.generalIdSub")}>
        <div className="flex h-8 w-full items-center gap-2 rounded-md bg-muted pr-1 pl-2.5 sm:w-70">
          <code className="min-w-0 flex-1 truncate font-mono text-xs text-muted-foreground">
            {ws.id}
          </code>
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            aria-label={`${t("action.copy")}: ${t("workspace.id")}`}
            onPress={() => void copyId()}
          >
            <Copy className="size-3.5" />
          </Button>
        </div>
      </SettingsRow>
    </div>
  );
  if (!canEdit) return rows;
  return (
    <Form
      onSubmit={(e) => {
        e.preventDefault();
        void guard(async () => {
          await run({ type: "update_workspace", name: name.trim(), slug }, { quiet: true });
          toast.show(t("workspace.saved"));
          if (slug !== ws.slug) await nav(`/${slug}/settings/general`, { replace: true });
          await reloadWorkspaceList();
        });
      }}
    >
      {rows}
      <SettingsFooter>
        <div className="min-w-0 flex-1">
          {error ? (
            <FormError>{error}</FormError>
          ) : (
            <p className="text-muted-foreground">{t("settings.generalSaveHint")}</p>
          )}
        </div>
        <Button
          type="submit"
          variant="primary"
          size="sm"
          isDisabled={unchanged || !name.trim() || Boolean(slugError) || pending || offline}
        >
          {t("action.save")}
        </Button>
      </SettingsFooter>
    </Form>
  );
}

function TransferOwnership() {
  const { t } = useI18n();
  const { ws, me, member, run, offline } = useWorkspace();
  const [target, setTarget] = useState<Id | null>(null);
  const [confirming, setConfirming] = useState(false);
  const options = ws.members
    .filter((m) => m.user_id !== me)
    .map((m) => ({ id: m.user_id, label: member(m.user_id)?.display_name ?? m.user_id }));
  const name = member(target)?.display_name ?? "";
  return (
    <SettingsRow label={t("workspace.transfer")} description={t("workspace.transferSub")}>
      <div className="flex items-center gap-2">
        <Select
          aria-label={t("workspace.transferTo")}
          placeholder={t("workspace.transferTo")}
          className="w-45 min-w-0 flex-1 sm:flex-none"
          isDisabled={options.length === 0 || offline}
          selectedKey={target}
          options={options}
          onSelectionChange={(key) => setTarget(key as Id)}
        />
        <Button
          variant="secondary"
          className="sm:w-23"
          isDisabled={target === null || offline}
          onPress={() => setConfirming(true)}
        >
          {t("workspace.transferAction")}
        </Button>
      </div>
      <ConfirmDialog
        title={t("workspace.transferConfirm", { name })}
        description={t("workspace.transferConfirmSub")}
        confirmLabel={t("workspace.transfer")}
        isOpen={confirming}
        onOpenChange={setConfirming}
        onConfirm={() =>
          run({ type: "transfer_ownership", user_id: target! }, { quiet: true }).then(() =>
            setTarget(null),
          )
        }
      />
    </SettingsRow>
  );
}

function Leave() {
  const { t } = useI18n();
  const nav = useNavigate();
  const { ws, me, role, run, offline } = useWorkspace();
  const [confirming, setConfirming] = useState(false);
  const soleOwner = role === "owner" && ws.members.filter((m) => m.role === "owner").length <= 1;
  return (
    <SettingsRow
      label={t("workspace.leave")}
      description={t(soleOwner ? "workspace.leaveSoleOwner" : "workspace.leaveSub")}
    >
      <Button
        variant="secondary"
        className="border-destructive/30 text-destructive hover:bg-destructive/10"
        isDisabled={soleOwner || offline}
        onPress={() => setConfirming(true)}
      >
        <LogOut className="size-3.5" />
        {t("workspace.leaveAction")}
      </Button>
      <ConfirmDialog
        title={t("workspace.leaveConfirm", { name: ws.name })}
        description={t("workspace.leaveSub")}
        confirmLabel={t("workspace.leave")}
        isOpen={confirming}
        onOpenChange={setConfirming}
        onConfirm={async () => {
          await run({ type: "remove_member", user_id: me }, { quiet: true });
          clearLastWs();
          await nav("/", { replace: true });
        }}
      />
    </SettingsRow>
  );
}
