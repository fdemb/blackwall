import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { ConfirmDialog } from "~/components/app/confirm";
import { clearSession, sessionHasPending } from "./session-replicas";
import { queryClient } from "./query-client";
import { clearLastWs } from "./auth-guard";
import { auth } from "./api";
import { useI18n } from "./i18n";
import { applyTheme } from "./theme";
import type { Profile } from "./types";

export async function logoutSession() {
  try {
    await clearSession((signal) => auth.logout(signal));
  } finally {
    queryClient.clear();
    clearLastWs();
    sessionStorage.clear();
    window.location.assign("/login");
  }
}

interface Session {
  profile: Profile;
  logout: () => Promise<void>;
  setProfile: (p: Profile) => void;
  saveProfile: (patch: Partial<Omit<Profile, "id" | "email">>) => Promise<void>;
}
const Ctx = createContext<Session | null>(null);

export function SessionProvider({ initial, children }: { initial: Profile; children: ReactNode }) {
  const { setLang, t } = useI18n();
  const [confirmLogout, setConfirmLogout] = useState(false);
  const finishLogout = useCallback(() => logoutSession(), []);
  const logout = useCallback(async () => {
    if (await sessionHasPending()) setConfirmLogout(true);
    else await finishLogout();
  }, [finishLogout]);
  const [profile, setProfileState] = useState(initial);
  const latest = useRef(initial);
  const writes = useRef<Promise<unknown>>(Promise.resolve());
  const setProfile = useCallback(
    (p: Profile) => {
      latest.current = p;
      setProfileState(p);
      setLang(p.language);
      applyTheme(p.theme);
    },
    [setLang],
  );
  // The whole profile is sent each time, so saves run one after another on the newest copy.
  // Two quick changes (language, then theme) must not overwrite each other.
  const saveProfile = useCallback(
    (patch: Partial<Omit<Profile, "id" | "email">>) => {
      const next = writes.current.then(async () => {
        const { id: _id, email: _email, ...rest } = { ...latest.current, ...patch };
        setProfile(await auth.editProfile(rest));
      });
      writes.current = next.catch(() => undefined);
      return next;
    },
    [setProfile],
  );
  const value = useMemo(
    () => ({ profile, setProfile, saveProfile, logout }),
    [profile, setProfile, saveProfile, logout],
  );
  return (
    <Ctx value={value}>
      {children}
      <ConfirmDialog
        title={t("draft.discardTitle")}
        description={t("draft.discardSub")}
        confirmLabel={t("nav.signOut")}
        isOpen={confirmLogout}
        onOpenChange={setConfirmLogout}
        onConfirm={finishLogout}
      />
    </Ctx>
  );
}

export function useSession() {
  const v = useContext(Ctx);
  if (!v) throw new Error("SessionProvider missing");
  return v;
}
