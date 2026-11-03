// Test-only: a tiny PDF writer (Helvetica text, an outline, page labels) so the library tests run on real PDFs.
export type OutlineSpec = {
  title: string
  /** 1-based page the entry points at */
  page: number
  children?: OutlineSpec[]
}
export type LabelSpec = {
  /** 1-based first page of the range */
  from: number
  /** D decimal, r/R roman, a/A letters; omit for prefix only */
  style?: 'D' | 'r' | 'R' | 'a' | 'A'
  prefix?: string
  start?: number
}
export type TestPdfOptions = {
  /** Text of each page (Latin-1; "\n" starts a new line); '' is a blank page */
  pages: string[]
  outline?: OutlineSpec[]
  labels?: LabelSpec[]
}

const esc = (s: string) => s.replace(/[\\()]/g, (c) => `\\${c}`)

export function makeTestPdf(o: TestPdfOptions): Uint8Array {
  const objs: string[] = []
  const alloc = () => objs.push('')
  const set = (n: number, body: string) => {
    objs[n - 1] = body
  }
  const catalog = alloc()
  const pagesN = alloc()
  const font = alloc()
  const pageNums: number[] = []
  for (const text of o.pages) {
    const page = alloc()
    const content = alloc()
    pageNums.push(page)
    const lines = text.split('\n')
    const stream = text
      ? `BT /F1 12 Tf 50 700 Td 14 TL ${lines.map((l) => `(${esc(l)}) Tj T*`).join(' ')} ET`
      : ''
    set(content, `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`)
    set(
      page,
      `<< /Type /Page /Parent ${pagesN} 0 R /MediaBox [0 0 612 792] /Contents ${content} 0 R /Resources << /Font << /F1 ${font} 0 R >> >> >>`,
    )
  }
  set(font, '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>')
  set(
    pagesN,
    `<< /Type /Pages /Kids [${pageNums.map((n) => `${n} 0 R`).join(' ')}] /Count ${pageNums.length} >>`,
  )

  let extra = ''
  if (o.outline?.length) {
    const root = alloc()
    const build = (items: OutlineSpec[], parent: number) => {
      const nums = items.map(() => alloc())
      let total = items.length
      items.forEach((it, i) => {
        const kids = it.children?.length
          ? build(it.children, nums[i] as number)
          : null
        if (kids) total += kids.count
        set(
          nums[i] as number,
          `<< /Title (${esc(it.title)}) /Parent ${parent} 0 R` +
            (i > 0 ? ` /Prev ${nums[i - 1]} 0 R` : '') +
            (i < items.length - 1 ? ` /Next ${nums[i + 1]} 0 R` : '') +
            (kids
              ? ` /First ${kids.first} 0 R /Last ${kids.last} 0 R /Count ${kids.count}`
              : '') +
            ` /Dest [${pageNums[it.page - 1]} 0 R /Fit] >>`,
        )
      })
      return {
        first: nums[0] as number,
        last: nums.at(-1) as number,
        count: total,
      }
    }
    const t = build(o.outline, root)
    set(
      root,
      `<< /Type /Outlines /First ${t.first} 0 R /Last ${t.last} 0 R /Count ${t.count} >>`,
    )
    extra += ` /Outlines ${root} 0 R`
  }
  if (o.labels?.length) {
    const nums = o.labels
      .map(
        (l) =>
          `${l.from - 1} << ${l.style ? `/S /${l.style}` : ''}${l.prefix ? ` /P (${esc(l.prefix)})` : ''}${l.start ? ` /St ${l.start}` : ''} >>`,
      )
      .join(' ')
    extra += ` /PageLabels << /Nums [${nums}] >>`
  }
  set(catalog, `<< /Type /Catalog /Pages ${pagesN} 0 R${extra} >>`)

  const parts: Buffer[] = [Buffer.from('%PDF-1.7\n', 'latin1')]
  const offsets: number[] = []
  let at = parts[0]?.length ?? 0
  objs.forEach((body, i) => {
    const b = Buffer.from(`${i + 1} 0 obj\n${body}\nendobj\n`, 'latin1')
    offsets.push(at)
    at += b.length
    parts.push(b)
  })
  const xref =
    `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n` +
    offsets.map((p) => `${String(p).padStart(10, '0')} 00000 n \n`).join('') +
    `trailer\n<< /Size ${objs.length + 1} /Root ${catalog} 0 R >>\nstartxref\n${at}\n%%EOF\n`
  parts.push(Buffer.from(xref, 'latin1'))
  return new Uint8Array(Buffer.concat(parts))
}
