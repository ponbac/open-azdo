import { Effect, Layer, Schema, type Redacted } from "effect"
import {
  FetchHttpClient,
  HttpClient,
  HttpClientError,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/unstable/http"

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
  ExistingThreadsResponseSchema,
  PullRequestMetadataResponseSchema,
  PullRequestWorkItemsResponseSchema,
  WorkItemCommentsResponseSchema,
  WorkItemsBatchResponseSchema,
  readAssignedToDisplayName,
  type PullRequestWorkItem,
  type PullRequestWorkItemRef,
  type WorkItemBatchItem,
} from "../Schemas"

const MAX_CONNECTED_WORK_ITEMS = 4
const MAX_WORK_ITEM_COMMENTS = 3
const MAX_WORK_ITEM_BATCH_IDS = 200
const MAX_RELATED_TITLES_PER_WORK_ITEM = 4
const WORK_ITEM_FIELDS = [
  "System.Id",
  "System.Title",
  "System.WorkItemType",
  "System.State",
  "Microsoft.VSTS.Common.Priority",
  "System.AssignedTo",
  "System.Description",
  "Microsoft.VSTS.Common.AcceptanceCriteria",
  "Microsoft.VSTS.TCM.ReproSteps",
  "System.IterationPath",
  "System.AreaPath",
  "System.Tags",
] as const

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

const readStringField = (fields: Record<string, unknown> | undefined, key: string) => {
  const value = fields?.[key]
  return typeof value === "string" ? normalizeOptionalString(value) : undefined
}

const parseIntegerLike = (value: unknown) => {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const parsed = Number.parseInt(value, 10)
    return Number.isFinite(parsed) ? parsed : undefined
  }

  return undefined
}

const readNumberField = (fields: Record<string, unknown> | undefined, key: string) => parseIntegerLike(fields?.[key])

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

    return parseIntegerLike(segments[apisIndex + 3])
  } catch {
    return undefined
  }
}

const readRelationWorkItemId = (relation: NonNullable<WorkItemBatchItem["relations"]>[number]) =>
  parseWorkItemIdFromUrl(normalizeOptionalString(relation.url ?? undefined)) ??
  parseIntegerLike(relation.attributes?.id)

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

const makeProjectClient = (
  context: AzureContext,
  token: Redacted.Redacted<string>,
  httpClient: HttpClient.HttpClient,
) =>
  httpClient.pipe(
    HttpClient.mapRequest((request) =>
      request.pipe(
        HttpClientRequest.prependUrl(buildProjectApiBaseUrl(context)),
        HttpClientRequest.bearerToken(token),
        HttpClientRequest.acceptJson,
      ),
    ),
  )

const toAzureDevOpsClientError =
  (request: HttpClientRequest.HttpClientRequest) =>
  (error: unknown): AzureDevOpsHttpError | AzureDevOpsDecodeError => {
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
    readonly fields: Record<string, unknown>
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
    const parsedId = parseIntegerLike(workItemRef.id)
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
  workItemRefs.map((workItemRef) => ({
    id: workItemRef.id,
    ...(workItemRef.url ? { url: workItemRef.url } : {}),
  }))

const toPullRequestWorkItem = Effect.fn("AzureDevOpsClient.toPullRequestWorkItem")(function* ({
  workItem,
  titleMap,
  comments,
}: {
  readonly workItem: WorkItemBatchItem
  readonly titleMap: ReadonlyMap<number, string>
  readonly comments: PullRequestWorkItem["recentComments"]
}) {
  const descriptionMarkdown = yield* renderWorkItemMarkdown(readStringField(workItem.fields, "System.Description"))
  const acceptanceCriteriaMarkdown = yield* renderWorkItemMarkdown(
    readStringField(workItem.fields, "Microsoft.VSTS.Common.AcceptanceCriteria"),
  )
  const reproStepsMarkdown = yield* renderWorkItemMarkdown(
    readStringField(workItem.fields, "Microsoft.VSTS.TCM.ReproSteps"),
  )

  const parentRelations = readRelationWorkItemIds(workItem.relations, "System.LinkTypes.Hierarchy-Reverse")
  const relatedRelations = readRelationWorkItemIds(workItem.relations, "System.LinkTypes.Related")
  const priority = readNumberField(workItem.fields, "Microsoft.VSTS.Common.Priority")
  const assignedTo = readAssignedToDisplayName(workItem.fields?.["System.AssignedTo"])
  const iterationPath = readStringField(workItem.fields, "System.IterationPath")
  const areaPath = readStringField(workItem.fields, "System.AreaPath")
  const parentId = parentRelations[0]

  return {
    id: workItem.id,
    title: readStringField(workItem.fields, "System.Title") ?? `Work item ${workItem.id}`,
    workItemType: readStringField(workItem.fields, "System.WorkItemType") ?? "Work Item",
    state: readStringField(workItem.fields, "System.State") ?? "Unknown",
    ...(priority !== undefined ? { priority } : {}),
    ...(assignedTo ? { assignedTo } : {}),
    ...(iterationPath ? { iterationPath } : {}),
    ...(areaPath ? { areaPath } : {}),
    tags: splitTags(readStringField(workItem.fields, "System.Tags")),
    ...(descriptionMarkdown ? { descriptionMarkdown } : {}),
    ...(acceptanceCriteriaMarkdown ? { acceptanceCriteriaMarkdown } : {}),
    ...(reproStepsMarkdown ? { reproStepsMarkdown } : {}),
    ...(parentId !== undefined
      ? {
          parent: {
            id: parentId,
            ...(titleMap.get(parentId) ? { title: titleMap.get(parentId) } : {}),
          },
        }
      : {}),
    related: relatedRelations.map((id) => ({
      id,
      ...(titleMap.get(id) ? { title: titleMap.get(id) } : {}),
    })),
    recentComments: comments,
  } satisfies PullRequestWorkItem
})

const makeAzureDevOpsClient = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient

  const fetchWorkItemsBatch = Effect.fn("AzureDevOpsClient.fetchWorkItemsBatch")(function* ({
    context,
    token,
    ids,
    fields,
    includeRelations,
  }: AzureRequestContext & {
    readonly ids: ReadonlyArray<number>
    readonly fields: ReadonlyArray<string>
    readonly includeRelations: boolean
  }) {
    if (ids.length === 0) {
      return [] as WorkItemBatchItem[]
    }

    const client = makeProjectClient(context, token, httpClient)
    const request = HttpClientRequest.post("/wit/workitemsbatch").pipe(
      HttpClientRequest.setUrlParams({
        "api-version": "7.1",
      }),
    )
    const requestBody = {
      ids,
      errorPolicy: "omit",
      // Azure DevOps rejects workitemsbatch bodies that combine $expand=Relations with an explicit fields filter.
      ...(includeRelations ? { $expand: "Relations" } : { fields }),
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
          fields: ["System.Title"],
          includeRelations: false,
        }),
      { concurrency: "unbounded" },
    ).pipe(Effect.map((chunks) => chunks.flat()))

    return new Map(
      items
        .map((item) => [item.id, readStringField(item.fields, "System.Title")] as const)
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
    const client = makeProjectClient(context, token, httpClient)
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
      return [] as WorkItemBatchItem[]
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
        fields: WORK_ITEM_FIELDS,
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
    const client = makeProjectClient(context, token, httpClient)
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

    return {
      ...(metadata.pullRequestId !== null && metadata.pullRequestId !== undefined
        ? { pullRequestId: metadata.pullRequestId }
        : {}),
      title: metadata.title,
      description: metadata.description ?? "",
      ...(metadata.url ? { url: metadata.url } : {}),
      ...(normalizeOptionalString(metadata.sourceRefName ?? undefined)
        ? { sourceRefName: normalizeOptionalString(metadata.sourceRefName ?? undefined) }
        : {}),
      ...(normalizeOptionalString(metadata.targetRefName ?? undefined)
        ? { targetRefName: normalizeOptionalString(metadata.targetRefName ?? undefined) }
        : {}),
      ...(normalizeOptionalString(metadata.createdBy?.displayName ?? undefined)
        ? { createdByDisplayName: normalizeOptionalString(metadata.createdBy?.displayName ?? undefined) }
        : {}),
      ...(metadata.repository
        ? {
            repository: {
              ...(normalizeOptionalString(metadata.repository.id ?? undefined)
                ? { id: normalizeOptionalString(metadata.repository.id ?? undefined) }
                : {}),
              ...(normalizeOptionalString(metadata.repository.name ?? undefined)
                ? { name: normalizeOptionalString(metadata.repository.name ?? undefined) }
                : {}),
              ...(normalizeOptionalString(metadata.repository.remoteUrl ?? undefined)
                ? { remoteUrl: normalizeOptionalString(metadata.repository.remoteUrl ?? undefined) }
                : {}),
              ...(normalizeOptionalString(metadata.repository.webUrl ?? undefined)
                ? { webUrl: normalizeOptionalString(metadata.repository.webUrl ?? undefined) }
                : {}),
            },
          }
        : {}),
      ...(normalizeOptionalString(metadata.lastMergeSourceCommit?.commitId ?? undefined)
        ? { sourceCommitId: normalizeOptionalString(metadata.lastMergeSourceCommit?.commitId ?? undefined) }
        : {}),
      workItemRefs: mapPullRequestWorkItemRefs(rawWorkItemRefs),
    }
  })

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

    const selectedIds = workItems.map((workItem) => workItem.id)
    const workItemsById = new Map(workItems.map((workItem) => [workItem.id, workItem] as const))
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
    const commentsByWorkItem = new Map(
      yield* Effect.forEach(
        selectedIds,
        (workItemId) =>
          withLoggedEmptyFallback(
            fetchWorkItemComments({
              context,
              token,
              workItemId,
            }),
            {
              onHttpMessage: "Failed to fetch work item comments. Continuing without comments for this work item.",
              onDecodeMessage: "Failed to decode work item comments. Continuing without comments for this work item.",
              fields: { workItemId },
              empty: [],
            },
          ).pipe(Effect.map((comments) => [workItemId, comments] as const)),
        { concurrency: "unbounded" },
      ),
    )

    const items: PullRequestWorkItem[] = []

    for (const workItemId of selectedIds) {
      const workItem = workItemsById.get(workItemId)
      if (!workItem) {
        continue
      }

      items.push(
        yield* toPullRequestWorkItem({
          workItem,
          titleMap,
          comments: commentsByWorkItem.get(workItemId) ?? [],
        }),
      )
    }

    return items
  })

  const listThreads: AzureDevOpsClient["Service"]["listThreads"] = Effect.fn("AzureDevOpsClient.listThreads")(
    function* ({ context, token }: AzureRequestContext) {
      const client = makeProjectClient(context, token, httpClient)
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
    const client = makeProjectClient(context, token, httpClient)
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
      const client = makeProjectClient(context, token, httpClient)
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
    function* ({ context, token, content, threadContext }: CreateThreadInput) {
      const client = makeProjectClient(context, token, httpClient)
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
        status: 1,
        threadContext,
      }).pipe(Effect.mapError(toAzureDevOpsClientError(request)))

      yield* executeOk(client, requestWithBody)
    },
  )

  return {
    getPullRequestMetadata,
    getPullRequestWorkItems,
    listThreads,
    updateThreadStatus,
    updateComment,
    createThread,
  }
})

export const AzureDevOpsClientLive = Layer.effect(AzureDevOpsClient, makeAzureDevOpsClient).pipe(
  Layer.provide(Layer.fresh(FetchHttpClient.layer)),
)
