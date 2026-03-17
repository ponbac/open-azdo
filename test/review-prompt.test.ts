import { describe, expect, test } from "bun:test"
import { BunServices } from "@effect/platform-bun"
import { Effect } from "effect"

import { buildReviewPrompt } from "../src/review-prompt"
import { makeReviewConfig } from "./helpers"

describe("review prompt", () => {
  test("asks the model to use more emojis in review comments", async () => {
    const prompt = await Effect.runPromise(
      buildReviewPrompt(makeReviewConfig(), {
        pullRequest: {
          title: "Feature PR",
          description: "Adds a new export",
        },
        changedFiles: [
          {
            path: "src/example.ts",
            diff: "@@ -1 +1,2 @@",
            excerpt: "export const value = 2",
          },
        ],
      }).pipe(Effect.provide(BunServices.layer)),
    )

    expect(prompt).toContain("Use a lively review tone with emojis throughout the human-readable text fields.")
    expect(prompt).toContain(
      "Include emojis in summary, finding titles, finding bodies, and unmapped notes; prefer multiple relevant emojis instead of a single token.",
    )
  })
})
