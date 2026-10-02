import { useEffect } from "react";

const APP = "Blackwall";

/** Sets the browser tab title for the current route. */
export function useDocumentTitle(title?: string | null) {
  useEffect(() => {
    document.title = title ? `${title} · ${APP}` : APP;
  }, [title]);
}
