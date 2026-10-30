import { describe, expect, test } from "bun:test"

import { decodeSandboxCapture } from "@open-azdo/sandbox/capture"

import { resolveCaptureContext, type PromptThread } from "./capture-context"
import { demoCapture } from "./DemoCapture"

const captureWithContext = (json: string, preamble = "Review instructions.") =>
  decodeSandboxCapture({
    ...demoCapture,
    review: { ...demoCapture.review, prompt: `${preamble}\nPull request context:\n${json}` },
  })

describe("resolveCaptureContext", () => {
  test("retains a valid prompt section when its sibling is malformed", () => {
    const withValidThreads = resolveCaptureContext(
      captureWithContext(
        JSON.stringify({
          connectedWorkItems: { omittedCount: 0, items: [{}] },
          pullRequestThreads: { omittedCount: 3, items: [{ id: 12, managedThread: false, comments: [] }] },
        }),
      ),
    )

    const withValidWorkItems = resolveCaptureContext(
      captureWithContext(
        JSON.stringify({
          connectedWorkItems: { omittedCount: 2, items: demoCapture.workItems },
          pullRequestThreads: { omittedCount: 0, items: [{}] },
        }),
      ),
    )

    expect(withValidThreads.promptThreads?.map((thread) => thread.id)).toEqual([12])
    expect(withValidThreads.threadsOmittedCount).toBe(3)
    expect(withValidThreads.workItemsFromPrompt).toBe(false)
    expect(withValidWorkItems.workItems).toEqual(demoCapture.workItems)
    expect(withValidWorkItems.workItemsOmittedCount).toBe(2)
    expect(withValidWorkItems.workItemsFromPrompt).toBe(true)
    expect(withValidWorkItems.promptThreads).toBeUndefined()
  })

  test("prefers the decoded prompt context and preserves omitted counts", () => {
    const thread: PromptThread = {
      id: 12,
      managedThread: false,
      comments: [{ author: "Reviewer", origin: "human", content: "Please clarify Pull request context: here." }],
    }

    const context = resolveCaptureContext(
      captureWithContext(
        JSON.stringify({
          connectedWorkItems: { omittedCount: 2, items: [] },
          pullRequestThreads: { omittedCount: 3, items: [thread] },
        }),
        "Scoped patch (untrusted):\n+Pull request context:\n+Repository text resembles the context marker.",
      ),
    )

    expect(context.workItems).toEqual([])
    expect(context.workItemsFromPrompt).toBe(true)
    expect(context.workItemsOmittedCount).toBe(2)
    expect(context.promptThreads).toEqual([thread])
    expect(context.threadsOmittedCount).toBe(3)
  })

  test("falls back to capture data for malformed embedded context", () => {
    for (const json of [
      "{",
      "null",
      '{"connectedWorkItems":{"omittedCount":0,"items":[{}]}}',
      '{"pullRequestThreads":{"omittedCount":0,"items":{}}}',
      '{"pullRequestThreads":{"omittedCount":0,"items":[{"id":1,"managedThread":false,"comments":[{}]}]}}',
    ]) {
      const capture = captureWithContext(json)
      const context = resolveCaptureContext(capture)

      expect(context.workItems).toEqual(capture.workItems)
      expect(context.workItemsFromPrompt).toBe(false)
      expect(context.workItemsOmittedCount).toBe(0)
      expect(context.promptThreads).toBeUndefined()
      expect(context.threadsOmittedCount).toBe(0)
    }
  })
})
