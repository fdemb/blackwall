import { useEffect, useRef, useState } from "react";
import { Check, Loader2 } from "lucide-react";
import { useT } from "~/lib/i18n";
import { useWorkspace } from "~/lib/workspace";

/** Says "Saving…" while writes are in flight and "Saved" for a moment after, for pages that save as you edit. */
export function SaveStatus() {
  const t = useT();
  const { pending } = useWorkspace();
  const [saved, setSaved] = useState(false);
  const was = useRef(0);
  useEffect(() => {
    const before = was.current;
    was.current = pending;
    if (pending > 0) return setSaved(false);
    if (before === 0) return;
    setSaved(true);
    const timer = setTimeout(() => setSaved(false), 2500);
    return () => clearTimeout(timer);
  }, [pending]);
  return (
    <span role="status" className="flex items-center gap-1 text-xs text-muted-foreground">
      {pending > 0 ? <><Loader2 className="size-3 animate-spin" />{t("action.saving")}</> : saved ? <><Check className="size-3" />{t("action.saved")}</> : null}
    </span>
  );
}
