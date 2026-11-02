export const ARABIC_ERROR =
  "Arabic inside math isn't supported; put the label in a separate text element"

const ARABIC_RE =
  /[\u0600-\u06FF\u0750-\u077F\u08A0-\u08FF\uFB50-\uFDFF\uFE70-\uFEFF\u{1EE00}-\u{1EEFF}]/u

export function containsArabic(s: string): boolean {
  return ARABIC_RE.test(s)
}
