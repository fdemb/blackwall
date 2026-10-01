import { Eye, Trash2, Users } from "lucide-react";
import { Navigate, useNavigate, useParams } from "react-router";
import { Button } from "~/components/ui/button";
import { Workbench } from "~/components/app/workbench";
import { Badge } from "~/components/ui/badge";
import { useT } from "~/lib/i18n";
import { useWorkspace } from "~/lib/workspace";

export default function View() {
  const t = useT();
  const nav = useNavigate();
  const { viewId, ws: wsId } = useParams();
  const { ws, me, run } = useWorkspace();
  const view = ws.views.find((v) => v.id === viewId);
  if (!view) return <Navigate to={`/${wsId}/issues`} replace />;
  return (
    <Workbench
      key={view.id}
      title={view.name}
      icon={<Eye className="size-4 text-muted-foreground" />}
      initial={view.filter}
      saveable={false}
      actions={
        <>
          {view.shared && <Badge tone="primary"><Users className="size-3" />{t("view.shared")}</Badge>}
          {view.owner === me && (
            <Button variant="ghost" size="sm" onPress={() => run({ type: "delete_view", id: view.id }).then(() => nav(`/${wsId}/issues`)).catch(() => {})}>
              <Trash2 />{t("view.delete")}
            </Button>
          )}
        </>
      }
    />
  );
}
