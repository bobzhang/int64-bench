(module
  (memory (export "memory") 1)

  (func (export "mul_i64") (param $a i64) (param $b i64) (result i64)
    (i64.mul (local.get $a) (local.get $b))
  )

  (func (export "div_s_i64") (param $a i64) (param $b i64) (result i64)
    (i64.div_s (local.get $a) (local.get $b))
  )

  (func (export "div_u_i64") (param $a i64) (param $b i64) (result i64)
    (i64.div_u (local.get $a) (local.get $b))
  )

  (func (export "rem_s_i64") (param $a i64) (param $b i64) (result i64)
    (i64.rem_s (local.get $a) (local.get $b))
  )

  ;; Batch: multiply N pairs. Input at [0..N*16), output at [N*16..N*24)
  ;; Each pair is two i64s (16 bytes), output is one i64 (8 bytes)
  (func (export "mul_i64_batch") (param $count i32)
    (local $i i32)
    (local $src i32)
    (local $dst i32)
    (block $break
      (loop $loop
        (br_if $break (i32.ge_u (local.get $i) (local.get $count)))
        (local.set $src (i32.mul (local.get $i) (i32.const 16)))
        (local.set $dst (i32.add
          (i32.mul (local.get $count) (i32.const 16))
          (i32.mul (local.get $i) (i32.const 8))
        ))
        (i64.store (local.get $dst)
          (i64.mul
            (i64.load (local.get $src))
            (i64.load (i32.add (local.get $src) (i32.const 8)))
          )
        )
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $loop)
      )
    )
  )

  ;; Batch: signed divide N pairs
  (func (export "div_s_i64_batch") (param $count i32)
    (local $i i32)
    (local $src i32)
    (local $dst i32)
    (block $break
      (loop $loop
        (br_if $break (i32.ge_u (local.get $i) (local.get $count)))
        (local.set $src (i32.mul (local.get $i) (i32.const 16)))
        (local.set $dst (i32.add
          (i32.mul (local.get $count) (i32.const 16))
          (i32.mul (local.get $i) (i32.const 8))
        ))
        (i64.store (local.get $dst)
          (i64.div_s
            (i64.load (local.get $src))
            (i64.load (i32.add (local.get $src) (i32.const 8)))
          )
        )
        (local.set $i (i32.add (local.get $i) (i32.const 1)))
        (br $loop)
      )
    )
  )
)
