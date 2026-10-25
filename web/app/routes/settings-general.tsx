import { useState } from "react";
import { Form } from "react-aria-components";
import { Link, useNavigate, useRevalidator } from "react-router";
import { Copy, LogOut } from "lucide-react";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { FormError, TextField } from "~/components/ui/field";
import { Select } from "~/components/ui/select";
import { useToast } from "~/components/ui/toast";
import { ConfirmDialog } from "~/components/app/confirm";
import { SettingsPage, SettingsSection } from "~/components/app/settings";
import { clearLastWs } from "~/lib/auth-guard";
import { useI18n } from "~/lib/i18n";
import { isWorkspaceSlug, slugInput } from "~/lib/identifiers";
import { useIssueCount } from "~/lib/stats";
import { usePending } from "~/lib/use-pending";
import { useWorkspace } from "~/lib/workspace";
import type { Id } from "~/lib/types";

export default function General() {
  const { t } = useI18n();
  const toast = useToast();
  const { ws, role, canAdmin } = useWorkspace();
  const issueCount = useIssueCount();
  const base = `/${ws.slug}/settings`;
  const copyId = () =>
    navigator.clipboard.writeText(ws.id).then(
      () => toast.show(t("action.copied")),
      () => toast.error(t("error.generic")),
    );
  const counts: [string, number, string?][] = [
    [t("settings.members"), ws.members.length, `${base}/members`],
    [t("nav.teams"), ws.teams.length, `${base}/teams`],
    [t("nav.projects"), ws.projects.length],
    [t("nav.issues"), issueCount],
  ];
  return (
    <SettingsPage title={t("settings.general")} description={t("settings.generalSub")}>
      {canAdmin && (
        <SettingsSection>
          <WorkspaceForm />
        </SettingsSection>
      )}
      <SettingsSection>
        <dl className="divide-y divide-border ">
          {!canAdmin && (
            <Row label={t("field.name")}>
              <span className="font-medium">{ws.name}</span>
            </Row>
          )}
          <Row label={t("workspace.id")}>
            <span className="flex min-w-0 items-center gap-1">
              <code className="truncate font-mono  text-muted-foreground">{ws.id}</code>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`${t("action.copy")}: ${t("workspace.id")}`}
                onPress={() => void copyId()}
              >
                <Copy />
              </Button>
            </span>
          </Row>
          <Row label={t("settings.yourRole")}>
            <Badge tone="primary">{t(`role.${role}`)}</Badge>
          </Row>
        </dl>
      </SettingsSection>
      <SettingsSection title={t("settings.contents")}>
        <dl className="divide-y divide-border ">
          {counts.map(([label, n, to]) => (
            <Row key={label} label={label}>
              {to ? (
                <Link
                  to={to}
                  className="rounded-sm font-medium tabular-nums underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/60"
                >
                  {n}
                </Link>
              ) : (
                <span className="font-medium tabular-nums">{n}</span>
              )}
            </Row>
          ))}
        </dl>
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

function WorkspaceForm() {
  const { t } = useI18n();
  const toast = useToast();
  const nav = useNavigate();
  const { revalidate: reloadWorkspaceList } = useRevalidator();
  const { ws, run, offline } = useWorkspace();
  const [name, setName] = useState(ws.name);
  const [slug, setSlug] = useState(ws.slug);
  const { pending, error, guard } = usePending();
  const slugError = isWorkspaceSlug(slug) ? "" : t("workspace.slugInvalid");
  const unchanged = name.trim() === ws.name && slug === ws.slug;
  return (
    <Form
      className="flex flex-col gap-4 px-4 py-4 sm:px-5"
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
      <TextField
        name="name"
        label={t("workspace.name")}
        value={name}
        onChange={setName}
        autoComplete="off"
        isRequired
      />
      <TextField
        name="slug"
        label={t("workspace.slug")}
        description={t(slug === ws.slug ? "workspace.slugHint" : "workspace.slugChangeHint", {
          slug,
        })}
        error={slugError}
        value={slug}
        onChange={(value) => setSlug(slugInput(value))}
        autoComplete="off"
        spellCheck="false"
        isRequired
      />
      <FormError>{error}</FormError>
      <div className="flex justify-end">
        <Button
          type="submit"
          variant="primary"
          isDisabled={unchanged || !name.trim() || Boolean(slugError) || pending || offline}
        >
          {t("action.save")}
        </Button>
      </div>
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
    <div className="flex flex-wrap items-end gap-3 px-4 py-4 sm:px-5">
      <div className="min-w-0 flex-1 basis-60">
        <p className="font-medium">{t("workspace.transfer")}</p>
        <p className="text-muted-foreground">{t("workspace.transferSub")}</p>
      </div>
      <Select
        aria-label={t("workspace.transferTo")}
        placeholder={t("workspace.transferTo")}
        className="w-48"
        isDisabled={options.length === 0 || offline}
        selectedKey={target}
        options={options}
        onSelectionChange={(key) => setTarget(key as Id)}
      />
      <Button
        variant="secondary"
        isDisabled={target === null || offline}
        onPress={() => setConfirming(true)}
      >
        {t("workspace.transfer")}
      </Button>
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
    </div>
  );
}

function Leave() {
  const { t } = useI18n();
  const nav = useNavigate();
  const { ws, me, role, run, offline } = useWorkspace();
  const [confirming, setConfirming] = useState(false);
  const soleOwner = role === "owner" && ws.members.filter((m) => m.role === "owner").length <= 1;
  return (
    <div className="flex flex-wrap items-center gap-3 px-4 py-4 sm:px-5">
      <div className="min-w-0 flex-1 basis-60">
        <p className="font-medium">{t("workspace.leave")}</p>
        <p className="text-muted-foreground">
          {t(soleOwner ? "workspace.leaveSoleOwner" : "workspace.leaveSub")}
        </p>
      </div>
      <Button
        variant="destructive"
        isDisabled={soleOwner || offline}
        onPress={() => setConfirming(true)}
      >
        <LogOut />
        {t("workspace.leave")}
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
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-11 items-center justify-between gap-6 px-4 py-2 sm:px-5">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 justify-end">{children}</dd>
    </div>
  );
}
