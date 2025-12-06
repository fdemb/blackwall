import type { JSX } from "solid-js";
import { Logo } from "./logos";

export function AuthShell(props: { children?: JSX.Element }) {
  return (
    <div class="min-h-screen flex flex-col-reverse md:flex-row bg-background">
      <div class="flex flex-1 justify-center items-center">
        {props.children}
      </div>
      <img
        src="/bg.png"
        alt="Splash screen"
        class="dark:hidden max-h-screen w-full hidden md:block object-cover md:h-auto md:w-1/2"
      />
      <img
        src="/bg_dark.png"
        alt="Splash screen"
        class="dark:md:block hidden max-h-screen w-full object-cover md:h-auto md:w-1/2"
      />
      <div class="bg-primary md:bg-gradient-to-b relative from-primary to-primary-darker h-4 w-full md:hidden">
        <div class="bg-[url(/brick-pattern.svg)] absolute inset-0"></div>
      </div>
    </div>
  );
}

export function AuthCard(props: { children?: JSX.Element; title?: string }) {
  return (
    <div class="p-6 ring-1 ring-black/10 dark:ring-border shadow-md dark:shadow-none bg-card min-w-80 rounded-lg">
      <div class="flex flex-col items-center gap-3 mb-6">
        <Logo class="size-7" />
        <h1 class="text-xl font-medium text-center">{props.title}</h1>
      </div>
      {props.children}
    </div>
  );
}
