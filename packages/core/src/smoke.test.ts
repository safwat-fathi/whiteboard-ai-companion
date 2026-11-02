import { expect, it } from 'vitest'

it('main resolves', async () => {
  await expect(import('./main')).resolves.toBeDefined()
})
