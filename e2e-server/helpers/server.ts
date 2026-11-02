import { type ChildProcess, spawn } from 'node:child_process'
import { resolve } from 'node:path'

export type RunningServer = {
  stop(): Promise<void>
}

export async function startServer(o: {
  dataDir: string
  port?: number
  publicOrigin?: string
}): Promise<RunningServer> {
  const port = o.port ?? 4201
  const publicOrigin = o.publicOrigin ?? 'http://localhost:3201'
  const root = process.cwd()
  const mainTs = resolve(root, 'apps/server/src/main.ts')

  const child: ChildProcess = spawn(
    'pnpm',
    ['--filter', '@whiteboard/server', 'exec', 'tsx', mainTs],
    {
      cwd: root,
      env: {
        ...process.env,
        PORT: String(port),
        HOST: '127.0.0.1',
        DATA_DIR: o.dataDir,
        PUBLIC_ORIGIN: publicOrigin,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )

  let exited = false
  child.on('exit', () => {
    exited = true
  })

  // Poll /api/health until it responds 200
  const url = `http://127.0.0.1:${port}/api/health`
  const t0 = Date.now()
  let ok = false
  while (Date.now() - t0 < 15_000) {
    if (exited) {
      throw new Error(
        `Server process exited prematurely with code ${child.exitCode}`,
      )
    }
    try {
      const res = await fetch(url)
      if (res.ok) {
        ok = true
        break
      }
    } catch {
      // wait a bit
    }
    await new Promise((r) => setTimeout(r, 100))
  }

  if (!ok) {
    child.kill('SIGTERM')
    throw new Error(`Timed out waiting for server on ${url}`)
  }

  return {
    async stop() {
      if (exited) return
      child.kill('SIGTERM')
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          child.kill('SIGKILL')
          resolve()
        }, 5000)
        child.on('exit', () => {
          clearTimeout(timeout)
          resolve()
        })
      })
    },
  }
}
