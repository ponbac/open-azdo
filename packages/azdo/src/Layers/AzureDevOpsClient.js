import { Effect, Layer, Redacted, Schema } from "effect"
import { parseJsonUnknown, stringifyJson } from "@open-azdo/core/json"
import { AzureDevOpsDecodeError, AzureDevOpsHttpError } from "../errors"
import { AzureDevOpsClient } from "../Services/AzureDevOpsClient"
import { ExistingThreadsResponseSchema, PullRequestMetadataResponseSchema } from "../Schemas"
const createHeaders = (token) => ({
  authorization: `Bearer ${Redacted.value(token)}`,
  "content-type": "application/json",
})
const buildPullRequestUrl = (context) =>
  `${context.collectionUrl.replace(/\/+$/, "")}/${encodeURIComponent(context.project)}/_apis/git/repositories/${encodeURIComponent(context.repositoryId)}/pullRequests/${context.pullRequestId}`
const requestJson = (url, init, decode) =>
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
const getPullRequestMetadata = ({ context, token }) =>
  requestJson(buildPullRequestUrl(context), { method: "GET", headers: createHeaders(token) }, (input) => {
    try {
      const metadata = Schema.decodeUnknownSync(PullRequestMetadataResponseSchema)(input)
      return {
        title: metadata.title,
        description: metadata.description ?? "",
        url: metadata.url ?? undefined,
      }
    } catch (error) {
      throw new AzureDevOpsDecodeError({
        message: "Azure DevOps response did not match the expected schema.",
        url: buildPullRequestUrl(context),
        body: stringifyJson(input),
        issues: [String(error)],
      })
    }
  })
const listThreads = ({ context, token }) =>
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
const updateThreadStatus = ({ context, token, threadId, status }) =>
  requestJson(
    `${buildPullRequestUrl(context)}/threads/${threadId}?api-version=7.1`,
    {
      method: "PATCH",
      headers: createHeaders(token),
      body: stringifyJson({ status }),
    },
    (input) => input,
  ).pipe(Effect.asVoid)
const updateComment = ({ context, token, threadId, commentId, content }) =>
  requestJson(
    `${buildPullRequestUrl(context)}/threads/${threadId}/comments/${commentId}?api-version=7.1`,
    {
      method: "PATCH",
      headers: createHeaders(token),
      body: stringifyJson({ content }),
    },
    (input) => input,
  ).pipe(Effect.asVoid)
const createThread = ({ context, token, content, threadContext }) =>
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
