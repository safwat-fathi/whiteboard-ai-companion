# Jump to AI work

> Part of [PLAN.md](../PLAN.md) §13 · Related: [chat-ui](./chat-ui.md) · [ai-integration](./ai-integration.md) · [whiteboard-engine](./whiteboard-engine.md) · [database](./database.md) · [api](./api.md)

**Requirement:** when the AI works on the whiteboard, the student can relocate to where it is happening *or did happen*.

## Data (what makes "did happen" possible)

Every agent batch is stored with `turn_id`, `label`, `bounds` (server-computed union of affected elements' bounds: after-apply for add/patch, before-remove for remove) and `touched_ids`. This metadata is kept forever; v1 also keeps op payloads, so history never expires ([database](./database.md)). The doc's 30-day retention is dropped (finding F7).

## Triggers

| Trigger | Result |
|---|---|
| Click a tool-call chip in chat, a row in the Activity tab, or a `board:` link in AI text | **Locate** the batch / turn / element |
| Hover an AI-authored element | Tag "AI · <turn label>" with **Show in chat** (scrolls the Chat tab to that turn) |
| A batch lands off-screen while Follow is off | Edge arrow + toast "AI is working here · Jump" |
| **Follow AI** on | The camera eases to each new batch (≥ 600 ms apart) |
| "Jump to AI" button (pinned in the chat header while a turn runs) | Locate the latest batch |
| After any jump | **↩ Back** chip restores the previous camera (stack of 5) |
| Open a deep link | `/boards/<id>?turn=<turnId>`, `?batch=<batchId>` or `?el=<elementId>` locates after load |

## Locate algorithm

1. `target` = union of the **current** bounds of the batch's `touched_ids` that still exist. If the student moved an element, Locate follows it.
2. If none survive, use the stored `bounds` and draw a dashed **ghost frame** labelled "removed".
3. `flyTo(target, { padding: 64 px, maxZoom: 2, ≈ 400 ms ease })`, then **pulse** the surviving elements for ~1.2 s on the overlay canvas.
4. Push the previous camera onto the history stack and show **↩ Back**.
5. `prefers-reduced-motion`: jump instantly, no pulse.

For a turn, `target` is the union over its batches; the Activity row for the turn offers *Locate turn*, each batch row *Locate*.

## Follow AI

Default **off** (the camera moving unasked is an anti-goal). A top-bar toggle.

| State | Behaviour |
|---|---|
| Off | `agent_focus` events only drive the edge indicator and the "Jump to AI" button |
| On | On `agent_focus`, if ≥ 600 ms since the last move, `flyTo` the batch bounds, keeping the current zoom unless the target does not fit the viewport |
| Auto-off | Any wheel, pan, zoom or pointer-down on the canvas turns Follow off and shows a toast "Follow AI off (you moved the canvas)" |

## Off-screen indicator

When the target rect is entirely outside the viewport and Follow is off: an arrow on the viewport edge (inset 16 px) pointing from the viewport centre toward the target centre, labelled "AI · n new". Click = Locate. It disappears when the target enters the viewport or the turn ends.

## AI presence

An "AI" cursor moves to each batch's centre with a status line ("drawing…", "reading page 42…") driven by `agent_focus` / `agent_status` ([api](./api.md)). No human cursors exist in v1 (single user).

## Undo

- Activity tab rows have **Undo** per batch.
- Chat has **Undo this response** per turn: the turn's inverse batches, newest first, skipping conflicts as the doc defines and reporting how many were skipped. Server-side `undo` message ([api](./api.md)).

## Activity tab

`GET /api/boards/:id/activity?before=&limit=` returns turns: `{turnId, startedAt, userText (first 80 chars), status, bounds, batches:[{batchId, seq, label, bounds, count}]}`. Live updates come from the WebSocket `ops` broadcast, which carries `turnId`, `label` and `bounds`, so the tab updates without polling.

## Accessibility

Locate controls are real buttons with text; toasts use `aria-live="polite"`; the edge indicator is focusable and keyboard-activatable; reduced-motion is honoured; the Follow toggle announces its state.

## Edge cases

- **Huge bounds** (a turn that laid out thousands of px): zoom clamps at 0.05; the Locate still lands on the union.
- **Element deleted by the student after the turn:** ghost frame at stored bounds.
- **Board edited by two tabs:** `bounds` come from the server, so both tabs locate the same area.
- **Two quick batches:** Follow debounces; the off-screen indicator counts them.
- **Reload mid-turn:** the Activity tab and chips rebuild from the DB; the live turn continues server-side only if the SSE client stays connected, otherwise it is aborted and its batches stay.

## Tests (Playwright, `TUTOR_STUB=1`)

- Follow off, far-away batch: edge indicator appears, Jump lands on it.
- Follow on: camera follows; a manual pan cancels it.
- Past: reload, click an old turn, lands on its elements. Delete them, click again: ghost frame at stored bounds. Move one: Locate goes to its new position.
- Hover tag → Show in chat scrolls to the right turn; deep links land correctly after reload.
- Undo this response removes all batches of the turn.
