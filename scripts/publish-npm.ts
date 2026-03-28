import { runPublishRelease, type PublishMode } from "../apps/open-azdo/src/PublishRelease"

const modeArg = process.argv[2] ?? "publish"

if (modeArg !== "publish" && modeArg !== "dry-run") {
  throw new Error(`Unsupported publish mode "${modeArg}". Expected "publish" or "dry-run".`)
}

const mode: PublishMode = modeArg

await runPublishRelease(mode)
