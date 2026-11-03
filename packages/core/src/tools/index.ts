import { boardTools } from './board'
import { addDiagram } from './diagram'

export { linearGeometry } from './board'
export { byOf, describeElement, detailOf } from './describe'
export { layout } from './diagram'
export { type Placement, PlacementSchema, resolvePlacement } from './place'
export {
  agentMayEdit,
  defineTool,
  ELEMENT_BUDGET,
  type ToolCtx,
  type ToolDef,
  ToolError,
  type ToolOutput,
} from './registry'

/** Every tool that needs only the board (the book tools live on the server). */
export const coreTools = [...boardTools, addDiagram]
