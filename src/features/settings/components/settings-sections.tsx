import { buttonVariants } from "@/features/shared/components/ui/button";
import { Link, type LinkProps } from "@tanstack/solid-router";
import ArrowLeftIcon from "lucide-solid/icons/arrow-left";
import type { JSX, ParentComponent } from "solid-js";
import { mergeProps, Show, splitProps } from "solid-js";

type SettingsPageProps = {
  title: string;
  fullWidth?: boolean;
};

export const SettingsPage: ParentComponent<SettingsPageProps> = (props) => {
  const merged = mergeProps(
    {
      fullWidth: false,
    },
    props,
  );

  return (
    <div
      class="flex flex-col gap-6 w-full pt-12"
      classList={{
        "max-w-3xl mx-auto": merged.fullWidth === false,
      }}
    >
      <h1 class="text-2xl font-medium px-6">{merged.title}</h1>
      {merged.children}
    </div>
  );
};

type SettingsSectionProps = {
  title?: string;
};

export const SettingsSection: ParentComponent<SettingsSectionProps> = (
  props,
) => {
  return (
    <section class="flex flex-col gap-3">
      <Show when={props.title}>
        <h2 class="text-lg font-medium px-6">{props.title}</h2>
      </Show>
      {props.children}
    </section>
  );
};

type SettingsCardProps = {
  variant?: "row" | "column";
};

export const SettingsCard: ParentComponent<SettingsCardProps> = (props) => {
  const merged = mergeProps(
    {
      variant: "row" as const,
    },
    props,
  );

  return (
    <div
      class="squircle-md bg-surface border px-2"
      classList={{
        "divide-y divide-border": merged.variant === "row",
        "py-4": merged.variant === "column",
      }}
    >
      {merged.children}
    </div>
  );
};

type SettingsRowProps = {
  title: string;
  description?: string;
  htmlFor?: string;
  descriptionId?: string;
  children?: JSX.Element;
};

export const SettingsRow: ParentComponent<SettingsRowProps> = (props) => {
  return (
    <div class="p-4 flex flex-col gap-4 md:flex-row md:items-center md:justify-between">
      <div class="flex-1">
        <Show
          when={props.htmlFor}
          fallback={<p class="font-medium">{props.title}</p>}
        >
          {(htmlFor) => (
            <label for={htmlFor()} class="font-medium leading-6">
              {props.title}
            </label>
          )}
        </Show>
        <Show when={props.description}>
          <p class="text-sm text-muted-foreground" id={props.descriptionId}>
            {props.description}
          </p>
        </Show>
      </div>
      <div>{props.children}</div>
    </div>
  );
};

export const SettingsBackButton = (props: LinkProps) => {
  const [local, rest] = splitProps(props, ["children"]);

  return (
    <div class="px-6 pt-3">
      <Link
        class={buttonVariants({ variant: "ghost", size: "xs", class: "w-fit" })}
        {...rest}
      >
        {(params) => (
          <>
            <ArrowLeftIcon class="size-4" />
            {typeof local.children === "function"
              ? local.children(params)
              : local.children}
          </>
        )}
      </Link>
    </div>
  );
};
