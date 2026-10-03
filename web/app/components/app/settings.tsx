import { useDocumentTitle } from "~/lib/title";
import { cn } from "~/lib/utils";

/** One settings screen: a title block, then sections separated by hairlines. */
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
      <header className="flex flex-wrap items-end gap-x-4 gap-y-3 border-b border-border pb-6">
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-semibold tracking-tight text-balance">{title}</h1>
          {description && (
            <p className="mt-1 max-w-prose text-[13px] text-muted-foreground">{description}</p>
          )}
        </div>
        {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
      </header>
      <div className="divide-y divide-border">{children}</div>
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
    <section className={cn("py-8", className)}>
      {(title || actions) && (
        <div className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2">
          <div className="min-w-0 flex-1">
            {title && <h2 className="text-[14px] font-semibold tracking-tight">{title}</h2>}
            {description && (
              <p className="mt-0.5 max-w-prose text-[13px] text-muted-foreground">{description}</p>
            )}
          </div>
          {actions && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
        </div>
      )}
      {children}
    </section>
  );
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
    <div className="flex flex-col gap-2 py-3 sm:flex-row sm:items-center sm:justify-between sm:gap-8">
      <div className="min-w-0">
        <p className="text-[13px] font-medium">{label}</p>
        {description && (
          <p className="mt-0.5 max-w-prose text-xs text-muted-foreground">{description}</p>
        )}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  );
}

/** A flat list with hairline separators; rows supply their own layout. */
export function SettingsList({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <ul className={cn("divide-y divide-border border-y border-border", className)}>{children}</ul>
  );
}
