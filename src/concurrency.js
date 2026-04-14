/**
 * Minimal bounded-concurrency map. Zero deps, tiny surface.
 *
 * pMap(items, fn, { concurrency, stopOnError }) → Promise<Array<{item, ok, value?, error?}>>
 *
 * - Preserves input order in the result.
 * - Never throws; each element resolves independently into {ok, value|error}.
 *   (Opt in to fail-fast via stopOnError:true → rejects on first error.)
 */

export async function pMap(items, fn, { concurrency = 5, stopOnError = false } = {}) {
  const n = items.length;
  const results = new Array(n);
  let cursor = 0;
  let aborted = false;
  let firstError = null;

  async function worker() {
    while (!aborted) {
      const i = cursor++;
      if (i >= n) return;
      const item = items[i];
      try {
        const value = await fn(item, i);
        results[i] = { item, ok: true, value };
      } catch (error) {
        results[i] = { item, ok: false, error };
        if (stopOnError && !aborted) {
          aborted = true;
          firstError = error;
        }
      }
    }
  }

  const workers = [];
  const c = Math.max(1, Math.min(concurrency, n || 1));
  for (let i = 0; i < c; i++) workers.push(worker());
  await Promise.all(workers);

  if (stopOnError && firstError) throw firstError;
  // Fill any skipped slots (when stopOnError aborts mid-run)
  for (let i = 0; i < n; i++) {
    if (!results[i]) results[i] = { item: items[i], ok: false, error: new Error('skipped') };
  }
  return results;
}
