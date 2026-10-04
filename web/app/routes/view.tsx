import { useState } from "react";
import { Form } from "react-aria-components";
import { Eye, Pencil, RotateCcw, Trash2, Users } from "lucide-react";
import { Navigate, useNavigate, useParams } from "react-router";
import { Button } from "~/components/ui/button";
import { Dialog, useDialogDirty } from "~/components/ui/dialog";
import { TextField } from "~/components/ui/field";
import { Switch } from "~/components/ui/toggles";
import { useToast } from "~/components/ui/toast";
import { ConfirmDialog } from "~/components/app/confirm";
import { Workbench, useQueueState } from "~/components/app/workbench";
import { Badge } from "~/components/ui/badge";
import { effectiveFilter, sameFilter } from "~/lib/filters";
import { useI18n } from "~/lib/i18n";
import { usePending } from "~/lib/use-pending";
import { useWorkspace } from "~/lib/workspace";
import type { SavedView } from "~/lib/types";

export default function View() {
  const { viewId, ws: wsId } = useParams();
  const { ws } = useWorkspace();
  const view = ws.views.find((v) => v.id === viewId);
  if (!view) return <Navigate to={`/${wsId}/issues`} replace />;
  return <ViewPage key={view.id} view={view} />;
}

function ViewPage({ view }: { view: SavedView }) {
  const { t } = useI18n();
  const nav = useNavigate();
  const toast = useToast();
  const { ws: wsId } = useParams();
  const { me, run, canAdmin } = useWorkspace();
  const state = useQueueState(view.filter);
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const { pending, guard } = usePending();
  const canEdit = view.owner === me || canAdmin;
  const current = effectiveFilter(state.filter, {}, state.groupBy);
  const changed = !sameFilter(current, view.filter);
  return (
    <Workbench
      title={view.name}
      icon={<Eye className="size-4 text-muted-foreground" />}
      state={state}
      saveable={false}
      subtitle={changed ? t("view.unsaved") : undefined}
      actions={
        <>
          {view.shared && (
            <Badge tone="primary">
              <Users className="size-3" />
              {t("view.shared")}
            </Badge>
          )}
          {changed && (
            <>
              <Button
                variant="ghost"
                size="sm"
                onPress={() => {
                  state.setFilter(view.filter);
                  state.setGroupBy(view.filter.group_by ?? "stage");
                }}
              >
                <RotateCcw />
                {t("view.revert")}
              </Button>
              {canEdit && (
                <Button
                  variant="subtle"
                  size="sm"
                  isDisabled={pending}
                  onPress={() =>
                    void guard(async () => {
                      await run({
                        type: "update_view",
                        id: view.id,
                        name: view.name,
                        shared: view.shared,
                        filter: current,
                      });
                      toast.show(t("view.updated"));
                    })
                  }
                >
                  {t("view.update")}
                </Button>
              )}
            </>
          )}
          {canEdit && (
            <Button variant="ghost" size="sm" onPress={() => setEditing(true)}>
              <Pencil />
              {t("view.rename")}
            </Button>
          )}
          {canEdit && (
            <Button variant="ghost" size="sm" onPress={() => setDeleting(true)}>
              <Trash2 />
              {t("view.delete")}
            </Button>
          )}
          <Dialog title={t("view.rename")} size="sm" isOpen={editing} onOpenChange={setEditing}>
            {(close) => <EditViewForm view={view} close={close} />}
          </Dialog>
          <ConfirmDialog
            title={t("view.deleteTitle")}
            isOpen={deleting}
            onOpenChange={setDeleting}
            onConfirm={async () => {
              await run({ type: "delete_view", id: view.id }, { quiet: true });
              await nav(`/${wsId}/issues`);
            }}
          />
        </>
      }
    />
  );
}

function EditViewForm({ view, close }: { view: SavedView; close: () => void }) {
  const { t } = useI18n();
  const { run, canWrite } = useWorkspace();
  const { pending, error, guard } = usePending();
  const [name, setName] = useState(view.name);
  const [shared, setShared] = useState(view.shared);
  useDialogDirty(name !== view.name || shared !== view.shared);
  return (
    <Form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        void guard(async () => {
          await run(
            { type: "update_view", id: view.id, name: name.trim(), shared, filter: view.filter },
            { quiet: true, expectedVersions: error ? undefined : { [view.id]: view.version } },
          );
          close();
        });
      }}
    >
      <TextField label={t("field.name")} value={name} onChange={setName} autoFocus isRequired />
      {canWrite && (
        <Switch isSelected={shared} onChange={setShared}>
          {t("view.share")}
        </Switch>
      )}
      {error && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onPress={close}>
          {t("action.cancel")}
        </Button>
        <Button type="submit" variant="primary" isDisabled={!name.trim() || pending}>
          {pending ? t("action.saving") : t("action.save")}
        </Button>
      </div>
    </Form>
  );
}
