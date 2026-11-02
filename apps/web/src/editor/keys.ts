/**
 * The shortcut letter of a key event, lower case. `e.key` wins while it is a Latin letter, so Dvorak and AZERTY users keep
 * the letters their layout shows. When another script's letter is typed (an Arabic, Cyrillic, ... layout is active), the
 * physical key (`e.code`, 'KeyR') stands in; punctuation never does, so Dvorak's Ctrl+; is not an undo.
 */
export const shortcutKey = (e: KeyboardEvent): string => {
  const k = e.key.toLowerCase()
  const physical = /^Key([A-Z])$/.exec(e.code)?.[1]
  return physical && /^\p{L}+$/u.test(k) && !/^[a-z]$/.test(k)
    ? physical.toLowerCase()
    : k
}
