import {
  Tabs as RACTabs,
  TabList as RACTabList,
  Tab as RACTab,
  TabPanel as RACTabPanel,
  composeRenderProps,
} from "react-aria-components";
import type { TabsProps, TabListProps, TabProps, TabPanelProps } from "react-aria-components";
import { cn } from "~/lib/utils";

export function Tabs({ className, ...props }: TabsProps) {
  return (
    <RACTabs
      {...props}
      className={composeRenderProps(className, (c) => cn("flex flex-col gap-3", c))}
    />
  );
}
export function TabList<T extends object>({ className, ...props }: TabListProps<T>) {
  return (
    <RACTabList
      {...props}
      className={composeRenderProps(className, (c) =>
        cn("inline-flex w-fit items-center gap-0.5 rounded-lg bg-muted p-0.5", c),
      )}
    />
  );
}
export function Tab({ className, ...props }: TabProps) {
  return (
    <RACTab
      {...props}
      className={composeRenderProps(className, (c) =>
        cn(
          "flex h-7 cursor-default items-center pointer-coarse:h-9 gap-1.5 rounded-md px-2.5 text-[13px] font-medium text-muted-foreground outline-none transition-colors hover:text-foreground selected:bg-card selected:text-foreground selected:shadow-xs focus-visible:ring-2 focus-visible:ring-ring/60 [&_svg]:size-3.5",
          c,
        ),
      )}
    />
  );
}
export function TabPanel({ className, ...props }: TabPanelProps) {
  return (
    <RACTabPanel
      {...props}
      className={composeRenderProps(className, (c) =>
        cn("outline-none focus-visible:ring-2 focus-visible:ring-ring/60", c),
      )}
    />
  );
}
