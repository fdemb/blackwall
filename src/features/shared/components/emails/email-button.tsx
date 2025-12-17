import type { JSX } from "solid-js";

export default function EmailButton(props: {
  children?: JSX.Element;
  href: string;
}) {
  return (
    <a
      href={props.href}
      style="line-height:100%;text-decoration:none;display:inline-block;max-width:100%;mso-padding-alt:0px;width:100%;box-sizing:border-box;padding:12px;font-weight:600;border-radius:8px;text-align:center;background-color:rgb(232,92,92);color:rgb(255,255,255);padding-top:12px;padding-right:12px;padding-bottom:12px;padding-left:12px"
      target="_blank"
    >
      <span
        innerHTML={`<!--[if mso]><i style="mso-font-width:300%;mso-text-raise:18" hidden>&#8202;&#8202;</i><![endif]-->`}
      ></span>
      <span style="max-width:100%;display:inline-block;line-height:120%;mso-padding-alt:0px;mso-text-raise:9px">
        {props.children}
      </span>
      <span
        innerHTML={`<!--[if mso]><i style="mso-font-width:300%" hidden>&#8202;&#8202;&#8203;</i><![endif]-->`}
      ></span>
    </a>
  );
}
