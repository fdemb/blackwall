import { createContext, useCallback, use, useMemo, useState, type ReactNode } from "react";
import { AlertCircle, Check, X } from "lucide-react";
import { useT } from "~/lib/i18n";
import { cn } from "~/lib/utils";

export interface ToastAction {
  label: string;
  run: () => void;
}
interface Item {
  id: number;
  text: string;
  kind: "info" | "error";
  action?: ToastAction;
}
interface ToastApi {
  show: (text: string, action?: ToastAction) => void;
  error: (text: string, action?: ToastAction) => void;
}
const Ctx = createContext<ToastApi | null>(null);
let counter = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const t = useT();
  const [items, setItems] = useState<Item[]>([]);
  const dismiss = useCallback((id: number) => setItems((l) => l.filter((i) => i.id !== id)), []);
  const push = useCallback(
    (kind: Item["kind"], text: string, action?: ToastAction) => {
      const id = ++counter;
      setItems((l) => [...l.slice(-3), { id, text, kind, action }]);
      // Toasts that offer a way forward (undo, retry) stay long enough to be read and used.
      setTimeout(() => dismiss(id), action ? 12000 : kind === "error" ? 8000 : 3200);
    },
    [dismiss],
  );
  const api = useMemo<ToastApi>(
    () => ({
      show: (text, a) => push("info", text, a),
      error: (text, a) => push("error", text, a),
    }),
    [push],
  );
  return (
    <Ctx value={api}>
      {children}
      <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-80 max-w-[calc(100vw-2rem)] flex-col gap-2">
        {items.map((i) => (
          <div
            key={i.id}
            role={i.kind === "error" ? "alert" : "status"}
            className={cn(
              "pointer-events-auto flex animate-in items-start gap-2 rounded-lg border bg-popover px-3 py-2.5 text-[13px] shadow-lg slide-in-from-bottom-2 fade-in-0",
              i.kind === "error" ? "border-destructive/40" : "border-border",
            )}
          >
            {i.kind === "error" ? (
              <AlertCircle aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-destructive" />
            ) : (
              <Check aria-hidden="true" className="mt-0.5 size-4 shrink-0 text-primary" />
            )}
            <span className="min-w-0 flex-1 break-words">{i.text}</span>
            {i.action && (
              <button
                type="button"
                className="shrink-0 font-medium text-primary hover:underline"
                onClick={() => {
                  i.action!.run();
                  dismiss(i.id);
                }}
              >
                {i.action.label}
              </button>
            )}
            <button
              type="button"
              aria-label={t("action.dismiss")}
              className="grid size-5 shrink-0 place-items-center text-muted-foreground hover:text-foreground pointer-coarse:size-8"
              onClick={() => dismiss(i.id)}
            >
              <X aria-hidden="true" className="size-3.5" />
            </button>
          </div>
        ))}
      </div>
    </Ctx>
  );
}
export function useToast() {
  const v = use(Ctx);
  if (!v) throw new Error("ToastProvider missing");
  return v;
}
