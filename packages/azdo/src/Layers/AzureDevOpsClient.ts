import { Effect, Layer, Redacted, Schema } from "effect"

import { parseJsonUnknown, stringifyJson } from "@open-azdo/core/json"

import type { AzureContext } from "../context"
import { AzureDevOpsDecodeError, AzureDevOpsHttpError } from "../errors"
import {
  AzureDevOpsClient,
  type AzureRequestContext,
  type CreateThreadInput,
  type UpdateCommentInput,
  type UpdateThreadStatusInput,
} from "../Services/AzureDevOpsClient"
import { ExistingThreadsResponseSchema, PullRequestMetadataSchema } from "../Schemas"

const createHeaders = (token: Redacted.Redacted<string>) => ({
  authorization: `Bearer ${Redacted.value(token)}`,
  "content-type": "application/json",
})

const buildPullRequestUrl = (context: AzureContext) =>
  `${context.collectionUrl.replace(/\/+$/, "")}/${encodeURIComponent(context.project)}/_apis/git/repositories/${encodeURIComponent(
    context.repositoryId,
  )}/pullRequests/${context.pullRequestId}`

const requestJson = <A>(
  url: string,
  init: RequestInit,
  decode: (input: unknown) => A,
): Effect.Effect<A, AzureDevOpsHttpError | AzureDevOpsDecodeError> =>
  Effect.tryPromise({
    try: async () => {
      const response = await globalThis.fetch(url, init)
      const text = await response.text()

      if (!response.ok) {
        throw new AzureDevOpsHttpError({
          message: `Azure DevOps request failed with status ${response.status}.`,
          url,
          status: response.status,
          body: text,
        })
      }

      if (!text) {
        return decode({})
      }

      const payload = await parseJsonUnknown(text).pipe(
        Effect.mapError(
          (error) =>
            new AzureDevOpsDecodeError({
              message: error.message,
              url,
              body: text,
              issues: [error.message],
            }),
        ),
        Effect.runPromise,
      )

      return decode(payload)
    },
    catch: (error) => {
      if (error instanceof AzureDevOpsHttpError || error instanceof AzureDevOpsDecodeError) {
        return error
      }

      return new AzureDevOpsHttpError({
        message: "Azure DevOps request failed before a valid response was received.",
        url,
        status: -1,
        body: String(error),
      })
    },
  })

const getPullRequestMetadata: AzureDevOpsClient["Service"]["getPullRequestMetadata"] = ({
  context,
  token,
}: AzureRequestContext) =>
  requestJson(buildPullRequestUrl(context), { method: "GET", headers: createHeaders(token) }, (input) => {
    try {
      return Schema.decodeUnknownSync(PullRequestMetadataSchema)(input)
    } catch (error) {
      throw new AzureDevOpsDecodeError({
        message: "Azure DevOps response did not match the expected schema.",
        url: buildPullRequestUrl(context),
        body: stringifyJson(input),
        issues: [String(error)],
      })
    }
  })

const listThreads: AzureDevOpsClient["Service"]["listThreads"] = ({ context, token }: AzureRequestContext) =>
  requestJson(
    `${buildPullRequestUrl(context)}/threads?api-version=7.1`,
    { method: "GET", headers: createHeaders(token) },
    (input) => {
      try {
        return Schema.decodeUnknownSync(ExistingThreadsResponseSchema)(input)
      } catch (error) {
        throw new AzureDevOpsDecodeError({
          message: "Azure DevOps response did not match the expected schema.",
          url: `${buildPullRequestUrl(context)}/threads?api-version=7.1`,
          body: stringifyJson(input),
          issues: [String(error)],
        })
      }
    },
  ).pipe(Effect.map((response) => response.value ?? []))

const updateThreadStatus: AzureDevOpsClient["Service"]["updateThreadStatus"] = ({
  context,
  token,
  threadId,
  status,
}: UpdateThreadStatusInput) =>
  requestJson(
    `${buildPullRequestUrl(context)}/threads/${threadId}?api-version=7.1`,
    {
      method: "PATCH",
      headers: createHeaders(token),
      body: stringifyJson({ status }),
    },
    (input) => input,
  ).pipe(Effect.asVoid)

const updateComment: AzureDevOpsClient["Service"]["updateComment"] = ({
  context,
  token,
  threadId,
  commentId,
  content,
}: UpdateCommentInput) =>
  requestJson(
    `${buildPullRequestUrl(context)}/threads/${threadId}/comments/${commentId}?api-version=7.1`,
    {
      method: "PATCH",
      headers: createHeaders(token),
      body: stringifyJson({ content }),
    },
    (input) => input,
  ).pipe(Effect.asVoid)

const createThread: AzureDevOpsClient["Service"]["createThread"] = ({
  context,
  token,
  content,
  threadContext,
}: CreateThreadInput) =>
  requestJson(
    `${buildPullRequestUrl(context)}/threads?api-version=7.1`,
    {
      method: "POST",
      headers: createHeaders(token),
      body: stringifyJson({
        comments: [
          {
            parentCommentId: 0,
            content,
            commentType: 1,
          },
        ],
        status: 1,
        threadContext,
      }),
    },
    (input) => input,
  ).pipe(Effect.asVoid)

const makeAzureDevOpsClient = Effect.succeed({
  getPullRequestMetadata,
  listThreads,
  updateThreadStatus,
  updateComment,
  createThread,
})

export const AzureDevOpsClientLive = Layer.effect(AzureDevOpsClient, makeAzureDevOpsClient)
