import { useState } from "react";
import { Form } from "react-aria-components";
import { MailPlus, RotateCw, UserMinus, X } from "lucide-react";
import { Avatar } from "~/components/ui/avatar";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Dialog } from "~/components/ui/dialog";
import { TextField } from "~/components/ui/field";
import { Select } from "~/components/ui/select";
import { useToast } from "~/components/ui/toast";
import { Card } from "~/components/app/page";
import { fullDate } from "~/lib/format";
import { useI18n } from "~/lib/i18n";
import { useWorkspace } from "~/lib/workspace";
import type { Id, Role } from "~/lib/types";

const ROLES: Role[] = ["owner", "admin", "member", "viewer"];

export default function Members() {
  const { t, lang } = useI18n();
  const { ws, members, me, role, run, canAdmin } = useWorkspace();
  const toast = useToast();
  const [inviting, setInviting] = useState(false);
  const [removing, setRemoving] = useState<Id | null>(null);
  const invitations = ws.invitations.filter((i) => i.state === "pending" || i.state === "expired");
  const owners = ws.members.filter((m) => m.role === "owner").length;
  const roleOptions = ROLES.filter((r) => r !== "owner" || role === "owner").map((r) => ({ id: r, label: t(`role.${r}`) }));
  return (
    <>
      <Card>
        <div className="flex items-center border-b border-border px-4 py-3">
          <div><h2 className="text-[14px] font-semibold">{t("settings.members")}</h2><p className="text-xs text-muted-foreground">{t("members.sub")}</p></div>
          {canAdmin && <Button variant="primary" size="sm" className="ml-auto" onPress={() => setInviting(true)}><MailPlus />{t("invite.new")}</Button>}
        </div>
        <ul className="divide-y divide-border">
          {ws.members.map((wm) => {
            const m = members.find((x) => x.id === wm.user_id);
            const locked = wm.role === "owner" && owners <= 1;
            return (
              <li key={wm.user_id} className="flex items-center gap-3 px-4 py-2.5">
                <Avatar name={m?.display_name ?? "?"} src={m?.avatar_url} size={28} />
                <div className="min-w-0 flex-1"><p className="truncate text-[13px] font-medium">{m?.display_name}{wm.user_id === me && <span className="ml-1.5 text-xs font-normal text-muted-foreground">({t("members.you")})</span>}</p><p className="truncate text-xs text-muted-foreground">{m?.email}</p></div>
                {canAdmin && !locked && (wm.role !== "owner" || role === "owner") ? (
                  <Select aria-label={t("field.role")} className="w-32" selectedKey={wm.role} options={roleOptions} onSelectionChange={(k) => run({ type: "set_role", user_id: wm.user_id, role: k as Role }).catch(() => {})} />
                ) : <Badge>{t(`role.${wm.role}`)}</Badge>}
                {canAdmin && !locked && wm.user_id !== me && (
                  <Button variant="ghost" size="icon" aria-label={t("members.remove")} onPress={() => setRemoving(wm.user_id)}><UserMinus /></Button>
                )}
              </li>
            );
          })}
        </ul>
      </Card>

      {canAdmin && (
        <Card>
          <div className="border-b border-border px-4 py-3"><h2 className="text-[14px] font-semibold">{t("invite.pending")}</h2></div>
          {invitations.length === 0 ? <p className="px-4 py-6 text-center text-[13px] text-muted-foreground">{t("invite.none")}</p> : (
            <ul className="divide-y divide-border">
              {invitations.map((i) => (
                <li key={i.id} className="flex items-center gap-3 px-4 py-2.5 text-[13px]">
                  <div className="min-w-0 flex-1"><p className="truncate font-medium">{i.email}</p><p className="text-xs text-muted-foreground">{t("invite.expires", { date: fullDate(i.expires_at, lang) })}</p></div>
                  <Badge tone={i.state === "expired" ? "warning" : "neutral"}>{t(`role.${i.role}`)}</Badge>
                  <Button variant="ghost" size="sm" onPress={() => run({ type: "resend_invitation", id: i.id, token_hash: "" }).then(() => toast.show(t("invite.resent"))).catch(() => {})}><RotateCw />{t("invite.resend")}</Button>
                  <Button variant="ghost" size="sm" onPress={() => run({ type: "cancel_invitation", id: i.id }).catch(() => {})}><X />{t("invite.cancel")}</Button>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      <Dialog title={t("invite.new")} description={t("invite.sub")} size="sm" isOpen={inviting} onOpenChange={setInviting}>
        {(close) => <InviteForm close={close} roles={roleOptions.filter((r) => r.id !== "owner")} />}
      </Dialog>
      <Dialog title={t("members.remove")} description={t("members.removeSub", { name: members.find((m) => m.id === removing)?.display_name ?? "" })} size="sm" isOpen={removing !== null} onOpenChange={(o) => !o && setRemoving(null)}>
        {(close) => (
          <div className="flex justify-end gap-2">
            <Button variant="ghost" onPress={close}>{t("action.cancel")}</Button>
            <Button variant="destructive" onPress={() => run({ type: "remove_member", user_id: removing! }).then(close).catch(() => {})}>{t("members.remove")}</Button>
          </div>
        )}
      </Dialog>
    </>
  );
}

function InviteForm({ close, roles }: { close: () => void; roles: { id: string; label: string }[] }) {
  const t = useI18n().t;
  const { run } = useWorkspace();
  const toast = useToast();
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<Role>("member");
  return (
    <Form className="flex flex-col gap-4" onSubmit={async (e) => {
      e.preventDefault();
      await run({ type: "invite", email: email.trim(), role, token_hash: "" }).then(() => { toast.show(t("invite.sent", { email })); close(); }).catch(() => {});
    }}>
      <TextField type="email" label={t("field.email")} value={email} onChange={setEmail} autoFocus isRequired />
      <Select label={t("field.role")} selectedKey={role} onSelectionChange={(k) => setRole(k as Role)} options={roles} />
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onPress={close}>{t("action.cancel")}</Button>
        <Button type="submit" variant="primary" isDisabled={!email.trim()}>{t("invite.send")}</Button>
      </div>
    </Form>
  );
}
