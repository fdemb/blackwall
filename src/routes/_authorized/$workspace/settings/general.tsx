import { PickerPopover } from "@/components/custom-ui/picker-popover";
import {
  SettingsCard,
  SettingsPage,
  SettingsRow,
  SettingsSection,
} from "@/components/settings/settings-sections";
import { useTheme } from "@/components/settings/use-theme";
import { Button } from "@/components/ui/button";
import { Popover } from "@kobalte/core/popover";
import { createFileRoute } from "@tanstack/solid-router";
import ChevronDownIcon from "lucide-solid/icons/chevron-down";
import { Show } from "solid-js";
import { Dynamic } from "solid-js/web";

export const Route = createFileRoute(
  "/_authorized/$workspace/settings/general",
)({
  component: RouteComponent,
});

function RouteComponent() {
  return (
    <SettingsPage title="General settings">
      <SettingsSection title="UI settings">
        <SettingsCard>
          <SettingsRow
            title="Theme"
            description="Customize the appearance of the app."
          >
            <ThemeSelector />
          </SettingsRow>
        </SettingsCard>
      </SettingsSection>
    </SettingsPage>
  );
}

function ThemeSelector() {
  const { currentTheme, setTheme, themes } = useTheme();

  return (
    <Popover>
      <Popover.Trigger as={Button} variant="outline">
        <Show when={currentTheme().icon}>
          <Dynamic component={currentTheme().icon} class="size-4 shrink-0" />
        </Show>
        {currentTheme().label}
        <ChevronDownIcon class="size-4" />
      </Popover.Trigger>

      <PickerPopover
        options={themes}
        value={currentTheme().id}
        onChange={setTheme}
      />
    </Popover>
  );
}
