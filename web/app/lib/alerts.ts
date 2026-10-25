export const ALERT_KINDS = ["assignment", "reply", "change", "mention", "deadline"] as const;

export type AlertKind = (typeof ALERT_KINDS)[number];
export type AlertPrefs = Record<AlertKind | `email_${AlertKind}`, boolean>;
export type AlertChannel = "inbox" | "email";

/** The server's column defaults, for a member who has never saved a choice. */
const DEFAULTS: AlertPrefs = {
  assignment: true,
  reply: true,
  change: true,
  mention: true,
  deadline: true,
  email_assignment: true,
  email_reply: true,
  email_change: false,
  email_mention: true,
  email_deadline: true,
};

export function storedAlerts(mine: Partial<AlertPrefs> | undefined): AlertPrefs {
  const entries = Object.entries(DEFAULTS).map(([field, on]) => [
    field,
    mine?.[field as keyof AlertPrefs] ?? on,
  ]);
  return Object.fromEntries(entries) as AlertPrefs;
}

/**
 * Email digests list inbox notifications, so a kind kept out of the inbox is never emailed. Its
 * email switch shows off and locked, and keeps the saved choice for when the inbox switch returns.
 */
export function alertSwitch(prefs: AlertPrefs, channel: AlertChannel, kind: AlertKind) {
  if (channel === "inbox") return { field: kind, selected: prefs[kind], disabled: false };
  const field = `email_${kind}` as const;
  return { field, selected: prefs[kind] && prefs[field], disabled: !prefs[kind] };
}
