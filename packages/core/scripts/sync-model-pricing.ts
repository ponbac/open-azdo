import { fileURLToPath } from "node:url"
import { mkdir } from "node:fs/promises"
import { dirname } from "node:path"

import {
  MODELS_DEV_SOURCE_URL,
  normalizeModelsDevPricingSnapshot,
  renderModelsDevPricingSnapshotModule,
} from "../src/model-pricing/internal/ModelsDevPricingSnapshot"

const OUTPUT_URL = new URL("../src/model-pricing/generated/models-dev-pricing-snapshot.ts", import.meta.url)
const OUTPUT_PATH = fileURLToPath(OUTPUT_URL)

const run = async () => {
  const response = await fetch(MODELS_DEV_SOURCE_URL)
  if (!response.ok) {
    throw new Error(`Failed to fetch ${MODELS_DEV_SOURCE_URL}: HTTP ${String(response.status)}`)
  }

  const payload = await response.json()
  const snapshot = normalizeModelsDevPricingSnapshot(payload, new Date().toISOString())
  const moduleSource = renderModelsDevPricingSnapshotModule(snapshot)

  // The generated module lives under `src/` so runtime imports stay synchronous.
  await mkdir(dirname(OUTPUT_PATH), { recursive: true })
  await Bun.write(OUTPUT_URL, moduleSource)
  process.stdout.write(`Wrote ${OUTPUT_PATH}\n`)
}

await run()
