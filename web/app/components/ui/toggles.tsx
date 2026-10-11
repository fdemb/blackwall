import {
  Checkbox as RACCheckbox,
  Switch as RACSwitch,
  composeRenderProps,
  type CheckboxProps,
  type SwitchProps,
} from "react-aria-components";
import { Check, Minus } from "lucide-react";
import { cn } from "~/lib/utils";

export function Checkbox({ className, children, ...props }: CheckboxProps) {
  return (
    <RACCheckbox
      {...props}
      className={composeRenderProps(className, (c) =>
        cn("group flex cursor-default items-center gap-2  disabled:opacity-50", c),
      )}
    >
      {composeRenderProps(children, (children, { isSelected, isIndeterminate }) => (
        <>
          <span
            className={cn(
              "flex size-4 shrink-0 items-center justify-center rounded-[5px] border border-input bg-card text-primary-foreground transition-[transform,opacity] group-hover:border-muted-foreground group-focus-visible:ring-2 group-focus-visible:ring-ring/60",
              (isSelected || isIndeterminate) &&
                "border-primary-solid bg-primary-solid group-hover:border-primary-solid",
            )}
          >
            {isIndeterminate ? (
              <Minus aria-hidden="true" className="size-3" strokeWidth={3} />
            ) : isSelected ? (
              <Check aria-hidden="true" className="size-3" strokeWidth={3} />
            ) : null}
          </span>
          {children}
        </>
      ))}
    </RACCheckbox>
  );
}

export function Switch({ className, children, ...props }: SwitchProps) {
  return (
    <RACSwitch
      {...props}
      className={composeRenderProps(className, (c) =>
        cn("group flex cursor-default items-center gap-3  disabled:opacity-50", c),
      )}
    >
      {composeRenderProps(children, (children) => (
        <>
          <span className="flex h-5 w-9 shrink-0 items-center rounded-full bg-input p-0.5 transition-[transform,opacity] group-selected:bg-primary group-focus-visible:ring-2 group-focus-visible:ring-ring/60">
            <span className="size-4 rounded-full bg-white shadow-sm transition-transform group-selected:translate-x-4" />
          </span>
          {children}
        </>
      ))}
    </RACSwitch>
  );
}
