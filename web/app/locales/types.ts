import type { en } from "./en";

/** Require every message, with the target language's plural categories for counted messages. */
export type Catalog<Plural extends Intl.LDMLPluralRule> = {
  [
    K in keyof typeof en as K extends `${infer Base}_one`
      ? `${Base}_${Plural}`
      : K extends `${string}_other`
        ? never
        : K
  ]: string;
};
