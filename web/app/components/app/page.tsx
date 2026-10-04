import { Link } from "react-router";
import { Separator } from "~/components/ui/separator";
import { useDocumentTitle } from "~/lib/title";
import type { Team } from "~/lib/types";
import { cn } from "~/lib/utils";

export function Page({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("flex min-h-0 flex-1 flex-col", className)}>{children}</div>;
}

export function PageHeader({
  title,
  icon,
  subtitle,
  heading,
  nav,
  actions,
  children,
}: {
  title: React.ReactNode;
  icon?: React.ReactNode;
  subtitle?: React.ReactNode;
  /** Replaces the icon, title and subtitle. `title` still names the document. */
  heading?: React.ReactNode;
  /** Sits between the heading and the actions, wrapping to its own line when they don't fit. */
  nav?: React.ReactNode;
  actions?: React.ReactNode;
  children?: React.ReactNode;
}) {
  useDocumentTitle(typeof title === "string" ? title : null);
  return (
    <header className="shrink-0 border-b border-border">
      <div className="flex min-h-12 flex-wrap items-center gap-x-2 gap-y-1.5 px-4 py-2">
        {heading ?? (
          <>
            {icon}
            <h1 className="truncate text-balance text-[15px] font-semibold tracking-tight">
              {title}
            </h1>
            {subtitle && (
              <span className="hidden truncate text-[13px] text-muted-foreground sm:block">
                {subtitle}
              </span>
            )}
          </>
        )}
        {nav}
        <div className="ml-auto flex items-center gap-1.5">{actions}</div>
      </div>
      {children && (
        <>
          <Separator />
          <div className="pt-2">{children}</div>
        </>
      )}
    </header>
  );
}

/** The team a page belongs to, as shown at the start of the header. */
export function TeamCrumb({ team, wsId }: { team: Pick<Team, "id" | "name">; wsId: string }) {
  return (
    <Link
      to={`/${wsId}/team/${team.id}`}
      className="text-[13px] text-muted-foreground hover:text-foreground hover:underline"
    >
      {team.name}
    </Link>
  );
}

export function EmptyState({
  icon,
  title,
  description,
  action,
}: {
  icon?: React.ReactNode;
  title: string;
  description?: string;
  action?: React.ReactNode;
}) {
  return (
    <div className="mx-auto flex max-w-sm flex-1 flex-col items-center justify-center px-6 py-16 text-center">
      {icon && (
        <div className="mb-4 grid size-12 place-items-center rounded-2xl bg-accent text-accent-foreground [&_svg]:size-5">
          {icon}
        </div>
      )}
      <h2 className="text-[15px] font-semibold tracking-tight">{title}</h2>
      {description && <p className="mt-1 text-[13px] text-muted-foreground">{description}</p>}
      {action && <div className="mt-4">{action}</div>}
    </div>
  );
}

export function Scroll({ children, className }: { children: React.ReactNode; className?: string }) {
  return <div className={cn("min-h-0 flex-1 overflow-y-auto", className)}>{children}</div>;
}

export function Card({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <div className={cn("rounded-xl border border-border bg-card shadow-xs", className)}>
      {children}
    </div>
  );
}
