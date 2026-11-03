import {
  DEFAULT_STYLE,
  type Element,
  type FreehandData,
  type ShapeData,
} from './schema'

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

/** A freehand stroke: three points across a 100 x 50 box unless `data` says otherwise. */
export const stroke = (
  id: string,
  p: Partial<Element> = {},
  data: Partial<FreehandData> = {},
): Element =>
  ({
    ...mk(id, { w: 100, h: 50 }),
    type: 'freehand',
    data: {
      points: [
        [0, 0],
        [50, 25],
        [100, 50],
      ],
      smoothing: 0.5,
      highlighter: false,
      ...data,
    },
    ...p,
  }) as Element
