import { cn } from "~/lib/utils";
import { colorFor, initials } from "~/lib/format";

/**
 * Avatars next to a visible name are decorative. Pass `named` when the avatar is the only sign of who
 * someone is, so assistive tech and hover get the name.
 */
export function Avatar({
  name,
  src,
  size = 20,
  className,
  named,
}: {
  name: string;
  src?: string | null;
  size?: number;
  className?: string;
  named?: boolean;
}) {
  const style = { width: size, height: size, fontSize: Math.max(9, size * 0.42) };
  if (src)
    return (
      <img
        src={src}
        alt={named ? name : ""}
        title={named ? name : undefined}
        style={style}
        className={cn("shrink-0 rounded-full object-cover", className)}
      />
    );
  return (
    <span
      {...(named ? { role: "img", "aria-label": name, title: name } : { "aria-hidden": true })}
      style={{ ...style, background: colorFor(name) }}
      className={cn(
        "inline-flex shrink-0 select-none items-center justify-center rounded-full font-semibold text-white",
        className,
      )}
    >
      {initials(name)}
    </span>
  );
}
