import { createContext, useCallback, useContext, useMemo, useState, type ReactNode } from "react";
import { auth } from "./api";
import { useI18n } from "./i18n";
import { applyTheme } from "./theme";
import type { Profile } from "./types";

interface Session {
  profile: Profile;
  setProfile: (p: Profile) => void;
  saveProfile: (patch: Partial<Omit<Profile, "id" | "email">>) => Promise<void>;
}
const Ctx = createContext<Session | null>(null);

export function SessionProvider({ initial, children }: { initial: Profile; children: ReactNode }) {
  const { setLang } = useI18n();
  const [profile, setProfileState] = useState(initial);
  const setProfile = useCallback(
    (p: Profile) => {
      setProfileState(p);
      setLang(p.language);
      applyTheme(p.theme);
    },
    [setLang],
  );
  const saveProfile = useCallback(
    async (patch: Partial<Omit<Profile, "id" | "email">>) => {
      const { id: _id, email: _email, ...rest } = { ...profile, ...patch };
      setProfile(await auth.editProfile(rest));
    },
    [profile, setProfile],
  );
  const value = useMemo(() => ({ profile, setProfile, saveProfile }), [profile, setProfile, saveProfile]);
  return <Ctx value={value}>{children}</Ctx>;
}

export function useSession() {
  const v = useContext(Ctx);
  if (!v) throw new Error("SessionProvider missing");
  return v;
}
