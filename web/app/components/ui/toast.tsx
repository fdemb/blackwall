import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { AlertCircle, Check, X } from "lucide-react";
import { cn } from "~/lib/utils";

interface Item {
  id: number;
  text: string;
  kind: "info" | "error";
}
interface ToastApi {
  show: (text: string) => void;
  error: (text: string) => void;
}
const Ctx = createContext<ToastApi | null>(null);
let counter = 0;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<Item[]>([]);
  const dismiss = useCallback((id: number) => setItems((l) => l.filter((i) => i.id !== id)), []);
  const push = useCallback(
    (kind: Item["kind"], text: string) => {
      const id = ++counter;
      setItems((l) => [...l.slice(-3), { id, text, kind }]);
      setTimeout(() => dismiss(id), kind === "error" ? 6000 : 3200);
    },
    [dismiss],
  );
  const api = useMemo<ToastApi>(
    () => ({ show: (t) => push("info", t), error: (t) => push("error", t) }),
    [push],
  );
  return (
    <Ctx value={api}>
      {children}
      <div
        role="status"
        aria-live="polite"
        className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-80 flex-col gap-2"
      >
        {items.map((i) => (
          <div
            key={i.id}
            className={cn(
              "pointer-events-auto flex animate-in items-start gap-2 rounded-lg border bg-popover px-3 py-2.5 text-[13px] shadow-lg slide-in-from-bottom-2 fade-in-0",
              i.kind === "error" ? "border-destructive/40" : "border-border",
            )}
          >
            {i.kind === "error" ? (
              <AlertCircle className="mt-0.5 size-4 shrink-0 text-destructive" />
            ) : (
              <Check className="mt-0.5 size-4 shrink-0 text-primary" />
            )}
            <span className="flex-1">{i.text}</span>
            <button
              aria-label="Dismiss"
              className="text-muted-foreground hover:text-foreground"
              onClick={() => dismiss(i.id)}
            >
              <X className="size-3.5" />
            </button>
          </div>
        ))}
      </div>
    </Ctx>
  );
}
export function useToast() {
  const v = useContext(Ctx);
  if (!v) throw new Error("ToastProvider missing");
  return v;
}
