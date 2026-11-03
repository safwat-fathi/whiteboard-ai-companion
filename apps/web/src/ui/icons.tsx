import type { SVGProps } from 'react'

export type IconProps = SVGProps<SVGSVGElement> & {
  size?: number
}

const defaultProps = (size = 18): SVGProps<SVGSVGElement> => ({
  width: size,
  height: size,
  viewBox: '0 0 24 24',
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 2,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
  'aria-hidden': 'true',
})

/* ==================== Canvas Tool Icons ==================== */

export function SelectIcon({ size = 18, ...props }: IconProps) {
  return (
    <svg {...defaultProps(size)} {...props}>
      <path d="M3 3l7 18 3-7 7-3L3 3z" />
    </svg>
  )
}

export function HandIcon({ size = 18, ...props }: IconProps) {
  return (
    <svg {...defaultProps(size)} {...props}>
      <path d="M18 11V6a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v4" />
      <path d="M14 10V4a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v6" />
      <path d="M10 10.5V6a2 2 0 0 0-2-2v0a2 2 0 0 0-2 2v8" />
      <path d="M18 8a2 2 0 0 1 2 2v4a8 8 0 0 1-8 8H9c-3.3 0-6-2.7-6-6v-3a2 2 0 0 1 2-2h1" />
    </svg>
  )
}

export function RectIcon({ size = 18, ...props }: IconProps) {
  return (
    <svg {...defaultProps(size)} {...props}>
      <rect x="3" y="3" width="18" height="18" rx="2" />
    </svg>
  )
}

export function EllipseIcon({ size = 18, ...props }: IconProps) {
  return (
    <svg {...defaultProps(size)} {...props}>
      <circle cx="12" cy="12" r="9" />
    </svg>
  )
}

export function DiamondIcon({ size = 18, ...props }: IconProps) {
  return (
    <svg {...defaultProps(size)} {...props}>
      <path d="M12 2L2 12l10 10 10-10L12 2z" />
    </svg>
  )
}

export function TriangleIcon({ size = 18, ...props }: IconProps) {
  return (
    <svg {...defaultProps(size)} {...props}>
      <path d="M12 3L2 21h20L12 3z" />
    </svg>
  )
}

export function LineIcon({ size = 18, ...props }: IconProps) {
  return (
    <svg {...defaultProps(size)} {...props}>
      <line x1="5" y1="19" x2="19" y2="5" />
    </svg>
  )
}

export function ArrowIcon({ size = 18, ...props }: IconProps) {
  return (
    <svg {...defaultProps(size)} {...props}>
      <line x1="5" y1="19" x2="19" y2="5" />
      <polyline points="9 5 19 5 19 15" />
    </svg>
  )
}

export function TextIcon({ size = 18, ...props }: IconProps) {
  return (
    <svg {...defaultProps(size)} {...props}>
      <polyline points="4 7 4 4 20 4 20 7" />
      <line x1="9" y1="20" x2="15" y2="20" />
      <line x1="12" y1="4" x2="12" y2="20" />
    </svg>
  )
}

export function MathIcon({ size = 18, ...props }: IconProps) {
  return (
    <svg {...defaultProps(size)} {...props}>
      {/* LaTeX / Math Sigma & x */}
      <path d="M18 4H6l7 8-7 8h12" />
    </svg>
  )
}

export function ImageIcon({ size = 18, ...props }: IconProps) {
  return (
    <svg {...defaultProps(size)} {...props}>
      <rect x="3" y="3" width="18" height="18" rx="2" />
      <circle cx="8.5" cy="8.5" r="1.5" />
      <polyline points="21 15 16 10 5 21" />
    </svg>
  )
}

export function PenIcon({ size = 18, ...props }: IconProps) {
  return (
    <svg {...defaultProps(size)} {...props}>
      <path d="M17 3a2.8 2.8 0 0 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z" />
    </svg>
  )
}

export function HighlighterIcon({ size = 18, ...props }: IconProps) {
  return (
    <svg {...defaultProps(size)} {...props}>
      <path d="M9 11l-6 6v3h9l3-3" />
      <path d="M22 12l-4.6 4.6a2 2 0 0 1-2.8 0l-5.2-5.2a2 2 0 0 1 0-2.8L14 4" />
    </svg>
  )
}

export function EraserIcon({ size = 18, ...props }: IconProps) {
  return (
    <svg {...defaultProps(size)} {...props}>
      <path d="M20 20H9L3.6 14.6a2 2 0 0 1 0-2.8L12.8 2.6a2 2 0 0 1 2.8 0l5.8 5.8a2 2 0 0 1 0 2.8L12 20.6" />
      <path d="M7 11l6 6" />
    </svg>
  )
}

export function UndoIcon({ size = 18, ...props }: IconProps) {
  return (
    <svg {...defaultProps(size)} {...props}>
      <path d="M3 7v6h6" />
      <path d="M3 13a9 9 0 1 1 3 6.7L3 13" />
    </svg>
  )
}

export function RedoIcon({ size = 18, ...props }: IconProps) {
  return (
    <svg {...defaultProps(size)} {...props}>
      <path d="M21 7v6h-6" />
      <path d="M21 13a9 9 0 1 0-3 6.7L21 13" />
    </svg>
  )
}

/* ==================== Interface & AI Icons ==================== */

export function SparklesIcon({ size = 18, ...props }: IconProps) {
  return (
    <svg {...defaultProps(size)} {...props}>
      <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9L12 3z" />
      <path d="M19 16l.9 2.1L22 19l-2.1.9L19 22l-.9-2.1L16 19l2.1-.9L19 16z" />
      <path d="M5 2l.6 1.4L7 4l-1.4.6L5 6l-.6-1.4L3 4l1.4-.6L5 2z" />
    </svg>
  )
}

export function BookIcon({ size = 18, ...props }: IconProps) {
  return (
    <svg {...defaultProps(size)} {...props}>
      <path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20" />
      <path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z" />
    </svg>
  )
}

export function ChevronLeftIcon({ size = 18, ...props }: IconProps) {
  return (
    <svg {...defaultProps(size)} {...props}>
      <polyline points="15 18 9 12 15 6" />
    </svg>
  )
}

export function ChevronRightIcon({ size = 18, ...props }: IconProps) {
  return (
    <svg {...defaultProps(size)} {...props}>
      <polyline points="9 18 15 12 9 6" />
    </svg>
  )
}

export function ChevronDownIcon({ size = 14, ...props }: IconProps) {
  return (
    <svg {...defaultProps(size)} {...props}>
      <polyline points="6 9 12 15 18 9" />
    </svg>
  )
}

export function CloseIcon({ size = 16, ...props }: IconProps) {
  return (
    <svg {...defaultProps(size)} {...props}>
      <line x1="18" y1="6" x2="6" y2="18" />
      <line x1="6" y1="6" x2="18" y2="18" />
    </svg>
  )
}

export function SendIcon({ size = 16, ...props }: IconProps) {
  return (
    <svg {...defaultProps(size)} {...props}>
      <path d="M22 2L11 13" />
      <path d="M22 2l-7 20-4-9-9-4 20-7z" />
    </svg>
  )
}

export function StopIcon({ size = 16, ...props }: IconProps) {
  return (
    <svg {...defaultProps(size)} {...props}>
      <rect x="6" y="6" width="12" height="12" rx="2" fill="currentColor" />
    </svg>
  )
}

export function LocateIcon({ size = 16, ...props }: IconProps) {
  return (
    <svg {...defaultProps(size)} {...props}>
      <circle cx="12" cy="12" r="8" />
      <line x1="12" y1="2" x2="12" y2="6" />
      <line x1="12" y1="18" x2="12" y2="22" />
      <line x1="2" y1="12" x2="6" y2="12" />
      <line x1="18" y1="12" x2="22" y2="12" />
    </svg>
  )
}

export function ChatIcon({ size = 16, ...props }: IconProps) {
  return (
    <svg {...defaultProps(size)} {...props}>
      <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
    </svg>
  )
}

export function ActivityIcon({ size = 16, ...props }: IconProps) {
  return (
    <svg {...defaultProps(size)} {...props}>
      <polyline points="22 12 18 12 15 21 9 3 6 12 2 12" />
    </svg>
  )
}

export function SourceIcon({ size = 16, ...props }: IconProps) {
  return (
    <svg {...defaultProps(size)} {...props}>
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z" />
      <polyline points="14 2 14 8 20 8" />
      <line x1="16" y1="13" x2="8" y2="13" />
      <line x1="16" y1="17" x2="8" y2="17" />
      <polyline points="10 9 9 9 8 9" />
    </svg>
  )
}

export function CoinsIcon({ size = 16, ...props }: IconProps) {
  return (
    <svg {...defaultProps(size)} {...props}>
      <circle cx="12" cy="12" r="9" />
      <path d="M14.8 9A2 2 0 0 0 13 8h-2a2 2 0 0 0 0 4h2a2 2 0 0 1 0 4h-2a2 2 0 0 1-1.8-1" />
      <path d="M12 6v2m0 8v2" />
    </svg>
  )
}

export function EyeIcon({ size = 16, ...props }: IconProps) {
  return (
    <svg {...defaultProps(size)} {...props}>
      <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z" />
      <circle cx="12" cy="12" r="3" />
    </svg>
  )
}

export function CheckIcon({ size = 16, ...props }: IconProps) {
  return (
    <svg {...defaultProps(size)} {...props}>
      <polyline points="20 6 9 17 4 12" />
    </svg>
  )
}

export function UploadIcon({ size = 18, ...props }: IconProps) {
  return (
    <svg {...defaultProps(size)} {...props}>
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
      <polyline points="17 8 12 3 7 8" />
      <line x1="12" y1="3" x2="12" y2="15" />
    </svg>
  )
}

export function SearchIcon({ size = 16, ...props }: IconProps) {
  return (
    <svg {...defaultProps(size)} {...props}>
      <circle cx="11" cy="11" r="8" />
      <line x1="21" y1="21" x2="16.65" y2="16.65" />
    </svg>
  )
}
