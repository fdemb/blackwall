import { createServerOnlyFn } from "@tanstack/solid-start";
import { setCookie } from "@tanstack/solid-start-server";
import { parseSetCookieHeader } from "better-auth/cookies";

export const setBetterAuthCookie = createServerOnlyFn(
  (setCookieHeader: string | null) => {
    if (!setCookieHeader) return;
    const cookies = parseSetCookieHeader(setCookieHeader);
    for (const [cookieName, cookie] of cookies) {
      setCookie(cookieName, decodeURIComponent(cookie.value), {
        sameSite: cookie.samesite,
        secure: cookie.secure,
        maxAge: cookie["max-age"],
        httpOnly: cookie.httponly,
        domain: cookie.domain,
        path: cookie.path,
      });
    }
  },
);
