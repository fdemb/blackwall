import { Card } from "~/components/app/page";
import { Badge } from "~/components/ui/badge";
import { useT } from "~/lib/i18n";
import { useWorkspace } from "~/lib/workspace";

export default function General() {
  const t = useT();
  const { ws, role } = useWorkspace();
  const stats = [
    [t("settings.members"), ws.members.length],
    [t("nav.teams"), ws.teams.length],
    [t("nav.projects"), ws.projects.length],
    [t("nav.issues"), ws.issues.filter((i) => !i.deleted_at).length],
  ] as const;
  return (
    <Card className="p-5">
      <div className="flex items-center gap-2">
        <h2 className="text-lg font-semibold tracking-tight">{ws.name}</h2>
        <Badge tone="primary">{t(`role.${role}`)}</Badge>
      </div>
      <p className="mt-1 break-all text-xs text-muted-foreground">
        {t("workspace.id")}: <code className="font-mono">{ws.id}</code>
      </p>
      <dl className="mt-5 grid grid-cols-2 gap-4 sm:grid-cols-4">
        {stats.map(([k, v]) => (
          <div key={k}>
            <dt className="text-xs text-muted-foreground">{k}</dt>
            <dd className="text-2xl font-semibold tabular-nums">{v}</dd>
          </div>
        ))}
      </dl>
    </Card>
  );
}
