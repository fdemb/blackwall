import { cn } from "~/lib/utils";
import { colorFor, initials } from "~/lib/format";

export function Avatar({ name, src, size = 20, className }: { name: string; src?: string | null; size?: number; className?: string }) {
  const style = { width: size, height: size, fontSize: Math.max(9, size * 0.42) };
  if (src)
    return <img src={src} alt="" style={style} className={cn("shrink-0 rounded-full object-cover", className)} />;
  return (
    <span
      aria-hidden
      style={{ ...style, background: colorFor(name) }}
      className={cn("inline-flex shrink-0 select-none items-center justify-center rounded-full font-semibold text-white", className)}
    >
      {initials(name)}
    </span>
  );
}
