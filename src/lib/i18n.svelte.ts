// Interface translations. Keys are the English text itself (gettext style): English needs no
// dictionary, anything missing falls back to English, and translators work from plain JSON in
// src/lib/locales/. Other languages load on demand, so English startup is unchanged.
// tests/i18n.test.ts checks every translated string in the source has an entry in every locale.

export const LANGUAGES: Record<string, string> = { en: "English", es: "Español", fr: "Français", de: "Deutsch" };

const loaders: Record<string, () => Promise<{ default: Record<string, string> }>> = {
  es: () => import("./locales/es.json"),
  fr: () => import("./locales/fr.json"),
  de: () => import("./locales/de.json"),
};

let dict = $state<Record<string, string>>({});

/** Translates `text`, filling `{name}` placeholders from `vars`. */
export function t(text: string, vars?: Record<string, string | number>): string {
  const s = dict[text] || text;
  return vars ? s.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m)) : s;
}

/** The language to use for a setting of "system" or a language code. */
export function resolveLanguage(setting: string, system = typeof navigator === "undefined" ? "en" : navigator.language): string {
  const code = (setting === "system" ? system : setting).toLowerCase().split("-")[0];
  return code in LANGUAGES ? code : "en";
}

let current = "en";

export async function setLanguage(setting: string) {
  const code = resolveLanguage(setting);
  if (code === current) return;
  dict = code === "en" ? {} : (await loaders[code]()).default;
  current = code;
  document.documentElement.lang = code;
}
