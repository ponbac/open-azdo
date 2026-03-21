import { Effect, Layer, Redacted, Schema } from "effect"

import { parseJsonUnknown, stringifyJson } from "@open-azdo/core/json"
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
  type ExistingThreadsResponse,
  type WorkItemCommentsResponse,
  type WorkItemsBatchResponse,
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
const MAX_RELATED_TITLES = 4
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

const createHeaders = (token: Redacted.Redacted<string>) => ({
  authorization: `Bearer ${Redacted.value(token)}`,
  "content-type": "application/json",
})

const buildPullRequestUrl = (context: AzureContext) =>
  `${context.collectionUrl.replace(/\/+$/, "")}/${encodeURIComponent(context.project)}/_apis/git/repositories/${encodeURIComponent(
    context.repositoryId,
  )}/pullRequests/${context.pullRequestId}`

type WorkItemEndpoint = {
  readonly collectionUrl: string
  readonly project: string
}

type WorkItemRequestTarget = WorkItemEndpoint & {
  readonly workItemId: number
}

const buildDefaultWorkItemEndpoint = (context: AzureContext): WorkItemEndpoint => ({
  collectionUrl: context.collectionUrl.replace(/\/+$/, ""),
  project: context.project,
})

const buildWorkItemsBatchUrl = (endpoint: WorkItemEndpoint) =>
  `${endpoint.collectionUrl}/${encodeURIComponent(endpoint.project)}/_apis/wit/workitemsbatch?api-version=7.1`

const buildWorkItemCommentsUrl = (target: WorkItemRequestTarget) =>
  `${target.collectionUrl}/${encodeURIComponent(target.project)}/_apis/wit/workItems/${target.workItemId}/comments?$top=20&$expand=renderedText&api-version=7.1-preview.4`

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

const readNumberField = (fields: Record<string, unknown> | undefined, key: string) => {
  return parseIntegerLike(fields?.[key])
}

const toWorkItemRequestTarget = (endpoint: WorkItemEndpoint, workItemId: number): WorkItemRequestTarget => ({
  ...endpoint,
  workItemId,
})

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

    const workItemId = parseIntegerLike(segments[apisIndex + 3])
    if (workItemId === undefined) {
      return undefined
    }

    return workItemId
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

const isTitleRelationType = (relationType: string | null | undefined) =>
  relationType === "System.LinkTypes.Hierarchy-Reverse" || relationType === "System.LinkTypes.Related"

const extractRelationTargets = (
  items: ReadonlyArray<WorkItemBatchItem>,
  defaultEndpoint: WorkItemEndpoint,
): ReadonlyArray<WorkItemRequestTarget> => {
  const relatedTargets = new Map<string, WorkItemRequestTarget>()

  for (const item of items) {
    for (const relation of item.relations ?? []) {
      if (!isTitleRelationType(relation.rel)) {
        continue
      }

      const relationId = readRelationWorkItemId(relation)

      if (relationId !== undefined) {
        const relationTarget = toWorkItemRequestTarget(defaultEndpoint, relationId)
        relatedTargets.set(
          `${relationTarget.collectionUrl}::${relationTarget.project}::${relationTarget.workItemId}`,
          relationTarget,
        )
      }
    }
  }

  return [...relatedTargets.values()]
}

const extractRenderedRelations = (relations: WorkItemBatchItem["relations"]) => [
  ...(relations ?? []).filter((relation) => relation.rel === "System.LinkTypes.Hierarchy-Reverse").slice(0, 1),
  ...(relations ?? []).filter((relation) => relation.rel === "System.LinkTypes.Related").slice(0, MAX_RELATED_TITLES),
]

const extractRenderedRelationTargets = (
  items: ReadonlyArray<WorkItemBatchItem>,
  defaultEndpoint: WorkItemEndpoint,
): ReadonlyArray<WorkItemRequestTarget> =>
  extractRelationTargets(
    items.map((item) => ({
      ...item,
      relations: extractRenderedRelations(item.relations),
    })),
    defaultEndpoint,
  )

const chunkIds = (ids: ReadonlyArray<number>, size: number) => {
  const chunks: number[][] = []

  for (let index = 0; index < ids.length; index += size) {
    chunks.push(ids.slice(index, index + size))
  }

  return chunks
}

const groupTargetsByEndpoint = <T extends WorkItemRequestTarget>(targets: ReadonlyArray<T>) => {
  const groups = new Map<string, { endpoint: WorkItemEndpoint; targets: T[] }>()

  for (const target of targets) {
    const key = `${target.collectionUrl}::${target.project}`
    const group = groups.get(key)
    if (group) {
      group.targets.push(target)
      continue
    }

    groups.set(key, {
      endpoint: {
        collectionUrl: target.collectionUrl,
        project: target.project,
      },
      targets: [target],
    })
  }

  return [...groups.values()]
}

const parseSelectedWorkItemTargets = Effect.fn("AzureDevOpsClient.parseSelectedWorkItemTargets")(function* ({
  context,
  workItemRefs,
}: {
  readonly context: AzureContext
  readonly workItemRefs: ReadonlyArray<PullRequestWorkItemRef>
}) {
  const defaultEndpoint = buildDefaultWorkItemEndpoint(context)
  const selectedTargets: WorkItemRequestTarget[] = []

  for (const workItemRef of workItemRefs.slice(0, MAX_CONNECTED_WORK_ITEMS)) {
    const parsed = Number.parseInt(workItemRef.id, 10)

    if (Number.isFinite(parsed)) {
      selectedTargets.push(
        toWorkItemRequestTarget(
          defaultEndpoint,
          parseWorkItemIdFromUrl(normalizeOptionalString(workItemRef.url)) ?? parsed,
        ),
      )
      continue
    }

    yield* logInfo("Ignoring pull-request work item ref with a non-numeric id.", {
      pullRequestId: context.pullRequestId,
      workItemId: workItemRef.id,
    })
  }

  return selectedTargets
})

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

const requestUnknown = Effect.fn("AzureDevOpsClient.requestUnknown")(function* (url: string, init: RequestInit) {
  const text = yield* Effect.tryPromise({
    try: async () => {
      const response = await globalThis.fetch(url, init)
      const responseText = await response.text()

      if (!response.ok) {
        throw new AzureDevOpsHttpError({
          message: `Azure DevOps request failed with status ${response.status}.`,
          url,
          status: response.status,
          body: responseText,
        })
      }

      return responseText
    },
    catch: (error) => {
      if (error instanceof AzureDevOpsHttpError) {
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

  if (!text) {
    return {}
  }

  return yield* parseJsonUnknown(text).pipe(
    Effect.mapError(
      (error) =>
        new AzureDevOpsDecodeError({
          message: error.message,
          url,
          body: text,
          issues: [error.message],
        }),
    ),
  )
})

const toDecodeError = (url: string, payload: unknown, error: unknown) =>
  new AzureDevOpsDecodeError({
    message: "Azure DevOps response did not match the expected schema.",
    url,
    body: stringifyJson(payload),
    issues: [String(error)],
  })

const requestSchemaWithBody = <A>(
  url: string,
  init: RequestInit,
  schema: Schema.Schema<A>,
): Effect.Effect<A, AzureDevOpsHttpError | AzureDevOpsDecodeError> =>
  requestUnknown(url, init).pipe(
    Effect.flatMap((payload) =>
      Effect.try({
        try: () => Schema.decodeUnknownSync(schema as never)(payload) as A,
        catch: (error) => toDecodeError(url, payload, error),
      }),
    ),
  )

const makeAzureDevOpsClient = Effect.sync(() => {
  const getPullRequestMetadata: AzureDevOpsClient["Service"]["getPullRequestMetadata"] = Effect.fn(
    "AzureDevOpsClient.getPullRequestMetadata",
  )(function* ({ context, token }: AzureRequestContext) {
    const url = `${buildPullRequestUrl(context)}?includeWorkItemRefs=true&api-version=7.1`
    const metadata: Schema.Schema.Type<typeof PullRequestMetadataResponseSchema> = yield* requestSchemaWithBody(
      url,
      { method: "GET", headers: createHeaders(token) },
      PullRequestMetadataResponseSchema,
    )

    return {
      title: metadata.title,
      description: metadata.description ?? "",
      ...(metadata.url ? { url: metadata.url } : {}),
      workItemRefs: (metadata.workItemRefs ?? []).map((workItemRef) => ({
        id: workItemRef.id,
        ...(workItemRef.url ? { url: workItemRef.url } : {}),
      })),
    }
  })

  const fetchWorkItemsBatch = Effect.fn("AzureDevOpsClient.fetchWorkItemsBatch")(function* ({
    token,
    endpoint,
    ids,
    fields,
    includeRelations,
  }: Pick<AzureRequestContext, "token"> & {
    readonly endpoint: WorkItemEndpoint
    readonly ids: ReadonlyArray<number>
    readonly fields: ReadonlyArray<string>
    readonly includeRelations: boolean
  }) {
    if (ids.length === 0) {
      return [] as WorkItemBatchItem[]
    }

    const response: WorkItemsBatchResponse = yield* requestSchemaWithBody(
      buildWorkItemsBatchUrl(endpoint),
      {
        method: "POST",
        headers: createHeaders(token),
        body: stringifyJson({
          ids,
          fields,
          errorPolicy: "omit",
          ...(includeRelations ? { $expand: "Relations" } : {}),
        }),
      },
      WorkItemsBatchResponseSchema,
    )

    return response.value ?? []
  })

  const fetchWorkItemTitleMap = Effect.fn("AzureDevOpsClient.fetchWorkItemTitleMap")(function* ({
    token,
    targets,
  }: Pick<AzureRequestContext, "token"> & {
    readonly targets: ReadonlyArray<WorkItemRequestTarget>
  }) {
    const items = yield* Effect.forEach(
      groupTargetsByEndpoint(targets),
      ({ endpoint, targets: endpointTargets }) =>
        Effect.forEach(
          chunkIds(
            endpointTargets.map((target) => target.workItemId),
            MAX_WORK_ITEM_BATCH_IDS,
          ),
          (chunk) =>
            fetchWorkItemsBatch({
              token,
              endpoint,
              ids: chunk,
              fields: ["System.Title"],
              includeRelations: false,
            }),
          { concurrency: "unbounded" },
        ),
      { concurrency: "unbounded" },
    ).pipe(Effect.map((chunks) => chunks.flat(2)))

    return new Map(
      items
        .map((item) => [item.id, readStringField(item.fields, "System.Title")] as const)
        .filter((entry): entry is readonly [number, string] => entry[1] !== undefined),
    )
  })

  const fetchWorkItemComments = Effect.fn("AzureDevOpsClient.fetchWorkItemComments")(function* ({
    token,
    target,
  }: Pick<AzureRequestContext, "token"> & {
    readonly target: WorkItemRequestTarget
  }) {
    const response: WorkItemCommentsResponse = yield* requestSchemaWithBody(
      buildWorkItemCommentsUrl(target),
      { method: "GET", headers: createHeaders(token) },
      WorkItemCommentsResponseSchema,
    )

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

    const selectedTargets = yield* parseSelectedWorkItemTargets({
      context,
      workItemRefs,
    })

    if (selectedTargets.length === 0) {
      return []
    }

    const workItems = yield* Effect.forEach(
      groupTargetsByEndpoint(selectedTargets),
      ({ endpoint, targets }) =>
        fetchWorkItemsBatch({
          token,
          endpoint,
          ids: targets.map((target) => target.workItemId),
          fields: WORK_ITEM_FIELDS,
          includeRelations: true,
        }),
      { concurrency: "unbounded" },
    ).pipe(Effect.map((chunks) => chunks.flat()))

    const workItemsById = new Map(workItems.map((workItem) => [workItem.id, workItem] as const))
    const relatedTargets = extractRenderedRelationTargets(workItems, buildDefaultWorkItemEndpoint(context))
    const titleMap = yield* withLoggedEmptyFallback(
      fetchWorkItemTitleMap({
        token,
        targets: relatedTargets,
      }),
      {
        onHttpMessage: "Failed to fetch linked work item titles. Continuing without relation titles.",
        onDecodeMessage: "Failed to decode linked work item titles. Continuing without relation titles.",
        fields: { referencedWorkItems: relatedTargets.length },
        empty: new Map<number, string>(),
      },
    )

    const commentsByWorkItem = new Map(
      yield* Effect.forEach(
        selectedTargets,
        Effect.fn("AzureDevOpsClient.getPullRequestWorkItems.comments")(function* (target) {
          const comments = yield* withLoggedEmptyFallback(
            fetchWorkItemComments({
              token,
              target,
            }),
            {
              onHttpMessage: "Failed to fetch work item comments. Continuing without comments for this work item.",
              onDecodeMessage: "Failed to decode work item comments. Continuing without comments for this work item.",
              fields: { workItemId: target.workItemId, project: target.project },
              empty: [],
            },
          )

          return [target.workItemId, comments] as const
        }),
        { concurrency: "unbounded" },
      ),
    )

    const pullRequestWorkItems: PullRequestWorkItem[] = []

    for (const { workItemId } of selectedTargets) {
      const workItem = workItemsById.get(workItemId)
      if (!workItem) {
        continue
      }

      pullRequestWorkItems.push(
        yield* toPullRequestWorkItem({
          workItem,
          titleMap,
          comments: commentsByWorkItem.get(workItemId) ?? [],
        }),
      )
    }

    return pullRequestWorkItems
  })

  const listThreads: AzureDevOpsClient["Service"]["listThreads"] = Effect.fn("AzureDevOpsClient.listThreads")(
    function* ({ context, token }: AzureRequestContext) {
      const response: ExistingThreadsResponse = yield* requestSchemaWithBody(
        `${buildPullRequestUrl(context)}/threads?api-version=7.1`,
        { method: "GET", headers: createHeaders(token) },
        ExistingThreadsResponseSchema,
      )

      return response.value ?? []
    },
  )

  const updateThreadStatus: AzureDevOpsClient["Service"]["updateThreadStatus"] = Effect.fn(
    "AzureDevOpsClient.updateThreadStatus",
  )(function* ({ context, token, threadId, status }: UpdateThreadStatusInput) {
    yield* requestUnknown(`${buildPullRequestUrl(context)}/threads/${threadId}?api-version=7.1`, {
      method: "PATCH",
      headers: createHeaders(token),
      body: stringifyJson({ status }),
    })
  })

  const updateComment: AzureDevOpsClient["Service"]["updateComment"] = Effect.fn("AzureDevOpsClient.updateComment")(
    function* ({ context, token, threadId, commentId, content }: UpdateCommentInput) {
      yield* requestUnknown(
        `${buildPullRequestUrl(context)}/threads/${threadId}/comments/${commentId}?api-version=7.1`,
        {
          method: "PATCH",
          headers: createHeaders(token),
          body: stringifyJson({ content }),
        },
      )
    },
  )

  const createThread: AzureDevOpsClient["Service"]["createThread"] = Effect.fn("AzureDevOpsClient.createThread")(
    function* ({ context, token, content, threadContext }: CreateThreadInput) {
      yield* requestUnknown(`${buildPullRequestUrl(context)}/threads?api-version=7.1`, {
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
      })
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

export const AzureDevOpsClientLive = Layer.effect(AzureDevOpsClient, makeAzureDevOpsClient)
