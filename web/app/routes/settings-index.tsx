import { redirect } from "react-router";
import type { Route } from "./+types/settings-index";

export function clientLoader({ params }: Route.ClientLoaderArgs) {
  throw redirect(`/${params.ws}/settings/profile`);
}
export default function SettingsIndex() {
  return null;
}
