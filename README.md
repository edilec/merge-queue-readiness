# Merge Queue Readiness

An offline, read-only gate for an exported branch snapshot. It evaluates required checks on the current head, approvals, review threads, conflicts and capture age. It never contacts GitHub and cannot assert live queue position.

Requires Node.js 22 or later. No dependencies.

```sh
node bin/merge-queue-readiness.mjs --root examples --policy policy.json --snapshot ready.json --at 2026-01-01T00:30:00Z
node bin/merge-queue-readiness.mjs --root examples --policy policy.json --snapshot blocked.json --at 2026-01-01T00:30:00Z
npm run check
```

The first example exits 0; the second exits 1. Inputs are read relative to `--root` and resolved to real paths within it. Findings use `@policy` and `@snapshot` as logical source roles, with JSON pointers into the exact files named at invocation. No content or absolute path from either file is printed.

`--at` is an explicit UTC evaluation instant. Export the snapshot independently, as close to gate time as practical. See [rules and limits](docs/README.md) for the complete schema, exit codes and evidence limitations.
