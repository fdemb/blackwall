import { Select } from "~/components/ui/select";
import { TextField } from "~/components/ui/field";
import { useI18n } from "~/lib/i18n";
import { syncProviderName, syncProviders } from "~/lib/sync";
import type { SyncProvider, SyncProviderKind } from "~/lib/types";
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
  providers: SyncProvider[];
  providersLoading: boolean;
  kind: SyncProviderKind | null;
  setKind: (kind: SyncProviderKind) => void;
}) {
  const { t } = useI18n();
  const text = kind ? syncProviders[kind] : undefined;
  return (
    <div className="flex flex-col gap-4">
      <Select
        label={t("sync.provider")}
        options={providers.map((provider) => ({
          id: provider.kind,
          label: syncProviderName(provider.kind),
        }))}
        selectedKey={kind}
        onSelectionChange={(key) => setKind(key as SyncProviderKind)}
        placeholder={providersLoading ? t("action.loading") : t("sync.loadError")}
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
        placeholder={kind ? syncProviderName(kind) : undefined}
      />
      <TextField
        label={text ? t(text.url) : t("sync.url")}
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
        label={text ? t(text.token) : t("sync.token")}
        description={
          connection ? t("sync.tokenKeep") : text ? t(text.tokenHint) : t("sync.tokenStored")
        }
        type="password"
        value={draft.token}
        onChange={(token) => update({ token })}
        isRequired={!connection}
        autoComplete="new-password"
        spellCheck="false"
        isDisabled={pending}
      />
      {!connection && <p className="text-xs text-muted-foreground">{t("sync.connectHint")}</p>}
    </div>
  );
}
