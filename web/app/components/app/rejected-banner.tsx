import { useState } from "react";
import { AlertTriangle } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Dialog } from "~/components/ui/dialog";
import { useToast } from "~/components/ui/toast";
import { useI18n } from "~/lib/i18n";
import type { Command } from "~/lib/types";
import { useWorkspace } from "~/lib/workspace";
import type { Rejection } from "~/sync/engine";

const TEXT_FIELDS = new Set(["description", "body", "title", "name"]);

/** The text a person typed into the command, so it can be pasted back; otherwise its JSON. */
export function rejectedText(command: NonNullable<Rejection["command"]>): string {
  const found: string[] = [];
  const visit = (value: unknown, key: string | null) => {
    if (typeof value === "string") {
      if (key !== null && TEXT_FIELDS.has(key) && value.trim()) found.push(value);
    } else if (value !== null && typeof value === "object")
      for (const [field, inner] of Object.entries(value)) visit(inner, field);
  };
  visit(command.args, null);
  return found.length > 0 ? found.join("\n\n") : JSON.stringify(command.args, null, 2);
}

/** Lists edits the server refused, kept across reloads until the person copies, retries or dismisses them. */
export function RejectedBanner() {
  const { t } = useI18n();
  const { unresolved } = useWorkspace();
  const [open, setOpen] = useState(false);
  if (unresolved.length === 0) return null;
  return (
    <div
      role="status"
      className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-destructive/40 bg-destructive/10 px-4 py-1.5 "
    >
      <AlertTriangle className="size-3.5 shrink-0" />
      <span className="flex-1">{t("rejected.banner", { count: unresolved.length })}</span>
      <Button size="sm" variant="ghost" onPress={() => setOpen(true)}>
        {t("rejected.review")}
      </Button>
      <Dialog title={t("rejected.title")} size="lg" isOpen={open} onOpenChange={setOpen}>
        <ul className="flex flex-col gap-3">
          {unresolved.map((rejection) => (
            <RejectedItem key={rejection.id} rejection={rejection} />
          ))}
        </ul>
      </Dialog>
    </div>
  );
}

function RejectedItem({ rejection }: { rejection: Rejection }) {
  const { t } = useI18n();
  const toast = useToast();
  const { run, resolveRejection, offline } = useWorkspace();
  const command = rejection.command;
  if (!command) return null;
  const text = rejectedText(command);
  const copy = () =>
    navigator.clipboard.writeText(text).then(
      () => toast.show(t("action.copied")),
      () => toast.error(t("error.generic")),
    );
  const retry = async () => {
    await run({ type: command.name, ...(command.args as object) } as Command);
    resolveRejection(rejection.id);
  };
  return (
    <li className="flex flex-col gap-2 rounded-md border p-3">
      <p className="text-destructive">{rejection.message}</p>
      <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words text-muted-foreground">
        {text}
      </pre>
      <div className="flex justify-end gap-2">
        <Button size="sm" variant="ghost" onPress={() => resolveRejection(rejection.id)}>
          {t("action.dismiss")}
        </Button>
        <Button size="sm" variant="ghost" onPress={copy}>
          {t("action.copy")}
        </Button>
        <Button size="sm" isDisabled={offline} onPress={() => void retry().catch(() => undefined)}>
          {t("action.retry")}
        </Button>
      </div>
    </li>
  );
}
