import { useRef, useState } from "react";
import { Form } from "react-aria-components";
import { useNavigate, useOutletContext, useRevalidator, useSearchParams } from "react-router";
import { Loader2 } from "lucide-react";
import { Button } from "~/components/ui/button";
import { FormError, TextField } from "~/components/ui/field";
import { Logo } from "~/components/app/logo";
import { LanguageToggle } from "~/components/app/preferences";
import { auth, workspaces } from "~/lib/api";
import { writeLastWs } from "~/lib/auth-guard";
import { useT } from "~/lib/i18n";
import { useSession } from "~/lib/session";
import { useDocumentTitle } from "~/lib/title";
import type { WorkspaceSummary } from "~/lib/types";
import { formText } from "~/lib/utils";

export default function Welcome() {
  const t = useT();
  const nav = useNavigate();
  const { profile } = useSession();
  const { revalidate } = useRevalidator();
  const { workspaces: list } = useOutletContext<{ workspaces: WorkspaceSummary[] }>();
  const [params] = useSearchParams();
  const [error, setError] = useState("");
  // An invitation link can carry ?workspace= and ?token=, which opens the join form with both filled in.
  const [mode, setMode] = useState<"create" | "join">(
    params.get("workspace") || params.get("token") ? "join" : "create",
  );
  const [busy, setBusy] = useState(false);
  const creation = useRef<{ name: string; key: string } | null>(null);
  useDocumentTitle(t("workspace.newOrJoin"));
  return (
    <div className="relative grid min-h-dvh place-items-center overflow-hidden px-4 py-10">
      <div
        aria-hidden
        className="pointer-events-none absolute -top-40 left-1/2 size-[640px] -translate-x-1/2 rounded-full bg-primary/15 blur-3xl"
      />
      <div className="absolute right-4 top-4 flex items-center gap-1">
        <LanguageToggle />
        <Button
          variant="ghost"
          size="sm"
          onPress={() =>
            auth.logout().finally(() => {
              location.href = "/login";
            })
          }
        >
          {t("nav.signOut")}
        </Button>
      </div>
      <main className="relative w-full max-w-sm">
        <Logo size={30} className="mb-6" />
        <h1 className="text-xl font-semibold tracking-tight">
          {t("welcome.title", { name: profile.display_name.split(" ")[0] })}
        </h1>
        <p className="mb-6 mt-1 text-muted-foreground">
          {mode === "create" ? t("welcome.createSub") : t("welcome.joinSub")}
        </p>
        <Form
          className="flex flex-col gap-4"
          onSubmit={async (e) => {
            e.preventDefault();
            if (busy) return;
            const f = new FormData(e.currentTarget);
            setBusy(true);
            setError("");
            try {
              if (mode === "create") {
                const name = f.get("name");
                if (typeof name !== "string") throw new Error(t("error.generic"));
                if (creation.current?.name !== name)
                  creation.current = { name, key: crypto.randomUUID() };
                const r = await workspaces.create(name, creation.current.key);
                writeLastWs(r.workspace.id);
                await revalidate();
                await nav(`/${r.workspace.id}/settings/teams`);
              } else {
                const id = formText(f, "id").trim();
                await workspaces.accept(id, formText(f, "token").trim());
                writeLastWs(id);
                await revalidate();
                await nav(`/${id}/my-issues`);
              }
            } catch (err) {
              setError((err as Error).message);
              setBusy(false);
            }
          }}
        >
          {mode === "create" ? (
            <TextField
              name="name"
              label={t("workspace.name")}
              placeholder={t("workspace.namePlaceholder")}
              autoComplete="off"
              spellCheck="false"
              autoFocus
              isRequired
            />
          ) : (
            <>
              <TextField
                name="id"
                label={t("workspace.id")}
                description={t("workspace.idHint")}
                defaultValue={params.get("workspace") ?? ""}
                autoComplete="off"
                spellCheck="false"
                autoFocus
                isRequired
              />
              <TextField
                name="token"
                label={t("invite.token")}
                defaultValue={params.get("token") ?? ""}
                autoComplete="off"
                spellCheck="false"
                isRequired
              />
            </>
          )}
          <FormError>{error}</FormError>
          <Button type="submit" variant="primary" size="lg" isPending={busy}>
            {busy && <Loader2 aria-hidden className="animate-spin" />}
            {busy
              ? mode === "create"
                ? t("workspace.creating")
                : t("workspace.joining")
              : mode === "create"
                ? t("workspace.create")
                : t("invite.accept")}
          </Button>
        </Form>
        <Button
          variant="link"
          className="mt-4 px-0"
          onPress={() => {
            setMode(mode === "create" ? "join" : "create");
            setError("");
          }}
        >
          {mode === "create" ? t("welcome.haveInvite") : t("welcome.startOwn")}
        </Button>
        {list.length > 0 && (
          <Button variant="link" className="ml-4 mt-4 px-0" onPress={() => nav("/")}>
            {t("welcome.back")}
          </Button>
        )}
      </main>
    </div>
  );
}
