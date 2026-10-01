import { useState } from "react";
import { Form } from "react-aria-components";
import { Tag } from "lucide-react";
import { Button } from "~/components/ui/button";
import { TextField } from "~/components/ui/field";
import { Card } from "~/components/app/page";
import { LabelDot } from "~/components/app/pickers";
import { useT } from "~/lib/i18n";
import { useWorkspace } from "~/lib/workspace";
import { cn } from "~/lib/utils";

const COLORS = ["#7c3aed", "#a78bfa", "#ec4899", "#ef4444", "#f97316", "#eab308", "#22c55e", "#14b8a6", "#0ea5e9", "#64748b"];

export default function Labels() {
  const t = useT();
  const { ws, run, canWrite } = useWorkspace();
  const [name, setName] = useState("");
  const [color, setColor] = useState(COLORS[0]);
  return (
    <>
      <div><h2 className="text-[14px] font-semibold">{t("settings.labels")}</h2><p className="text-xs text-muted-foreground">{t("labels.sub")}</p></div>
      {canWrite && (
        <Card className="p-4">
          <Form className="flex flex-wrap items-end gap-3" onSubmit={async (e) => { e.preventDefault(); await run({ type: "create_label", name: name.trim(), color }).then(() => setName("")).catch(() => {}); }}>
            <TextField className="min-w-48 flex-1" label={t("field.name")} value={name} onChange={setName} isRequired maxLength={40} />
            <div role="radiogroup" aria-label={t("labels.color")} className="flex gap-1.5 pb-1.5">
              {COLORS.map((c) => (
                <button key={c} type="button" role="radio" aria-checked={c === color} aria-label={c} onClick={() => setColor(c)} className={cn("size-5 rounded-full outline-none ring-offset-2 ring-offset-card transition focus-visible:ring-2 focus-visible:ring-ring", c === color && "ring-2 ring-foreground")} style={{ background: c }} />
              ))}
            </div>
            <Button type="submit" variant="primary" isDisabled={!name.trim()}>{t("labels.add")}</Button>
          </Form>
        </Card>
      )}
      <Card>
        {ws.labels.length === 0 ? <p className="flex items-center justify-center gap-2 px-4 py-8 text-[13px] text-muted-foreground"><Tag className="size-4" />{t("labels.empty")}</p> : (
          <ul className="divide-y divide-border">{ws.labels.map((l) => <li key={l.id} className="flex items-center gap-2.5 px-4 py-2.5 text-[13px]"><LabelDot color={l.color} className="size-2.5" />{l.name}<span className="ml-auto text-xs text-muted-foreground tabular-nums">{ws.issues.filter((i) => !i.deleted_at && i.labels.includes(l.id)).length}</span></li>)}</ul>
        )}
      </Card>
    </>
  );
}
