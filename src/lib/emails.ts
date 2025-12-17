import nodemailer from "nodemailer";
import type { JSX } from "solid-js";
import { renderToString } from "solid-js/web";
import { env } from "./zod-env";

export type SendableEmail = {
  to: string;
  subject: string;
  html: string;
  text: string;
};

const transporter = env.SMTP_HOST
  ? nodemailer.createTransport({
      host: env.SMTP_HOST,
      port: env.SMTP_PORT,
      auth: {
        user: env.SMTP_USER,
        pass: env.SMTP_PASS,
      },
    })
  : null;

export async function sendEmail(email: SendableEmail) {
  if (!transporter) {
    console.log("Attempted to send email without SMTP configuration:");
    console.log(email);
    console.log("Add SMTP configuration to enable email sending.");
    return;
  }

  const info = await transporter.sendMail({
    from: env.EMAIL_FROM,
    to: email.to,
    subject: email.subject,
    html: email.html,
    text: email.text,
  });

  return info;
}

const emailDoctype = `<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.0 Transitional//EN" "http://www.w3.org/TR/xhtml1/DTD/xhtml1-transitional.dtd">`;
export function renderEmail(component: JSX.Element) {
  let string = renderToString(() => component);
  string = `${emailDoctype}${string}`;

  return string;
}
