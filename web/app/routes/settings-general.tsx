import { Link } from "react-router";
import { Copy } from "lucide-react";
import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { useToast } from "~/components/ui/toast";
import { SettingsPage, SettingsSection } from "~/components/app/settings";
import { useT } from "~/lib/i18n";
import { useWorkspace } from "~/lib/workspace";

export default function General() {
  const t = useT();
  const toast = useToast();
  const { ws, role } = useWorkspace();
  const base = `/${ws.id}/settings`;
  const copyId = () =>
    navigator.clipboard.writeText(ws.id).then(
      () => toast.show(t("action.copied")),
      () => toast.error(t("error.generic")),
    );
  const counts: [string, number, string?][] = [
    [t("settings.members"), ws.members.length, `${base}/members`],
    [t("nav.teams"), ws.teams.length, `${base}/teams`],
    [t("nav.projects"), ws.projects.length],
    [t("nav.issues"), ws.issues.filter((i) => !i.deleted_at).length],
  ];
  return (
    <SettingsPage title={t("settings.general")} description={t("settings.generalSub")}>
      <SettingsSection>
        <dl className="divide-y divide-border text-[13px]">
          <Row label={t("field.name")}>
            <span className="font-medium">{ws.name}</span>
          </Row>
          <Row label={t("workspace.id")}>
            <span className="flex min-w-0 items-center gap-1">
              <code className="truncate font-mono text-xs text-muted-foreground">{ws.id}</code>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`${t("action.copy")}: ${t("workspace.id")}`}
                onPress={() => void copyId()}
              >
                <Copy />
              </Button>
            </span>
          </Row>
          <Row label={t("settings.yourRole")}>
            <Badge tone="primary">{t(`role.${role}`)}</Badge>
          </Row>
        </dl>
      </SettingsSection>
      <SettingsSection title={t("settings.contents")}>
        <dl className="divide-y divide-border text-[13px]">
          {counts.map(([label, n, to]) => (
            <Row key={label} label={label}>
              {to ? (
                <Link
                  to={to}
                  className="rounded-sm font-medium tabular-nums underline-offset-4 outline-none hover:underline focus-visible:ring-2 focus-visible:ring-ring/60"
                >
                  {n}
                </Link>
              ) : (
                <span className="font-medium tabular-nums">{n}</span>
              )}
            </Row>
          ))}
        </dl>
      </SettingsSection>
    </SettingsPage>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex min-h-11 items-center justify-between gap-6 py-2">
      <dt className="shrink-0 text-muted-foreground">{label}</dt>
      <dd className="flex min-w-0 justify-end">{children}</dd>
    </div>
  );
}
