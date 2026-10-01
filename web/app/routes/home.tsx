import { redirect } from "react-router";
import { LAST_WS, landing } from "~/lib/auth-guard";

export async function clientLoader() {
  const { list } = await landing();
  const last = localStorage.getItem(LAST_WS);
  const target = list.find((w) => w.id === last) ?? list[0];
  throw redirect(target ? `/${target.id}/my-issues` : "/welcome");
}

export default function Home() {
  return null;
}
