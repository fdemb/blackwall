import { useDocumentTitle } from "~/lib/title";
import { cn } from "~/lib/utils";

/** One settings screen: a title block, then spaced group cards. */
export function SettingsPage({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
}) {
  useDocumentTitle(title);
  return (
    <>
      <header className="mb-8 flex flex-wrap items-end gap-x-4 gap-y-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-semibold tracking-tight text-balance">{title}</h1>
          {description && (
            <p className="mt-1 max-w-prose text-sm text-muted-foreground">{description}</p>
          )}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </header>
      <div className="space-y-8">{children}</div>
    </>
  );
}

export function SettingsSection({
  title,
  description,
  actions,
  children,
  className,
}: {
  title?: React.ReactNode;
  description?: React.ReactNode;
  actions?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <section className={className}>
      {(title || actions) && (
        <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 px-1">
          <div className="min-w-0 flex-1">
            {title && <h2 className="text-[15px] text-muted-foreground">{title}</h2>}
            {description && (
              <p className="mt-0.5 max-w-prose text-[13px] text-muted-foreground">{description}</p>
            )}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </div>
      )}
      <div className="overflow-hidden rounded-2xl border border-border bg-card">{children}</div>
    </section>
  );
}

/** A freeform block without card chrome, for banners and callouts between sections. */
export function SettingsBlock({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return <section className={className}>{children}</section>;
}

/** A label on the left, its control on the right. Stacks on narrow screens. */
export function SettingsRow({
  label,
  description,
  children,
}: {
  label: React.ReactNode;
  description?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6 sm:px-5">
      <div className="min-w-0">
        <p className="text-sm font-medium">{label}</p>
        {description && (
          <p className="mt-0.5 max-w-prose text-[13px] text-muted-foreground">{description}</p>
        )}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

/** Rows inside a card; the card supplies border and rounding. */
export function SettingsList({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <ul className={cn("divide-y divide-border [&>li]:px-4 [&>li]:sm:px-5", className)}>
      {children}
    </ul>
  );
}
