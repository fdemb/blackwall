import type { session } from "@/features/auth/actions";
import { type Accessor, createContext, useContext } from "solid-js";

export type SessionData = NonNullable<Awaited<ReturnType<typeof session>>>;
export type SessionContextType = Accessor<SessionData>;

export const SessionContext = createContext<SessionContextType>();

export const useSessionData = () => {
  const ctx = useContext(SessionContext);

  if (!ctx) {
    throw new Error("useSessionData called outside SessionContext.");
  }

  return ctx;
};
