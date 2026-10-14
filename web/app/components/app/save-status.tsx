import { useEffect, useState } from "react";
import { AlertCircle, Check, CloudOff, Loader2, type LucideIcon } from "lucide-react";
import { useI18n, type Key } from "~/lib/i18n";
import { useWorkspace, type SyncProblem } from "~/lib/workspace";

type SaveState = "queued" | "unsent" | "saving" | "failed" | "saved";

const VIEW: Record<SaveState, { icon: LucideIcon; className: string; label: Key }> = {
  queued: { icon: CloudOff, className: "size-3", label: "action.queued" },
  unsent: { icon: AlertCircle, className: "size-3 text-destructive", label: "action.notSent" },
  saving: { icon: Loader2, className: "size-3 animate-spin", label: "action.saving" },
  failed: { icon: AlertCircle, className: "size-3 text-destructive", label: "action.saveFailed" },
  saved: { icon: Check, className: "size-3", label: "action.saved" },
};

function saveState(
  pending: number,
  problem: SyncProblem,
  failed: boolean,
  saved: boolean,
): SaveState | null {
  if (pending > 0) {
    if (problem === "offline" || problem === "unreachable") return "queued";
    return problem === null ? "saving" : "unsent";
  }
  if (failed) return "failed";
  return saved ? "saved" : null;
}

/**
 * Says "Saving…" while writes are in flight and "Saved" for a moment after, for pages that save as
 * you edit. Writes that wait for a connection, can't be sent, or came back rejected say so instead.
 */
export function SaveStatus() {
  const { t } = useI18n();
  const { pending, rejected, syncProblem } = useWorkspace();
  const [saved, setSaved] = useState(false);
  const [prevPending, setPrevPending] = useState(pending);
  // Rejections counted when the current writes started, so later ones mark them not saved.
  const [baseline, setBaseline] = useState(rejected);
  if (prevPending !== pending) {
    setPrevPending(pending);
    if (prevPending === 0) setBaseline(rejected);
    setSaved(pending === 0 && prevPending > 0);
  }
  useEffect(() => {
    if (!saved) return;
    const timer = setTimeout(() => setSaved(false), 2500);
    return () => clearTimeout(timer);
  }, [saved]);
  const state = saveState(pending, syncProblem, rejected > baseline, saved);
  const view = state && VIEW[state];
  return (
    <span role="status" className="flex items-center gap-1  text-muted-foreground">
      {view && (
        <>
          <view.icon className={view.className} />
          {t(view.label)}
        </>
      )}
    </span>
  );
}
