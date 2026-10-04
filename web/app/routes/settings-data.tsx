import { useRef, useState } from "react";
import { DropZone, FileTrigger, Text } from "react-aria-components";
import { Download, FileUp } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Dialog } from "~/components/ui/dialog";
import { FormError } from "~/components/ui/field";
import { useToast } from "~/components/ui/toast";
import { SettingsPage, SettingsSection } from "~/components/app/settings";
import { workspaces } from "~/lib/api";
import { download } from "~/lib/format";
import { useT, type Key } from "~/lib/i18n";
import { usePending } from "~/lib/use-pending";
import { useWorkspace } from "~/lib/workspace";
import type { ImportSummary } from "~/lib/types";

type Body = { issues: unknown[] } | { transfer: unknown };
interface Preview {
  name: string;
  kind: "transfer" | "issues";
  counts: [Key, number][];
  body: Body;
}

const COUNTED = [
  "issues",
  "comments",
  "time_entries",
  "teams",
  "labels",
  "projects",
  "sprints",
] as const;

/** Reads the file and works out what it holds, without sending anything to the server yet. */
function inspect(name: string, parsed: unknown): Preview | null {
  const obj = (parsed ?? {}) as Record<string, unknown>;
  const len = (v: unknown) => (Array.isArray(v) ? v.length : 0);
  // A Blackwall export is an object; a bare array is treated as a list of issue inputs.
  if (Array.isArray(parsed))
    return parsed.length
      ? {
          name,
          kind: "issues",
          counts: [["data.count.issues", parsed.length]],
          body: { issues: parsed },
        }
      : null;
  if (obj.issues && !obj.workspace && !obj.teams)
    return len(obj.issues)
      ? {
          name,
          kind: "issues",
          counts: [["data.count.issues", len(obj.issues)]],
          body: { issues: obj.issues as unknown[] },
        }
      : null;
  const counts = COUNTED.map(
    (k) => [`data.count.${k}` as Key, len(obj[k])] as [Key, number],
  ).filter(([, n]) => n > 0);
  return counts.length ? { name, kind: "transfer", counts, body: { transfer: parsed } } : null;
}

export default function Data() {
  const t = useT();
  const { ws, canWrite, canAdmin, reload } = useWorkspace();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const importKey = useRef(crypto.randomUUID());
  const [preview, setPreview] = useState<Preview | null>(null);
  const [result, setResult] = useState<ImportSummary | null | undefined>(undefined);

  const exportAll = async () => {
    setBusy(true);
    try {
      const data = await workspaces.export(ws.id);
      download(
        `${ws.name.toLowerCase().replace(/\W+/g, "-")}-export.json`,
        JSON.stringify(data, null, 2),
      );
    } catch (e) {
      toast.error((e as Error).message);
    }
    setBusy(false);
  };
  const choose = async (file: File) => {
    importKey.current = crypto.randomUUID();
    try {
      const found = inspect(file.name, JSON.parse(await file.text()));
      if (!found) return toast.error(t("data.emptyFile"));
      setResult(undefined);
      setPreview(found);
    } catch (e) {
      toast.error(e instanceof SyntaxError ? t("data.invalidJson") : (e as Error).message);
    }
  };
  const close = () => {
    setPreview(null);
    setResult(undefined);
  };
  return (
    <SettingsPage title={t("settings.data")}>
      <SettingsSection title={t("data.export")} description={t("data.exportSub")}>
        <div className="px-4 py-4 sm:px-5 sm:py-5">
          <Button variant="secondary" isDisabled={busy} onPress={exportAll}>
            <Download />
            {t("data.exportButton")}
          </Button>
        </div>
      </SettingsSection>
      {canWrite && (
        <SettingsSection title={t("data.import")} description={t("data.importSub")}>
          <div className="px-4 py-4 sm:px-5 sm:py-5">
            <DropZone
              className="flex flex-col items-center gap-2 rounded-xl border border-dashed border-input px-6 py-10 text-center transition-colors drop-target:border-primary drop-target:bg-accent/50"
              onDrop={async (e) => {
                for (const item of e.items)
                  if (item.kind === "file") {
                    await choose(await item.getFile());
                    break;
                  }
              }}
            >
              <FileUp className="size-5 text-muted-foreground" />
              <Text slot="label" className="text-[13px] text-muted-foreground">
                {t("data.drop")}
              </Text>
              <FileTrigger
                acceptedFileTypes={["application/json", ".json"]}
                onSelect={(l) => l?.[0] && void choose(l[0])}
              >
                <Button variant="secondary">{t("data.choose")}</Button>
              </FileTrigger>
            </DropZone>
          </div>
        </SettingsSection>
      )}
      <Dialog
        title={result !== undefined ? t("data.resultTitle") : t("data.previewTitle")}
        description={
          result === undefined && preview
            ? t("data.previewSub", { name: preview.name, workspace: ws.name })
            : undefined
        }
        size="sm"
        isOpen={preview !== null}
        onOpenChange={(o) => !o && close()}
      >
        {() =>
          preview &&
          (result !== undefined ? (
            <Finished summary={result} onDone={close} />
          ) : (
            <Review
              preview={preview}
              allowed={preview.kind === "issues" || canAdmin}
              onCancel={close}
              onImport={async () => {
                const res = await workspaces.import(ws.id, preview.body, importKey.current);
                await reload().catch(() => undefined);
                setResult(res.summary);
                toast.show(t("data.imported"));
              }}
            />
          ))
        }
      </Dialog>
    </SettingsPage>
  );
}

function Review({
  preview,
  allowed,
  onCancel,
  onImport,
}: {
  preview: Preview;
  allowed: boolean;
  onCancel: () => void;
  onImport: () => Promise<void>;
}) {
  const t = useT();
  const { pending, error, guard } = usePending();
  return (
    <div className="space-y-4">
      <div>
        <p className="text-[13px] font-medium">
          {t(preview.kind === "transfer" ? "data.kindTransfer" : "data.kindIssues")}
        </p>
        <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-1 text-[13px]">
          {preview.counts.map(([label, n]) => (
            <div key={label} className="flex justify-between border-b border-border/60 py-1">
              <dt className="text-muted-foreground">{t(label)}</dt>
              <dd className="tabular-nums">{n}</dd>
            </div>
          ))}
        </dl>
      </div>
      {!allowed && (
        <p role="alert" className="text-[13px] text-destructive">
          {t("data.adminOnly")}
        </p>
      )}
      <FormError>{error}</FormError>
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onPress={onCancel}>
          {t("action.cancel")}
        </Button>
        <Button
          variant="primary"
          isDisabled={!allowed || pending}
          onPress={() => void guard(onImport)}
        >
          {pending ? t("data.importing") : t("data.confirm")}
        </Button>
      </div>
    </div>
  );
}

function Finished({ summary, onDone }: { summary: ImportSummary | null; onDone: () => void }) {
  const t = useT();
  const fallback = summary?.identities.filter((i) => i.fallback).length ?? 0;
  const matched = (summary?.identities.length ?? 0) - fallback;
  return (
    <div className="space-y-3 text-[13px]">
      {summary ? (
        <>
          <p>
            {t("data.resultCounts", {
              issues: summary.issues,
              comments: summary.comments,
              time: summary.time_entries,
            })}
          </p>
          {matched > 0 && (
            <p className="text-muted-foreground">{t("data.resultMatched", { n: matched })}</p>
          )}
          {fallback > 0 && (
            <p className="font-medium">{t("data.resultIdentities", { n: fallback })}</p>
          )}
        </>
      ) : (
        <p>{t("data.imported")}</p>
      )}
      <div className="flex justify-end">
        <Button variant="primary" onPress={onDone}>
          {t("data.done")}
        </Button>
      </div>
    </div>
  );
}
