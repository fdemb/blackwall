import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

/** A text field from a submitted form. File inputs and missing fields read as empty. */
export function formText(form: FormData, name: string) {
  const value = form.get(name);
  return typeof value === "string" ? value : "";
}

/** The ids a multiple-selection list reports. `"all"` means every item it shows. */
export function selectedIds(selection: "all" | Set<string | number>, items: { id: string }[]) {
  return selection === "all" ? items.map((item) => item.id) : Array.from(selection, String);
}
