import type { Issue } from "@/db/schema";
import CircleIcon from "lucide-solid/icons/circle";
import CircleCheck from "lucide-solid/icons/circle-check";
import CircleDotDashed from "lucide-solid/icons/circle-dot-dashed";
import CircleFadingArrowUpIcon from "lucide-solid/icons/circle-fading-arrow-up";
import type { JSX } from "solid-js";

export type BaseMapping = {
  label: string;
  textClass?: string;
  icon?: (props: { class?: string }) => JSX.Element;
};

export const issueMappings = {
  status: {
    backlog: {
      label: "Backlog",
      textClass: "text-theme-gray",
      icon: CircleDotDashed,
    },
    to_do: {
      label: "To Do",
      textClass: "text-theme-teal",
      icon: CircleIcon,
    },
    in_progress: {
      label: "In Progress",
      textClass: "text-theme-blue",
      icon: CircleFadingArrowUpIcon,
    },
    done: {
      label: "Done",
      textClass: "text-theme-green",
      icon: CircleCheck,
    },
  } as const satisfies Record<Issue["status"], BaseMapping>,
  priority: {
    low: {
      label: "Low",
      textClass: "text-theme-green",
    },
    medium: {
      label: "Medium",
      textClass: "text-theme-blue",
    },
    high: {
      label: "High",
      textClass: "text-theme-yellow",
    },
    urgent: {
      label: "Urgent",
      textClass: "text-theme-red",
    },
  } as const satisfies Record<Issue["priority"], BaseMapping>,
};

export function mappingToOptionArray<T extends Record<string, BaseMapping>>(
  mapping: T,
) {
  return Object.entries(mapping).map(([id, rest]) => {
    return {
      id: id as keyof T,
      ...rest,
    };
  });
}
