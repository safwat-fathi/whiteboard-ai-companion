import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { createBlobsDb, openDatabase } from './index'

it('removes a blob row, and reports whether there was one', () => {
  const root = mkdtempSync(join(tmpdir(), 'wb-blobsdb-'))
  const db = openDatabase({ dataDir: join(root, 'data') })
  try {
    const blobs = createBlobsDb(db)
    blobs.insert({
      id: 'a'.repeat(64),
      mime: 'application/pdf',
      bytes: 3,
      createdAt: 1,
    })
    expect(blobs.remove('a'.repeat(64))).toBe(true)
    expect(blobs.get('a'.repeat(64))).toBeUndefined()
    expect(blobs.remove('a'.repeat(64))).toBe(false)
  } finally {
    db.close()
    rmSync(root, { recursive: true, force: true })
  }
})
