import { redirect } from "react-router";
import type { Route } from "./+types/account";

/** Account settings moved into the unified settings screen. */
export function clientLoader({ params }: Route.ClientLoaderArgs) {
  throw redirect(`/${params.ws}/settings/profile`);
}
export default function Account() {
  return null;
}
