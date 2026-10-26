import { useState } from "react";
import { Link } from "react-router";
import { Form } from "react-aria-components";
import { ChevronRight, Plus, Users } from "lucide-react";
import { Avatar } from "~/components/ui/avatar";
import { Button } from "~/components/ui/button";
import { Dialog, useDialogDirty } from "~/components/ui/dialog";
import { FormError, TextField } from "~/components/ui/field";
import { EmptyState } from "~/components/app/page";
import { SettingsBlock, SettingsPage, SettingsSection } from "~/components/app/settings";
import { MultiMemberPicker } from "~/components/app/pickers";
import { StageIcon } from "~/components/app/icons";
import { TeamIcon } from "~/components/app/team-icon";
import { useI18n } from "~/lib/i18n";
import { usePending } from "~/lib/use-pending";
import { useIssueCount, useStageIssueCounts } from "~/lib/stats";
import { teamView, type TeamView } from "~/lib/team-settings";
import { useWorkspace } from "~/lib/workspace";
import { freeTeamKey, isTeamKey, teamKey, teamKeyInput } from "~/lib/identifiers";
import type { Id } from "~/lib/types";

const MAX_AVATARS = 4;

export default function Teams() {
  const { t } = useI18n();
  const { ws, canAdmin, canWrite, create } = useWorkspace();
  const issueCount = useIssueCount();
  const counts = useStageIssueCounts();
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
      {ws.teams.length > 0 && issueCount === 0 && canWrite && (
        <SettingsBlock>
          <div className="flex flex-wrap items-center gap-3 rounded-lg bg-accent/50 px-4 py-3">
            <div className="min-w-0 flex-1">
              <h2 className=" font-semibold">{t("setup.issueTitle")}</h2>
              <p className=" text-muted-foreground">{t("setup.issueSub")}</p>
            </div>
            <Button
              variant="primary"
              size="sm"
              onPress={() => create.show({ team_id: ws.teams[0].id })}
            >
              {t("issue.new")}
            </Button>
          </div>
        </SettingsBlock>
      )}
      {ws.teams.length === 0 ? (
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
      ) : (
        <SettingsSection>
          <div
            aria-hidden
            className="flex items-center gap-4 border-b border-border bg-background px-4 py-2 text-xs font-medium text-muted-foreground sm:px-5"
          >
            <span className="flex-1">{t("teams.colTeam")}</span>
            <span className="hidden w-45 shrink-0 md:block">{t("teams.colWorkflow")}</span>
            <span className="hidden w-24 shrink-0 sm:block">{t("teams.colMembers")}</span>
            <span className="w-16 shrink-0 text-right">{t("teams.colOpen")}</span>
            <span className="w-4 shrink-0" />
          </div>
          <ul className="divide-y divide-border">
            {ws.teams.map((team) => (
              <TeamRow key={team.id} view={teamView(team, counts)} />
            ))}
          </ul>
        </SettingsSection>
      )}
      <Dialog title={t("team.create")} size="sm" isOpen={creating} onOpenChange={setCreating}>
        {(close) => <CreateTeam close={close} />}
      </Dialog>
    </SettingsPage>
  );
}

function TeamRow({ view: { team, stages, openIssues } }: { view: TeamView }) {
  const { t } = useI18n();
  const { ws, member } = useWorkspace();
  const people = team.members.flatMap((id) => {
    const m = member(id);
    return m ? [m] : [];
  });
  return (
    <li>
      <Link
        to={`/${ws.slug}/settings/teams/${team.key}`}
        className="flex items-center gap-4 px-4 py-3.5 outline-none transition-colors hover:bg-muted/60 focus-visible:bg-muted/60 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/60 sm:px-5"
      >
        <span className="flex min-w-0 flex-1 items-center gap-3">
          <TeamIcon team={team} className="size-8 rounded-lg [&_svg]:size-4" />
          <span className="flex min-w-0 flex-col">
            <span className="flex items-center gap-2">
              <span className="truncate font-medium">{team.name}</span>
              <span className="font-mono text-[11px] text-muted-foreground">{team.key}</span>
            </span>
            <span className="truncate text-muted-foreground">
              {team.archive_after_days === null
                ? t("teams.archivesNever")
                : t("teams.archivesAfter", { count: team.archive_after_days })}
            </span>
          </span>
        </span>
        <span className="hidden w-45 shrink-0 items-center gap-1.5 md:flex">
          {stages.map(({ stage }) => (
            <StageIcon key={stage.id} kind={stage.kind} />
          ))}
          <span className="pl-0.5 text-muted-foreground">
            {t("teams.stages", { count: stages.length })}
          </span>
        </span>
        <span
          role="img"
          className="hidden w-24 shrink-0 items-center -space-x-1.5 sm:flex"
          aria-label={t("count.members", { count: people.length })}
        >
          {people.slice(0, MAX_AVATARS).map((m) => (
            <Avatar
              key={m.id}
              name={m.display_name}
              src={m.avatar_url}
              size={26}
              className="ring-2 ring-card"
            />
          ))}
          {people.length > MAX_AVATARS && (
            <span className="pl-2.5 text-xs text-muted-foreground">
              +{people.length - MAX_AVATARS}
            </span>
          )}
        </span>
        <span className="w-16 shrink-0 text-right tabular-nums">{openIssues}</span>
        <ChevronRight aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      </Link>
    </li>
  );
}

function CreateTeam({ close }: { close: () => void }) {
  const { t } = useI18n();
  const { run, me, ws } = useWorkspace();
  const [name, setName] = useState("");
  // The key follows the name until edited by hand.
  const [key, setKey] = useState<string | null>(null);
  const [members, setMembers] = useState<Id[]>([me]);
  const { pending, error, guard } = usePending();
  useDialogDirty(name !== "");
  const taken = new Set(ws.teams.flatMap((team) => [team.key, ...team.former_keys]));
  const shownKey = key ?? freeTeamKey(teamKey(name), taken);
  const keyError = !shownKey
    ? ""
    : !isTeamKey(shownKey)
      ? t("team.keyInvalid")
      : taken.has(shownKey)
        ? t("team.keyTaken")
        : "";
  return (
    <Form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        void guard(async () => {
          await run(
            { type: "create_team", name: name.trim(), key: shownKey, members },
            { quiet: true },
          );
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
      <TextField
        label={t("team.key")}
        description={shownKey ? t("team.keyHint", { example: `${shownKey}-1` }) : undefined}
        error={keyError}
        value={shownKey}
        onChange={(value) => setKey(teamKeyInput(value))}
        autoComplete="off"
        spellCheck="false"
        isRequired
      />
      <div>
        <span className="mb-1 block  font-medium text-muted-foreground">{t("nav.people")}</span>
        <MultiMemberPicker value={members} onChange={setMembers} />
      </div>
      <FormError>{error}</FormError>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onPress={close}>
          {t("action.cancel")}
        </Button>
        <Button
          type="submit"
          variant="primary"
          isDisabled={!name.trim() || !shownKey || Boolean(keyError) || pending}
        >
          {pending ? t("action.saving") : t("action.save")}
        </Button>
      </div>
    </Form>
  );
}
