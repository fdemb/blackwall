import { useEffect, useRef, useState } from "react";
import { Form } from "react-aria-components";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Check } from "lucide-react";
import { Button } from "~/components/ui/button";
import { useDialogBusy, useDialogDirty } from "~/components/ui/dialog";
import { FormError } from "~/components/ui/field";
import { useToast } from "~/components/ui/toast";
import { useI18n } from "~/lib/i18n";
import { usePending } from "~/lib/use-pending";
import { useWorkspace } from "~/lib/workspace";
import { syncApi, syncKey, syncProvidersQuery, syncQuery } from "~/lib/sync";
import {
  WIZARD_STEPS,
  canVisit,
  configChanged,
  configSnapshot,
  connectBody,
  connectChanged,
  draftProblem,
  findCreatedConnection,
  initialDraft,
  isAmbiguousFailure,
  resolveProjects,
  stepError,
  supportedOptions,
  type WizardDraft,
  type WizardStep,
} from "~/lib/sync-wizard";
import type { SyncConnection, SyncProvider, SyncProviderKind } from "~/lib/types";
import { cn } from "~/lib/utils";
import { ConnectStep } from "./connect-step";
import { ProjectsStep } from "./projects-step";
import { StatusesStep } from "./statuses-step";
import { PeopleStep } from "./people-step";
import { FieldsStep } from "./fields-step";
import { ReviewStep } from "./review-step";

export interface StepProps {
  draft: WizardDraft;
  update: (change: Partial<WizardDraft>) => void;
  /** Null until Connect creates the connection. */
  connection: SyncConnection | null;
  provider: SyncProvider | undefined;
  pending: boolean;
}

export function SyncWizard({
  editing,
  close,
}: {
  editing: SyncConnection | null;
  close: () => void;
}) {
  const { ws, members, run } = useWorkspace();
  const { t } = useI18n();
  const toast = useToast();
  const client = useQueryClient();
  const providers = useQuery(syncProvidersQuery(ws.id));
  // The list query polls, so cached projects appear here while discovery runs.
  const list = useQuery(syncQuery(ws.id));
  const [saved, setSaved] = useState(editing);
  const connection = list.data?.connections.find((c) => c.id === saved?.id) ?? saved;
  const [kind, setKind] = useState<SyncProviderKind | null>(editing?.provider ?? null);
  const provider =
    providers.data?.find((p) => p.kind === (connection?.provider ?? kind)) ?? providers.data?.[0];
  const [step, setStep] = useState<WizardStep>("connect");
  const [draft, setDraft] = useState(() => initialDraft(editing));
  // The server settings the draft started from; saving stops if someone else changed them.
  const [base, setBase] = useState(() => (editing ? configSnapshot(editing) : null));
  const [stale, setStale] = useState<SyncConnection | null>(null);
  const [problem, setProblem] = useState("");
  const { pending, error, guard } = usePending();
  useDialogBusy(pending);
  // Connections that existed at open. A create whose response was lost may have made a new one.
  const known = useRef(
    client.getQueryData(syncQuery(ws.id).queryKey)?.connections.map((c) => c.id) ?? null,
  );
  const createLost = useRef(false);
  const heading = useRef<HTMLHeadingElement>(null);
  const navigated = useRef(false);
  useEffect(() => {
    if (navigated.current) heading.current?.focus();
  }, [step]);
  const refresh = () => client.invalidateQueries({ queryKey: syncKey(ws.id) });
  const update = (change: Partial<WizardDraft>) => {
    setProblem("");
    setDraft((old) => ({ ...old, ...change }));
  };
  useDialogDirty(JSON.stringify(draft) !== JSON.stringify(initialDraft(connection)));

  const adopt = (created: SyncConnection) => {
    setSaved(created);
    setBase(configSnapshot(created));
    setDraft((old) => ({ ...old, token: "", options: created.options }));
  };

  // Connect saves right away: a new connection needs to exist before discovery can list projects.
  const saveConnect = async () => {
    if (!connection) {
      if (!provider) throw new Error(t("sync.loadError"));
      if (!known.current || createLost.current) {
        const { connections } = await syncApi.list(ws.id);
        if (!known.current) known.current = connections.map((c) => c.id);
        const created =
          createLost.current &&
          findCreatedConnection(connections, new Set(known.current), provider.kind, draft);
        if (created) {
          createLost.current = false;
          adopt(created);
          await refresh();
          return;
        }
      }
      try {
        adopt(
          await syncApi.create(ws.id, {
            provider: provider.kind,
            name: draft.name.trim(),
            base_url: draft.base_url.trim(),
            token: draft.token.trim(),
          }),
        );
        createLost.current = false;
      } catch (e) {
        createLost.current = isAmbiguousFailure(e);
        throw e;
      }
      await refresh();
    } else if (connectChanged(connection, draft)) {
      const updated = await syncApi.update(ws.id, connection.id, connectBody(draft));
      setSaved(updated);
      setBase(configSnapshot(updated));
      setDraft((old) => ({ ...old, token: "" }));
      await refresh();
    }
  };

  const moveTo = (target: WizardStep) => {
    navigated.current = true;
    setStep(target);
  };

  const reload = () => {
    if (!stale) return;
    setSaved(stale);
    setDraft(initialDraft(stale));
    setBase(configSnapshot(stale));
    setStale(null);
    setProblem("");
  };

  const go = (target: WizardStep) => {
    const forward = WIZARD_STEPS.indexOf(target) > WIZARD_STEPS.indexOf(step);
    const blocked = forward ? stepError(step, draft, !connection) : null;
    if (blocked) return setProblem(t(blocked));
    setProblem("");
    if (step !== "connect") return moveTo(target);
    void guard(async () => {
      await saveConnect();
      moveTo(target);
    });
  };

  const save = () =>
    void guard(async () => {
      if (!connection || !provider) return;
      const blocked = draftProblem(draft, connection.cached_statuses, ws.teams, memberIds);
      if (blocked) {
        setProblem(t(blocked.error));
        return moveTo(blocked.step);
      }
      const latest = (await syncApi.list(ws.id)).connections.find((c) => c.id === connection.id);
      if (!latest) throw new Error(t("sync.loadError"));
      if (configChanged(base, latest)) return setStale(latest);
      const projects = await resolveProjects(
        draft.projects,
        connection.cached_statuses,
        ws.teams,
        (stage) => run({ type: "create_stage", ...stage }, { quiet: true }),
        t("sync.migrationMissing"),
      );
      // Created stages stay in the draft, so a retry after a failed save doesn't create them again.
      setDraft((old) => ({ ...old, projects }));
      const result = await syncApi.update(ws.id, connection.id, {
        projects,
        people_mapping: draft.people,
        options: supportedOptions(draft.options, provider),
      });
      // Unchanged import settings don't restart the scan, so ask for one.
      if (result.generation === connection.generation && result.enabled && projects.length > 0)
        await syncApi.sync(ws.id, connection.id);
      toast.show(t("sync.started"));
      await refresh();
      close();
    });

  const memberIds = new Set(members.map((member) => member.id));
  const index = WIZARD_STEPS.indexOf(step);
  const last = index === WIZARD_STEPS.length - 1;
  const missing =
    last && connection
      ? draftProblem(draft, connection.cached_statuses, ws.teams, memberIds)
      : null;
  const props: StepProps = { draft, update, connection, provider, pending };
  return (
    <Form
      className="flex flex-col gap-5"
      onSubmit={(event) => {
        event.preventDefault();
        if (last) save();
        else go(WIZARD_STEPS[index + 1]!);
      }}
    >
      <nav aria-label={t("sync.wizard.steps")}>
        <ol className="flex flex-wrap gap-1">
          {WIZARD_STEPS.map((target, at) => {
            const current = target === step;
            const done = at < index;
            return (
              <li key={target}>
                <Button
                  variant="ghost"
                  size="sm"
                  aria-current={current ? "step" : undefined}
                  isDisabled={
                    pending || (!current && !canVisit(target, draft, Boolean(connection)))
                  }
                  onPress={() => go(target)}
                  className={cn(
                    "gap-1.5 text-muted-foreground",
                    current && "bg-accent text-accent-foreground",
                  )}
                >
                  <span
                    aria-hidden
                    className={cn(
                      "flex size-4 items-center justify-center rounded-full border border-border text-[10px] tabular-nums",
                      (current || done) && "border-primary-solid",
                    )}
                  >
                    {done ? <Check className="size-2.5" /> : at + 1}
                  </span>
                  {t(`sync.step.${target}`)}
                </Button>
              </li>
            );
          })}
        </ol>
      </nav>
      <h3 ref={heading} tabIndex={-1} className="-mb-2 text-[13px] font-medium outline-none">
        {t(`sync.step.${step}`)}
      </h3>
      <div className="min-h-48">
        {step === "connect" && (
          <ConnectStep
            {...props}
            providers={providers.data ?? []}
            providersLoading={providers.isPending}
            kind={provider?.kind ?? null}
            setKind={setKind}
          />
        )}
        {step === "projects" && <ProjectsStep {...props} />}
        {step === "statuses" && <StatusesStep {...props} />}
        {step === "people" && <PeopleStep {...props} />}
        {step === "fields" && <FieldsStep {...props} />}
        {step === "review" && <ReviewStep {...props} />}
      </div>
      {stale ? (
        <div
          role="alert"
          className="flex flex-wrap items-center gap-3 text-[13px] text-destructive"
        >
          <p>{t("sync.wizard.changed")}</p>
          <Button size="sm" onPress={reload}>
            {t("sync.wizard.reload")}
          </Button>
        </div>
      ) : (
        <FormError>{problem || error || (missing ? t(missing.error) : "")}</FormError>
      )}
      <div className="flex items-center justify-between gap-2 border-t border-border pt-4">
        <Button variant="ghost" onPress={close} isDisabled={pending}>
          {t("action.cancel")}
        </Button>
        <div className="flex gap-2">
          {index > 0 && (
            <Button isDisabled={pending} onPress={() => go(WIZARD_STEPS[index - 1]!)}>
              {t("sync.wizard.back")}
            </Button>
          )}
          <Button
            type="submit"
            variant="primary"
            isPending={pending}
            isDisabled={!provider || Boolean(missing) || (last && Boolean(stale))}
          >
            {last
              ? t("sync.wizard.save")
              : step === "connect" && !connection
                ? t("sync.wizard.connect")
                : t("sync.wizard.next")}
          </Button>
        </div>
      </div>
    </Form>
  );
}
