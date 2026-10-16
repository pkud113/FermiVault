/** Marks UI text that is stored now and translated where it's shown with t(): command names,
 *  tab labels, permission descriptions. It returns its argument unchanged; tests/i18n.test.ts
 *  finds these as well as t() calls, to check every locale has the string. */
export const tk = (text: string) => text;
