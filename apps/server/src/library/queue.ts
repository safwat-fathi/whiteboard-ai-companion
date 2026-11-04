/**
 * An in-process queue that runs one job at a time (library-ingestion.md "Jobs"; no Redis, no BullMQ). A job is a book id;
 * a book already waiting or running is not queued twice. A failing job is reported to `onError` and the next one runs;
 * `onDone` fires after every job, failed or not (the server drops that book's vector cache there).
 */
export function createQueue(
  run: (id: string) => Promise<void>,
  o: {
    onError?: (id: string, error: unknown) => void
    /** Called first for every failed job, however it died (a worker crash leaves the book mid-job): mark it failed here. */
    onFail?: (id: string, error: unknown) => void
    onDone?: (id: string) => void
  } = {},
) {
  const waiting: string[] = []
  let current: string | null = null
  let pump: Promise<void> | null = null

  async function loop() {
    while (waiting.length > 0) {
      const id = waiting.shift() as string
      current = id
      try {
        await run(id)
      } catch (e) {
        o.onFail?.(id, e)
        o.onError?.(id, e)
      }
      current = null
      o.onDone?.(id)
    }
    pump = null
  }

  return {
    /** False when the book is already waiting or running. */
    enqueue(id: string): boolean {
      if (id === current || waiting.includes(id)) return false
      waiting.push(id)
      pump ??= loop()
      return true
    },
    size: (): number => waiting.length + (current === null ? 0 : 1),
    /** Resolves once everything queued so far has finished (at once when nothing is queued). */
    whenIdle: (): Promise<void> => pump ?? Promise.resolve(),
  }
}
