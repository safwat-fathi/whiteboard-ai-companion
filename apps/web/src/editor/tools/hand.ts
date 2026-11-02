import type { Tool } from './index'

/** Moves nothing by itself: the canvas pans only while Space is held (the Editor owns that, for every tool). */
export const handTool = (): Tool => ({
  id: 'hand',
  key: 'h',
  navigates: true,
  cursor: 'grab',
  onPointerDown() {},
  onPointerMove() {},
  onPointerUp() {},
})
