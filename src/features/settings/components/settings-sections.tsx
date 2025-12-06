import type { JSX, ParentComponent } from "solid-js";
import { Show } from "solid-js";

type SettingsPageProps = {
  title: string;
};

export const SettingsPage: ParentComponent<SettingsPageProps> = (props) => {
  return (
    <div class="flex flex-col gap-6 max-w-3xl mx-auto w-full pt-12">
      <h1 class="text-xl font-medium">{props.title}</h1>
      {props.children}
    </div>
  );
};

type SettingsSectionProps = {
  title: string;
};

export const SettingsSection: ParentComponent<SettingsSectionProps> = (
  props,
) => {
  return (
    <section class="flex flex-col gap-3">
      <h2 class="text-lg font-medium">{props.title}</h2>
      {props.children}
    </section>
  );
};

export const SettingsCard: ParentComponent = (props) => {
  return (
    <div class="squircle-md bg-surface border divide-y divide-border">
      {props.children}
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
