import { useEffect, useState } from "react";
import { Check, Loader2 } from "lucide-react";
import { useI18n } from "~/lib/i18n";
import { useWorkspace } from "~/lib/workspace";

/** Says "Saving…" while writes are in flight and "Saved" for a moment after, for pages that save as you edit. */
export function SaveStatus() {
  const { t } = useI18n();
  const { pending } = useWorkspace();
  const [saved, setSaved] = useState(false);
  const [prevPending, setPrevPending] = useState(pending);
  if (prevPending !== pending) {
    setPrevPending(pending);
    setSaved(pending === 0 && prevPending > 0);
  }
  useEffect(() => {
    if (!saved) return;
    const timer = setTimeout(() => setSaved(false), 2500);
    return () => clearTimeout(timer);
  }, [saved]);
  return (
    <span role="status" className="flex items-center gap-1 text-xs text-muted-foreground">
      {pending > 0 ? (
        <>
          <Loader2 className="size-3 animate-spin" />
          {t("action.saving")}
        </>
      ) : saved ? (
        <>
          <Check className="size-3" />
          {t("action.saved")}
        </>
      ) : null}
    </span>
  );
}
