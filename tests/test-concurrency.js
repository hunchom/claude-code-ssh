#!/usr/bin/env node
/** Tests for src/concurrency.js */
import assert from 'assert';
import { pMap } from '../src/concurrency.js';

let passed = 0, failed = 0; const fails = [];
async function test(name, fn) {
  try { await fn(); passed++; console.log(`✅ ${name}`); }
  catch (e) { failed++; fails.push({ name, err: e }); console.error(`❌ ${name}: ${e.message}`); }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

console.log('🧪 Testing concurrency\n');

await test('pMap: empty input returns empty array', async () => {
  const r = await pMap([], async x => x);
  assert.deepStrictEqual(r, []);
});

await test('pMap: preserves input order', async () => {
  const r = await pMap([3, 1, 2], async x => { await sleep(x * 5); return x * 10; });
  assert.deepStrictEqual(r.map(x => x.value), [30, 10, 20]);
});

await test('pMap: limits parallelism to `concurrency`', async () => {
  let inFlight = 0, peak = 0;
  await pMap([1, 2, 3, 4, 5, 6, 7, 8], async () => {
    inFlight++; peak = Math.max(peak, inFlight);
    await sleep(10);
    inFlight--;
  }, { concurrency: 3 });
  assert(peak <= 3, `peak=${peak}, expected ≤3`);
});

await test('pMap: individual failures captured per-item by default', async () => {
  const r = await pMap([1, 2, 3], async x => {
    if (x === 2) throw new Error(`bad ${x}`);
    return x;
  });
  assert.strictEqual(r[0].ok, true);  assert.strictEqual(r[0].value, 1);
  assert.strictEqual(r[1].ok, false); assert.strictEqual(r[1].error.message, 'bad 2');
  assert.strictEqual(r[2].ok, true);  assert.strictEqual(r[2].value, 3);
});

await test('pMap: stopOnError:true rejects on first error', async () => {
  await assert.rejects(
    () => pMap([1, 2, 3], async x => { if (x === 2) throw new Error('halt'); return x; },
      { concurrency: 1, stopOnError: true }),
    /halt/,
  );
});

await test('pMap: concurrency=1 serializes', async () => {
  const order = [];
  await pMap([1, 2, 3], async x => { order.push(`start-${x}`); await sleep(5); order.push(`end-${x}`); },
    { concurrency: 1 });
  assert.deepStrictEqual(order, ['start-1','end-1','start-2','end-2','start-3','end-3']);
});

await test('pMap: concurrency > items still works', async () => {
  const r = await pMap([1, 2], async x => x * 2, { concurrency: 10 });
  assert.deepStrictEqual(r.map(x => x.value), [2, 4]);
});

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) { for (const f of fails) console.error(`  ✗ ${f.name}\n    ${f.err.stack}`); process.exit(1); }
