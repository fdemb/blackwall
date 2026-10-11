/** Row actions hide until hover on devices that can hover, and stay visible on touch. */
export const revealOnHover =
  "[@media(hover:hover)]:opacity-0 group-hover:opacity-100 group-focus-within:opacity-100";

export function Section({
  title,
  icon,
  action,
  children,
}: {
  title: string;
  icon?: React.ReactNode;
  action?: React.ReactNode;
  children: React.ReactNode;
}) {
  return (
    <section>
      <div className="mb-2 flex min-h-7 items-center gap-2">
        {icon}
        <h2 className=" font-semibold">{title}</h2>
        <div className="ml-auto">{action}</div>
      </div>
      {children}
    </section>
  );
}
