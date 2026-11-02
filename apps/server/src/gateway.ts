import type http from 'node:http'
import type { Duplex } from 'node:stream'
import { type WebSocket, WebSocketServer } from 'ws'
import { z } from 'zod'
import type { Author, BoardService, Broadcast } from './board-service'
import type { Config } from './config'
import { ApiError } from './errors'
import { checkHost } from './http'

const MAX_MESSAGE_BYTES = 1024 * 1024 // 1 MB; a bigger frame closes the socket with 1009
const OWNER: Author = { kind: 'human', id: 'owner' } // the author of everything that arrives on a socket (never the client's claim)

const ClientMessage = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('join'),
    boardId: z.string(),
    fromSeq: z.number().int().min(0),
  }),
  z.object({
    type: z.literal('ops'),
    clientSeq: z.number().int().min(0),
    batch: z.unknown(),
  }),
])

const opsMessage = (b: Broadcast) => ({
  type: 'ops' as const,
  seq: b.seq,
  batch: b.batch,
  author: b.author,
  ...(b.turnId === undefined ? {} : { turnId: b.turnId }),
  bounds: b.bounds,
})

function refuse(socket: Duplex, status: number, text: string) {
  socket.write(
    `HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  )
  socket.destroy()
}

function reasonOf(e: unknown) {
  if (e instanceof ApiError)
    return { code: e.code, message: e.message, details: e.details }
  console.error(
    'gateway error:',
    e instanceof Error ? `${e.name}: ${e.message}` : String(e),
  )
  return { code: 'internal_error', message: 'internal error' }
}

/**
 * The board WebSocket (`/ws?boardId=`). The handshake needs the exact Origin (plan R3) and an allowed Host; an unknown
 * board opens then closes 4404; a protocol error closes 4400. After `join` the socket gets `sync`, then `ack`/`reject`
 * for its own `ops` and `ops` broadcasts of everyone else's batches (never an echo of its own).
 */
export function attachGateway(
  server: http.Server,
  deps: { boards: BoardService; config: Config; pingMs?: number },
): { close(): Promise<void>; clients(): number } {
  const { boards, config } = deps
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_MESSAGE_BYTES,
  })
  const alive = new WeakMap<WebSocket, boolean>()
  let sender: WebSocket | null = null // the socket whose batch is being broadcast right now (submit is synchronous)

  server.on('upgrade', (req, socket, head) => {
    if (!checkHost(req.headers.host, config))
      return refuse(socket, 403, 'Forbidden')
    if (req.headers.origin !== config.publicOrigin)
      return refuse(socket, 403, 'Forbidden')
    let url: URL
    try {
      url = new URL(req.url ?? '/', 'http://localhost')
    } catch {
      return refuse(socket, 400, 'Bad Request') // an unparsable target must not throw out of an event listener
    }
    if (url.pathname !== '/ws') return refuse(socket, 404, 'Not Found')
    wss.handleUpgrade(req, socket, head, (ws) =>
      connection(ws, url.searchParams.get('boardId')),
    )
  })

  function connection(ws: WebSocket, boardId: string | null) {
    ws.on('error', () => {}) // ws emits 'error' for oversize or malformed frames and then 'close'
    if (!boardId || !boards.getBoard(boardId))
      return ws.close(4404, 'unknown board')
    alive.set(ws, true)
    ws.on('pong', () => alive.set(ws, true))
    let unsubscribe: (() => void) | undefined
    ws.on('close', () => unsubscribe?.())
    const send = (m: unknown) => {
      if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m))
    }

    ws.on('message', (data, isBinary) => {
      if (isBinary) return ws.close(4400, 'text frames only')
      let msg: z.infer<typeof ClientMessage>
      try {
        msg = ClientMessage.parse(JSON.parse(data.toString()))
      } catch {
        return ws.close(4400, 'bad message')
      }
      if (msg.type === 'join') {
        if (msg.boardId !== boardId || unsubscribe)
          return ws.close(4400, 'bad join')
        try {
          const res = boards.join(boardId, msg.fromSeq)
          unsubscribe = boards.subscribe(boardId, (b) => {
            if (sender !== ws) send(opsMessage(b))
          })
          send({ type: 'sync', ...res })
        } catch {
          ws.close(4404, 'unknown board') // deleted since the upgrade
        }
        return
      }
      if (!unsubscribe) return ws.close(4400, 'join first')
      sender = ws
      try {
        const r = boards.submit(boardId, msg.batch, OWNER)
        send({ type: 'ack', clientSeq: msg.clientSeq, seq: r.seq })
      } catch (e) {
        send({ type: 'reject', clientSeq: msg.clientSeq, reason: reasonOf(e) })
      } finally {
        sender = null
      }
    })
  }

  // A proxy drops idle sockets and a vanished client never sends close: ping, and terminate what does not answer.
  const timer = setInterval(() => {
    for (const ws of wss.clients) {
      if (alive.get(ws) === false) {
        ws.terminate()
        continue
      }
      alive.set(ws, false)
      ws.ping()
    }
  }, deps.pingMs ?? 30_000)
  timer.unref()

  return {
    clients: () => wss.clients.size,
    async close() {
      clearInterval(timer)
      for (const ws of wss.clients) {
        ws.close(1001, 'server shutting down')
        setTimeout(() => ws.terminate(), 1_000).unref()
      }
      await new Promise<void>((r) => wss.close(() => r()))
    },
  }
}
