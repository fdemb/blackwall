export function formatDateShort(date: Date): string {
  return date.toLocaleDateString("en-US", {
    year:
      date.getFullYear() == new Date().getFullYear() ? undefined : "numeric",
    month: "short",
    day: "numeric",
  });
}
