import type { PickerOption } from "@/components/custom-ui/picker";
import { getPreferredTheme, updatePreferredTheme } from "@/server/auth/api";
import MonitorIcon from "lucide-solid/icons/monitor";
import MoonIcon from "lucide-solid/icons/moon";
import SunIcon from "lucide-solid/icons/sun";
import { createSignal, onMount } from "solid-js";

export const themes = [
  {
    id: "system",
    label: "System",
    icon: MonitorIcon,
  },
  {
    id: "light",
    label: "Light",
    icon: SunIcon,
  },
  {
    id: "dark",
    label: "Dark",
    icon: MoonIcon,
  },
] as const satisfies PickerOption[];

type ThemeId = (typeof themes)[number]["id"];

function getCurrentThemeId(): ThemeId {
  if (typeof window === "undefined") {
    return "system";
  }

  if (document.documentElement.hasAttribute("data-theme-system")) {
    return "system";
  }
  return (
    (document.documentElement.getAttribute("data-theme") as ThemeId) ?? "system"
  );
}

export const useTheme = () => {
  const [currentThemeId, setCurrentThemeId] = createSignal<ThemeId>("system");

  onMount(() => {
    setCurrentThemeId(getCurrentThemeId());
  });

  const currentTheme = () =>
    themes.find((t) => t.id === currentThemeId()) ?? themes[0];

  const setTheme = (themeId: ThemeId) => {
    const theme = themes.find((t) => t.id === themeId);
    if (theme) {
      updatePreferredTheme({
        data: { theme: themeId },
      }).then(() => {
        setCurrentThemeId(themeId);
        window._setTheme(themeId);
      });
    }
  };

  const setThemeToUserPreference = () => {
    getPreferredTheme().then((theme) => {
      setCurrentThemeId(theme);
      window._setTheme(theme);
    });
  };

  return {
    currentTheme: currentTheme as () => PickerOption<ThemeId>,
    setTheme,
    themes,
    setThemeToUserPreference,
  };
};
