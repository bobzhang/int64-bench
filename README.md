# int64-bench

Benchmarking three approaches to 64-bit integer multiplication and division in JavaScript:

1. **Pure JS with `class Int64` (two int32 fields)** -- multiplication via 16-bit chunk decomposition, division via binary long division
2. **Pure JS with BigInt** -- `BigInt.asIntN(64, a * b)` / `BigInt.asIntN(64, a / b)`
3. **WebAssembly with native i64** -- `i64.mul` / `i64.div_s`, both single-call and batch

## Results

Node v25.8.2, Apple Silicon (arm64):

### Multiplication (per op)

| Approach | ns/op | Relative |
|----------|------:|----------|
| WASM i64.mul (single call) | 14.7 | 1.0x |
| Int64.mul (16-bit chunks) | 16.2 | 1.1x |
| BigInt * + asIntN(64) | 54.3 | 3.7x |
| WASM batch (pre-loaded) | 0.65 | 0.04x |

### Signed Division (per op)

| Approach | ns/op | Relative |
|----------|------:|----------|
| BigInt / + asIntN(64) | 14.6 | 1.0x |
| WASM i64.div_s (single call) | 15.3 | 1.05x |
| Int64.div (binary long division) | 494.6 | 33.8x |
| WASM batch (pre-loaded) | 0.81 | 0.06x |

### Analysis: WASM Boundary Cost vs BigInt Allocation

The JS-to-WASM boundary round-trip costs ~10-15ns (BigInt in -> i64 -> BigInt out). Whether WASM wins depends on whether that boundary cost is cheaper than V8's native BigInt operation:

- **Multiplication**: WASM wins even with boundary cost (14.7ns vs 54.3ns). V8's BigInt multiplication allocates a new heap object for the result, which is more expensive than the WASM round-trip. **WASM is 3.7x faster**.
- **Division**: Essentially tied (14.6ns BigInt vs 15.3ns WASM). V8 has heavily optimized small-BigInt division -- likely using the hardware `div` instruction directly for values that fit in 64 bits, the same instruction WASM emits. No reason to go through WASM for division.
- **Two-int32 class**: Competitive for multiplication (16.2ns) but catastrophic for division (494.6ns / 34x slower). Binary long division in JS allocates new Int64 objects on every shift/sub/compare inside a ~38-iteration loop -- GC pressure dominates.

### Key Takeaways

- **For multiplication-heavy workloads**: Use WASM single calls -- 3.7x faster than pure BigInt, even accounting for boundary cost
- **For division-heavy workloads**: Just use BigInt directly -- V8's optimizer matches native WASM performance
- **For mixed workloads**: WASM single calls are a good default (fastest mul, tied on div)
- **For batch processing**: If data can live in WASM linear memory, sub-1ns/op is achievable -- 15-20x faster than any single-call approach
- **Avoid two-int32 for division**: Don't implement your own long division in JS

## Correctness

The benchmark verifies all three implementations against 37 edge cases (including 0, +/-1, max/min int64, 2^32 boundary, overflow wrapping) for mul, div, and rem. Additionally validated with 200k random test cases via Codex CLI (GPT-5.4).

## Running

```bash
# Run benchmark with GC exposed for fair measurement
node --expose-gc bench.mjs

# Rebuild WASM if you edit the .wat source
wasm-tools parse encode-wasm.wat -o encode-wasm.wasm
```

## Files

- `bench.mjs` -- benchmark harness with Int64 class, BigInt wrappers, WASM loader, correctness verification, and timing
- `encode-wasm.wat` -- WAT source for i64 mul/div/rem (single + batch)
- `encode-wasm.wasm` -- compiled WASM binary

## Benchmark Methodology

- 5M total operations per benchmark
- 1024 varying input pairs (avoids constant folding / JIT elimination)
- 7 rounds, GC before each, drop min/max, report trimmed median
- Sink variable prevents dead-code elimination
- Symmetric sink cost across all approaches (`& 0xFF` extraction)
