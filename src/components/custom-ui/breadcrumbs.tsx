import { FastLink } from "@/components/custom-ui/fast-link";
import type { LinkProps } from "@tanstack/solid-router";
import ChevronRightIcon from "lucide-solid/icons/chevron-right";
import type { JSX } from "solid-js";
import { Show } from "solid-js";

export function Breadcrumbs(props: { children?: JSX.Element }) {
  return <ul class="flex flex-row items-center">{props.children}</ul>;
}

export function BreadcrumbsItem(props: {
  children?: JSX.Element;
  linkProps?: LinkProps;
}) {
  return (
    <li class="group flex flex-row items-center leading-none text-muted-foreground last:text-foreground">
      <Show when={props.linkProps} fallback={<>{props.children}</>}>
        <FastLink
          {...props.linkProps}
          class="hover:bg-background hover:text-foreground px-1 py-1 -mx-1"
        >
          {props.children}
        </FastLink>
      </Show>
      <ChevronRightIcon class="size-4 mx-2 shrink-0 group-last:hidden" />
    </li>
  );
}
