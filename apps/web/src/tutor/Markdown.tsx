'use client'

import { parseCite } from '@whiteboard/core'
import { isValidElement, type ReactNode, useEffect, useState } from 'react'
import ReactMarkdown, { type Components } from 'react-markdown'
import remarkGfm from 'remark-gfm'
import remarkMath from 'remark-math'

export type LinkHandlers = {
  /** Is this page one the model was shown this turn? Unverified citations are not links. */
  isVerified: (c: { bookId: string; page: number }) => boolean
  onCite?: (c: { bookId: string; page: number }) => void
  onLocate?: (elementId: string) => void
}

type MathLib = typeof import('@whiteboard/math')
let mathLib: Promise<MathLib> | undefined
const loadMath = () => {
  mathLib ??= import('@whiteboard/math')
  return mathLib
}

/**
 * A formula as an image. MathJax's SVG goes through an <img> data URL, never into the page's DOM, so nothing in a
 * (model-written, untrusted) formula can run or reach the page.
 */
export function MathSpan({
  latex,
  display,
}: {
  latex: string
  display: boolean
}) {
  const [res, setRes] = useState<
    Awaited<ReturnType<MathLib['renderMath']>> | undefined
  >()
  useEffect(() => {
    let live = true
    setRes(undefined)
    loadMath()
      .then((m) => m.renderMath(latex, { display, color: '#1e1e1e' }))
      .then(
        (r) => live && setRes(r),
        () => live && setRes({ ok: false, error: 'math failed to load' }),
      )
    return () => {
      live = false
    }
  }, [latex, display])
  if (!res?.ok)
    return (
      <code title={res && !res.ok ? res.error : 'rendering…'} dir="ltr">
        {latex}
      </code>
    )
  const img = (
    // biome-ignore lint/performance/noImgElement: a data-URL SVG of a formula; next/image does not apply
    <img
      alt={latex}
      src={`data:image/svg+xml;charset=utf-8,${encodeURIComponent(res.svg)}`}
      style={{
        height: `${res.height + res.depth}em`,
        verticalAlign: `${-res.depth}em`,
        maxWidth: '100%',
      }}
    />
  )
  return display ? (
    <span style={{ display: 'block', textAlign: 'center', margin: '8px 0' }}>
      {img}
    </span>
  ) : (
    img
  )
}

const link: React.CSSProperties = {
  font: 'inherit',
  color: '#1a56db',
  background: 'none',
  border: 'none',
  padding: 0,
  textDecoration: 'underline',
  cursor: 'pointer',
}

// Only our own schemes survive; every other link is rendered as plain text (the tutor has no business sending the student away).
const urlTransform = (url: string) =>
  url.startsWith('cite:') || url.startsWith('board:') ? url : ''

export function Markdown({
  text,
  handlers,
}: {
  text: string
  handlers: LinkHandlers
}) {
  const components: Components = {
    a({ href, children }) {
      const cite = href ? parseCite(href) : null
      if (cite)
        return handlers.isVerified(cite) ? (
          <button
            type="button"
            style={link}
            onClick={() => handlers.onCite?.(cite)}
          >
            {children}
          </button>
        ) : (
          <span title="This citation could not be verified">{children}</span>
        )
      if (href?.startsWith('board:') && handlers.onLocate) {
        const id = decodeURIComponent(href.slice('board:'.length))
        return (
          <button
            type="button"
            style={link}
            onClick={() => handlers.onLocate?.(id)}
          >
            {children}
          </button>
        )
      }
      return <span>{children}</span>
    },
    code({ className, children }) {
      if (/language-math/.test(className ?? ''))
        return (
          <MathSpan
            latex={String(children).trim()}
            display={/math-display/.test(className ?? '')}
          />
        )
      return <code className={className}>{children}</code>
    },
    pre({ children }: { children?: ReactNode }) {
      const only = Array.isArray(children) ? children[0] : children
      const cls = isValidElement(only)
        ? (only.props as { className?: string }).className
        : undefined
      return /language-math/.test(cls ?? '') ? children : <pre>{children}</pre>
    },
  }
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm, remarkMath]}
      components={components}
      urlTransform={urlTransform}
    >
      {text}
    </ReactMarkdown>
  )
}
