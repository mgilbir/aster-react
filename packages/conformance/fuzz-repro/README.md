# Fuzz reproducers

Each `*.vg.json` here is a deterministic reproducer emitted by
`pnpm fuzz` (or the nightly workflow) when the differential fuzzer finds a
geometry difference between `@aster/core` and the real Vega oracle.

Replay the whole directory:

```bash
pnpm --filter @aster/conformance run fuzz:replay
```

When a mismatch is fixed, promote the case into `corpus/` (so the normal
conformance gate keeps it fixed) and delete the reproducer.
