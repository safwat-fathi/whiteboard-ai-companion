# In-app chat UI

> Part of [PLAN.md](../PLAN.md) §9 (resolution R2) · Related: [ai-integration](./ai-integration.md) · [board-context](./board-context.md) · [jump-to-ai](./jump-to-ai.md) · [math-renderer](./math-renderer.md) · [api](./api.md)

The student talks to the AI **inside the app**. There is no external client, no copy-paste to another tool. The chat dock sits beside the board and is always aware of it.

## Layout (board page)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│ ‹ Boards   Photosynthesis · Ch. 3 (Biology.pdf)   [Follow AI ○]   $0.42 today │
├────┬──────────────────────────────────────────────┬─────────────────────────┤
│tool│                                              │ Chat │ Activity │ Source │
│bar │              infinite canvas                 │─────────────────────────│
│    │                                              │ messages …              │
│    │     [selection toolbar: Ask AI · …]          │                         │
│    │                                              │ ┌ context chips ───────┐│
│    │                                              │ │ ▣ 3 selected ▢ view  ││
│    │                                              │ └ composer ────────────┘│
└────┴──────────────────────────────────────────────┴─────────────────────────┘
```

- **Dock:** right side, resizable (320–560 px), collapsible, **open by default** on a board. On narrow screens it becomes a bottom sheet.
- **Tabs:** *Chat* · *Activity* (AI batches grouped by turn, [jump-to-ai](./jump-to-ai.md)) · *Source* (cited book page, [library-ingestion](./library-ingestion.md)). Clicking a citation switches to *Source*.
- **Top bar:** board title, scope chip (opens the scope picker), **Follow AI** toggle, today's spend. Routes: `/` boards and library, `/boards/:id` workspace.

## Message list

- User and assistant messages, history loaded from `GET /api/boards/:id/messages` (paged), live via the chat stream.
- **Assistant message parts:**
  - *Text:* Markdown (`react-markdown`, GFM) with LaTeX through `remark-math` + our `renderMath()` ([math-renderer](./math-renderer.md)). `dir="auto"` per message so Arabic and English both read correctly.
  - *Tool chips:* one per board action, e.g. "Added concept map · 12 elements · **Locate**". Click = Locate that batch; secondary action = Undo that batch.
  - *Links with custom schemes:* `[p. 42](cite:<chunkId>)` opens the Source tab on that page; `[the red arrow](board:<elementId>)` runs Locate on the element.
  - *Footer:* model, tokens, cost of the turn (hover for cached tokens).
- **User message** shows its attached context as chips (what was sent): "Selection · 3 elements · picture", and a thumbnail when a picture was attached.

## Composer

- Multi-line textarea (`dir="auto"`); **Enter** sends, **Shift+Enter** newline. **Send** becomes **Stop** while a turn runs.
- **Context chips (R3)** above the input, each removable and each showing what it will send:

  | Chip | Default | Options |
  |---|---|---|
  | **Selection (n)** | On when something is selected | as: structure · picture · both (default both) |
  | **Viewport** | Off | picture |
  | **Whole board** | Off | as: structure · picture · both |

  Details and the exact payloads: [board-context](./board-context.md). A **"What the AI sees"** link opens a preview with the exact digest text, thumbnails and a token estimate.
- **Quick actions** (prefill the input, no new backend): *Explain on the board* · *Summarise this chapter* · *Check my work* (needs a selection) · *Ask*. They set the turn `mode`.
- **Attach images:** paste or drop an image into the composer to include it as an image part (uploaded via `POST /api/blobs`).
- **Entry from the board:** the selection toolbar's **Ask AI** and the right-click menu focus the composer with the Selection chip attached. No keyboard shortcut is assigned until M5 (browser-reserved combos such as Ctrl+L are avoided).

## States

| State | UI |
|---|---|
| Idle | Composer enabled |
| Streaming | Text appears incrementally; **Stop** shown; chips appear as batches land; top bar shows "Jump to AI" |
| Tool running | Chip with spinner; AI cursor and status line on the board |
| Stopped / error | Partial message kept; inline notice; *Undo this response* offered when batches were applied |
| `turn_busy` | "The AI is still working on this board" with Stop |
| Budget exceeded | Notice naming the cap, a link to settings, composer disabled for daily cap |
| Disconnected | Banner "Reconnecting…"; sending is disabled until the WebSocket rejoins |

After each finished turn: **Undo this response** (reverts every batch of the turn, newest first, skipping conflicts) and the turn's cost.

## Transport

`useChat` with `DefaultChatTransport({ api: '/api/chat' })`. The default request sends the whole message array; the server owns history, so customise the transport to send only the new message plus the context descriptor (`prepareSendMessagesRequest` pattern, **verify in M5**). Server response: AI SDK UI message stream (SSE) plus custom `data-batch` and `data-usage` parts ([api](./api.md)). `stop()` aborts the fetch; the server aborts the model call.

## Accessibility and i18n

- The message list is a log region; streaming text updates are throttled into `aria-live="polite"` announcements. Focus returns to the composer after a send.
- Chips and quick actions are real buttons; Locate buttons have text labels; reduced-motion disables the camera animation and pulses ([jump-to-ai](./jump-to-ai.md)).
- UI strings are English in v1 with CSS logical properties so an Arabic UI is a translation task, not a layout rewrite. Message content is any language.

## Not in v1

Voice input, message editing/branching, multiple threads per board (one thread per board), sharing a chat, streaming reasoning traces.

## Tests

Playwright with `TUTOR_STUB=1`: send → text streams → chips appear → Locate works; Stop mid-stream; budget message; paste image; context chips change the request descriptor (asserted at the API boundary); reload restores history.
