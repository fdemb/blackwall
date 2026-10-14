import {
  Button as RACButton,
  Calendar,
  Dialog,
  DialogTrigger,
  type ButtonProps,
} from "react-aria-components";
import { CalendarDays, X } from "lucide-react";
import { Button } from "~/components/ui/button";
import { CalendarBody, fromCalendarDate, toCalendarDate } from "~/components/ui/date-picker";
import { Menu, MenuItem, MenuPopover, MenuSeparator, MenuTrigger } from "~/components/ui/menu";
import { Popover } from "~/components/ui/popover";
import { shortDate } from "~/lib/format";
import { useI18n } from "~/lib/i18n";
import { cn } from "~/lib/utils";

const NONE = "__none";

/** A property as a compact rounded button. Unset properties read muted and name the field. */
export function Pill({
  isEmpty,
  className,
  ...props
}: Omit<ButtonProps, "className"> & { isEmpty?: boolean; className?: string }) {
  return (
    <RACButton
      {...props}
      className={cn(
        "inline-flex h-7 min-w-0 max-w-56 shrink-0 cursor-default items-center gap-1.5 rounded-full border border-border px-2.5 text-[12.5px] text-foreground outline-none transition-colors hover:bg-muted focus-visible:ring-2 focus-visible:ring-ring/60 pressed:bg-muted aria-expanded:bg-muted pointer-coarse:h-9 [&_svg]:shrink-0",
        isEmpty && "border-dashed text-muted-foreground hover:text-foreground",
        className,
      )}
    />
  );
}

export interface Choice {
  id: string;
  label: string;
  icon?: React.ReactNode;
}

interface OpenProps {
  isOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
}

/**
 * One value from a short list. With `none`, the list starts with an entry that clears the value.
 * `emptyIcon` and `label` show on the pill while nothing is picked.
 */
export function ChoicePill({
  label,
  choices,
  value,
  onChange,
  none,
  emptyIcon,
  isOpen,
  onOpenChange,
}: OpenProps & {
  label: string;
  choices: Choice[];
  value: string | null | undefined;
  onChange: (id: string | null) => void;
  none?: Choice;
  emptyIcon?: React.ReactNode;
}) {
  const picked = choices.find((c) => c.id === value);
  return (
    <MenuTrigger isOpen={isOpen} onOpenChange={onOpenChange}>
      <Pill
        isEmpty={!picked}
        aria-label={picked ? `${label}: ${picked.label}` : label}
        className="max-w-48"
      >
        {picked ? picked.icon : emptyIcon}
        <span className="truncate">{picked ? picked.label : label}</span>
      </Pill>
      <MenuPopover placement="bottom start">
        <Menu
          aria-label={label}
          selectionMode="single"
          selectedKeys={[value ?? NONE]}
          onAction={(k) => onChange(k === NONE ? null : String(k))}
        >
          {none && (
            <>
              <MenuItem id={NONE} textValue={none.label}>
                {none.icon}
                {none.label}
              </MenuItem>
              <MenuSeparator />
            </>
          )}
          {choices.map((c) => (
            <MenuItem key={c.id} id={c.id} textValue={c.label}>
              {c.icon}
              <span className="truncate">{c.label}</span>
            </MenuItem>
          ))}
        </Menu>
      </MenuPopover>
    </MenuTrigger>
  );
}

export function DatePill({
  label,
  value,
  onChange,
  isOpen,
  onOpenChange,
}: OpenProps & {
  label: string;
  value: string | null;
  onChange: (iso: string | null) => void;
}) {
  const { t, lang } = useI18n();
  return (
    <DialogTrigger isOpen={isOpen} onOpenChange={onOpenChange}>
      <Pill isEmpty={!value} aria-label={value ? `${label}: ${shortDate(value, lang)}` : label}>
        <CalendarDays aria-hidden className="size-3.5" />
        <span className="truncate">{value ? shortDate(value, lang) : label}</span>
      </Pill>
      <Popover placement="bottom start" className="w-auto min-w-0">
        <Dialog aria-label={label} className="p-3 outline-none">
          {({ close }) => (
            <>
              <Calendar
                autoFocus
                aria-label={label}
                value={toCalendarDate(value)}
                onChange={(d) => {
                  onChange(fromCalendarDate(d));
                  close();
                }}
              >
                <CalendarBody />
              </Calendar>
              {value && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="mt-2 w-full"
                  onPress={() => {
                    onChange(null);
                    close();
                  }}
                >
                  <X aria-hidden />
                  {t("action.clearField")}
                </Button>
              )}
            </>
          )}
        </Dialog>
      </Popover>
    </DialogTrigger>
  );
}
