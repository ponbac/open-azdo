import { describe, expect, test } from "bun:test"
import { Effect } from "effect"

import { publishFailureSummary, publishReview } from "../src/azure-devops"
import {
  makeFetchMock,
  makeManagedFindingThread,
  makeManagedSummaryThread,
  makeNormalizedReviewResult,
  makeReviewConfig,
  makeReviewFinding,
} from "./helpers"

describe("azure devops", () => {
  test("creates summary and inline threads for new managed findings", async () => {
    const finding = makeReviewFinding()
    const { fetchMock, calls } = makeFetchMock((url) => {
      if (url.includes("/threads?api-version=7.1")) {
        if (calls.length === 1) {
          return Response.json({ value: [] })
        }

        return Response.json({ id: calls.length })
      }

      return Response.json({})
    })

    const result = await Effect.runPromise(
      publishReview(makeReviewConfig(), makeNormalizedReviewResult([finding]), fetchMock as typeof fetch),
    )

    expect(result.actions).toHaveLength(2)
    expect(calls.filter((call) => call.init?.method === "POST")).toHaveLength(2)
  })

  test("updates existing summary, reuses matching findings, and closes stale threads", async () => {
    const finding = makeReviewFinding()
    const staleFinding = makeReviewFinding({
      title: "Stale finding",
      line: 3,
    })
    const existingThreads = [
      makeManagedSummaryThread(),
      makeManagedFindingThread(finding, 2),
      makeManagedFindingThread(staleFinding, 3),
    ]
    const { fetchMock, calls } = makeFetchMock((url, init) => {
      if (url.endsWith("/threads?api-version=7.1") && init?.method === "GET") {
        return Response.json({ value: existingThreads })
      }

      return Response.json({ ok: true })
    })

    const result = await Effect.runPromise(
      publishReview(makeReviewConfig(), makeNormalizedReviewResult([finding]), fetchMock as typeof fetch),
    )

    expect(result.actions.map((action) => action.type)).toEqual(["upsert-summary", "upsert-finding", "close-thread"])
    expect(calls.filter((call) => call.init?.method === "PATCH").length).toBeGreaterThanOrEqual(3)
  })

  test("surfaces comment post failures", async () => {
    const finding = makeReviewFinding()
    const { fetchMock } = makeFetchMock((url, init) => {
      if (url.endsWith("/threads?api-version=7.1") && init?.method === "GET") {
        return Response.json({ value: [] })
      }

      return new Response("boom", { status: 500 })
    })

    const exit = await Effect.runPromiseExit(
      publishReview(makeReviewConfig(), makeNormalizedReviewResult([finding]), fetchMock as typeof fetch),
    )

    expect(exit._tag).toBe("Failure")
  })

  test("publishes a managed failure summary", async () => {
    const existingThreads = [makeManagedSummaryThread()]
    const { fetchMock, calls } = makeFetchMock((url, init) => {
      if (url.endsWith("/threads?api-version=7.1") && init?.method === "GET") {
        return Response.json({ value: existingThreads })
      }

      return Response.json({ ok: true })
    })

    await Effect.runPromise(publishFailureSummary(makeReviewConfig(), "Failed badly", fetchMock as typeof fetch))

    expect(calls.some((call) => call.url.includes("/comments/10"))).toBe(true)
  })
})
