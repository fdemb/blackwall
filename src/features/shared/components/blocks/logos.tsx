import type { ComponentProps } from "solid-js";

export function Logo(props: ComponentProps<"svg">) {
  return (
    <svg
      width="64"
      height="64"
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <rect width="64" height="64" fill="#C9184A" />
      <path
        fill-rule="evenodd"
        clip-rule="evenodd"
        d="M64 11.4375H58.5352V23.1875H64V26.125H46.002V37.875H64V40.8125H58.5352V52.5625H64V55.5H0V52.5625H5.46484V40.8125H0V37.875H19.5645V26.125H0V23.1875H5.46484V11.4375H0V8.5H64V11.4375ZM8.40234 52.5625H30.5312V40.8125H8.40234V52.5625ZM33.4688 52.5625H55.5977V40.8125H33.4688V52.5625ZM22.502 37.875H43.0645V26.125H22.502V37.875ZM8.40234 23.1875H30.5312V11.4375H8.40234V23.1875ZM33.4688 23.1875H55.5977V11.4375H33.4688V23.1875Z"
        fill="#fff"
      />
    </svg>
  );
}

export function LogoNoBg(props: ComponentProps<"svg">) {
  return (
    <svg
      width="64"
      height="64"
      viewBox="0 0 64 64"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      {...props}
    >
      <path
        fill-rule="evenodd"
        clip-rule="evenodd"
        d="M64 11.4375H58.5352V23.1875H64V26.125H46.002V37.875H64V40.8125H58.5352V52.5625H64V55.5H0V52.5625H5.46484V40.8125H0V37.875H19.5645V26.125H0V23.1875H5.46484V11.4375H0V8.5H64V11.4375ZM8.40234 52.5625H30.5312V40.8125H8.40234V52.5625ZM33.4688 52.5625H55.5977V40.8125H33.4688V52.5625ZM22.502 37.875H43.0645V26.125H22.502V37.875ZM8.40234 23.1875H30.5312V11.4375H8.40234V23.1875ZM33.4688 23.1875H55.5977V11.4375H33.4688V23.1875Z"
        fill="currentColor"
      />
    </svg>
  );
}

export function LogoText() {
  return (
    <div class="flex flex-row items-center gap-1 ">
      <Logo class="size-5 shrink-0" />
      <span class="text-lg font-[452] tracking-tighter">Blackwall</span>
    </div>
  );
}
