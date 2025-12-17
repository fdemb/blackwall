import type { JSX } from "solid-js";

export default function EmailText(props: { children?: JSX.Element }) {
  return (
    <p style="font-size:14px;line-height:24px;margin-top:16px;margin-bottom:16px">
      {props.children}
    </p>
  );
}
