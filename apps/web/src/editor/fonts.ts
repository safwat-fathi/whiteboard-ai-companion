import './fonts.css'

/** Resolves once both canvas fonts are usable; the editor must not draw text before then. */
export async function loadFonts(): Promise<void> {
  await Promise.all([
    document.fonts.load('16px "Plex-Arabic"', 'م'),
    document.fonts.load('16px "Plex-Latin"', 'A'),
  ])
}
