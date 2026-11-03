import type { Config } from '../config'
import type { BooksDb } from '../db'
import type { Providers } from './providers'
import {
  type SearchOptions,
  type SearchResult,
  search,
  type VectorCache,
} from './search'

/**
 * Hybrid search with the query embedded by the configured provider; an embedding that costs money lands in the `spend`
 * ledger. Shared by the REST route and the tutor's `search_book`, so both behave (and bill) the same way.
 */
export function createSearcher(o: {
  books: BooksDb
  cache: VectorCache
  providers: Pick<Providers, 'embed'>
  config: Pick<Config, 'embedModel'>
  now?: () => number
}): (opts: SearchOptions) => Promise<SearchResult> {
  const now = o.now ?? Date.now
  return (opts) =>
    search(
      {
        books: o.books,
        cache: o.cache,
        embedModel: o.config.embedModel,
        embed: async (q) => {
          const r = await o.providers.embed([q])
          if (r.costUsd > 0)
            o.books.addSpend({
              at: now(),
              kind: 'embed',
              ref: null,
              costUsd: r.costUsd,
            })
          return r.vectors[0] as Float32Array
        },
      },
      opts,
    )
}
