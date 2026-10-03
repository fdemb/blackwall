import { useRef, useState } from "react";
import { Form } from "react-aria-components";
import { ArrowDown, ArrowUp, Plus, Trash2, Users } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Dialog, useDialogDirty } from "~/components/ui/dialog";
import { FormError, Input, TextField } from "~/components/ui/field";
import { Select } from "~/components/ui/select";
import { EmptyState } from "~/components/app/page";
import { SettingsPage, SettingsSection } from "~/components/app/settings";
import { MultiMemberPicker } from "~/components/app/pickers";
import { StageIcon } from "~/components/app/icons";
import { STAGE_KINDS } from "~/lib/format";
import { useT } from "~/lib/i18n";
import { usePending } from "~/lib/use-pending";
import { useWorkspace } from "~/lib/workspace";
import type { Id, Stage, StageKind, Team } from "~/lib/types";

export default function Teams() {
  const t = useT();
  const { ws, canAdmin, canWrite, create } = useWorkspace();
  const [creating, setCreating] = useState(false);
  return (
    <SettingsPage
      title={t("settings.teams")}
      description={t("teams.sub")}
      actions={
        canAdmin && (
          <Button variant="primary" size="sm" onPress={() => setCreating(true)}>
            <Plus />
            {t("team.create")}
          </Button>
        )
      }
    >
      {ws.teams.length > 0 && ws.issues.length === 0 && canWrite && (
        <SettingsSection>
          <div className="flex flex-wrap items-center gap-3 rounded-lg bg-accent/50 px-4 py-3">
            <div className="min-w-0 flex-1">
              <h2 className="text-[13px] font-semibold">{t("setup.issueTitle")}</h2>
              <p className="text-xs text-muted-foreground">{t("setup.issueSub")}</p>
            </div>
            <Button
              variant="primary"
              size="sm"
              onPress={() => create.show({ team_id: ws.teams[0].id })}
            >
              {t("issue.new")}
            </Button>
          </div>
        </SettingsSection>
      )}
      {ws.teams.length === 0 && (
        <SettingsSection>
          <EmptyState
            icon={<Users />}
            title={t("teams.emptyTitle")}
            description={t("teams.emptySub")}
            action={
              canAdmin && (
                <Button variant="primary" onPress={() => setCreating(true)}>
                  {t("team.create")}
                </Button>
              )
            }
          />
        </SettingsSection>
      )}
      {ws.teams.map((tm) => (
        <TeamSection key={tm.id} team={tm} />
      ))}
      <Dialog title={t("team.create")} size="sm" isOpen={creating} onOpenChange={setCreating}>
        {(close) => <CreateTeam close={close} />}
      </Dialog>
    </SettingsPage>
  );
}

function CreateTeam({ close }: { close: () => void }) {
  const t = useT();
  const { run, me } = useWorkspace();
  const [name, setName] = useState("");
  const [members, setMembers] = useState<Id[]>([me]);
  const { pending, error, guard } = usePending();
  useDialogDirty(name !== "");
  return (
    <Form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        void guard(async () => {
          await run({ type: "create_team", name: name.trim(), members }, { quiet: true });
          close();
        });
      }}
    >
      <TextField
        label={t("field.name")}
        value={name}
        onChange={setName}
        autoFocus
        isRequired
        placeholder={t("team.namePlaceholder")}
      />
      <div>
        <span className="mb-1 block text-xs font-medium text-muted-foreground">
          {t("nav.people")}
        </span>
        <MultiMemberPicker value={members} onChange={setMembers} />
      </div>
      <FormError>{error}</FormError>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onPress={close}>
          {t("action.cancel")}
        </Button>
        <Button type="submit" variant="primary" isDisabled={!name.trim() || pending}>
          {pending ? t("action.saving") : t("action.save")}
        </Button>
      </div>
    </Form>
  );
}

function TeamSection({ team }: { team: Team }) {
  const t = useT();
  const { run, canAdmin } = useWorkspace();
  const stages = [...team.stages].sort((a, b) => a.position - b.position);
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<Stage | null>(null);
  const { pending: moving, guard } = usePending();
  const swap = (a: Stage, b: Stage) =>
    guard(async () => {
      await run({
        type: "update_stage",
        team_id: team.id,
        id: a.id,
        name: a.name,
        kind: a.kind,
        position: b.position,
      });
      await run({
        type: "update_stage",
        team_id: team.id,
        id: b.id,
        name: b.name,
        kind: b.kind,
        position: a.position,
      });
    });
  return (
    <SettingsSection
      title={team.name}
      actions={
        canAdmin && (
          <div className="w-56">
            <MultiMemberPicker
              value={team.members}
              onChange={(members) =>
                run({ type: "set_team_members", id: team.id, members }).catch(() => {})
              }
            />
          </div>
        )
      }
    >
      <div className="mb-2 flex items-center">
        <h3 className="text-xs font-medium text-muted-foreground">{t("teams.workflow")}</h3>
        {canAdmin && (
          <Button variant="ghost" size="sm" className="ml-auto" onPress={() => setAdding(true)}>
            <Plus />
            {t("stage.add")}
          </Button>
        )}
      </div>
      <ul className="space-y-1">
        {stages.map((s, i) => (
          <StageRow
            key={s.id}
            team={team}
            stage={s}
            first={i === 0}
            last={i === stages.length - 1}
            canEdit={canAdmin}
            busy={moving}
            onUp={() => void swap(s, stages[i - 1])}
            onDown={() => void swap(s, stages[i + 1])}
            onDelete={() => setDeleting(s)}
          />
        ))}
      </ul>
      <Dialog title={t("stage.add")} size="sm" isOpen={adding} onOpenChange={setAdding}>
        {(close) => <AddStage team={team} close={close} />}
      </Dialog>
      <Dialog
        title={t("stage.delete")}
        description={deleting ? t("stage.deleteSub", { name: deleting.name }) : ""}
        size="sm"
        isOpen={deleting !== null}
        onOpenChange={(o) => !o && setDeleting(null)}
      >
        {(close) => deleting && <DeleteStage team={team} stage={deleting} close={close} />}
      </Dialog>
    </SettingsSection>
  );
}

function StageRow({
  team,
  stage,
  first,
  last,
  canEdit,
  busy,
  onUp,
  onDown,
  onDelete,
}: {
  team: Team;
  stage: Stage;
  first: boolean;
  last: boolean;
  canEdit: boolean;
  busy: boolean;
  onUp: () => void;
  onDown: () => void;
  onDelete: () => void;
}) {
  const t = useT();
  const { run } = useWorkspace();
  const [name, setName] = useState(stage.name);
  const [status, setStatus] = useState<"idle" | "saving" | "saved" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  // Inline edits save on their own, so each row says whether the change landed.
  const save = async (patch: Partial<Stage>) => {
    clearTimeout(timer.current);
    setStatus("saving");
    try {
      await run({
        type: "update_stage",
        team_id: team.id,
        id: stage.id,
        name: (patch.name ?? stage.name).trim(),
        kind: patch.kind ?? stage.kind,
        position: stage.position,
      });
      setStatus("saved");
      timer.current = setTimeout(() => setStatus("idle"), 2500);
    } catch {
      setName(stage.name);
      setStatus("failed");
    }
  };
  return (
    <li className="flex flex-wrap items-center gap-2 sm:flex-nowrap">
      <StageIcon kind={stage.kind} className="mx-1" />
      <Input
        aria-label={t("stage.name")}
        value={name}
        disabled={!canEdit}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => name.trim() && name !== stage.name && void save({ name })}
        className="h-8 min-w-0 flex-1 basis-40"
      />
      <Select
        aria-label={t("stage.kind")}
        className="w-full basis-full sm:w-36 sm:basis-auto"
        isDisabled={!canEdit}
        selectedKey={stage.kind}
        onSelectionChange={(k) => void save({ kind: k as StageKind })}
        options={STAGE_KINDS.map((k) => ({
          id: k,
          label: t(`stage.kind.${k}`),
          icon: <StageIcon kind={k} />,
        }))}
      />
      {canEdit && (
        <span className="flex">
          <Button
            variant="ghost"
            size="icon"
            aria-label={t("action.moveUp")}
            isDisabled={first || busy}
            onPress={onUp}
          >
            <ArrowUp />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t("action.moveDown")}
            isDisabled={last || busy}
            onPress={onDown}
          >
            <ArrowDown />
          </Button>
          <Button variant="ghost" size="icon" aria-label={t("action.delete")} onPress={onDelete}>
            <Trash2 />
          </Button>
        </span>
      )}
      <span
        role="status"
        className={`w-16 text-xs ${status === "failed" ? "text-destructive" : "text-muted-foreground"}`}
      >
        {status === "saving"
          ? t("action.saving")
          : status === "saved"
            ? t("action.saved")
            : status === "failed"
              ? t("action.saveFailed")
              : ""}
      </span>
    </li>
  );
}

function AddStage({ team, close }: { team: Team; close: () => void }) {
  const t = useT();
  const { run } = useWorkspace();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<StageKind>("active");
  const position = Math.max(0, ...team.stages.map((s) => s.position)) + 1;
  const { pending, error, guard } = usePending();
  useDialogDirty(name !== "");
  return (
    <Form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        void guard(async () => {
          await run(
            { type: "create_stage", team_id: team.id, name: name.trim(), kind, position },
            { quiet: true },
          );
          close();
        });
      }}
    >
      <TextField label={t("stage.name")} value={name} onChange={setName} autoFocus isRequired />
      <Select
        label={t("stage.kind")}
        selectedKey={kind}
        onSelectionChange={(k) => setKind(k as StageKind)}
        options={STAGE_KINDS.map((k) => ({
          id: k,
          label: t(`stage.kind.${k}`),
          icon: <StageIcon kind={k} />,
        }))}
      />
      <FormError>{error}</FormError>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onPress={close}>
          {t("action.cancel")}
        </Button>
        <Button type="submit" variant="primary" isDisabled={!name.trim() || pending}>
          {pending ? t("action.saving") : t("action.save")}
        </Button>
      </div>
    </Form>
  );
}

function DeleteStage({ team, stage, close }: { team: Team; stage: Stage; close: () => void }) {
  const t = useT();
  const { run } = useWorkspace();
  const others = team.stages.filter((s) => s.id !== stage.id);
  const [replacement, setReplacement] = useState<Id | undefined>(others[0]?.id);
  const { pending, error, guard } = usePending();
  return (
    <Form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (replacement)
          void guard(async () => {
            await run(
              { type: "delete_stage", team_id: team.id, id: stage.id, replacement },
              { quiet: true },
            );
            close();
          });
      }}
    >
      <Select
        label={t("stage.moveTo")}
        selectedKey={replacement}
        onSelectionChange={(k) => setReplacement(k as Id)}
        options={others.map((s) => ({
          id: s.id,
          label: s.name,
          icon: <StageIcon kind={s.kind} />,
        }))}
      />
      <FormError>{error}</FormError>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onPress={close}>
          {t("action.cancel")}
        </Button>
        <Button type="submit" variant="destructive" isDisabled={!replacement || pending}>
          {t("action.delete")}
        </Button>
      </div>
    </Form>
  );
}
