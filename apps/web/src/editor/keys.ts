/**
 * The shortcut letter of a key event, lower case. `e.key` wins while it is Latin text (a letter, or a named key such as
 * 'Process'), so Dvorak and AZERTY users keep the letters their layout shows. Otherwise (an Arabic, Cyrillic, ... layout
 * is active, or a shifted key typed punctuation) the physical key (`e.code`, 'KeyR') stands in. Never with Alt held:
 * Windows reports AltGr as ctrl+alt, so Polish AltGr+Z ('ż') must not become an undo.
 * ponytail: on Dvorak the punctuation keys that sit on QWERTY Q/W/E/Z also map by position (Ctrl+; is then an undo).
 */
export const shortcutKey = (e: KeyboardEvent): string => {
  const k = e.key.toLowerCase()
  const physical = /^Key([A-Z])$/.exec(e.code)?.[1]
  return physical && !e.altKey && !/^[a-z]+$/.test(k)
    ? physical.toLowerCase()
    : k
}
