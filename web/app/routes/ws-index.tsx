import { redirect } from "react-router";
import type { Route } from "./+types/ws-index";

export function clientLoader({ params }: Route.ClientLoaderArgs) {
  throw redirect(`/${params.ws}/my-issues`);
}
export default function Index() {
  return null;
}
