import type { JSX } from "solid-js";

export default function EmailHeading(props: { children?: JSX.Element }) {
  return (
    <h1 style="font-size:24px;letter-spacing:-0.5px;line-height:1.3;font-weight:400;color:rgb(72,72,72);padding-top:17px;padding-right:0;padding-left:0;padding-bottom:0">
      {props.children}
    </h1>
  );
}
