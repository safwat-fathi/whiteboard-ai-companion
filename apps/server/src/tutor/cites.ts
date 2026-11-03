import { parseCite } from '@whiteboard/core'

export type SourceRange = { bookId: string; pageStart: number; pageEnd: number }

/**
 * Citations are page-based: `[p. 40](cite:<bookId>#<page>)`, and only a page the model was shown this turn may be cited
 * (R6). Streamed text cannot be taken back, so the dock already refuses to link an unknown page; this makes the stored
 * message agree, turning every other `cite:` link into its plain text. Returns how many it removed.
 */
export function sanitizeCites(
  text: string,
  sources: readonly SourceRange[],
): { text: string; stripped: number } {
  let stripped = 0
  const out = text.replace(
    /\[([^\]]*)\]\((cite:[^)\s]*)\)/g,
    (whole, label: string, href: string) => {
      const c = parseCite(href)
      const ok =
        c !== null &&
        sources.some(
          (s) =>
            s.bookId === c.bookId &&
            c.page >= s.pageStart &&
            c.page <= s.pageEnd,
        )
      if (ok) return whole
      stripped++
      return label
    },
  )
  return { text: out, stripped }
}
