import { useState } from "react";
import { Form, ToggleButton, ToggleButtonGroup } from "react-aria-components";
import { Copy, Info, Mail, MailPlus, MoreHorizontal, RotateCw, UserMinus } from "lucide-react";
import { Avatar } from "~/components/ui/avatar";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Dialog, useDialogDirty } from "~/components/ui/dialog";
import { FormError, SearchField, TextField } from "~/components/ui/field";
import { Menu, MenuItem, MenuPopover, MenuTrigger } from "~/components/ui/menu";
import { Select } from "~/components/ui/select";
import { useToast } from "~/components/ui/toast";
import { ConfirmDialog } from "~/components/app/confirm";
import { SettingsList, SettingsPage, SettingsSection } from "~/components/app/settings";
import { shortDate } from "~/lib/format";
import { useI18n } from "~/lib/i18n";
import {
  filterMembers,
  roleCounts,
  ROLE_FILTERS,
  ROLES,
  type MemberEntry,
  type RoleFilter,
} from "~/lib/members";
import { usePending } from "~/lib/use-pending";
import { cn } from "~/lib/utils";
import { useWorkspace } from "~/lib/workspace";
import type { Id, Invitation, Role } from "~/lib/types";
import type { IssuedInvitation } from "~/sync/transport";

type Issued = { email: string; invitation: IssuedInvitation };
type MemberView = MemberEntry & { avatar_url: string | null; teams: string[] };

const rank = (r: Role) => ROLES.length - ROLES.indexOf(r);

// The header row and every member row share these widths so the columns line up.
const COLUMN = {
  teams: "hidden w-40 shrink-0 md:flex",
  role: "w-30 shrink-0",
  actions: "w-7 shrink-0",
};

function RoleFilters({
  counts,
  filter,
  onFilterChange,
}: {
  counts: Record<RoleFilter, number>;
  filter: RoleFilter;
  onFilterChange: (filter: RoleFilter) => void;
}) {
  const { t } = useI18n();
  return (
    <ToggleButtonGroup
      aria-label={t("members.filterLabel")}
      selectionMode="single"
      disallowEmptySelection
      selectedKeys={[filter]}
      onSelectionChange={(keys) => onFilterChange([...keys][0] as RoleFilter)}
      className="flex flex-1 flex-wrap items-center gap-1"
    >
      {ROLE_FILTERS.map((f) => (
        <ToggleButton
          key={f}
          id={f}
          className={({ isSelected }) =>
            cn(
              "flex h-6.5 cursor-default items-center gap-1.5 rounded-full px-2.5 font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
              isSelected
                ? "bg-foreground text-background"
                : "text-secondary-foreground hover:bg-secondary",
            )
          }
        >
          {({ isSelected }) => (
            <>
              {t(`members.filter.${f}`)}
              <span
                className={cn("tabular-nums", isSelected ? "opacity-60" : "text-muted-foreground")}
              >
                {counts[f]}
              </span>
            </>
          )}
        </ToggleButton>
      ))}
    </ToggleButtonGroup>
  );
}

function TeamKeys({ keys }: { keys: string[] }) {
  const { t } = useI18n();
  if (keys.length === 0)
    return <span className="text-muted-foreground">{t("members.noTeams")}</span>;
  return (
    <>
      {keys.map((key) => (
        <span
          key={key}
          className="rounded-sm bg-secondary px-1.5 py-px font-mono text-[11px] leading-4 text-secondary-foreground"
        >
          {key}
        </span>
      ))}
    </>
  );
}

function MemberRow({
  row,
  locked,
  roleOptions,
  isDisabled,
  onRoleChange,
  onRemove,
}: {
  row: MemberView;
  locked: boolean;
  roleOptions: { id: Role; label: string }[];
  isDisabled: boolean;
  onRoleChange: (role: Role) => void;
  onRemove: () => void;
}) {
  const { t } = useI18n();
  const { me, role, canAdmin, offline } = useWorkspace();
  // Only an owner may change another owner's role.
  const canChangeRole = canAdmin && !locked && (row.role !== "owner" || role === "owner");
  const canRemove = canAdmin && !locked && row.user_id !== me;
  return (
    <div role="row" className="flex min-h-13 items-center gap-3 px-5 py-2.5">
      <div role="cell" className="flex min-w-0 flex-1 items-center gap-3">
        <Avatar name={row.display_name || "?"} src={row.avatar_url} size={28} />
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 font-medium">
            <span className="truncate">{row.display_name}</span>
            {row.user_id === me && (
              <span className="shrink-0 font-normal text-muted-foreground">{t("members.you")}</span>
            )}
          </p>
          <p className="truncate text-muted-foreground">{row.email}</p>
          <div className="mt-1 flex flex-wrap items-center gap-1 md:hidden">
            <TeamKeys keys={row.teams} />
          </div>
        </div>
      </div>
      <div role="cell" className={cn(COLUMN.teams, "flex-wrap items-center gap-1")}>
        <TeamKeys keys={row.teams} />
      </div>
      <div role="cell" className={COLUMN.role}>
        {canChangeRole ? (
          <Select
            aria-label={t("members.roleFor", { name: row.display_name })}
            className="w-full"
            isDisabled={isDisabled}
            selectedKey={row.role}
            options={roleOptions}
            onSelectionChange={(k) => onRoleChange(k as Role)}
          />
        ) : (
          t(`role.${row.role}`)
        )}
      </div>
      {canAdmin && (
        <div role="cell" className={COLUMN.actions}>
          {canRemove && (
            <MenuTrigger>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`${t("action.more")}: ${row.display_name}`}
                isDisabled={offline}
              >
                <MoreHorizontal />
              </Button>
              <MenuPopover placement="bottom end">
                <Menu onAction={onRemove}>
                  <MenuItem id="delete">
                    <UserMinus />
                    {t("members.remove")}
                  </MenuItem>
                </Menu>
              </MenuPopover>
            </MenuTrigger>
          )}
        </div>
      )}
    </div>
  );
}

function InvitationRow({
  invitation: i,
  isDisabled,
  isCancelDisabled,
  onResend,
  onCancel,
}: {
  invitation: Invitation;
  isDisabled: boolean;
  isCancelDisabled: boolean;
  onResend: () => void;
  onCancel: () => void;
}) {
  const { t, lang } = useI18n();
  const expired = i.state === "expired";
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1 py-3">
      <span className="flex size-7 shrink-0 items-center justify-center rounded-full border border-dashed border-input text-muted-foreground">
        <Mail aria-hidden="true" className="size-3.5" />
      </span>
      <div className="min-w-0 flex-1 basis-48">
        <p className="flex items-center gap-2">
          <span className="truncate font-medium">{i.email}</span>
          {expired && <Badge tone="warning">{t("invite.expired")}</Badge>}
        </p>
        <p className="text-muted-foreground">
          {t(expired ? "invite.detailExpired" : "invite.detail", {
            role: t(`role.${i.role}`),
            date: shortDate(i.expires_at, lang),
          })}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button variant="ghost" size="sm" isDisabled={isDisabled} onPress={onResend}>
          <RotateCw />
          {t("invite.resend")}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="text-muted-foreground"
          isDisabled={isCancelDisabled}
          onPress={onCancel}
        >
          {t("invite.cancel")}
        </Button>
      </div>
    </li>
  );
}

export default function Members() {
  const { t } = useI18n();
  const { ws, members, me, role, run, invite, canAdmin, offline } = useWorkspace();
  const toast = useToast();
  const [inviting, setInviting] = useState(false);
  const [issued, setIssued] = useState<Issued | null>(null);
  const [removing, setRemoving] = useState<Id | null>(null);
  const [demoting, setDemoting] = useState<Role | null>(null);
  const [filter, setFilter] = useState<RoleFilter>("all");
  const [query, setQuery] = useState("");
  const { pending, guard } = usePending();
  const changeRole = (userId: Id, next: Role, current: Role) => {
    // Lowering your own role can't be undone by yourself, so ask first.
    if (userId === me && rank(next) < rank(current)) return setDemoting(next);
    void guard(() => run({ type: "set_role", user_id: userId, role: next }));
  };
  const resend = (i: Invitation) =>
    void guard(async () => {
      const invitation = await invite({ type: "resend_invitation", id: i.id, token_hash: "" });
      if (invitation) setIssued({ email: i.email, invitation });
      else toast.show(t("invite.noLink"));
    });
  const invitations = ws.invitations.filter((i) => i.state === "pending" || i.state === "expired");
  const rows: MemberView[] = ws.members.map((wm) => {
    const m = members.find((x) => x.id === wm.user_id);
    return {
      user_id: wm.user_id,
      role: wm.role,
      display_name: m?.display_name ?? "",
      email: m?.email ?? "",
      avatar_url: m?.avatar_url ?? null,
      teams: ws.teams.filter((team) => team.members.includes(wm.user_id)).map((team) => team.key),
    };
  });
  const shown = filterMembers(rows, filter, query);
  const counts = roleCounts(rows);
  const roleOptions = ROLES.filter((r) => r !== "owner" || role === "owner").map((r) => ({
    id: r,
    label: t(`role.${r}`),
  }));
  return (
    <SettingsPage
      title={t("settings.members")}
      description={t("members.summary", { count: rows.length })}
      actions={
        canAdmin && (
          <Button
            variant="primary"
            size="sm"
            isDisabled={offline}
            onPress={() => setInviting(true)}
          >
            <MailPlus />
            {t("invite.new")}
          </Button>
        )
      }
    >
      {canAdmin && invitations.length > 0 && (
        <SettingsSection
          title={
            <span className="flex items-center gap-2">
              {t("invite.pending")}
              <Badge className="tabular-nums">{invitations.length}</Badge>
            </span>
          }
        >
          <SettingsList>
            {invitations.map((i) => (
              <InvitationRow
                key={i.id}
                invitation={i}
                isDisabled={pending || offline}
                isCancelDisabled={pending}
                onResend={() => resend(i)}
                onCancel={() => void guard(() => run({ type: "cancel_invitation", id: i.id }))}
              />
            ))}
          </SettingsList>
        </SettingsSection>
      )}

      <div className="space-y-3">
        <SettingsSection>
          <div className="flex flex-wrap items-center gap-3 border-b border-border py-3 pr-3 pl-5">
            <RoleFilters counts={counts} filter={filter} onFilterChange={setFilter} />
            <SearchField
              aria-label={t("members.search")}
              placeholder={t("members.search")}
              className="w-50 shrink-0"
              value={query}
              onChange={setQuery}
            />
          </div>
          <div role="table" aria-label={t("settings.members")}>
            <div
              role="row"
              className="flex items-center gap-3 border-b border-border bg-background px-5 py-2 text-xs font-medium text-muted-foreground"
            >
              <span role="columnheader" className="flex-1">
                {t("members.colName")}
              </span>
              <span role="columnheader" className={COLUMN.teams}>
                {t("members.colTeams")}
              </span>
              <span role="columnheader" className={COLUMN.role}>
                {t("members.colRole")}
              </span>
              {canAdmin && (
                <span role="columnheader" className={COLUMN.actions}>
                  <span className="sr-only">{t("members.colActions")}</span>
                </span>
              )}
            </div>
            <div className="divide-y divide-border">
              {shown.map((row) => (
                <MemberRow
                  key={row.user_id}
                  row={row}
                  // The last owner can't be demoted or removed.
                  locked={row.role === "owner" && counts.owner <= 1}
                  roleOptions={roleOptions}
                  isDisabled={pending || offline}
                  onRoleChange={(next) => changeRole(row.user_id, next, row.role)}
                  onRemove={() => setRemoving(row.user_id)}
                />
              ))}
            </div>
          </div>
          {shown.length === 0 && (
            <p className="px-5 py-6 text-center text-muted-foreground">{t("members.noMatch")}</p>
          )}
        </SettingsSection>
        <p className="flex gap-2 px-1 text-muted-foreground">
          <Info aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
          {t("members.roleHelp")}
        </p>
      </div>

      <Dialog
        title={t("invite.new")}
        description={t("invite.sub")}
        size="sm"
        isOpen={inviting}
        onOpenChange={setInviting}
      >
        {(close) => (
          <InviteForm
            close={close}
            roles={roleOptions.filter((r) => r.id !== "owner")}
            onIssued={setIssued}
          />
        )}
      </Dialog>
      <InvitationLinkDialog issued={issued} close={() => setIssued(null)} />
      <ConfirmDialog
        title={t("members.selfDemoteTitle")}
        description={t("members.selfDemoteSub")}
        confirmLabel={t("members.changeRole")}
        isOpen={demoting !== null}
        onOpenChange={(o) => !o && setDemoting(null)}
        onConfirm={() => run({ type: "set_role", user_id: me, role: demoting! }, { quiet: true })}
      />
      <Dialog
        title={t("members.remove")}
        description={t("members.removeSub", {
          name: members.find((m) => m.id === removing)?.display_name ?? "",
        })}
        size="sm"
        isOpen={removing !== null}
        onOpenChange={(o) => !o && setRemoving(null)}
      >
        {(close) => (
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onPress={close}>
              {t("action.cancel")}
            </Button>
            <Button
              variant="destructive"
              isDisabled={pending || offline}
              onPress={() =>
                void guard(() => run({ type: "remove_member", user_id: removing! }).then(close))
              }
            >
              {t("members.remove")}
            </Button>
          </div>
        )}
      </Dialog>
    </SettingsPage>
  );
}

function InvitationLinkDialog({ issued, close }: { issued: Issued | null; close: () => void }) {
  const { t } = useI18n();
  return (
    <Dialog
      title={t("invite.linkTitle")}
      description={
        issued
          ? t(issued.invitation.emailed ? "invite.emailed" : "invite.notEmailed", {
              email: issued.email,
            })
          : undefined
      }
      size="sm"
      isOpen={issued !== null}
      onOpenChange={(open) => !open && close()}
    >
      {(dismiss) => (
        <div className="flex flex-col gap-4">
          {issued && <InvitationLink token={issued.invitation.token} />}
          <div className="flex justify-end">
            <Button variant="primary" onPress={dismiss}>
              {t("action.close")}
            </Button>
          </div>
        </div>
      )}
    </Dialog>
  );
}

export function InvitationLink({ token }: { token: string }) {
  const { t } = useI18n();
  const { ws } = useWorkspace();
  const toast = useToast();
  const url = new URL("/welcome", window.location.origin);
  url.searchParams.set("workspace", ws.id);
  url.searchParams.set("token", token);
  const link = url.href;
  return (
    <>
      <div className="flex items-center gap-1 rounded-lg bg-muted p-2">
        <code className="min-w-0 flex-1 break-all font-mono text-[11px]">{link}</code>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t("invite.copyLink")}
          onPress={() =>
            // Browsers expose no clipboard on plain-http pages.
            void (navigator.clipboard?.writeText(link) ?? Promise.reject()).then(
              () => toast.show(t("action.copied")),
              () => toast.error(t("error.generic")),
            )
          }
        >
          <Copy />
        </Button>
      </div>
      <p className="text-muted-foreground">{t("invite.linkOnce")}</p>
    </>
  );
}

function InviteForm({
  close,
  roles,
  onIssued,
}: {
  close: () => void;
  roles: { id: string; label: string }[];
  onIssued: (issued: Issued) => void;
}) {
  const { t } = useI18n();
  const { invite, offline } = useWorkspace();
  const toast = useToast();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("member");
  const { pending, error, guard } = usePending();
  useDialogDirty(email !== "");
  return (
    <Form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        void guard(async () => {
          const address = email.trim();
          const invitation = await invite(
            { type: "invite", email: address, role, token_hash: "" },
            { quiet: true },
          );
          close();
          if (invitation) onIssued({ email: address, invitation });
          else toast.show(t("invite.noLink"));
        });
      }}
    >
      <TextField
        type="email"
        label={t("field.email")}
        value={email}
        onChange={setEmail}
        autoFocus
        isRequired
      />
      <Select
        label={t("field.role")}
        selectedKey={role}
        onSelectionChange={(k) => setRole(k as Role)}
        options={roles}
      />
      <FormError>{error}</FormError>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onPress={close}>
          {t("action.cancel")}
        </Button>
        <Button type="submit" variant="primary" isDisabled={!email.trim() || pending || offline}>
          {pending ? t("invite.sending") : t("invite.send")}
        </Button>
      </div>
    </Form>
  );
}
