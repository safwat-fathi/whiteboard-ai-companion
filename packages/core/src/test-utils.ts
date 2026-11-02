import { DEFAULT_STYLE, type Element, type ShapeData } from './schema'

export const mk = (
  id: string,
  p: Partial<Element> & { data?: ShapeData; fill?: string | null } = {},
): Element => {
  const { fill, ...rest } = p
  return {
    id,
    type: 'shape',
    x: 0,
    y: 0,
    w: 100,
    h: 20,
    rotation: 0,
    z: 'a0',
    style: { ...DEFAULT_STYLE, fill: fill ?? null },
    locked: false,
    author: { kind: 'human', id: 'u' },
    v: 0,
    data: { kind: 'rect' },
    ...rest,
  } as Element
}
