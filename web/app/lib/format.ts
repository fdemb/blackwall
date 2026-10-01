import type { Priority, StageKind } from "./types";

export const PRIORITIES: Priority[] = ["urgent", "high", "normal", "low", "none"];
export const PRIORITY_RANK: Record<Priority, number> = { urgent: 4, high: 3, normal: 2, low: 1, none: 0 };
export const STAGE_KINDS: StageKind[] = ["backlog", "planned", "active", "done", "cancelled"];

export const issueKey = (number: number) => `BW-${number}`;

export function formatMinutes(minutes: number) {
  if (!minutes) return "0m";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return [h ? `${h}h` : "", m ? `${m}m` : ""].filter(Boolean).join(" ");
}

/** Accepts "90", "1h 30m", "1.5h", "45m", "1:30". Returns minutes or null. */
export function parseMinutes(input: string): number | null {
  const s = input.trim().toLowerCase();
  if (!s) return null;
  if (/^\d+$/.test(s)) return Number(s);
  const colon = s.match(/^(\d+):(\d{1,2})$/);
  if (colon) return Number(colon[1]) * 60 + Number(colon[2]);
  const dec = s.match(/^(\d+(?:[.,]\d+)?)\s*h$/);
  if (dec) return Math.round(Number(dec[1].replace(",", ".")) * 60);
  const full = s.match(/^(?:(\d+)\s*h)?\s*(?:(\d+)\s*m(?:in)?)?$/);
  if (full && (full[1] || full[2])) return Number(full[1] ?? 0) * 60 + Number(full[2] ?? 0);
  return null;
}

export function initials(name: string) {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts.length > 1 ? parts[parts.length - 1][0] : "")).toUpperCase() || "?";
}

export function colorFor(seed: string) {
  let hash = 0;
  for (const ch of seed) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  return `oklch(0.62 0.14 ${hash % 360})`;
}

export function relativeTime(iso: string, lang: string) {
  const diff = (new Date(iso).getTime() - Date.now()) / 1000;
  const rtf = new Intl.RelativeTimeFormat(lang, { numeric: "auto" });
  const steps: [Intl.RelativeTimeFormatUnit, number][] = [
    ["year", 31536000], ["month", 2592000], ["week", 604800], ["day", 86400], ["hour", 3600], ["minute", 60],
  ];
  for (const [unit, secs] of steps) if (Math.abs(diff) >= secs) return rtf.format(Math.round(diff / secs), unit);
  return rtf.format(Math.round(diff), "second");
}

export function shortDate(iso: string, lang: string) {
  return new Date(iso).toLocaleDateString(lang, { month: "short", day: "numeric" });
}

export function fullDate(iso: string, lang: string) {
  return new Date(iso).toLocaleDateString(lang, { year: "numeric", month: "short", day: "numeric" });
}

export function daysUntil(iso: string) {
  const end = new Date(iso);
  end.setHours(23, 59, 59, 999);
  return Math.ceil((end.getTime() - Date.now()) / 86400000) - 1;
}

export function bytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}

export function download(name: string, content: string, type = "application/json") {
  const url = URL.createObjectURL(new Blob([content], { type }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

export async function sha256Hex(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
