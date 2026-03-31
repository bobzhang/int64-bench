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

### Key Takeaways

- **Multiplication**: Two-int32 with 16-bit chunk decomposition is competitive (~16ns), only slightly slower than a WASM boundary call (~15ns). BigInt mul is 3.7x slower.
- **Division**: Two-int32 binary long division is **34x slower** than BigInt or WASM. V8's BigInt division matches native WASM `i64.div_s`. Don't implement your own long division in JS.
- **WASM batch**: When data already lives in linear memory, WASM crushes everything at sub-1ns/op -- but the JS-to-WASM boundary cost (~10-15ns) dominates for single calls.
- **Bottom line**: Just use BigInt for division. For multiplication, two-int32 is viable if you want to avoid BigInt allocation. WASM only wins if you can batch.

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
