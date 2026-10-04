import { useState } from "react";
import { Form } from "react-aria-components";
import { MailPlus, RotateCw, UserMinus, X } from "lucide-react";
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

const ROLES: Role[] = ["owner", "admin", "member", "viewer"];
const rank = (r: Role) => ROLES.length - ROLES.indexOf(r);

export default function Members() {
  const { t, lang } = useI18n();
  const { ws, members, me, role, run, canAdmin } = useWorkspace();
  const toast = useToast();
  const [inviting, setInviting] = useState(false);
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
          <Button variant="primary" size="sm" onPress={() => setInviting(true)}>
            <MailPlus />
            {t("invite.new")}
          </Button>
        )
      }
    >
      <SettingsSection>
        <SettingsList>
          {ws.members.map((wm) => {
            const m = members.find((x) => x.id === wm.user_id);
            const locked = wm.role === "owner" && owners <= 1;
            return (
              <li key={wm.user_id} className="flex min-h-13 items-center gap-3 py-2">
                <Avatar name={m?.display_name ?? "?"} src={m?.avatar_url} size={28} />
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-medium">
                    {m?.display_name}
                    {wm.user_id === me && (
                      <span className="ml-1.5 text-xs font-normal text-muted-foreground">
                        ({t("members.you")})
                      </span>
                    )}
                  </p>
                  <p className="truncate text-xs text-muted-foreground">{m?.email}</p>
                </div>
                {canAdmin && !locked && (wm.role !== "owner" || role === "owner") ? (
                  <Select
                    aria-label={t("members.roleFor", { name: m?.display_name ?? "" })}
                    className="w-32"
                    isDisabled={pending}
                    selectedKey={wm.role}
                    options={roleOptions}
                    onSelectionChange={(k) => changeRole(wm.user_id, k as Role, wm.role)}
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
                        onPress={() => setRemoving(wm.user_id)}
                      >
                        <UserMinus />
                      </Button>
                    )}
                  </span>
                )}
              </li>
            );
          })}
        </SettingsList>
      </SettingsSection>

      {canAdmin && (
        <SettingsSection title={t("invite.pending")}>
          {invitations.length === 0 ? (
            <p className="px-4 py-4 text-[13px] text-muted-foreground sm:px-5">
              {t("invite.none")}
            </p>
          ) : (
            <SettingsList>
              {invitations.map((i) => (
                <li
                  key={i.id}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1 py-2.5 text-[13px]"
                >
                  <div className="min-w-0 flex-1">
                    <p className="truncate font-medium">{i.email}</p>
                    <p className="text-xs text-muted-foreground">
                      {t("invite.expires", { date: fullDate(i.expires_at, lang) })}
                    </p>
                  </div>
                  {i.state === "expired" && <Badge tone="warning">{t("invite.expired")}</Badge>}
                  <Badge>{t(`role.${i.role}`)}</Badge>
                  <Button
                    variant="ghost"
                    size="sm"
                    isDisabled={pending}
                    onPress={() =>
                      void guard(() =>
                        run({ type: "resend_invitation", id: i.id, token_hash: "" }).then(() =>
                          toast.show(t("invite.resent")),
                        ),
                      )
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
          <InviteForm close={close} roles={roleOptions.filter((r) => r.id !== "owner")} />
        )}
      </Dialog>
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
              isDisabled={pending}
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

function InviteForm({
  close,
  roles,
}: {
  close: () => void;
  roles: { id: string; label: string }[];
}) {
  const t = useI18n().t;
  const { run } = useWorkspace();
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
          await run({ type: "invite", email: email.trim(), role, token_hash: "" }, { quiet: true });
          toast.show(t("invite.sent", { email }));
          close();
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
        <Button type="submit" variant="primary" isDisabled={!email.trim() || pending}>
          {pending ? t("invite.sending") : t("invite.send")}
        </Button>
      </div>
    </Form>
  );
}
