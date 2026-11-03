# Whiteboard as AI context

> Part of [PLAN.md](../PLAN.md) §10 (resolution R3) · Related: [chat-ui](./chat-ui.md) · [ai-integration](./ai-integration.md) · [rag-context-engineering](./rag-context-engineering.md) · [whiteboard-engine](./whiteboard-engine.md) · [api](./api.md)

**R3:** the whiteboard is the AI's context, and a selected portion of it (or the viewport, or the whole board) can be passed to the AI in chat. The student always sees what is being sent.

## The contract: what the AI gets each turn

| Layer | When | Content | Typical size |
|---|---|---|---|
| **Board digest** | Always | Header, counts, viewport, selection ids, a budgeted element list | ≤ 3k tokens |
| **Selection detail** | Selection chip on (default when something is selected) | Full data of the selected elements (freehand points replaced by a count) | ≤ 4k tokens |
| **Pictures** | Per chip | PNG of the selection, the viewport and/or the whole board | ~1–2k tokens each |
| **Pull on demand** | During the turn | `get_elements(filter)`, `get_snapshot(region)` | per call |

Nothing else leaves the machine from the board: not other boards, not book text beyond retrieval ([rag-context-engineering](./rag-context-engineering.md)), never the API key.

## Context chips

| Chip | Default | "As" | What is sent |
|---|---|---|---|
| **Selection (n)** | On when n > 0 | structure · picture · **both** (default) | Element data + PNG of the selection's padded bounds |
| **Viewport** | Off | picture | PNG of exactly what the student sees |
| **Whole board** | Off | structure · picture · both | Full digest up to the budget / PNG of the content bounds fitted to 1600 px |

- **Auto-picture rule (as built, M6; PLAN §19 #57):** if the **selection** holds handwriting (a freehand element) and the chip says `structure`, the picture is forced: the composer shows "structure + picture" with "(auto)" beside it and the descriptor says `both`. `picture`, `both` and a text-only selection behave as the student set them. **A viewport that contains ink does not attach a picture by itself:** the Viewport chip stays an explicit opt-in (cost and surprise on a handwritten board). Groups are not built, so only a freehand element in the selection itself counts. All candidate models accept images ([ai-integration](./ai-integration.md)).
- With **nothing selected and no chips**, the turn still carries the digest, so "explain what I have here" works without any attachment.
- Entry points: the selection toolbar's **Ask AI**, the right-click menu, or simply typing in the dock while a selection exists.

## Digest format

Plain text inside `<board_state>` tags, declared untrusted data in the system prompt:

```
BOARD "Photosynthesis" · seq 1234 · 87 elements (text 31, shape 22, math 9, image 3, chart 1, freehand 21)
CONTENT [x y w h]   VIEWPORT [x y w h] zoom 0.8   SELECTION el_12 el_13 el_40
id    | type  | x,y,w,h            | by        | detail
el_12 | text  | 120,80,300,40      | you       | "Light reactions"
el_13 | math  | 120,140,220,60     | AI t_8    | \int_0^\infty e^{-x}dx
el_40 | image | 600,80,320,240     | AI t_8    | book p.42 "Chloroplast structure"
…
(+57 more not shown. Use get_elements with a region or type.)
```

- **Order:** selection first, then elements in the viewport, then the rest by most recently changed. **Cap:** 200 rows or ~3k tokens, whichever comes first, with the "+N more" footer and the per-type counts so the AI knows what exists.
- **Detail per type:** text (≤ 80 chars), math (LaTeX ≤ 80 chars), shape (kind + label), chart (kind + title), image (alt/caption or `book p.N`), freehand (`stroke, n pts`), group (name + child count).
- **`by`:** `you` or `AI <turnId>`, so the tutor can tell its own work from the student's.

## Pictures

- **Rendered in the browser** with the core `render()` into an offscreen canvas, scene only (no selection handles or overlays), white background. No server round trip, and no dependency on server-side Arabic shaping for these.
- Sizes: longest side ≤ 1600 px; selection crop padded by 24 world units; whole board fitted (small text may be unreadable, which the descriptor notes). Several far-apart selected elements produce one crop of their union in v1; per-cluster crops (up to 4) are a v1.1 refinement.
- Uploaded with `POST /api/blobs`, referenced by blob id in the chat request, and stored with the user message. Old pictures are **not** re-sent on later turns; they are replaced by a one-line note ("picture of selection el_12–el_14").

## Edit rights follow the selection

Selected element ids are sent as `selection`. For that turn only, the Board service lets the tutor patch or delete those human-authored elements (`grantedIds`); everything else human-authored stays read-only to it ([ai-integration](./ai-integration.md)). The Selection chip's tooltip says so: "The AI may edit these".

## Consistency and staleness

1. The client waits until its pending ops are acknowledged, then sends `boardSeq`.
2. The server builds the digest from its authoritative scene at turn start and tells the model `board_seq`.
3. During the turn tools read the **live** scene, so a student edit mid-turn is visible to `get_elements`. Writes are field-level patches, so they still apply.
4. The student's selection at send time is the grant; changing selection mid-turn does not alter it.

## Transparency: "What the AI sees"

A link in the composer opens a preview of the exact digest text, the picture thumbnails, and a token estimate (`POST /api/boards/:id/context-preview`). The sent context is saved on the user message (`messages.context`: selection ids, attach modes, picture blob ids, digest text), so any past turn can be inspected and the chips can be redrawn in history.

## Large boards

Digest truncation plus per-type counts keeps the prompt flat. The AI drills down with `get_elements {region | type | author | text}`; "regions" summaries (grid cells with counts and first text) are a v1.1 option if drill-down proves clumsy.

## Descriptor (client → server)

```json
{
  "boardId": "…", "boardSeq": 1234, "mode": "ask|explain|summarize|check",
  "viewport": { "x": 0, "y": 0, "w": 1280, "h": 800, "zoom": 0.8 },
  "selection": ["el_12", "el_13"],
  "attach": { "selection": "both", "viewport": "none", "board": "none" },
  "pictures": [ { "blobId": "…", "of": "selection", "rect": { "x": 96, "y": 56, "w": 340, "h": 188 } } ]
}
```

Wire details live in [api](./api.md).

## Tests

- Selecting 3 elements and sending builds a request whose descriptor matches the chips (API-boundary assertion).
- The digest ordering, cap and footer are unit-tested on a 500-element fixture.
- Handwriting selection auto-attaches a picture; a text-only selection does not.
- A tutor patch to an unselected human element is rejected; to a selected one succeeds.
- "What the AI sees" equals the text actually sent (compared in the stub tutor's recorded request).
