import { Select } from "~/components/ui/select";
import { TextField } from "~/components/ui/field";
import { useI18n } from "~/lib/i18n";
import { trackerProviderName, trackerProviders } from "~/lib/trackers";
import type { TrackerProvider, TrackerProviderKind } from "~/lib/types";
import type { StepProps } from "./wizard";

export function ConnectStep({
  draft,
  update,
  connection,
  pending,
  providers,
  providersLoading,
  kind,
  setKind,
}: StepProps & {
  providers: TrackerProvider[];
  providersLoading: boolean;
  kind: TrackerProviderKind | null;
  setKind: (kind: TrackerProviderKind) => void;
}) {
  const { t } = useI18n();
  const text = kind ? trackerProviders[kind] : undefined;
  return (
    <div className="flex flex-col gap-4">
      <Select
        label={t("tracker.provider")}
        options={providers.map((provider) => ({
          id: provider.kind,
          label: trackerProviderName(provider.kind),
        }))}
        selectedKey={kind}
        onSelectionChange={(key) => setKind(key as TrackerProviderKind)}
        placeholder={providersLoading ? t("action.loading") : t("tracker.loadError")}
        // A connection keeps its provider; another tracker needs another connection.
        isDisabled={pending || connection !== null || providers.length < 2}
      />
      <TextField
        label={t("field.name")}
        value={draft.name}
        onChange={(name) => update({ name })}
        isRequired
        autoFocus
        autoComplete="off"
        isDisabled={pending}
        placeholder={kind ? trackerProviderName(kind) : undefined}
      />
      <TextField
        label={text ? t(text.url) : t("tracker.url")}
        description={text ? t(text.urlHint) : undefined}
        type="url"
        value={draft.base_url}
        onChange={(base_url) => update({ base_url })}
        isRequired
        autoComplete="off"
        spellCheck="false"
        isDisabled={pending}
        placeholder="https://"
      />
      <TextField
        label={text ? t(text.token) : t("tracker.token")}
        description={
          connection ? t("tracker.tokenKeep") : text ? t(text.tokenHint) : t("tracker.tokenStored")
        }
        type="password"
        value={draft.token}
        onChange={(token) => update({ token })}
        isRequired={!connection}
        autoComplete="new-password"
        spellCheck="false"
        isDisabled={pending}
      />
      {!connection && <p className="text-xs text-muted-foreground">{t("tracker.connectHint")}</p>}
    </div>
  );
}
