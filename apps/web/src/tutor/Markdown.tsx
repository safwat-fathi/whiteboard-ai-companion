'use client'

import { parseCite } from '@whiteboard/core'
import {
  isValidElement,
  memo,
  type ReactNode,
  type RefObject,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
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

/** The element id in a `board:` link, or null: the text is model-written, so a bad escape or a strange id is just not a link. */
function elementId(raw: string): string | null {
  try {
    const id = decodeURIComponent(raw)
    return /^[\w-]{1,64}$/.test(id) ? id : null
  } catch {
    return null
  }
}

// Only our own schemes survive; every other link is rendered as plain text (the tutor has no business sending the student away).
const urlTransform = (url: string) =>
  url.startsWith('cite:') || url.startsWith('board:') ? url : ''

/**
 * The renderers for react-markdown. They are built once per Markdown instance and read the latest handlers through a
 * ref: react-markdown uses each entry as an element type, so a fresh function per render made React unmount and remount
 * every link, code span and formula on every update (a streamed reply re-rendered, and re-typeset its math, per token).
 */
function componentsFor(handlers: RefObject<LinkHandlers>): Components {
  return {
    a({ href, children }) {
      const h = handlers.current
      const cite = href ? parseCite(href) : null
      if (cite)
        return h.isVerified(cite) ? (
          <button
            type="button"
            style={link}
            onClick={() => handlers.current.onCite?.(cite)}
          >
            {children}
          </button>
        ) : (
          <span title="This citation could not be verified">{children}</span>
        )
      const id = href?.startsWith('board:') ? elementId(href.slice(6)) : null
      if (id && h.onLocate) {
        return (
          <button
            type="button"
            style={link}
            onClick={() => handlers.current.onLocate?.(id)}
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
}

const remarkPlugins = [remarkGfm, remarkMath]

/** Re-parses only when the text or the handlers change; callers keep `handlers` stable (see MessageView). */
export const Markdown = memo(function Markdown({
  text,
  handlers,
}: {
  text: string
  handlers: LinkHandlers
}) {
  const latest = useRef(handlers)
  latest.current = handlers
  const components = useMemo(() => componentsFor(latest), [])
  return (
    <ReactMarkdown
      remarkPlugins={remarkPlugins}
      components={components}
      urlTransform={urlTransform}
    >
      {text}
    </ReactMarkdown>
  )
})
