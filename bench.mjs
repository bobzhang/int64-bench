import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

// ═════════════════════════════════════════════════════════════
// Approach 1: class Int64 with two int32 fields
// Mul/div implemented via 16-bit chunk decomposition (Long.js style)
// ═════════════════════════════════════════════════════════════
class Int64 {
  constructor(hi, lo) {
    this.hi = hi | 0;
    this.lo = lo >>> 0;
  }

  static fromBigInt(b) {
    const lo = Number(BigInt.asUintN(32, b)) >>> 0;
    const hi = Number(BigInt.asIntN(32, b >> 32n)) | 0;
    return new Int64(hi, lo);
  }

  toBigInt() {
    return BigInt.asIntN(64, (BigInt(this.hi) << 32n) | BigInt(this.lo >>> 0));
  }

  isZero() {
    return this.hi === 0 && this.lo === 0;
  }

  isNeg() {
    return this.hi < 0;
  }

  negate() {
    const lo = (~this.lo + 1) >>> 0;
    const hi = (~this.hi + (lo === 0 ? 1 : 0)) | 0;
    return new Int64(hi, lo);
  }

  // Multiplication: split into 16-bit pieces to stay within safe integer range.
  // Each column accumulates products + carry, then extracts lower 16 bits.
  // Max column sum: 4 products (each ≤ 0xFFFE0001) + carry (≤ ~17 bits) ≈ 17B, safe in f64.
  mul(other) {
    const a0 = this.lo & 0xFFFF;
    const a1 = this.lo >>> 16;
    const a2 = this.hi & 0xFFFF;
    const a3 = this.hi >>> 16;
    const b0 = other.lo & 0xFFFF;
    const b1 = other.lo >>> 16;
    const b2 = other.hi & 0xFFFF;
    const b3 = other.hi >>> 16;

    // Column 0: bits [0..15]
    let t = a0 * b0;
    const r0 = t & 0xFFFF;
    t = (t - r0) / 65536;  // carry (exact integer division, avoids >>> 16 sign issues on large values)

    // Column 1: bits [16..31]
    t += a0 * b1 + a1 * b0;
    const r1 = t & 0xFFFF;
    t = (t - r1) / 65536;

    // Column 2: bits [32..47]
    t += a0 * b2 + a1 * b1 + a2 * b0;
    const r2 = t & 0xFFFF;
    t = (t - r2) / 65536;

    // Column 3: bits [48..63]
    t += a0 * b3 + a1 * b2 + a2 * b1 + a3 * b0;
    const r3 = t & 0xFFFF;

    const lo = ((r1 << 16) | r0) >>> 0;
    const hi = ((r3 << 16) | r2) | 0;
    return new Int64(hi, lo);
  }

  // Unsigned comparison: -1 if this < other, 0 if equal, 1 if this > other
  static ucmp(a, b) {
    const ahi = a.hi >>> 0, bhi = b.hi >>> 0;
    if (ahi !== bhi) return ahi < bhi ? -1 : 1;
    if (a.lo !== b.lo) return a.lo < b.lo ? -1 : 1;
    return 0;
  }

  // Count leading zeros
  static clz(v) {
    let hi = v.hi >>> 0;
    if (hi !== 0) return Math.clz32(hi);
    return 32 + Math.clz32(v.lo);
  }

  // Unsigned left shift (amount 0..63)
  shl(n) {
    if (n === 0) return this;
    if (n >= 64) return new Int64(0, 0);
    if (n >= 32) {
      return new Int64((this.lo << (n - 32)) | 0, 0);
    }
    const hi = ((this.hi << n) | (this.lo >>> (32 - n))) | 0;
    const lo = (this.lo << n) >>> 0;
    return new Int64(hi, lo);
  }

  // Unsigned right shift (amount 0..63)
  shru(n) {
    if (n === 0) return this;
    if (n >= 64) return new Int64(0, 0);
    if (n >= 32) {
      return new Int64(0, (this.hi >>> (n - 32)) >>> 0);
    }
    const lo = ((this.lo >>> n) | (this.hi << (32 - n))) >>> 0;
    const hi = (this.hi >>> n) >>> 0;
    return new Int64(hi | 0, lo);
  }

  add(other) {
    const lo = (this.lo + other.lo) >>> 0;
    const carry = (lo < this.lo) ? 1 : 0;
    const hi = (this.hi + other.hi + carry) | 0;
    return new Int64(hi, lo);
  }

  sub(other) {
    const lo = (this.lo - other.lo) >>> 0;
    const borrow = (this.lo < other.lo) ? 1 : 0;
    const hi = (this.hi - other.hi - borrow) | 0;
    return new Int64(hi, lo);
  }

  // Unsigned division via binary long division
  static udiv(num, den) {
    if (den.isZero()) throw new RangeError('Division by zero');
    if (num.isZero()) return [new Int64(0, 0), new Int64(0, 0)];

    // Fast path: both fit in 32 bits
    if (num.hi === 0 && den.hi === 0) {
      const q = (num.lo / den.lo) >>> 0;
      const r = (num.lo - q * den.lo) >>> 0;
      return [new Int64(0, q), new Int64(0, r)];
    }

    const shift = Int64.clz(den) - Int64.clz(num);
    if (shift < 0) return [new Int64(0, 0), num]; // num < den

    let rem = num;
    let d = den.shl(shift);
    let quot = new Int64(0, 0);

    for (let i = shift; i >= 0; i--) {
      quot = quot.shl(1);
      if (Int64.ucmp(rem, d) >= 0) {
        rem = rem.sub(d);
        quot = new Int64(quot.hi, quot.lo | 1);
      }
      d = d.shru(1);
    }

    return [quot, rem];
  }

  // Signed division (truncates toward zero, like C/WASM i64.div_s)
  div(other) {
    const aNeg = this.isNeg();
    const bNeg = other.isNeg();
    const a = aNeg ? this.negate() : this;
    const b = bNeg ? other.negate() : other;
    let [q] = Int64.udiv(a, b);
    if (aNeg !== bNeg) q = q.negate();
    return q;
  }

  // Signed remainder
  rem(other) {
    const aNeg = this.isNeg();
    const a = aNeg ? this.negate() : this;
    const b = other.isNeg() ? other.negate() : other;
    let [, r] = Int64.udiv(a, b);
    if (aNeg) r = r.negate();
    return r;
  }
}

const ZERO = new Int64(0, 0);
const ONE = new Int64(0, 1);

// ═════════════════════════════════════════════════════════════
// Approach 2: Pure BigInt with BigInt.asIntN
// ═════════════════════════════════════════════════════════════
function bigintMul(a, b) {
  return BigInt.asIntN(64, a * b);
}

function bigintDiv(a, b) {
  return BigInt.asIntN(64, a / b);
}

function bigintRem(a, b) {
  return BigInt.asIntN(64, a % b);
}

// ═════════════════════════════════════════════════════════════
// Approach 3: WASM with native i64
// ═════════════════════════════════════════════════════════════
const wasmBytes = readFileSync(new URL('./encode-wasm.wasm', import.meta.url));
const wasmModule = new WebAssembly.Module(wasmBytes);
const wasmInstance = new WebAssembly.Instance(wasmModule, {});
const {
  mul_i64, div_s_i64, div_u_i64, rem_s_i64,
  add_i64, sub_i64,
  mul_i64_batch, div_s_i64_batch, add_i64_batch, memory
} = wasmInstance.exports;
const wasmDV = new DataView(memory.buffer);

// ═════════════════════════════════════════════════════════════
// Correctness verification
// ═════════════════════════════════════════════════════════════
function verify() {
  console.log('=== Correctness Verification ===\n');

  const cases = [
    [7n, 3n],
    [0n, 12345n],
    [1n, 1n],
    [-1n, 1n],
    [100n, -7n],
    [-100n, -7n],
    [0x7FFFFFFFFFFFFFFFn, 2n],              // max_i64 / 2
    [-0x8000000000000000n, -1n],            // min_i64 / -1 = overflow → skip div
    [0x123456789ABCDEFn, 0xFEDCBA98n],
    [0x100000000n, 0x100000000n],           // 2^32 * 2^32 = 2^64 → wraps to 0
    [-0x123456789ABCDEFn, 0x1234n],
    [0x7FFFFFFFFFFFFFFFn, 0x7FFFFFFFFFFFFFFFn], // max * max
    [12345678901234n, 9876543210n],
  ];

  let pass = 0, fail = 0;

  for (const [a, b] of cases) {
    const ai = Int64.fromBigInt(a);
    const bi = Int64.fromBigInt(b);

    // -- Addition --
    const refAdd = BigInt.asIntN(64, a + b);
    const gotAdd64 = ai.add(bi).toBigInt();
    const gotAddBI = BigInt.asIntN(64, a + b);
    const gotAddW = add_i64(a, b);
    const addOk = gotAdd64 === refAdd && gotAddBI === refAdd && gotAddW === refAdd;
    console.log(`  add(${String(a).padStart(22)}, ${String(b).padStart(22)}) = ${String(refAdd).padStart(22)}  int64=${gotAdd64 === refAdd ? 'OK' : 'FAIL'} bigint=${gotAddBI === refAdd ? 'OK' : 'FAIL'} wasm=${gotAddW === refAdd ? 'OK' : 'FAIL'}`);
    if (addOk) pass++; else fail++;

    // -- Subtraction --
    const refSub = BigInt.asIntN(64, a - b);
    const gotSub64 = ai.sub(bi).toBigInt();
    const gotSubBI = BigInt.asIntN(64, a - b);
    const gotSubW = sub_i64(a, b);
    const subOk = gotSub64 === refSub && gotSubBI === refSub && gotSubW === refSub;
    console.log(`  sub(${String(a).padStart(22)}, ${String(b).padStart(22)}) = ${String(refSub).padStart(22)}  int64=${gotSub64 === refSub ? 'OK' : 'FAIL'} bigint=${gotSubBI === refSub ? 'OK' : 'FAIL'} wasm=${gotSubW === refSub ? 'OK' : 'FAIL'}`);
    if (subOk) pass++; else fail++;

    // -- Multiplication --
    const refMul = BigInt.asIntN(64, a * b);
    const gotMul64 = ai.mul(bi).toBigInt();
    const gotMulBI = bigintMul(a, b);
    const gotMulW = mul_i64(a, b);
    const mulOk = gotMul64 === refMul && gotMulBI === refMul && gotMulW === refMul;
    console.log(`  mul(${String(a).padStart(22)}, ${String(b).padStart(22)}) = ${String(refMul).padStart(22)}  int64=${gotMul64 === refMul ? 'OK' : 'FAIL'} bigint=${gotMulBI === refMul ? 'OK' : 'FAIL'} wasm=${gotMulW === refMul ? 'OK' : 'FAIL'}`);
    if (mulOk) pass++; else fail++;

    // -- Division (skip min_i64 / -1 which traps in WASM) --
    if (b !== 0n && !(a === -0x8000000000000000n && b === -1n)) {
      const refDiv = BigInt.asIntN(64, a / b);
      const gotDiv64 = ai.div(bi).toBigInt();
      const gotDivBI = bigintDiv(a, b);
      const gotDivW = div_s_i64(a, b);
      const divOk = gotDiv64 === refDiv && gotDivBI === refDiv && gotDivW === refDiv;
      console.log(`  div(${String(a).padStart(22)}, ${String(b).padStart(22)}) = ${String(refDiv).padStart(22)}  int64=${gotDiv64 === refDiv ? 'OK' : 'FAIL'} bigint=${gotDivBI === refDiv ? 'OK' : 'FAIL'} wasm=${gotDivW === refDiv ? 'OK' : 'FAIL'}`);
      if (divOk) pass++; else fail++;

      // -- Remainder --
      const refRem = BigInt.asIntN(64, a % b);
      const gotRem64 = ai.rem(bi).toBigInt();
      const gotRemBI = bigintRem(a, b);
      const gotRemW = rem_s_i64(a, b);
      const remOk = gotRem64 === refRem && gotRemBI === refRem && gotRemW === refRem;
      console.log(`  rem(${String(a).padStart(22)}, ${String(b).padStart(22)}) = ${String(refRem).padStart(22)}  int64=${gotRem64 === refRem ? 'OK' : 'FAIL'} bigint=${gotRemBI === refRem ? 'OK' : 'FAIL'} wasm=${gotRemW === refRem ? 'OK' : 'FAIL'}`);
      if (remOk) pass++; else fail++;
    }
  }

  console.log(`\n  ${pass} passed, ${fail} failed\n`);
  if (fail > 0) process.exit(1);
}

// ═════════════════════════════════════════════════════════════
// Benchmark harness
// ═════════════════════════════════════════════════════════════
function bench(name, fn, iterations) {
  for (let i = 0; i < Math.min(iterations, 50000); i++) fn();

  const ROUNDS = 7;
  const times = [];
  for (let r = 0; r < ROUNDS; r++) {
    if (globalThis.gc) globalThis.gc();
    const start = performance.now();
    for (let i = 0; i < iterations; i++) fn();
    times.push(performance.now() - start);
  }

  times.sort((a, b) => a - b);
  const trimmed = times.slice(1, -1);
  const median = trimmed[Math.floor(trimmed.length / 2)];
  const opsPerSec = ((iterations / median) * 1000).toFixed(0);
  const nsPerOp = ((median / iterations) * 1e6).toFixed(2);
  console.log(
    `  ${name.padEnd(50)} ${nsPerOp.padStart(10)} ns/op  ${opsPerSec.padStart(14)} ops/sec  ` +
    `[${trimmed.map(t => t.toFixed(2) + 'ms').join(', ')}]`
  );
  return { name, median, nsPerOp: parseFloat(nsPerOp), opsPerSec: parseInt(opsPerSec) };
}

// ═════════════════════════════════════════════════════════════
// Run benchmarks
// ═════════════════════════════════════════════════════════════
function runBenchmarks() {
  const PAIR_COUNT = 1024;
  const ITERS = 5_000_000;
  const LOOP_ITERS = Math.floor(ITERS / PAIR_COUNT);
  const results = [];

  // Pre-generate varying input pairs (avoid constant folding)
  const pairsBig = [];
  const pairs64 = [];
  // For division, ensure divisor is non-zero and not too small
  const divPairsBig = [];
  const divPairs64 = [];

  for (let i = 0; i < PAIR_COUNT; i++) {
    const a = BigInt.asIntN(64, BigInt(i + 1) * 0x123456789ABCDn);
    const b = BigInt.asIntN(64, BigInt(PAIR_COUNT - i) * 0xFEDCBA987654n + 1n);
    pairsBig.push([a, b]);
    pairs64.push([Int64.fromBigInt(a), Int64.fromBigInt(b)]);

    // For division: large dividend, smaller divisor (realistic)
    const dividend = BigInt.asIntN(64, BigInt(i + 1) * 0x123456789ABCDEFn);
    const divisor = BigInt.asIntN(64, BigInt(i + 1) * 0x12345n + 1n);
    divPairsBig.push([dividend, divisor]);
    divPairs64.push([Int64.fromBigInt(dividend), Int64.fromBigInt(divisor)]);
  }

  let sink = 0;

  // ── ADDITION ──
  console.log(`=== Addition (${PAIR_COUNT} pairs × ${LOOP_ITERS} loops = ${(PAIR_COUNT * LOOP_ITERS).toLocaleString()} ops) ===\n`);

  results.push(bench('1. Int64.add (two int32)', () => {
    for (let i = 0; i < PAIR_COUNT; i++) {
      sink += pairs64[i][0].add(pairs64[i][1]).lo & 0xFF;
    }
  }, LOOP_ITERS));

  results.push(bench('2. BigInt add + asIntN(64)', () => {
    for (let i = 0; i < PAIR_COUNT; i++) {
      sink += Number(BigInt.asIntN(64, pairsBig[i][0] + pairsBig[i][1]) & 0xFFn);
    }
  }, LOOP_ITERS));

  results.push(bench('3. WASM i64.add (single calls)', () => {
    for (let i = 0; i < PAIR_COUNT; i++) {
      sink += Number(add_i64(pairsBig[i][0], pairsBig[i][1]) & 0xFFn);
    }
  }, LOOP_ITERS));

  // ── SUBTRACTION ──
  console.log(`\n=== Subtraction (${PAIR_COUNT} pairs × ${LOOP_ITERS} loops) ===\n`);

  results.push(bench('1. Int64.sub (two int32)', () => {
    for (let i = 0; i < PAIR_COUNT; i++) {
      sink += pairs64[i][0].sub(pairs64[i][1]).lo & 0xFF;
    }
  }, LOOP_ITERS));

  results.push(bench('2. BigInt sub + asIntN(64)', () => {
    for (let i = 0; i < PAIR_COUNT; i++) {
      sink += Number(BigInt.asIntN(64, pairsBig[i][0] - pairsBig[i][1]) & 0xFFn);
    }
  }, LOOP_ITERS));

  results.push(bench('3. WASM i64.sub (single calls)', () => {
    for (let i = 0; i < PAIR_COUNT; i++) {
      sink += Number(sub_i64(pairsBig[i][0], pairsBig[i][1]) & 0xFFn);
    }
  }, LOOP_ITERS));

  // ── MULTIPLICATION ──
  console.log(`\n=== Multiplication (${PAIR_COUNT} pairs × ${LOOP_ITERS} loops = ${(PAIR_COUNT * LOOP_ITERS).toLocaleString()} ops) ===\n`);

  results.push(bench('1. Int64.mul (two int32, 16-bit chunks)', () => {
    for (let i = 0; i < PAIR_COUNT; i++) {
      sink += pairs64[i][0].mul(pairs64[i][1]).lo & 0xFF;
    }
  }, LOOP_ITERS));

  results.push(bench('2. BigInt mul + asIntN(64)', () => {
    for (let i = 0; i < PAIR_COUNT; i++) {
      sink += Number(BigInt.asIntN(64, pairsBig[i][0] * pairsBig[i][1]) & 0xFFn);
    }
  }, LOOP_ITERS));

  results.push(bench('3. WASM i64.mul (single calls)', () => {
    for (let i = 0; i < PAIR_COUNT; i++) {
      sink += Number(mul_i64(pairsBig[i][0], pairsBig[i][1]) & 0xFFn);
    }
  }, LOOP_ITERS));

  // ── SIGNED DIVISION ──
  console.log(`\n=== Signed Division (${PAIR_COUNT} pairs × ${LOOP_ITERS} loops) ===\n`);

  results.push(bench('1. Int64.div (two int32, binary long div)', () => {
    for (let i = 0; i < PAIR_COUNT; i++) {
      sink += divPairs64[i][0].div(divPairs64[i][1]).lo & 0xFF;
    }
  }, LOOP_ITERS));

  results.push(bench('2. BigInt div + asIntN(64)', () => {
    for (let i = 0; i < PAIR_COUNT; i++) {
      sink += Number(BigInt.asIntN(64, divPairsBig[i][0] / divPairsBig[i][1]) & 0xFFn);
    }
  }, LOOP_ITERS));

  results.push(bench('3. WASM i64.div_s (single calls)', () => {
    for (let i = 0; i < PAIR_COUNT; i++) {
      sink += Number(div_s_i64(divPairsBig[i][0], divPairsBig[i][1]) & 0xFFn);
    }
  }, LOOP_ITERS));

  // ── BATCH ADDITION (WASM amortized) ──
  console.log(`\n=== Batch Addition (${PAIR_COUNT} pairs, WASM pre-loaded) ===\n`);

  for (let i = 0; i < PAIR_COUNT; i++) {
    wasmDV.setBigInt64(i * 16, pairsBig[i][0], true);
    wasmDV.setBigInt64(i * 16 + 8, pairsBig[i][1], true);
  }

  results.push(bench('3b. WASM i64.add batch (pre-loaded)', () => {
    add_i64_batch(PAIR_COUNT);
  }, LOOP_ITERS));

  // ── BATCH MULTIPLICATION (WASM amortized) ──
  console.log(`\n=== Batch Multiplication (${PAIR_COUNT} pairs, WASM pre-loaded) ===\n`);

  // Pre-load pairs into WASM memory for batch
  for (let i = 0; i < PAIR_COUNT; i++) {
    wasmDV.setBigInt64(i * 16, pairsBig[i][0], true);
    wasmDV.setBigInt64(i * 16 + 8, pairsBig[i][1], true);
  }

  results.push(bench('3b. WASM i64.mul batch (pre-loaded)', () => {
    mul_i64_batch(PAIR_COUNT);
  }, LOOP_ITERS));

  // ── BATCH DIVISION (WASM amortized) ──
  console.log(`\n=== Batch Division (${PAIR_COUNT} pairs, WASM pre-loaded) ===\n`);

  for (let i = 0; i < PAIR_COUNT; i++) {
    wasmDV.setBigInt64(i * 16, divPairsBig[i][0], true);
    wasmDV.setBigInt64(i * 16 + 8, divPairsBig[i][1], true);
  }

  results.push(bench('3b. WASM i64.div_s batch (pre-loaded)', () => {
    div_s_i64_batch(PAIR_COUNT);
  }, LOOP_ITERS));

  if (sink === -Infinity) console.log(sink);

  // ── SUMMARY ──
  console.log('\n' + '═'.repeat(80));
  console.log('  SUMMARY');
  console.log('═'.repeat(80) + '\n');

  const groups = [
    { label: 'Addition (per op)', items: results.slice(0, 3), perOp: PAIR_COUNT },
    { label: 'Subtraction (per op)', items: results.slice(3, 6), perOp: PAIR_COUNT },
    { label: 'Multiplication (per op)', items: results.slice(6, 9), perOp: PAIR_COUNT },
    { label: 'Division (per op)', items: results.slice(9, 12), perOp: PAIR_COUNT },
    { label: 'Batch Add (per op, WASM only)', items: results.slice(12, 13), perOp: PAIR_COUNT },
    { label: 'Batch Mul (per op, WASM only)', items: results.slice(13, 14), perOp: PAIR_COUNT },
    { label: 'Batch Div (per op, WASM only)', items: results.slice(14, 15), perOp: PAIR_COUNT },
  ];

  for (const { label, items, perOp } of groups) {
    console.log(`  ${label}:`);
    for (const r of items) {
      const perOpNs = (r.nsPerOp / perOp).toFixed(2);
      console.log(`    ${r.name.padEnd(50)} ${perOpNs.padStart(10)} ns/op`);
    }
    console.log();
  }
}

// ═════════════════════════════════════════════════════════════
verify();
runBenchmarks();
