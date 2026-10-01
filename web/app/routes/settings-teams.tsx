import { useState } from "react";
import { Form } from "react-aria-components";
import { ArrowDown, ArrowUp, Plus, Trash2, Users } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Dialog } from "~/components/ui/dialog";
import { Input, TextField } from "~/components/ui/field";
import { Select } from "~/components/ui/select";
import { Card, EmptyState } from "~/components/app/page";
import { MultiMemberPicker } from "~/components/app/pickers";
import { StageIcon } from "~/components/app/icons";
import { STAGE_KINDS } from "~/lib/format";
import { useT } from "~/lib/i18n";
import { useWorkspace } from "~/lib/workspace";
import type { Id, Stage, StageKind, Team } from "~/lib/types";

export default function Teams() {
  const t = useT();
  const { ws, canAdmin } = useWorkspace();
  const [creating, setCreating] = useState(false);
  return (
    <>
      <div className="flex items-center">
        <div>
          <h2 className="text-[14px] font-semibold">{t("settings.teams")}</h2>
          <p className="text-xs text-muted-foreground">{t("teams.sub")}</p>
        </div>
        {canAdmin && (
          <Button variant="primary" size="sm" className="ml-auto" onPress={() => setCreating(true)}>
            <Plus />
            {t("team.create")}
          </Button>
        )}
      </div>
      {ws.teams.length === 0 && (
        <Card>
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
        </Card>
      )}
      {ws.teams.map((tm) => (
        <TeamCard key={tm.id} team={tm} />
      ))}
      <Dialog title={t("team.create")} size="sm" isOpen={creating} onOpenChange={setCreating}>
        {(close) => <CreateTeam close={close} />}
      </Dialog>
    </>
  );
}

function CreateTeam({ close }: { close: () => void }) {
  const t = useT();
  const { run, me } = useWorkspace();
  const [name, setName] = useState("");
  const [members, setMembers] = useState<Id[]>([me]);
  return (
    <Form
      className="flex flex-col gap-4"
      onSubmit={async (e) => {
        e.preventDefault();
        await run({ type: "create_team", name: name.trim(), members })
          .then(close)
          .catch(() => {});
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
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onPress={close}>
          {t("action.cancel")}
        </Button>
        <Button type="submit" variant="primary" isDisabled={!name.trim()}>
          {t("action.save")}
        </Button>
      </div>
    </Form>
  );
}

function TeamCard({ team }: { team: Team }) {
  const t = useT();
  const { run, canAdmin } = useWorkspace();
  const stages = [...team.stages].sort((a, b) => a.position - b.position);
  const [adding, setAdding] = useState(false);
  const [deleting, setDeleting] = useState<Stage | null>(null);
  const swap = async (a: Stage, b: Stage) => {
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
  };
  return (
    <Card>
      <div className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
        <h3 className="text-[14px] font-semibold">{team.name}</h3>
        <div className="ml-auto w-56">
          {canAdmin ? (
            <MultiMemberPicker
              value={team.members}
              onChange={(members) =>
                run({ type: "set_team_members", id: team.id, members }).catch(() => {})
              }
            />
          ) : null}
        </div>
      </div>
      <div className="px-4 py-3">
        <div className="mb-2 flex items-center">
          <h4 className="text-xs font-medium text-muted-foreground">{t("teams.workflow")}</h4>
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
              onUp={() => swap(s, stages[i - 1]).catch(() => {})}
              onDown={() => swap(s, stages[i + 1]).catch(() => {})}
              onDelete={() => setDeleting(s)}
            />
          ))}
        </ul>
      </div>
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
    </Card>
  );
}

function StageRow({
  team,
  stage,
  first,
  last,
  canEdit,
  onUp,
  onDown,
  onDelete,
}: {
  team: Team;
  stage: Stage;
  first: boolean;
  last: boolean;
  canEdit: boolean;
  onUp: () => void;
  onDown: () => void;
  onDelete: () => void;
}) {
  const t = useT();
  const { run } = useWorkspace();
  const [name, setName] = useState(stage.name);
  const save = (patch: Partial<Stage>) =>
    run({
      type: "update_stage",
      team_id: team.id,
      id: stage.id,
      name: (patch.name ?? stage.name).trim(),
      kind: patch.kind ?? stage.kind,
      position: stage.position,
    }).catch(() => setName(stage.name));
  return (
    <li className="flex items-center gap-2">
      <StageIcon kind={stage.kind} className="mx-1" />
      <Input
        aria-label={t("stage.name")}
        value={name}
        disabled={!canEdit}
        onChange={(e) => setName(e.target.value)}
        onBlur={() => name.trim() && name !== stage.name && save({ name })}
        className="h-8 flex-1"
      />
      <Select
        aria-label={t("stage.kind")}
        className="w-36"
        isDisabled={!canEdit}
        selectedKey={stage.kind}
        onSelectionChange={(k) => save({ kind: k as StageKind })}
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
            isDisabled={first}
            onPress={onUp}
          >
            <ArrowUp />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            aria-label={t("action.moveDown")}
            isDisabled={last}
            onPress={onDown}
          >
            <ArrowDown />
          </Button>
          <Button variant="ghost" size="icon" aria-label={t("action.delete")} onPress={onDelete}>
            <Trash2 />
          </Button>
        </span>
      )}
    </li>
  );
}

function AddStage({ team, close }: { team: Team; close: () => void }) {
  const t = useT();
  const { run } = useWorkspace();
  const [name, setName] = useState("");
  const [kind, setKind] = useState<StageKind>("active");
  const position = Math.max(0, ...team.stages.map((s) => s.position)) + 1;
  return (
    <Form
      className="flex flex-col gap-4"
      onSubmit={async (e) => {
        e.preventDefault();
        await run({ type: "create_stage", team_id: team.id, name: name.trim(), kind, position })
          .then(close)
          .catch(() => {});
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
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onPress={close}>
          {t("action.cancel")}
        </Button>
        <Button type="submit" variant="primary" isDisabled={!name.trim()}>
          {t("action.save")}
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
  return (
    <Form
      className="flex flex-col gap-4"
      onSubmit={async (e) => {
        e.preventDefault();
        if (replacement)
          await run({ type: "delete_stage", team_id: team.id, id: stage.id, replacement })
            .then(close)
            .catch(() => {});
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
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onPress={close}>
          {t("action.cancel")}
        </Button>
        <Button type="submit" variant="destructive" isDisabled={!replacement}>
          {t("action.delete")}
        </Button>
      </div>
    </Form>
  );
}
