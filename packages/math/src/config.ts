export const MAX_LATEX = 4000

export const TEX_PACKAGES = [
  'base',
  'ams',
  'boldsymbol',
  'cancel',
  'mathtools',
  'mhchem',
] as const

const P = '@mathjax/mathjax-newcm-font/js/svg/dynamic/'

const DYNAMIC_FONTS: Record<string, () => Promise<unknown>> = {
  [`${P}PUA.js`]: () =>
    import('@mathjax/mathjax-newcm-font/js/svg/dynamic/PUA.js'),
  [`${P}accents-b-i.js`]: () =>
    import('@mathjax/mathjax-newcm-font/js/svg/dynamic/accents-b-i.js'),
  [`${P}accents.js`]: () =>
    import('@mathjax/mathjax-newcm-font/js/svg/dynamic/accents.js'),
  [`${P}arabic.js`]: () =>
    import('@mathjax/mathjax-newcm-font/js/svg/dynamic/arabic.js'),
  [`${P}arrows.js`]: () =>
    import('@mathjax/mathjax-newcm-font/js/svg/dynamic/arrows.js'),
  [`${P}braille-d.js`]: () =>
    import('@mathjax/mathjax-newcm-font/js/svg/dynamic/braille-d.js'),
  [`${P}braille.js`]: () =>
    import('@mathjax/mathjax-newcm-font/js/svg/dynamic/braille.js'),
  [`${P}calligraphic.js`]: () =>
    import('@mathjax/mathjax-newcm-font/js/svg/dynamic/calligraphic.js'),
  [`${P}cherokee.js`]: () =>
    import('@mathjax/mathjax-newcm-font/js/svg/dynamic/cherokee.js'),
  [`${P}cyrillic-ss.js`]: () =>
    import('@mathjax/mathjax-newcm-font/js/svg/dynamic/cyrillic-ss.js'),
  [`${P}cyrillic.js`]: () =>
    import('@mathjax/mathjax-newcm-font/js/svg/dynamic/cyrillic.js'),
  [`${P}devanagari.js`]: () =>
    import('@mathjax/mathjax-newcm-font/js/svg/dynamic/devanagari.js'),
  [`${P}double-struck.js`]: () =>
    import('@mathjax/mathjax-newcm-font/js/svg/dynamic/double-struck.js'),
  [`${P}fraktur.js`]: () =>
    import('@mathjax/mathjax-newcm-font/js/svg/dynamic/fraktur.js'),
  [`${P}greek-ss.js`]: () =>
    import('@mathjax/mathjax-newcm-font/js/svg/dynamic/greek-ss.js'),
  [`${P}greek.js`]: () =>
    import('@mathjax/mathjax-newcm-font/js/svg/dynamic/greek.js'),
  [`${P}hebrew.js`]: () =>
    import('@mathjax/mathjax-newcm-font/js/svg/dynamic/hebrew.js'),
  [`${P}latin-b.js`]: () =>
    import('@mathjax/mathjax-newcm-font/js/svg/dynamic/latin-b.js'),
  [`${P}latin-bi.js`]: () =>
    import('@mathjax/mathjax-newcm-font/js/svg/dynamic/latin-bi.js'),
  [`${P}latin-i.js`]: () =>
    import('@mathjax/mathjax-newcm-font/js/svg/dynamic/latin-i.js'),
  [`${P}latin.js`]: () =>
    import('@mathjax/mathjax-newcm-font/js/svg/dynamic/latin.js'),
  [`${P}marrows.js`]: () =>
    import('@mathjax/mathjax-newcm-font/js/svg/dynamic/marrows.js'),
  [`${P}math.js`]: () =>
    import('@mathjax/mathjax-newcm-font/js/svg/dynamic/math.js'),
  [`${P}monospace-ex.js`]: () =>
    import('@mathjax/mathjax-newcm-font/js/svg/dynamic/monospace-ex.js'),
  [`${P}monospace-l.js`]: () =>
    import('@mathjax/mathjax-newcm-font/js/svg/dynamic/monospace-l.js'),
  [`${P}monospace.js`]: () =>
    import('@mathjax/mathjax-newcm-font/js/svg/dynamic/monospace.js'),
  [`${P}mshapes.js`]: () =>
    import('@mathjax/mathjax-newcm-font/js/svg/dynamic/mshapes.js'),
  [`${P}phonetics-ss.js`]: () =>
    import('@mathjax/mathjax-newcm-font/js/svg/dynamic/phonetics-ss.js'),
  [`${P}phonetics.js`]: () =>
    import('@mathjax/mathjax-newcm-font/js/svg/dynamic/phonetics.js'),
  [`${P}sans-serif-b.js`]: () =>
    import('@mathjax/mathjax-newcm-font/js/svg/dynamic/sans-serif-b.js'),
  [`${P}sans-serif-bi.js`]: () =>
    import('@mathjax/mathjax-newcm-font/js/svg/dynamic/sans-serif-bi.js'),
  [`${P}sans-serif-ex.js`]: () =>
    import('@mathjax/mathjax-newcm-font/js/svg/dynamic/sans-serif-ex.js'),
  [`${P}sans-serif-i.js`]: () =>
    import('@mathjax/mathjax-newcm-font/js/svg/dynamic/sans-serif-i.js'),
  [`${P}sans-serif-r.js`]: () =>
    import('@mathjax/mathjax-newcm-font/js/svg/dynamic/sans-serif-r.js'),
  [`${P}sans-serif.js`]: () =>
    import('@mathjax/mathjax-newcm-font/js/svg/dynamic/sans-serif.js'),
  [`${P}script.js`]: () =>
    import('@mathjax/mathjax-newcm-font/js/svg/dynamic/script.js'),
  [`${P}shapes.js`]: () =>
    import('@mathjax/mathjax-newcm-font/js/svg/dynamic/shapes.js'),
  [`${P}symbols-b-i.js`]: () =>
    import('@mathjax/mathjax-newcm-font/js/svg/dynamic/symbols-b-i.js'),
  [`${P}symbols.js`]: () =>
    import('@mathjax/mathjax-newcm-font/js/svg/dynamic/symbols.js'),
  [`${P}variants.js`]: () =>
    import('@mathjax/mathjax-newcm-font/js/svg/dynamic/variants.js'),
}

const EM = 16
const EX = 8

type DocHandle = {
  convert(latex: string, display: boolean): Promise<string>
}

let loaded = false
let conversionCount = 0
const asyncLoadedModules: string[] = []
let docPromise: Promise<DocHandle> | undefined
let queue: Promise<unknown> = Promise.resolve()

export function isMathJaxLoaded(): boolean {
  return loaded
}

export function getConversionCount(): number {
  return conversionCount
}

export function getAsyncLoadedModules(): readonly string[] {
  return asyncLoadedModules
}

function getDocument(): Promise<DocHandle> {
  if (docPromise) return docPromise
  docPromise = (async () => {
    const [
      { mathjax },
      { TeX },
      { SVG },
      { liteAdaptor },
      { RegisterHTMLHandler },
      { MathJaxMhchemFontExtension },
    ] = await Promise.all([
      import('@mathjax/src/js/mathjax.js'),
      import('@mathjax/src/js/input/tex.js'),
      import('@mathjax/src/js/output/svg.js'),
      import('@mathjax/src/js/adaptors/liteAdaptor.js'),
      import('@mathjax/src/js/handlers/html.js'),
      import('@mathjax/mathjax-mhchem-font-extension/js/svg.js'),
      import('@mathjax/src/js/input/tex/base/BaseConfiguration.js'),
      import('@mathjax/src/js/input/tex/ams/AmsConfiguration.js'),
      import('@mathjax/src/js/input/tex/boldsymbol/BoldsymbolConfiguration.js'),
      import('@mathjax/src/js/input/tex/cancel/CancelConfiguration.js'),
      import('@mathjax/src/js/input/tex/mathtools/MathtoolsConfiguration.js'),
      import('@mathjax/src/js/input/tex/mhchem/MhchemConfiguration.js'),
    ])
    loaded = true
    mathjax.asyncLoad = async (name: string) => {
      asyncLoadedModules.push(name)
      const loader = DYNAMIC_FONTS[name]
      if (!loader) throw new Error(`Disallowed MathJax dynamic load: ${name}`)
      const mod = (await loader()) as { default?: unknown }
      return mod.default ?? mod
    }
    const adaptor = liteAdaptor({ fontSize: EM })
    RegisterHTMLHandler(adaptor)
    const svgJax = new SVG({ fontCache: 'none' })
    svgJax.addExtension(MathJaxMhchemFontExtension)
    const html = mathjax.document('', {
      InputJax: new TeX({
        packages: [...TEX_PACKAGES],
        maxMacros: 1000,
        maxBuffer: 5 * 1024,
        formatError: (_jax: unknown, err: { message?: string }) => {
          throw new Error(err?.message ?? String(err))
        },
      }),
      OutputJax: svgJax,
    })
    return {
      async convert(latex: string, display: boolean): Promise<string> {
        const node = await html.convertPromise(latex, {
          display,
          em: EM,
          ex: EX,
          containerWidth: 80 * EM,
        })
        const svgNode = adaptor.tags(node, 'svg')[0]
        if (!svgNode) throw new Error('MathJax produced no <svg> element')
        return adaptor.serializeXML(svgNode) as string
      },
    }
  })()
  return docPromise
}

export async function convertToSvg(
  latex: string,
  display: boolean,
): Promise<{ svg: string; width: number; height: number; depth: number }> {
  conversionCount++
  const run = queue.then(async () => {
    const doc = await getDocument()
    return doc.convert(latex, display)
  })
  queue = run.catch(() => undefined)
  const svg = await run
  const rootMatch = svg.match(/^<svg[^>]*>/)
  const vbMatch = rootMatch?.[0].match(/viewBox="([^"]+)"/)
  if (!vbMatch?.[1]) throw new Error('MathJax SVG missing viewBox')
  const parts = vbMatch[1].trim().split(/\s+/).map(Number)
  const vy = parts[1] ?? 0
  const vw = parts[2] ?? 0
  const vh = parts[3] ?? 0
  const width = Math.max(0.001, vw / 1000)
  const totalH = Math.max(0.001, vh / 1000)
  const depth = Math.max(0, Math.min(totalH, (vy + vh) / 1000))
  const height = Math.max(0.001, totalH - depth)
  return { svg, width, height, depth }
}
