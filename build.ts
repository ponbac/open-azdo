#!/usr/bin/env bun

import { mkdir } from "node:fs/promises"
import { join } from "node:path"

const distDir = join(process.cwd(), "dist")

await mkdir(distDir, { recursive: true })

const result = await Bun.build({
  entrypoints: [join(process.cwd(), "bin/open-azdo.ts")],
  outdir: distDir,
  target: "bun",
  format: "esm",
  sourcemap: "external",
})

if (!result.success) {
  for (const log of result.logs) {
    process.stderr.write(`${log.message}\n`)
  }

  process.exit(1)
}
