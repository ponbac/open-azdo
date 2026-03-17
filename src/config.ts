import { Effect, Redacted, Schema } from "effect"

import { ConfigError } from "./errors"

const NonEmptyString = Schema.String.check(Schema.isMinLength(1))
const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0))

export type ReviewConfig = {
  command: "review"
  model: string
  workspace: string
  organization: string
  project: string
  repositoryId: string
  pullRequestId: number
  collectionUrl: string
  agent: string
  promptFile: string | undefined
  dryRun: boolean
  json: boolean
  systemAccessToken: Redacted.Redacted<string>
  targetBranch: string | undefined
  sourceVersion: string | undefined
  buildId: string | undefined
  buildNumber: string | undefined
  buildUri: string | undefined
}

export type AzureContext = {
  organization: string
  project: string
  collectionUrl: string
  repositoryId: string
  pullRequestId: number
  buildId: string | undefined
  buildNumber: string | undefined
  buildUri: string | undefined
  sourceVersion: string | undefined
  targetBranch: string | undefined
}

const RawReviewConfigSchema = Schema.Struct({
  command: Schema.Literal("review"),
  model: NonEmptyString,
  workspace: NonEmptyString,
  organization: NonEmptyString,
  project: NonEmptyString,
  repositoryId: NonEmptyString,
  pullRequestId: PositiveInt,
  collectionUrl: NonEmptyString,
  agent: NonEmptyString,
  promptFile: Schema.optionalKey(NonEmptyString),
  dryRun: Schema.Boolean,
  json: Schema.Boolean,
  systemAccessToken: NonEmptyString,
  targetBranch: Schema.optionalKey(NonEmptyString),
  sourceVersion: Schema.optionalKey(NonEmptyString),
  buildId: Schema.optionalKey(NonEmptyString),
  buildNumber: Schema.optionalKey(NonEmptyString),
  buildUri: Schema.optionalKey(NonEmptyString),
})

type RawReviewConfig = Schema.Schema.Type<typeof RawReviewConfigSchema>

export const loadReviewConfig = Effect.fn("config.loadReviewConfig")(function* (
  argv: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
) {
  const parsedArgs = parseArgs(argv)

  if (parsedArgs.command !== "review") {
    return yield* new ConfigError({
      message: "Only the `review` subcommand is supported in v1.",
      issues: ["Usage: open-azdo review --model <provider/model>"],
    })
  }

  const collectionUrl =
    readStringFlag(parsedArgs.flags, "collection-url") ?? env.OPEN_AZDO_COLLECTION_URL ?? env.SYSTEM_COLLECTIONURI
  const organization =
    readStringFlag(parsedArgs.flags, "organization") ??
    env.OPEN_AZDO_ORGANIZATION ??
    inferOrganizationFromCollectionUrl(collectionUrl ?? "")

  const rawConfig = yield* Effect.try({
    try: () =>
      Schema.decodeUnknownSync(RawReviewConfigSchema)(
        compactOptionalKeys({
          command: "review",
          model: readStringFlag(parsedArgs.flags, "model") ?? env.OPEN_AZDO_MODEL,
          workspace:
            readStringFlag(parsedArgs.flags, "workspace") ?? env.OPEN_AZDO_WORKSPACE ?? env.BUILD_SOURCESDIRECTORY,
          organization,
          project: readStringFlag(parsedArgs.flags, "project") ?? env.OPEN_AZDO_PROJECT ?? env.SYSTEM_TEAMPROJECT,
          repositoryId:
            readStringFlag(parsedArgs.flags, "repository-id") ?? env.OPEN_AZDO_REPOSITORY_ID ?? env.BUILD_REPOSITORY_ID,
          pullRequestId: toPositiveInt(
            readStringFlag(parsedArgs.flags, "pull-request-id") ??
              env.OPEN_AZDO_PULL_REQUEST_ID ??
              env.SYSTEM_PULLREQUEST_PULLREQUESTID,
          ),
          collectionUrl,
          agent: readStringFlag(parsedArgs.flags, "agent") ?? env.OPEN_AZDO_AGENT ?? "azdo-review",
          promptFile: readStringFlag(parsedArgs.flags, "prompt-file") ?? env.OPEN_AZDO_PROMPT_FILE,
          dryRun: readBooleanFlag(parsedArgs.flags, "dry-run"),
          json: readBooleanFlag(parsedArgs.flags, "json"),
          systemAccessToken: env.SYSTEM_ACCESSTOKEN,
          targetBranch: env.SYSTEM_PULLREQUEST_TARGETBRANCH,
          sourceVersion: env.BUILD_SOURCEVERSION,
          buildId: env.BUILD_BUILDID,
          buildNumber: env.BUILD_BUILDNUMBER,
          buildUri: env.BUILD_BUILDURI,
        }),
      ),
    catch: (error) =>
      new ConfigError({
        message: "Invalid CLI flags or environment configuration.",
        issues: [String(error)],
      }),
  })

  yield* validateCollectionUrl(rawConfig.collectionUrl)

  return toReviewConfig(rawConfig)
})

export const createAzureContext = (config: ReviewConfig): AzureContext => ({
  organization: config.organization,
  project: config.project,
  collectionUrl: stripTrailingSlash(config.collectionUrl),
  repositoryId: config.repositoryId,
  pullRequestId: config.pullRequestId,
  buildId: config.buildId,
  buildNumber: config.buildNumber,
  buildUri: config.buildUri,
  sourceVersion: config.sourceVersion,
  targetBranch: config.targetBranch,
})

export const inferOrganizationFromCollectionUrl = (collectionUrl: string) => {
  if (!collectionUrl) {
    return ""
  }

  try {
    const url = new URL(collectionUrl)
    const parts = url.pathname.split("/").filter(Boolean)

    if (url.hostname === "dev.azure.com") {
      return parts[0] ?? ""
    }

    if (parts[0]?.toLowerCase() === "tfs") {
      return parts[1] ?? ""
    }

    return parts[0] ?? ""
  } catch {
    return ""
  }
}

type ParsedArgs = {
  command: string | undefined
  flags: Record<string, string | boolean>
}

export const parseArgs = (argv: ReadonlyArray<string>): ParsedArgs => {
  const [command, ...rest] = argv
  const flags: Record<string, string | boolean> = {}

  for (let index = 0; index < rest.length; index += 1) {
    const entry = rest[index]
    if (!entry?.startsWith("--")) {
      continue
    }

    const key = entry.slice(2)
    const next = rest[index + 1]

    if (next && !next.startsWith("--")) {
      flags[key] = next
      index += 1
      continue
    }

    flags[key] = true
  }

  return { command, flags }
}

const toReviewConfig = (rawConfig: RawReviewConfig): ReviewConfig => ({
  command: rawConfig.command,
  model: rawConfig.model,
  workspace: rawConfig.workspace,
  organization: rawConfig.organization,
  project: rawConfig.project,
  repositoryId: rawConfig.repositoryId,
  pullRequestId: rawConfig.pullRequestId,
  collectionUrl: rawConfig.collectionUrl,
  agent: rawConfig.agent,
  promptFile: rawConfig.promptFile,
  dryRun: rawConfig.dryRun,
  json: rawConfig.json,
  systemAccessToken: Redacted.make(rawConfig.systemAccessToken),
  targetBranch: rawConfig.targetBranch,
  sourceVersion: rawConfig.sourceVersion,
  buildId: rawConfig.buildId,
  buildNumber: rawConfig.buildNumber,
  buildUri: rawConfig.buildUri,
})

const validateCollectionUrl = (collectionUrl: string) =>
  Effect.try({
    try: () => {
      const url = new URL(collectionUrl)
      if (!/^https?:$/.test(url.protocol)) {
        throw new Error("Collection URL must use http or https.")
      }
    },
    catch: (error) =>
      new ConfigError({
        message: "Invalid Azure DevOps collection URL.",
        issues: [String(error)],
      }),
  })

const readStringFlag = (flags: Record<string, string | boolean>, key: string) => {
  const value = flags[key]
  return typeof value === "string" ? value : undefined
}

const readBooleanFlag = (flags: Record<string, string | boolean>, key: string) => flags[key] === true

const toPositiveInt = (value: string | undefined) => {
  if (!value) {
    return Number.NaN
  }

  return Number.parseInt(value, 10)
}

const stripTrailingSlash = (value: string) => value.replace(/\/+$/, "")

const compactOptionalKeys = <T extends Record<string, unknown>>(input: T) =>
  Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined))
