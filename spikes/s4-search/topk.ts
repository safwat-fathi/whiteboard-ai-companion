// Exact brute-force top-k by dot product. `vectors` is row-major (n rows of `dims`, unit length),
// so dot product = cosine. Result is descending by score; ties keep the lower index first.
// dims must be a multiple of 4 (every embedding size in use is; a scalar tail loop cost ~15% here).
export function topK(vectors: Float32Array, dims: number, query: Float32Array, k: number): { i: number; score: number }[] {
  if (dims % 4 !== 0) throw new Error(`dims ${dims} is not a multiple of 4`);
  if (k <= 0) return [];
  const n = Math.floor(vectors.length / dims);
  const ids = new Int32Array(k);
  const scores = new Float64Array(k); // kept sorted descending; k is small, so insertion beats a heap
  let size = 0;
  for (let i = 0, base = 0; i < n; i++, base += dims) {
    // four independent accumulators let the CPU overlap the multiply-adds
    let a = 0, b = 0, c = 0, d = 0;
    for (let j = 0; j < dims; j += 4) {
      a += vectors[base + j] * query[j];
      b += vectors[base + j + 1] * query[j + 1];
      c += vectors[base + j + 2] * query[j + 2];
      d += vectors[base + j + 3] * query[j + 3];
    }
    const s = a + b + c + d;
    if (size === k && s <= scores[k - 1]) continue;
    let p = size < k ? size++ : k - 1;
    while (p > 0 && scores[p - 1] < s) {
      scores[p] = scores[p - 1];
      ids[p] = ids[p - 1];
      p--;
    }
    scores[p] = s;
    ids[p] = i;
  }
  return Array.from({ length: size }, (_, r) => ({ i: ids[r], score: scores[r] }));
}
