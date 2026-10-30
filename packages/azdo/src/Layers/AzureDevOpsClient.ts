import { Effect, Layer, Option, Schema, type Redacted } from "effect"
import { FetchHttpClient, HttpClient, HttpClientError, HttpClientRequest, HttpClientResponse } from "effect/http"

import type { HttpBody } from "effect/http"

import { logInfo } from "@open-azdo/core/logging"

import { normalizeWorkItemMarkdown, renderWorkItemMarkdown } from "../WorkItemMarkdown"
import type { AzureContext } from "../context"
import { AzureDevOpsDecodeError, AzureDevOpsHttpError } from "../errors"
import {
  AzureDevOpsClient,
  type AzureRequestContext,
  type CreateThreadInput,
  type UpdateCommentInput,
  type UpdateThreadStatusInput,
} from "../Services/AzureDevOpsClient"
import {
  ConnectionDataResponseSchema,
  ExistingThreadsResponseSchema,
  PullRequestMetadataResponseSchema,
  PullRequestWorkItemsResponseSchema,
  WorkItemCommentsResponseSchema,
  WorkItemsBatchResponseSchema,
  WorkItemIntegerSchema,
  readAssignedToDisplayName,
  type PullRequestWorkItem,
  type PullRequestMetadata,
  type PullRequestWorkItemRef,
  type WorkItemBatchItem,
} from "../Schemas"

const MAX_CONNECTED_WORK_ITEMS = 4
const MAX_WORK_ITEM_COMMENTS = 3
const MAX_WORK_ITEM_BATCH_IDS = 200
const MAX_RELATED_TITLES_PER_WORK_ITEM = 4

const normalizeCollectionUrl = (collectionUrl: string) => collectionUrl.replace(/\/+$/, "")

const buildProjectApiBaseUrl = (context: AzureContext) =>
  `${normalizeCollectionUrl(context.collectionUrl)}/${encodeURIComponent(context.project)}/_apis`

const buildPullRequestPath = (context: AzureContext) =>
  `/git/repositories/${encodeURIComponent(context.repositoryId)}/pullRequests/${context.pullRequestId}`

const buildPullRequestWorkItemsPath = (context: AzureContext) => `${buildPullRequestPath(context)}/workitems`

const normalizeOptionalString = (value: string | null | undefined) => {
  const trimmed = value?.trim()

  return trimmed && trimmed.length > 0 ? trimmed : undefined
}

const decodeWorkItemId = Schema.decodeUnknownOption(WorkItemIntegerSchema.check(Schema.isGreaterThan(0)))

/** Refines external work-item IDs with the same decimal integer policy used for sparse Azure fields. */
const parseWorkItemId = (value: string | undefined) => Option.getOrUndefined(decodeWorkItemId(value))

const splitTags = (tags: string | undefined) =>
  tags
    ?.split(";")
    .map((tag) => tag.trim())
    .filter((tag) => tag.length > 0) ?? []

const parseWorkItemIdFromUrl = (url: string | undefined): number | undefined => {
  if (!url) {
    return undefined
  }

  try {
    const parsedUrl = new URL(url)
    const segments = parsedUrl.pathname.split("/").filter((segment) => segment.length > 0)
    const apisIndex = segments.lastIndexOf("_apis")

    if (apisIndex < 0 || segments[apisIndex + 1] !== "wit" || segments[apisIndex + 2] !== "workItems") {
      return undefined
    }

    return parseWorkItemId(segments[apisIndex + 3])
  } catch {
    return undefined
  }
}

const readRelationWorkItemId = (relation: NonNullable<WorkItemBatchItem["relations"]>[number]) =>
  parseWorkItemIdFromUrl(normalizeOptionalString(relation.url ?? undefined)) ?? relation.attributes?.id

const readRelationWorkItemIds = (
  relations: WorkItemBatchItem["relations"],
  relationType: "System.LinkTypes.Hierarchy-Reverse" | "System.LinkTypes.Related",
) =>
  (relations ?? [])
    .filter((relation) => relation.rel === relationType)
    .map(readRelationWorkItemId)
    .filter((id): id is number => id !== undefined)

const selectRelationTitleIds = (workItem: WorkItemBatchItem) => [
  ...readRelationWorkItemIds(workItem.relations, "System.LinkTypes.Hierarchy-Reverse").slice(0, 1),
  ...readRelationWorkItemIds(workItem.relations, "System.LinkTypes.Related").slice(0, MAX_RELATED_TITLES_PER_WORK_ITEM),
]

const extractRelationTitleIds = (items: ReadonlyArray<WorkItemBatchItem>) => {
  const ids = new Set<number>()

  for (const item of items) {
    for (const relationId of selectRelationTitleIds(item)) {
      ids.add(relationId)
    }
  }

  return [...ids]
}

const chunkIds = (ids: ReadonlyArray<number>, size: number) => {
  const chunks: number[][] = []

  for (let index = 0; index < ids.length; index += size) {
    chunks.push(ids.slice(index, index + size))
  }

  return chunks
}

/** Binds bearer authorization to requests within an explicit Azure collection or project API base. */
const makeAuthenticatedClient = (
  baseUrl: string,
  token: Redacted.Redacted<string>,
  httpClient: HttpClient.HttpClient,
) =>
  httpClient.pipe(
    HttpClient.mapRequest((request) =>
      request.pipe(
        HttpClientRequest.prependUrl(baseUrl),
        HttpClientRequest.bearerToken(token),
        HttpClientRequest.acceptJson,
      ),
    ),
  )

const toAzureDevOpsClientError =
  (request: HttpClientRequest.HttpClientRequest) =>
  (
    error: HttpClientError.HttpClientError | HttpBody.HttpBodyError | Schema.SchemaError,
  ): AzureDevOpsHttpError | AzureDevOpsDecodeError => {
    if (Schema.isSchemaError(error)) {
      return new AzureDevOpsDecodeError({
        message: "Azure DevOps response did not match the expected schema.",
        url: request.url,
        body: error.message,
        issues: [error.message],
      })
    }

    if (HttpClientError.isHttpClientError(error)) {
      return new AzureDevOpsHttpError({
        message: error.message,
        url: request.url,
        status: error.response?.status ?? -1,
        body: error.message,
      })
    }

    return new AzureDevOpsHttpError({
      message: "Azure DevOps request failed before a valid response was received.",
      url: request.url,
      status: -1,
      body: String(error),
    })
  }

const executeJson = <A>(
  client: HttpClient.HttpClient,
  request: HttpClientRequest.HttpClientRequest,
  schema: Schema.Codec<A, unknown, never, never>,
): Effect.Effect<A, AzureDevOpsHttpError | AzureDevOpsDecodeError> =>
  client
    .execute(request)
    .pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)),
      Effect.mapError(toAzureDevOpsClientError(request)),
    )

const executeOk = (
  client: HttpClient.HttpClient,
  request: HttpClientRequest.HttpClientRequest,
): Effect.Effect<void, AzureDevOpsHttpError | AzureDevOpsDecodeError> =>
  client
    .execute(request)
    .pipe(
      Effect.flatMap(HttpClientResponse.filterStatusOk),
      Effect.mapError(toAzureDevOpsClientError(request)),
      Effect.asVoid,
    )

const withLoggedEmptyFallback = <A>(
  effect: Effect.Effect<A, AzureDevOpsHttpError | AzureDevOpsDecodeError>,
  {
    onHttpMessage,
    onDecodeMessage,
    fields,
    empty,
  }: {
    readonly onHttpMessage: string
    readonly onDecodeMessage: string
    readonly fields: {
      readonly pullRequestId?: number
      readonly referencedWorkItems?: number
      readonly workItemId?: number
    }
    readonly empty: A
  },
): Effect.Effect<A> =>
  effect.pipe(
    Effect.catchTags({
      AzureDevOpsHttpError: (error) =>
        logInfo(onHttpMessage, {
          ...fields,
          status: error.status,
          url: error.url,
        }).pipe(Effect.as(empty)),
      AzureDevOpsDecodeError: (error) =>
        logInfo(onDecodeMessage, {
          ...fields,
          url: error.url,
        }).pipe(Effect.as(empty)),
    }),
  )

const parseWorkItemIds = Effect.fn("AzureDevOpsClient.parseWorkItemIds")(function* ({
  context,
  workItemRefs,
}: {
  readonly context: AzureContext
  readonly workItemRefs: ReadonlyArray<PullRequestWorkItemRef>
}) {
  const workItemIds: number[] = []

  for (const workItemRef of workItemRefs) {
    const parsedId = parseWorkItemId(workItemRef.id)
    const workItemId = parseWorkItemIdFromUrl(normalizeOptionalString(workItemRef.url)) ?? parsedId

    if (workItemId !== undefined) {
      workItemIds.push(workItemId)
      continue
    }

    yield* logInfo("Ignoring pull-request work item ref with a non-numeric id.", {
      pullRequestId: context.pullRequestId,
      workItemId: workItemRef.id,
    })
  }

  return workItemIds
})

const mapPullRequestWorkItemRefs = (
  workItemRefs: ReadonlyArray<{
    readonly id: string
    readonly url?: string | null | undefined
  }>,
): PullRequestWorkItemRef[] =>
  workItemRefs.map((workItemRef) => {
    let ref: PullRequestWorkItemRef = { id: workItemRef.id }

    if (workItemRef.url) ref = { ...ref, url: workItemRef.url }

    return ref
  })

/** Projects decoded sparse fields into prompt context, omitting unavailable enrichment values. */
const toPullRequestWorkItem = Effect.fn("AzureDevOpsClient.toPullRequestWorkItem")(function* ({
  workItem,
  titleMap,
  comments,
}: {
  readonly workItem: WorkItemBatchItem
  readonly titleMap: ReadonlyMap<number, string>
  readonly comments: PullRequestWorkItem["recentComments"]
}) {
  const descriptionMarkdown = yield* renderWorkItemMarkdown(
    normalizeOptionalString(workItem.fields?.["System.Description"]),
  )

  const acceptanceCriteriaMarkdown = yield* renderWorkItemMarkdown(
    normalizeOptionalString(workItem.fields?.["Microsoft.VSTS.Common.AcceptanceCriteria"]),
  )

  const reproStepsMarkdown = yield* renderWorkItemMarkdown(
    normalizeOptionalString(workItem.fields?.["Microsoft.VSTS.TCM.ReproSteps"]),
  )

  const parentRelations = readRelationWorkItemIds(workItem.relations, "System.LinkTypes.Hierarchy-Reverse")
  const relatedRelations = readRelationWorkItemIds(workItem.relations, "System.LinkTypes.Related")
  const priority = workItem.fields?.["Microsoft.VSTS.Common.Priority"]
  const assignedTo = readAssignedToDisplayName(workItem.fields?.["System.AssignedTo"])
  const iterationPath = normalizeOptionalString(workItem.fields?.["System.IterationPath"])
  const areaPath = normalizeOptionalString(workItem.fields?.["System.AreaPath"])
  const parentId = parentRelations[0]

  let item: PullRequestWorkItem = {
    id: workItem.id,
    title: normalizeOptionalString(workItem.fields?.["System.Title"]) ?? `Work item ${workItem.id}`,
    workItemType: normalizeOptionalString(workItem.fields?.["System.WorkItemType"]) ?? "Work Item",
    state: normalizeOptionalString(workItem.fields?.["System.State"]) ?? "Unknown",
    tags: splitTags(normalizeOptionalString(workItem.fields?.["System.Tags"])),
    related: relatedRelations.map((id) => {
      let relation: PullRequestWorkItem["related"][number] = { id }
      const title = titleMap.get(id)

      if (title) relation = { ...relation, title }

      return relation
    }),
    recentComments: comments,
  }

  if (priority !== undefined) item = { ...item, priority }

  if (assignedTo) item = { ...item, assignedTo }

  if (iterationPath) item = { ...item, iterationPath }

  if (areaPath) item = { ...item, areaPath }

  if (descriptionMarkdown) item = { ...item, descriptionMarkdown }

  if (acceptanceCriteriaMarkdown) item = { ...item, acceptanceCriteriaMarkdown }

  if (reproStepsMarkdown) item = { ...item, reproStepsMarkdown }

  if (parentId !== undefined) {
    let parent: NonNullable<PullRequestWorkItem["parent"]> = { id: parentId }
    const title = titleMap.get(parentId)

    if (title) parent = { ...parent, title }
    item = { ...item, parent }
  }

  return item
})

const makeAzureDevOpsClient = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient

  /** Resolves collection-scoped connection data with the same bearer token used to write PR comments. */
  const getAuthenticatedIdentity: AzureDevOpsClient["Service"]["getAuthenticatedIdentity"] = Effect.fn(
    "AzureDevOpsClient.getAuthenticatedIdentity",
  )(function* ({ context, token }: AzureRequestContext) {
    const client = makeAuthenticatedClient(normalizeCollectionUrl(context.collectionUrl), token, httpClient)
    // Microsoft uses this collection endpoint without a project segment or api-version query.
    // https://github.com/microsoft/azure-devops-mcp/blob/main/src/tools/auth.ts
    const request = HttpClientRequest.get("/_apis/connectionData")
    const connectionData = yield* executeJson(client, request, ConnectionDataResponseSchema)

    return connectionData.authenticatedUser.id
  })

  /** Fetches full work items with relations for the prompt, or only titles for relation enrichment. */
  const fetchWorkItemsBatch = Effect.fn("AzureDevOpsClient.fetchWorkItemsBatch")(function* ({
    context,
    token,
    ids,
    includeRelations,
  }: AzureRequestContext & {
    readonly ids: ReadonlyArray<number>
    readonly includeRelations: boolean
  }) {
    if (ids.length === 0) {
      return Array<WorkItemBatchItem>()
    }

    const client = makeAuthenticatedClient(buildProjectApiBaseUrl(context), token, httpClient)

    const request = HttpClientRequest.post("/wit/workitemsbatch").pipe(
      HttpClientRequest.setUrlParams({
        "api-version": "7.1",
      }),
    )

    const requestBody = {
      ids,
      errorPolicy: "omit",
      // Azure DevOps rejects workitemsbatch bodies that combine $expand=Relations with an explicit fields filter.
      ...(includeRelations ? { $expand: "Relations" } : { fields: ["System.Title"] }),
    }

    const requestWithBody = yield* HttpClientRequest.bodyJson(request, requestBody).pipe(
      Effect.mapError(toAzureDevOpsClientError(request)),
    )

    const response = yield* executeJson(client, requestWithBody, WorkItemsBatchResponseSchema)

    return response.value ?? []
  })

  const fetchWorkItemTitleMap = Effect.fn("AzureDevOpsClient.fetchWorkItemTitleMap")(function* ({
    context,
    token,
    ids,
  }: AzureRequestContext & {
    readonly ids: ReadonlyArray<number>
  }) {
    if (ids.length === 0) {
      return new Map<number, string>()
    }

    const items = yield* Effect.forEach(
      chunkIds(ids, MAX_WORK_ITEM_BATCH_IDS),
      (chunk) =>
        fetchWorkItemsBatch({
          context,
          token,
          ids: chunk,
          includeRelations: false,
        }),
      { concurrency: "unbounded" },
    ).pipe(Effect.map((chunks) => chunks.flat()))

    return new Map(
      items
        .map((item) => [item.id, normalizeOptionalString(item.fields?.["System.Title"])] as const)
        .filter((entry): entry is readonly [number, string] => entry[1] !== undefined),
    )
  })

  const fetchWorkItemComments = Effect.fn("AzureDevOpsClient.fetchWorkItemComments")(function* ({
    context,
    token,
    workItemId,
  }: AzureRequestContext & {
    readonly workItemId: number
  }) {
    const client = makeAuthenticatedClient(buildProjectApiBaseUrl(context), token, httpClient)

    const request = HttpClientRequest.get(`/wit/workItems/${workItemId}/comments`).pipe(
      HttpClientRequest.setUrlParams({
        $top: "20",
        order: "desc",
        $expand: "renderedText",
        "api-version": "7.1-preview.4",
      }),
    )

    const response = yield* executeJson(client, request, WorkItemCommentsResponseSchema)

    const comments = yield* Effect.forEach(
      response.comments ?? [],
      Effect.fn("AzureDevOpsClient.fetchWorkItemComments.map")(function* (comment) {
        if (comment.isDeleted === true) {
          return undefined
        }

        const markdown = comment.renderedText
          ? yield* renderWorkItemMarkdown(comment.renderedText)
          : yield* normalizeWorkItemMarkdown(comment.text)

        if (!markdown) {
          return undefined
        }

        return {
          author: normalizeOptionalString(comment.createdBy?.displayName ?? undefined) ?? "Unknown",
          createdAt: normalizeOptionalString(comment.createdDate ?? undefined) ?? "",
          markdown,
        }
      }),
      { concurrency: "unbounded" },
    )

    return comments
      .filter((comment): comment is NonNullable<typeof comment> => comment !== undefined)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, MAX_WORK_ITEM_COMMENTS)
  })

  const fetchSelectedWorkItems = Effect.fn("AzureDevOpsClient.fetchSelectedWorkItems")(function* ({
    context,
    token,
    ids,
  }: AzureRequestContext & {
    readonly ids: ReadonlyArray<number>
  }) {
    if (ids.length === 0) {
      return Array<WorkItemBatchItem>()
    }

    const selectedWorkItems: WorkItemBatchItem[] = []
    let index = 0

    while (index < ids.length && selectedWorkItems.length < MAX_CONNECTED_WORK_ITEMS) {
      const remainingSlots = MAX_CONNECTED_WORK_ITEMS - selectedWorkItems.length
      const chunk = ids.slice(index, index + remainingSlots)
      index += chunk.length

      const workItems = yield* fetchWorkItemsBatch({
        context,
        token,
        ids: chunk,
        includeRelations: true,
      })

      const workItemsById = new Map(workItems.map((workItem) => [workItem.id, workItem] as const))

      for (const workItemId of chunk) {
        const workItem = workItemsById.get(workItemId)

        if (!workItem) {
          continue
        }

        selectedWorkItems.push(workItem)

        if (selectedWorkItems.length >= MAX_CONNECTED_WORK_ITEMS) {
          break
        }
      }
    }

    return selectedWorkItems
  })

  const getPullRequestMetadata: AzureDevOpsClient["Service"]["getPullRequestMetadata"] = Effect.fn(
    "AzureDevOpsClient.getPullRequestMetadata",
  )(function* ({ context, token }: AzureRequestContext) {
    const client = makeAuthenticatedClient(buildProjectApiBaseUrl(context), token, httpClient)

    const request = HttpClientRequest.get(buildPullRequestPath(context)).pipe(
      HttpClientRequest.setUrlParams({
        includeWorkItemRefs: "true",
        "api-version": "7.1",
      }),
    )

    const metadata = yield* executeJson(client, request, PullRequestMetadataResponseSchema)

    const rawWorkItemRefs =
      metadata.workItemRefs ??
      (yield* withLoggedEmptyFallback(
        executeJson(
          client,
          HttpClientRequest.get(buildPullRequestWorkItemsPath(context)).pipe(
            HttpClientRequest.setUrlParams({
              "api-version": "7.1-preview.1",
            }),
          ),
          PullRequestWorkItemsResponseSchema,
        ),
        {
          onHttpMessage:
            "Failed to fetch linked pull-request work items from the fallback endpoint. Continuing without work items.",
          onDecodeMessage:
            "Failed to decode linked pull-request work items from the fallback endpoint. Continuing without work items.",
          fields: {
            pullRequestId: context.pullRequestId,
          },
          empty: [],
        },
      ))

    let result: PullRequestMetadata = {
      title: metadata.title,
      description: metadata.description ?? "",
      workItemRefs: mapPullRequestWorkItemRefs(rawWorkItemRefs),
    }

    const sourceRefName = normalizeOptionalString(metadata.sourceRefName)
    const targetRefName = normalizeOptionalString(metadata.targetRefName)
    const createdByDisplayName = normalizeOptionalString(metadata.createdBy?.displayName)
    const sourceCommitId = normalizeOptionalString(metadata.lastMergeSourceCommit?.commitId)

    if (metadata.pullRequestId !== null && metadata.pullRequestId !== undefined) {
      result = { ...result, pullRequestId: metadata.pullRequestId }
    }

    if (metadata.url) result = { ...result, url: metadata.url }

    if (sourceRefName) result = { ...result, sourceRefName }

    if (targetRefName) result = { ...result, targetRefName }

    if (createdByDisplayName) result = { ...result, createdByDisplayName }

    if (sourceCommitId) result = { ...result, sourceCommitId }

    if (metadata.repository) {
      let repository: NonNullable<PullRequestMetadata["repository"]> = {}
      const id = normalizeOptionalString(metadata.repository.id)
      const name = normalizeOptionalString(metadata.repository.name)
      const remoteUrl = normalizeOptionalString(metadata.repository.remoteUrl)
      const webUrl = normalizeOptionalString(metadata.repository.webUrl)

      if (id) repository = { ...repository, id }

      if (name) repository = { ...repository, name }

      if (remoteUrl) repository = { ...repository, remoteUrl }

      if (webUrl) repository = { ...repository, webUrl }
      result = { ...result, repository }
    }

    return result
  })

  /** Select a bounded, ordered prompt context and enrich each work item with optional titles and comments. */
  const getPullRequestWorkItems: AzureDevOpsClient["Service"]["getPullRequestWorkItems"] = Effect.fn(
    "AzureDevOpsClient.getPullRequestWorkItems",
  )(function* ({
    context,
    token,
    workItemRefs,
  }: AzureRequestContext & { readonly workItemRefs: ReadonlyArray<PullRequestWorkItemRef> }) {
    if (workItemRefs.length === 0) {
      return []
    }

    const workItemIds = yield* parseWorkItemIds({
      context,
      workItemRefs,
    })

    if (workItemIds.length === 0) {
      return []
    }

    const workItems = yield* fetchSelectedWorkItems({
      context,
      token,
      ids: workItemIds,
    })

    if (workItems.length === 0) {
      return []
    }

    const relatedIds = extractRelationTitleIds(workItems)

    const titleMap = yield* withLoggedEmptyFallback(
      fetchWorkItemTitleMap({
        context,
        token,
        ids: relatedIds,
      }),
      {
        onHttpMessage: "Failed to fetch linked work item titles. Continuing without relation titles.",
        onDecodeMessage: "Failed to decode linked work item titles. Continuing without relation titles.",
        fields: { referencedWorkItems: relatedIds.length },
        empty: new Map<number, string>(),
      },
    )

    // Selection is bounded to four items; forEach keeps their order while fetching comments concurrently.
    return yield* Effect.forEach(
      workItems,
      Effect.fn("AzureDevOpsClient.enrichWorkItem")(function* (workItem) {
        const comments = yield* withLoggedEmptyFallback(
          fetchWorkItemComments({
            context,
            token,
            workItemId: workItem.id,
          }),
          {
            onHttpMessage: "Failed to fetch work item comments. Continuing without comments for this work item.",
            onDecodeMessage: "Failed to decode work item comments. Continuing without comments for this work item.",
            fields: { workItemId: workItem.id },
            empty: [],
          },
        )

        return yield* toPullRequestWorkItem({
          workItem,
          titleMap,
          comments,
        })
      }),
      { concurrency: "unbounded" },
    )
  })

  const listThreads: AzureDevOpsClient["Service"]["listThreads"] = Effect.fn("AzureDevOpsClient.listThreads")(
    function* ({ context, token }: AzureRequestContext) {
      const client = makeAuthenticatedClient(buildProjectApiBaseUrl(context), token, httpClient)

      const request = HttpClientRequest.get(`${buildPullRequestPath(context)}/threads`).pipe(
        HttpClientRequest.setUrlParams({
          "api-version": "7.1",
        }),
      )

      const response = yield* executeJson(client, request, ExistingThreadsResponseSchema)

      return response.value ?? []
    },
  )

  const updateThreadStatus: AzureDevOpsClient["Service"]["updateThreadStatus"] = Effect.fn(
    "AzureDevOpsClient.updateThreadStatus",
  )(function* ({ context, token, threadId, status }: UpdateThreadStatusInput) {
    const client = makeAuthenticatedClient(buildProjectApiBaseUrl(context), token, httpClient)

    const request = HttpClientRequest.patch(`${buildPullRequestPath(context)}/threads/${threadId}`).pipe(
      HttpClientRequest.setUrlParams({
        "api-version": "7.1",
      }),
    )

    const requestWithBody = yield* HttpClientRequest.bodyJson(request, { status }).pipe(
      Effect.mapError(toAzureDevOpsClientError(request)),
    )

    yield* executeOk(client, requestWithBody)
  })

  const updateComment: AzureDevOpsClient["Service"]["updateComment"] = Effect.fn("AzureDevOpsClient.updateComment")(
    function* ({ context, token, threadId, commentId, content }: UpdateCommentInput) {
      const client = makeAuthenticatedClient(buildProjectApiBaseUrl(context), token, httpClient)

      const request = HttpClientRequest.patch(
        `${buildPullRequestPath(context)}/threads/${threadId}/comments/${commentId}`,
      ).pipe(
        HttpClientRequest.setUrlParams({
          "api-version": "7.1",
        }),
      )

      const requestWithBody = yield* HttpClientRequest.bodyJson(request, { content }).pipe(
        Effect.mapError(toAzureDevOpsClientError(request)),
      )

      yield* executeOk(client, requestWithBody)
    },
  )

  const createThread: AzureDevOpsClient["Service"]["createThread"] = Effect.fn("AzureDevOpsClient.createThread")(
    function* ({ context, token, content, threadContext, status = 1 }: CreateThreadInput) {
      const client = makeAuthenticatedClient(buildProjectApiBaseUrl(context), token, httpClient)

      const request = HttpClientRequest.post(`${buildPullRequestPath(context)}/threads`).pipe(
        HttpClientRequest.setUrlParams({
          "api-version": "7.1",
        }),
      )

      const requestWithBody = yield* HttpClientRequest.bodyJson(request, {
        comments: [
          {
            parentCommentId: 0,
            content,
            commentType: 1,
          },
        ],
        status,
        threadContext,
      }).pipe(Effect.mapError(toAzureDevOpsClientError(request)))

      yield* executeOk(client, requestWithBody)
    },
  )

  return AzureDevOpsClient.of({
    getAuthenticatedIdentity,
    getPullRequestMetadata,
    getPullRequestWorkItems,
    listThreads,
    updateThreadStatus,
    updateComment,
    createThread,
  })
})

export const AzureDevOpsClientLive = Layer.effect(AzureDevOpsClient, makeAzureDevOpsClient).pipe(
  Layer.provide(Layer.fresh(FetchHttpClient.layer)),
)
