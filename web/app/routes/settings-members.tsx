import { useState } from "react";
import { Form } from "react-aria-components";
import { Copy, MailPlus, RotateCw, UserMinus, X } from "lucide-react";
import { Avatar } from "~/components/ui/avatar";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Dialog, useDialogDirty } from "~/components/ui/dialog";
import { FormError, TextField } from "~/components/ui/field";
import { Select } from "~/components/ui/select";
import { useToast } from "~/components/ui/toast";
import { ConfirmDialog } from "~/components/app/confirm";
import { SettingsList, SettingsPage, SettingsSection } from "~/components/app/settings";
import { fullDate } from "~/lib/format";
import { useI18n } from "~/lib/i18n";
import { usePending } from "~/lib/use-pending";
import { useWorkspace } from "~/lib/workspace";
import type { Id, Role } from "~/lib/types";
import type { IssuedInvitation } from "~/sync/transport";

type Issued = { email: string; invitation: IssuedInvitation };

const ROLES: Role[] = ["owner", "admin", "member", "viewer"];
const rank = (r: Role) => ROLES.length - ROLES.indexOf(r);

function MemberRow({
  member: wm,
  locked,
  roleOptions,
  isDisabled,
  onRoleChange,
  onRemove,
}: {
  member: { user_id: Id; role: Role };
  locked: boolean;
  roleOptions: { id: Role; label: string }[];
  isDisabled: boolean;
  onRoleChange: (role: Role) => void;
  onRemove: () => void;
}) {
  const { t } = useI18n();
  const { members, me, role, canAdmin, offline } = useWorkspace();
  const m = members.find((x) => x.id === wm.user_id);
  // Only an owner may change another owner's role.
  const canChangeRole = canAdmin && !locked && (wm.role !== "owner" || role === "owner");
  return (
    <li className="flex min-h-13 items-center gap-3 py-2">
      <Avatar name={m?.display_name ?? "?"} src={m?.avatar_url} size={28} />
      <div className="min-w-0 flex-1">
        <p className="truncate  font-medium">
          {m?.display_name}
          {wm.user_id === me && (
            <span className="ml-1.5  font-normal text-muted-foreground">({t("members.you")})</span>
          )}
        </p>
        <p className="truncate  text-muted-foreground">{m?.email}</p>
      </div>
      {canChangeRole ? (
        <Select
          aria-label={t("members.roleFor", { name: m?.display_name ?? "" })}
          className="w-32"
          isDisabled={isDisabled}
          selectedKey={wm.role}
          options={roleOptions}
          onSelectionChange={(k) => onRoleChange(k as Role)}
        />
      ) : (
        <Badge>{t(`role.${wm.role}`)}</Badge>
      )}
      {canAdmin && (
        <span className="w-7 shrink-0">
          {!locked && wm.user_id !== me && (
            <Button
              variant="ghost"
              size="icon"
              aria-label={`${t("members.remove")}: ${m?.display_name ?? ""}`}
              isDisabled={offline}
              onPress={onRemove}
            >
              <UserMinus />
            </Button>
          )}
        </span>
      )}
    </li>
  );
}

export default function Members() {
  const { t, lang } = useI18n();
  const { ws, members, me, role, run, invite, canAdmin, offline } = useWorkspace();
  const toast = useToast();
  const [inviting, setInviting] = useState(false);
  const [issued, setIssued] = useState<Issued | null>(null);
  const [removing, setRemoving] = useState<Id | null>(null);
  const [demoting, setDemoting] = useState<Role | null>(null);
  const { pending, guard } = usePending();
  const changeRole = (userId: Id, next: Role, current: Role) => {
    // Lowering your own role can't be undone by yourself, so ask first.
    if (userId === me && rank(next) < rank(current)) return setDemoting(next);
    void guard(() => run({ type: "set_role", user_id: userId, role: next }));
  };
  const invitations = ws.invitations.filter((i) => i.state === "pending" || i.state === "expired");
  const owners = ws.members.filter((m) => m.role === "owner").length;
  const roleOptions = ROLES.filter((r) => r !== "owner" || role === "owner").map((r) => ({
    id: r,
    label: t(`role.${r}`),
  }));
  return (
    <SettingsPage
      title={t("settings.members")}
      description={`${t("members.sub")} ${t("members.roleHelp")}`}
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
      <SettingsSection>
        <SettingsList>
          {ws.members.map((wm) => (
            <MemberRow
              key={wm.user_id}
              member={wm}
              // The last owner can't be demoted or removed.
              locked={wm.role === "owner" && owners <= 1}
              roleOptions={roleOptions}
              isDisabled={pending || offline}
              onRoleChange={(next) => changeRole(wm.user_id, next, wm.role)}
              onRemove={() => setRemoving(wm.user_id)}
            />
          ))}
        </SettingsList>
      </SettingsSection>

      {canAdmin && (
        <SettingsSection title={t("invite.pending")}>
          {invitations.length === 0 ? (
            <p className="px-4 py-4  text-muted-foreground sm:px-5">{t("invite.none")}</p>
          ) : (
            <SettingsList>
              {invitations.map((i) => (
                <li key={i.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5 ">
                  <div className="min-w-0 flex-1 basis-48">
                    <p className="truncate font-medium">{i.email}</p>
                    <p className=" text-muted-foreground">
                      {t("invite.expires", { date: fullDate(i.expires_at, lang) })}
                    </p>
                  </div>
                  {i.state === "expired" && <Badge tone="warning">{t("invite.expired")}</Badge>}
                  <Badge>{t(`role.${i.role}`)}</Badge>
                  <Button
                    variant="ghost"
                    size="sm"
                    isDisabled={pending || offline}
                    onPress={() =>
                      void guard(async () => {
                        const invitation = await invite({
                          type: "resend_invitation",
                          id: i.id,
                          token_hash: "",
                        });
                        if (invitation) setIssued({ email: i.email, invitation });
                        else toast.show(t("invite.noLink"));
                      })
                    }
                  >
                    <RotateCw />
                    {t("invite.resend")}
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    isDisabled={pending}
                    onPress={() => void guard(() => run({ type: "cancel_invitation", id: i.id }))}
                  >
                    <X />
                    {t("invite.cancel")}
                  </Button>
                </li>
              ))}
            </SettingsList>
          )}
        </SettingsSection>
      )}

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
