export type AffineMatrix = [number, number, number, number, number, number]

export type MathPathItem = {
  d: string
  m: AffineMatrix
  fill: string
}

export type MathPaths = {
  viewBox: [number, number, number, number]
  items: MathPathItem[]
}

const IDENTITY: AffineMatrix = [1, 0, 0, 1, 0, 0]

function mul(a: AffineMatrix, b: AffineMatrix): AffineMatrix {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ]
}

function parseTransform(raw: string | undefined): AffineMatrix | null {
  if (!raw || raw.trim() === '') return IDENTITY
  let cur: AffineMatrix = IDENTITY
  const re = /\s*(translate|scale|rotate|matrix)\s*\(\s*([^)]*)\)\s*/y
  let idx = 0
  while (idx < raw.length) {
    re.lastIndex = idx
    const m = re.exec(raw)
    if (!m) return null
    idx = re.lastIndex
    const fn = m[1]
    const nums = (m[2] ?? '')
      .trim()
      .split(/[\s,]+/)
      .filter(Boolean)
      .map(Number)
    if (nums.some((n) => !Number.isFinite(n))) return null
    if (fn === 'translate') {
      if (nums.length < 1 || nums.length > 2) return null
      cur = mul(cur, [1, 0, 0, 1, nums[0] ?? 0, nums[1] ?? 0])
    } else if (fn === 'scale') {
      if (nums.length < 1 || nums.length > 2) return null
      const sx = nums[0] ?? 1
      const sy = nums[1] ?? sx
      cur = mul(cur, [sx, 0, 0, sy, 0, 0])
    } else if (fn === 'rotate') {
      if (nums.length !== 1) return null
      const rad = ((nums[0] ?? 0) * Math.PI) / 180
      const c = Math.cos(rad)
      const s = Math.sin(rad)
      cur = mul(cur, [c, s, -s, c, 0, 0])
    } else if (fn === 'matrix') {
      if (nums.length !== 6) return null
      cur = mul(cur, [
        nums[0] ?? 1,
        nums[1] ?? 0,
        nums[2] ?? 0,
        nums[3] ?? 1,
        nums[4] ?? 0,
        nums[5] ?? 0,
      ])
    }
  }
  return cur
}

function parseAttrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const m of raw.matchAll(/([a-zA-Z0-9:-]+)\s*=\s*"([^"]*)"/g)) {
    if (m[1]) out[m[1]] = m[2] ?? ''
  }
  return out
}

export function fixViewBox(
  svg: string,
  pxPerEm: number,
): { svg: string; w: number; h: number } {
  const rootMatch = svg.match(/^<svg[^>]*>/)
  const vbMatch = rootMatch?.[0].match(/viewBox="([^"]+)"/)
  const parts = vbMatch?.[1]?.trim().split(/\s+/).map(Number) ?? [0, 0, 0, 0]
  const vw = parts[2] ?? 0
  const vh = parts[3] ?? 0
  const w = (vw / 1000) * pxPerEm
  const h = (vh / 1000) * pxPerEm
  const rewritten = svg.replace(/^<svg[^>]*>/, (tag) => {
    const withW = / width="[^"]*"/.test(tag)
      ? tag.replace(/ width="[^"]*"/, ` width="${w}"`)
      : tag.replace(/^<svg/, `<svg width="${w}"`)
    return / height="[^"]*"/.test(withW)
      ? withW.replace(/ height="[^"]*"/, ` height="${h}"`)
      : withW.replace(/^<svg/, `<svg height="${h}"`)
  })
  return { svg: rewritten, w, h }
}

const ALLOWED_TAGS = new Set(['svg', 'g', 'path', 'rect', 'line'])
// MathJax's stylesheet gives array rules and frames a 70-unit stroke that is not an attribute in the markup.
const DEFAULT_STROKE = 70

export function svgToPaths(svg: string): MathPaths | null {
  const rootMatch = svg.match(/^<svg[^>]*>/)
  const vbMatch = rootMatch?.[0].match(/viewBox="([^"]+)"/)
  if (!vbMatch?.[1]) return null
  const vb = vbMatch[1].trim().split(/\s+/).map(Number)
  if (vb.length !== 4 || vb.some((n) => !Number.isFinite(n))) return null
  const [vx = 0, vy = 0, vw = 0, vh = 0] = vb
  if (vw <= 0 || vh <= 0) return null

  type Frame = { m: AffineMatrix; fill: string; stroke: string }
  const stack: Frame[] = [{ m: IDENTITY, fill: '#000000', stroke: '#000000' }]
  const items: MathPathItem[] = []

  const tagRe = /<(\/?)([a-zA-Z0-9:-]+)([^>]*?)(\/?)>/g
  let lastEnd = 0
  for (const match of svg.matchAll(tagRe)) {
    const idx = match.index ?? 0
    if (svg.slice(lastEnd, idx).trim() !== '') return null
    lastEnd = idx + match[0].length

    const isClose = match[1] === '/'
    const tag = match[2] ?? ''
    const attrStr = match[3] ?? ''
    const isSelfClose = match[4] === '/'

    if (!ALLOWED_TAGS.has(tag)) return null

    if (isClose) {
      if (tag === 'g' || tag === 'svg') {
        if (stack.length > 1) stack.pop()
      }
      continue
    }

    const parent = stack[stack.length - 1]
    if (!parent) return null
    const attrs = parseAttrs(attrStr)
    const localM = parseTransform(attrs.transform)
    if (!localM) return null
    const m = mul(parent.m, localM)
    const fill = attrs.fill ?? parent.fill
    const stroke = attrs.stroke ?? parent.stroke

    if (tag === 'svg' || tag === 'g') {
      if (!isSelfClose) stack.push({ m, fill, stroke })
      continue
    }

    if (tag === 'path') {
      const d = attrs.d
      if (d && fill !== 'none') {
        items.push({ d, m, fill })
      }
    } else if (tag === 'rect') {
      const x = Number(attrs.x ?? 0)
      const y = Number(attrs.y ?? 0)
      const rw = Number(attrs.width ?? 0)
      const rh = Number(attrs.height ?? 0)
      if (Number.isFinite(x) && Number.isFinite(y) && rw > 0 && rh > 0) {
        if (fill !== 'none') {
          items.push({ d: `M${x} ${y}h${rw}v${rh}h${-rw}Z`, m, fill })
        } else if (stroke !== 'none') {
          // \boxed, \fbox and array frames are unfilled rects whose width is the stroke: draw the border as a ring.
          const sw = Number(attrs['stroke-width'] ?? DEFAULT_STROKE)
          const h = sw / 2
          if (sw > 0 && rw > sw && rh > sw) {
            const d =
              `M${x - h} ${y - h}h${rw + sw}v${rh + sw}h${-(rw + sw)}Z` +
              `M${x + h} ${y + h}v${rh - sw}h${rw - sw}v${-(rh - sw)}Z`
            items.push({ d, m, fill: stroke })
          }
        }
      }
    } else if (tag === 'line') {
      const x1 = Number(attrs.x1 ?? 0)
      const y1 = Number(attrs.y1 ?? 0)
      const x2 = Number(attrs.x2 ?? 0)
      const y2 = Number(attrs.y2 ?? 0)
      const sw = Number(attrs['stroke-width'] ?? DEFAULT_STROKE)
      const dx = x2 - x1
      const dy = y2 - y1
      const len = Math.hypot(dx, dy)
      if (len > 0 && sw > 0 && stroke !== 'none') {
        const nx = (-dy / len) * (sw / 2)
        const ny = (dx / len) * (sw / 2)
        const d = `M${x1 + nx} ${y1 + ny}L${x2 + nx} ${y2 + ny}L${x2 - nx} ${y2 - ny}L${x1 - nx} ${y1 - ny}Z`
        items.push({ d, m, fill: stroke })
      }
    }
  }
  if (svg.slice(lastEnd).trim() !== '') return null
  return { viewBox: [vx, vy, vw, vh], items }
}

export function drawMathPaths(
  ctx: CanvasRenderingContext2D,
  paths: MathPaths,
  x: number,
  y: number,
  w: number,
  h: number,
  createPath2D: (d: string) => Path2D,
  color?: string,
): void {
  const [vx, vy, vw, vh] = paths.viewBox
  if (vw <= 0 || vh <= 0 || w <= 0 || h <= 0) return
  ctx.save()
  ctx.translate(x, y)
  ctx.scale(w / vw, h / vh)
  ctx.translate(-vx, -vy)
  for (const item of paths.items) {
    ctx.save()
    const [a, b, c, d, e, f] = item.m
    ctx.transform(a, b, c, d, e, f)
    ctx.fillStyle = color ?? item.fill
    ctx.fill(createPath2D(item.d))
    ctx.restore()
  }
  ctx.restore()
}
