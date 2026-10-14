import { Button } from "~/components/ui/button";
import { Dialog } from "~/components/ui/dialog";
import { useI18n } from "~/lib/i18n";
import { usePending } from "~/lib/use-pending";

/**
 * Asks before something destructive. Stays open and shows the error if the action fails.
 *
 * `isOpen`/`onOpenChange` stay the public API; closing delegates to the `close` render-prop from
 * `Dialog` (its Close equivalent), so both buttons and the dialog chrome dismiss the same way.
 */
export function ConfirmDialog({
  title,
  description,
  confirmLabel,
  isOpen,
  onOpenChange,
  onConfirm,
}: {
  title: string;
  description?: string;
  confirmLabel?: string;
  isOpen: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: () => Promise<unknown>;
}) {
  const { t } = useI18n();
  return (
    <Dialog
      title={title}
      description={description ?? t("action.cannotUndo")}
      size="sm"
      isOpen={isOpen}
      onOpenChange={onOpenChange}
    >
      {(close) => (
        <ConfirmBody
          label={confirmLabel ?? t("action.delete")}
          close={close}
          onConfirm={onConfirm}
        />
      )}
    </Dialog>
  );
}

function ConfirmBody({
  label,
  close,
  onConfirm,
}: {
  label: string;
  close: () => void;
  onConfirm: () => Promise<unknown>;
}) {
  const { t } = useI18n();
  const { pending, error, guard } = usePending();
  return (
    <div className="space-y-3">
      {error && (
        <p role="alert" className=" text-destructive">
          {error}
        </p>
      )}
      <div className="flex justify-end gap-2">
        <Button variant="ghost" onPress={close}>
          {t("action.cancel")}
        </Button>
        <Button
          variant="destructive"
          isDisabled={pending}
          onPress={() =>
            void guard(async () => {
              await onConfirm();
              close();
            })
          }
        >
          {label}
        </Button>
      </div>
    </div>
  );
}
