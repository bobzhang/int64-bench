# int64-bench

Benchmarking three approaches to 64-bit integer arithmetic in JavaScript:

1. **Pure JS with `class Int64` (two int32 fields)** -- add/sub via carry/borrow, multiplication via 16-bit chunk decomposition, division via binary long division
2. **Pure JS with BigInt** -- `BigInt.asIntN(64, a op b)`
3. **WebAssembly with native i64** -- `i64.add` / `i64.mul` / `i64.div_s`, both single-call and batch

## Results

Node v25.8.2, Apple Silicon (arm64):

### Addition / Subtraction (per op)

| Approach | add ns/op | sub ns/op |
|----------|------:|------:|
| Int64 (two int32) | 11.6 | 10.5 |
| BigInt + asIntN(64) | ~14* | ~14* |
| WASM single call | 14.3 | 14.2 |
| WASM batch (pre-loaded) | 0.66 | -- |

\* BigInt add showed bimodal behavior (28ns in some runs, 14ns in others) due to GC pauses in the full benchmark suite. When isolated, BigInt add and sub are both ~14ns/op. Confirmed by Codex (GPT-5.4) independent reproduction.

### Multiplication (per op)

| Approach | ns/op | Relative |
|----------|------:|----------|
| WASM i64.mul (single call) | 14.7 | 1.0x |
| Int64.mul (16-bit chunks) | 16.2 | 1.1x |
| BigInt * + asIntN(64) | 54.3 | 3.7x |
| WASM batch (pre-loaded) | 0.62 | 0.04x |

### Signed Division (per op)

| Approach | ns/op | Relative |
|----------|------:|----------|
| BigInt / + asIntN(64) | 14.6 | 1.0x |
| WASM i64.div_s (single call) | 15.3 | 1.05x |
| Int64.div (binary long division) | 494.6 | 33.8x |
| WASM batch (pre-loaded) | 0.77 | 0.05x |

## Analysis: When to Use What

The JS-to-WASM boundary round-trip costs ~10-15ns (BigInt in -> i64 -> BigInt out). Whether WASM wins depends on whether that boundary cost is cheaper than V8's native BigInt operation:

| Operation | BigInt | WASM single | Winner | Why |
|-----------|--------|-------------|--------|-----|
| **Addition** | ~14ns | ~14ns | **Tied** | Both trivial; boundary cost = BigInt alloc cost |
| **Subtraction** | ~14ns | ~14ns | **Tied** | Same as addition |
| **Multiplication** | ~54ns | ~15ns | **WASM (3.7x)** | BigInt mul allocates heap object; WASM boundary is cheaper |
| **Division** | ~15ns | ~15ns | **Tied** | V8 optimized small-BigInt div to use hardware instruction |

### Recommendation for Compiler Targets (e.g., MoonBit JS backend)

- **Addition/Subtraction**: Emit pure BigInt. WASM boundary cost buys nothing -- both are ~14ns. No benefit to routing through WASM for a trivial add/sub.
- **Multiplication**: Route through WASM. 3.7x faster than pure BigInt even with boundary overhead. V8's BigInt multiplication has unavoidable heap allocation cost.
- **Division**: Emit pure BigInt. V8's optimizer matches WASM `i64.div_s` performance. No benefit to WASM routing.
- **Batch/fused operations**: If multiple i64 operations can be fused into a single WASM call (data stays in linear memory), sub-1ns/op is achievable -- 15-20x faster than any single-call approach.
- **Never use two-int32 class for division**: 34x slower than BigInt due to binary long division allocating objects in a ~38-iteration loop.

## Correctness

The benchmark verifies all three implementations against 63 edge cases (including 0, +/-1, max/min int64, 2^32 boundary, overflow wrapping) for add, sub, mul, div, and rem. Additionally validated with 200k random test cases via Codex CLI (GPT-5.4).

## Running

```bash
# Run benchmark with GC exposed for fair measurement
node --expose-gc bench.mjs

# Rebuild WASM if you edit the .wat source
wasm-tools parse encode-wasm.wat -o encode-wasm.wasm
```

## Files

- `bench.mjs` -- benchmark harness with Int64 class, BigInt wrappers, WASM loader, correctness verification, and timing
- `encode-wasm.wat` -- WAT source for i64 add/sub/mul/div/rem (single + batch)
- `encode-wasm.wasm` -- compiled WASM binary

## Benchmark Methodology

- 5M total operations per benchmark
- 1024 varying input pairs (avoids constant folding / JIT elimination)
- 7 rounds, GC before each, drop min/max, report trimmed median
- Sink variable prevents dead-code elimination
- Symmetric sink cost across all approaches (`& 0xFF` extraction)
- BigInt add/sub anomaly investigated and confirmed as GC artifact via isolated reproduction
