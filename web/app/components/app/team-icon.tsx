import { Dialog, DialogTrigger, ListBox, ListBoxItem } from "react-aria-components";
import {
  BookOpen,
  Briefcase,
  Bug,
  ChartColumn,
  Code,
  Compass,
  Cpu,
  Database,
  FlaskConical,
  Globe,
  Headset,
  Heart,
  Layers,
  Leaf,
  Megaphone,
  Palette,
  Rocket,
  Server,
  Shield,
  Smartphone,
  Target,
  Users,
  Wrench,
  Zap,
  type LucideIcon,
} from "lucide-react";
import { Button } from "~/components/ui/button";
import { Popover } from "~/components/ui/popover";
import { useI18n } from "~/lib/i18n";
import { TEAM_COLORS, TEAM_ICONS } from "~/lib/teams";
import type { Team, TeamColor, TeamIcon as TeamIconName } from "~/lib/types";
import { cn } from "~/lib/utils";

const ICONS: Record<TeamIconName, LucideIcon> = {
  users: Users,
  rocket: Rocket,
  code: Code,
  palette: Palette,
  megaphone: Megaphone,
  shield: Shield,
  server: Server,
  database: Database,
  bug: Bug,
  flask: FlaskConical,
  briefcase: Briefcase,
  headset: Headset,
  globe: Globe,
  zap: Zap,
  book: BookOpen,
  wrench: Wrench,
  chart: ChartColumn,
  heart: Heart,
  cpu: Cpu,
  smartphone: Smartphone,
  layers: Layers,
  target: Target,
  compass: Compass,
  leaf: Leaf,
};

// Full class names, so Tailwind sees each one. `tile` tints the icon's square, `swatch` fills a dot.
const COLORS: Record<TeamColor, { tile: string; swatch: string }> = {
  violet: {
    tile: "bg-violet-500/15 text-violet-600 dark:text-violet-400",
    swatch: "bg-violet-500",
  },
  blue: { tile: "bg-blue-500/15 text-blue-600 dark:text-blue-400", swatch: "bg-blue-500" },
  sky: { tile: "bg-sky-500/15 text-sky-600 dark:text-sky-400", swatch: "bg-sky-500" },
  teal: { tile: "bg-teal-500/15 text-teal-600 dark:text-teal-400", swatch: "bg-teal-500" },
  green: { tile: "bg-green-500/15 text-green-600 dark:text-green-400", swatch: "bg-green-500" },
  lime: { tile: "bg-lime-500/15 text-lime-700 dark:text-lime-400", swatch: "bg-lime-500" },
  amber: { tile: "bg-amber-500/15 text-amber-700 dark:text-amber-400", swatch: "bg-amber-500" },
  orange: {
    tile: "bg-orange-500/15 text-orange-600 dark:text-orange-400",
    swatch: "bg-orange-500",
  },
  red: { tile: "bg-red-500/15 text-red-600 dark:text-red-400", swatch: "bg-red-500" },
  pink: { tile: "bg-pink-500/15 text-pink-600 dark:text-pink-400", swatch: "bg-pink-500" },
  fuchsia: {
    tile: "bg-fuchsia-500/15 text-fuchsia-600 dark:text-fuchsia-400",
    swatch: "bg-fuchsia-500",
  },
  slate: { tile: "bg-slate-500/15 text-slate-600 dark:text-slate-300", swatch: "bg-slate-500" },
};

/** A team's icon on a tile in its color. Size the tile with `className`; the glyph follows. */
export function TeamIcon({
  team,
  className,
}: {
  team: Pick<Team, "icon" | "color">;
  className?: string;
}) {
  // Records cached before icons existed may lack them until the next pull.
  const Icon = ICONS[team.icon] ?? Users;
  return (
    <span
      aria-hidden
      className={cn(
        "grid size-4 shrink-0 place-items-center rounded",
        (COLORS[team.color] ?? COLORS.violet).tile,
        className,
      )}
    >
      <Icon className="size-[70%]" strokeWidth={2.25} />
    </span>
  );
}

const cell =
  "grid size-7 cursor-default place-items-center rounded-md outline-none focus-visible:ring-2 focus-visible:ring-ring/60 hover:bg-muted selected:bg-accent";

/** Admin control for a team's icon and color. */
export function TeamAppearancePicker({
  team,
  isDisabled,
  onChange,
}: {
  team: Team;
  isDisabled?: boolean;
  onChange: (appearance: Pick<Team, "icon" | "color">) => void;
}) {
  const { t } = useI18n();
  return (
    <DialogTrigger>
      <Button
        variant="ghost"
        size="icon"
        className="size-8"
        isDisabled={isDisabled}
        aria-label={t("team.appearance")}
      >
        <TeamIcon team={team} className="size-6" />
      </Button>
      <Popover placement="bottom start" className="min-w-0">
        <Dialog aria-label={t("team.appearance")} className="w-64 space-y-3 p-3 outline-none">
          <TeamColorSwatches
            value={team.color}
            onChange={(color) => onChange({ icon: team.icon, color })}
            className="grid grid-cols-6 gap-1"
          />
          <ListBox
            aria-label={t("team.icon")}
            layout="grid"
            selectionMode="single"
            disallowEmptySelection
            selectedKeys={[team.icon]}
            onSelectionChange={(keys) => {
              const [icon] = keys === "all" ? [] : [...keys];
              if (icon) onChange({ icon: icon as TeamIconName, color: team.color });
            }}
            className="grid grid-cols-6 gap-1 border-t border-border pt-3"
          >
            {TEAM_ICONS.map((icon) => {
              const Icon = ICONS[icon];
              return (
                <ListBoxItem
                  key={icon}
                  id={icon}
                  textValue={t(`team.icons.${icon}`)}
                  className={cn(cell, "text-muted-foreground selected:text-foreground")}
                >
                  <Icon aria-hidden className="size-4" />
                </ListBoxItem>
              );
            })}
          </ListBox>
        </Dialog>
      </Popover>
    </DialogTrigger>
  );
}

/** The team color palette as a row of swatches, one selected. */
export function TeamColorSwatches({
  value,
  onChange,
  isDisabled,
  className,
}: {
  value: TeamColor;
  onChange: (color: TeamColor) => void;
  isDisabled?: boolean;
  className?: string;
}) {
  const { t } = useI18n();
  return (
    <ListBox
      aria-label={t("team.color")}
      layout="grid"
      selectionMode="single"
      disallowEmptySelection
      disabledKeys={isDisabled ? TEAM_COLORS : []}
      selectedKeys={[value]}
      onSelectionChange={(keys) => {
        const [color] = keys === "all" ? [] : [...keys];
        if (color) onChange(color as TeamColor);
      }}
      className={className}
    >
      {TEAM_COLORS.map((color) => (
        <ListBoxItem
          key={color}
          id={color}
          textValue={t(`team.colors.${color}`)}
          className={cn(cell, "disabled:opacity-60")}
        >
          <span className={cn("size-4 rounded-full", COLORS[color].swatch)} />
        </ListBoxItem>
      ))}
    </ListBox>
  );
}
