import { Languages, Monitor, Moon, Sun } from "lucide-react";
import { Button } from "~/components/ui/button";
import { Menu, MenuItem, MenuPopover, MenuTrigger } from "~/components/ui/menu";
import { useI18n } from "~/lib/i18n";
import { applyTheme } from "~/lib/theme";
import { useSession } from "~/lib/session";
import type { Language, Theme } from "~/lib/types";

export function LanguageToggle() {
  const { lang, setLang, t } = useI18n();
  return (
    <MenuTrigger>
      <Button variant="ghost" size="sm" aria-label={t("pref.language")}><Languages />{lang.toUpperCase()}</Button>
      <MenuPopover placement="bottom end">
        <Menu selectionMode="single" selectedKeys={[lang]} onAction={(k) => setLang(k as Language)}>
          <MenuItem id="en">English</MenuItem>
          <MenuItem id="pl">Polski</MenuItem>
        </Menu>
      </MenuPopover>
    </MenuTrigger>
  );
}

export const THEME_ICONS = { light: Sun, dark: Moon, system: Monitor } as const;

export function ThemeToggle() {
  const { t } = useI18n();
  const { profile, saveProfile } = useSession();
  const Icon = THEME_ICONS[profile.theme];
  return (
    <MenuTrigger>
      <Button variant="ghost" size="icon" aria-label={t("pref.theme")}><Icon /></Button>
      <MenuPopover placement="top end">
        <Menu selectionMode="single" selectedKeys={[profile.theme]} onAction={(k) => { applyTheme(k as Theme); saveProfile({ theme: k as Theme }).catch(() => {}); }}>
          {(["light", "dark", "system"] as const).map((k) => {
            const I = THEME_ICONS[k];
            return <MenuItem key={k} id={k}><I />{t(`theme.${k}`)}</MenuItem>;
          })}
        </Menu>
      </MenuPopover>
    </MenuTrigger>
  );
}
