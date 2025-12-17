import type { JSX } from "solid-js";

export default function EmailShell(props: { children?: JSX.Element }) {
  return (
    <>
      <html dir="ltr" lang="en">
        <head>
          {/* @ts-ignore */}
          <meta content="text/html; charset=UTF-8" http-equiv="Content-Type" />
          <meta name="x-apple-disable-message-reformatting" />
        </head>
        <body style="background-color:rgb(255,255,255)">
          <table
            // @ts-ignore
            border="0"
            width="100%"
            cellpadding="0"
            cellspacing="0"
            role="presentation"
            align="center"
          >
            <tbody>
              <tr>
                <td
                  style={`background-color:rgb(255,255,255);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Oxygen-Sans,Ubuntu,Cantarell,"Helvetica Neue",sans-serif`}
                >
                  <table
                    // @ts-ignore
                    align="center"
                    width="100%"
                    border="0"
                    cellpadding="0"
                    cellspacing="0"
                    role="presentation"
                    style="max-width:560px;margin-right:auto;margin-left:auto;margin-bottom:0;margin-top:0;padding-right:0;padding-left:0;padding-top:20px;padding-bottom:48px"
                  >
                    <tbody>
                      <tr style="width:100%">
                        <td>{props.children}</td>
                      </tr>
                    </tbody>
                  </table>
                </td>
              </tr>
            </tbody>
          </table>
        </body>
      </html>
    </>
  );
}
