import { useState } from "react";
import { DropZone, FileTrigger, Text } from "react-aria-components";
import { Download, FileUp } from "lucide-react";
import { Button } from "~/components/ui/button";
import { useToast } from "~/components/ui/toast";
import { Card } from "~/components/app/page";
import { workspaces } from "~/lib/api";
import { download } from "~/lib/format";
import { useT } from "~/lib/i18n";
import { useWorkspace } from "~/lib/workspace";

export default function Data() {
  const t = useT();
  const { ws, revision, canWrite, reload } = useWorkspace();
  const toast = useToast();
  const [busy, setBusy] = useState(false);

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
  const importFile = async (file: File) => {
    setBusy(true);
    try {
      const parsed = JSON.parse(await file.text());
      // A Blackwall export is an object; a bare array is treated as a list of issue inputs.
      const body = Array.isArray(parsed)
        ? { issues: parsed }
        : parsed.issues && !parsed.workspace && !parsed.teams
          ? { issues: parsed.issues }
          : { transfer: parsed };
      await workspaces.import(ws.id, revision, body);
      await reload();
      toast.show(t("data.imported"));
    } catch (e) {
      toast.error(e instanceof SyntaxError ? t("data.invalidJson") : (e as Error).message);
    }
    setBusy(false);
  };
  return (
    <>
      <Card className="p-5">
        <h2 className="text-[14px] font-semibold">{t("data.export")}</h2>
        <p className="mt-0.5 text-[13px] text-muted-foreground">{t("data.exportSub")}</p>
        <Button className="mt-4" variant="secondary" isDisabled={busy} onPress={exportAll}>
          <Download />
          {t("data.exportButton")}
        </Button>
      </Card>
      {canWrite && (
        <Card className="p-5">
          <h2 className="text-[14px] font-semibold">{t("data.import")}</h2>
          <p className="mt-0.5 text-[13px] text-muted-foreground">{t("data.importSub")}</p>
          <DropZone
            className="mt-4 flex flex-col items-center gap-2 rounded-xl border-2 border-dashed border-border p-8 text-center transition-colors drop-target:border-primary drop-target:bg-accent/50"
            onDrop={async (e) => {
              for (const item of e.items)
                if (item.kind === "file") await importFile(await item.getFile());
            }}
          >
            <FileUp className="size-6 text-muted-foreground" />
            <Text slot="label" className="text-[13px] text-muted-foreground">
              {t("data.drop")}
            </Text>
            <FileTrigger
              acceptedFileTypes={["application/json", ".json"]}
              onSelect={(l) => l?.[0] && importFile(l[0])}
            >
              <Button variant="secondary" isDisabled={busy}>
                {t("data.choose")}
              </Button>
            </FileTrigger>
          </DropZone>
        </Card>
      )}
    </>
  );
}
