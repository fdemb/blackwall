import {
  DatePicker as RACDatePicker,
  DateInput,
  DateSegment,
  Calendar,
  CalendarGrid,
  CalendarGridHeader,
  CalendarGridBody,
  CalendarHeaderCell,
  CalendarCell,
  Heading,
  Group,
  Dialog,
  composeRenderProps,
  type DatePickerProps,
  type DateValue,
} from "react-aria-components";
import { CalendarDays, ChevronLeft, ChevronRight, X } from "lucide-react";
import { parseDate, type CalendarDate } from "@internationalized/date";
import { useT } from "~/lib/i18n";
import { cn } from "~/lib/utils";
import { Button } from "./button";
import { Label } from "./field";
import { Popover } from "./popover";

export function toCalendarDate(iso: string | null | undefined): CalendarDate | null {
  if (!iso) return null;
  const d = new Date(iso);
  return parseDate(
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`,
  );
}
/** End of the chosen local day, so a deadline "today" stays valid all day. */
export function fromCalendarDate(value: DateValue | null, endOfDay = true): string | null {
  if (!value) return null;
  const d = new Date(value.year, value.month - 1, value.day, endOfDay ? 17 : 9, 0, 0);
  return d.toISOString();
}

interface Props extends Omit<DatePickerProps<DateValue>, "value" | "onChange"> {
  label?: string;
  value: string | null;
  onChange: (iso: string | null) => void;
  clearable?: boolean;
  placeholder?: string;
  endOfDay?: boolean;
  variant?: "field" | "ghost";
}

export function DatePicker({
  label,
  value,
  onChange,
  clearable = true,
  placeholder,
  endOfDay = true,
  variant = "field",
  className,
  ...props
}: Props) {
  const t = useT();
  return (
    <RACDatePicker
      {...props}
      granularity="day"
      value={toCalendarDate(value)}
      onChange={(v) => onChange(fromCalendarDate(v, endOfDay))}
      className={composeRenderProps(className, (c) => cn("flex flex-col", c))}
    >
      {label && <Label>{label}</Label>}
      <Group
        className={cn(
          "flex items-center gap-1 rounded-md text-[13px]",
          variant === "field"
            ? "h-8 border border-input bg-card pl-2.5 pr-0.5 shadow-xs focus-within:border-ring focus-within:ring-3 focus-within:ring-ring/25"
            : "h-7 pl-2",
        )}
      >
        {value ? (
          <DateInput className="flex flex-1">
            {(segment) => (
              <DateSegment
                segment={segment}
                className="rounded px-0.5 tabular-nums outline-none focus:bg-primary-solid focus:text-primary-foreground data-[placeholder]:text-muted-foreground"
              />
            )}
          </DateInput>
        ) : (
          <span className="flex-1 text-muted-foreground">{placeholder ?? ""}</span>
        )}
        {clearable && value && (
          <Button
            variant="ghost"
            size="icon"
            className="size-6"
            aria-label={t("action.clearField")}
            onPress={() => onChange(null)}
          >
            <X className="size-3" />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="size-6"
          aria-label={t("action.openCalendar")}
        >
          <CalendarDays className="size-3.5" />
        </Button>
      </Group>
      <Popover placement="bottom start" className="w-auto min-w-0">
        <Dialog className="p-3 outline-none">
          <Calendar>
            <header className="mb-2 flex items-center justify-between">
              <Button slot="previous" variant="ghost" size="icon">
                <ChevronLeft />
              </Button>
              <Heading className="text-[13px] font-semibold" />
              <Button slot="next" variant="ghost" size="icon">
                <ChevronRight />
              </Button>
            </header>
            <CalendarGrid className="border-separate border-spacing-0.5">
              <CalendarGridHeader>
                {(day) => (
                  <CalendarHeaderCell className="pb-1 text-[11px] font-medium text-muted-foreground">
                    {day}
                  </CalendarHeaderCell>
                )}
              </CalendarGridHeader>
              <CalendarGridBody>
                {(date) => (
                  <CalendarCell
                    date={date}
                    className="flex size-8 cursor-default items-center justify-center rounded-md text-[13px] outline-none hover:bg-muted selected:bg-primary-solid selected:text-primary-foreground focus-visible:ring-2 focus-visible:ring-ring/60 outside-month:text-muted-foreground/40 disabled:opacity-30 unavailable:text-destructive"
                  />
                )}
              </CalendarGridBody>
            </CalendarGrid>
          </Calendar>
        </Dialog>
      </Popover>
    </RACDatePicker>
  );
}
