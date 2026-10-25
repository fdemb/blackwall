import type { Invitation } from "./api";

/** The invitation in a `next` path such as `/welcome?workspace=…&token=…`, if it carries one. */
export function invitationFromNext(next: string | null): Invitation | null {
  if (!next?.startsWith("/")) return null;
  const base = "http://blackwall.invalid";
  const url = new URL(next, base);
  const workspace_id = url.searchParams.get("workspace")?.trim();
  const token = url.searchParams.get("token")?.trim();
  if (url.origin !== base || url.pathname !== "/welcome" || !workspace_id || !token) return null;
  return { workspace_id, token };
}
