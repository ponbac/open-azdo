import { Config, Effect, Layer, Option, Redacted, Schema, Context } from "effect"

import { ConfigError } from "./errors"
import { resolveOpenCodeTimeout, validateCollectionUrl } from "./ConfigParsing"

const NonEmptyString = Schema.String.check(Schema.isMinLength(1))
const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0))
export const ModelId = NonEmptyString.pipe(Schema.brand("ModelId"))

export type ModelId = typeof ModelId.Type

export const WorkspacePath = NonEmptyString.pipe(Schema.brand("WorkspacePath"))

export type WorkspacePath = typeof WorkspacePath.Type

export const CollectionUrl = NonEmptyString.pipe(Schema.brand("CollectionUrl"))

export type CollectionUrl = typeof CollectionUrl.Type

export const PullRequestId = PositiveInt.pipe(Schema.brand("PullRequestId"))

export type PullRequestId = typeof PullRequestId.Type

export const AgentName = NonEmptyString.pipe(Schema.brand("AgentName"))

export type AgentName = typeof AgentName.Type

export const SystemAccessToken = Schema.Redacted(NonEmptyString).pipe(Schema.brand("SystemAccessToken"))

export type SystemAccessToken = typeof SystemAccessToken.Type

export type ReviewCliInput = {
  readonly model: Option.Option<string>
  readonly opencodeVariant: Option.Option<string>
  readonly opencodeTimeout: Option.Option<string>
  readonly workspace: Option.Option<string>
  readonly organization: Option.Option<string>
  readonly project: Option.Option<string>
  readonly repositoryId: Option.Option<string>
  readonly pullRequestId: Option.Option<number>
  readonly collectionUrl: Option.Option<string>
  readonly agent: Option.Option<string>
  readonly promptFile: Option.Option<string>
  readonly dryRun: boolean
  readonly json: boolean
}

/** Parsed review flags supplied by the command boundary. */
export class ReviewCommandInput extends Context.Service<ReviewCommandInput, ReviewCliInput>()(
  "open-azdo/cli/ReviewCommandInput",
) {}

const AppConfigSchema = Schema.Struct({
  command: Schema.Literal("review"),
  model: ModelId,
  opencodeVariant: Schema.optionalKey(NonEmptyString),
  opencodeTimeout: Schema.Duration,
  workspace: WorkspacePath,
  organization: NonEmptyString,
  project: NonEmptyString,
  repositoryId: NonEmptyString,
  pullRequestId: PullRequestId,
  collectionUrl: CollectionUrl,
  agent: AgentName,
  promptFile: Schema.optionalKey(NonEmptyString),
  dryRun: Schema.Boolean,
  json: Schema.Boolean,
  systemAccessToken: SystemAccessToken,
  targetBranch: Schema.optionalKey(NonEmptyString),
  sourceCommitId: Schema.optionalKey(NonEmptyString),
  sourceVersion: Schema.optionalKey(NonEmptyString),
  buildId: Schema.optionalKey(NonEmptyString),
  buildNumber: Schema.optionalKey(NonEmptyString),
  buildUri: Schema.optionalKey(NonEmptyString),
})

/** Validated review settings consumed by the workflow. */
export interface ReviewSettings extends Schema.Schema.Type<typeof AppConfigSchema> {}

export class AppConfig extends Context.Service<AppConfig, ReviewSettings>()("open-azdo/config/AppConfig") {}

const optionalStringConfig = (name: string) =>
  Config.String(name).pipe(Config.option, Config.map(Option.getOrUndefined))

const EnvConfig = Config.all({
  openAzdoModel: optionalStringConfig("OPEN_AZDO_MODEL"),
  openAzdoVariant: optionalStringConfig("OPEN_AZDO_OPENCODE_VARIANT"),
  openAzdoTimeout: optionalStringConfig("OPEN_AZDO_OPENCODE_TIMEOUT"),
  openAzdoWorkspace: optionalStringConfig("OPEN_AZDO_WORKSPACE"),
  openAzdoOrganization: optionalStringConfig("OPEN_AZDO_ORGANIZATION"),
  openAzdoProject: optionalStringConfig("OPEN_AZDO_PROJECT"),
  openAzdoRepositoryId: optionalStringConfig("OPEN_AZDO_REPOSITORY_ID"),
  openAzdoPullRequestId: optionalStringConfig("OPEN_AZDO_PULL_REQUEST_ID"),
  openAzdoCollectionUrl: optionalStringConfig("OPEN_AZDO_COLLECTION_URL"),
  openAzdoAgent: optionalStringConfig("OPEN_AZDO_AGENT"),
  openAzdoPromptFile: optionalStringConfig("OPEN_AZDO_PROMPT_FILE"),
  systemAccessToken: optionalStringConfig("SYSTEM_ACCESSTOKEN"),
  systemCollectionUri: optionalStringConfig("SYSTEM_COLLECTIONURI"),
  systemTeamProject: optionalStringConfig("SYSTEM_TEAMPROJECT"),
  buildRepositoryId: optionalStringConfig("BUILD_REPOSITORY_ID"),
  systemPullRequestPullRequestId: optionalStringConfig("SYSTEM_PULLREQUEST_PULLREQUESTID"),
  buildSourcesDirectory: optionalStringConfig("BUILD_SOURCESDIRECTORY"),
  systemPullRequestTargetBranch: optionalStringConfig("SYSTEM_PULLREQUEST_TARGETBRANCH"),
  systemPullRequestSourceCommitId: optionalStringConfig("SYSTEM_PULLREQUEST_SOURCECOMMITID"),
  buildSourceVersion: optionalStringConfig("BUILD_SOURCEVERSION"),
  buildBuildId: optionalStringConfig("BUILD_BUILDID"),
  buildBuildNumber: optionalStringConfig("BUILD_BUILDNUMBER"),
  buildBuildUri: optionalStringConfig("BUILD_BUILDURI"),
})

const compactOptionalKeys = <T extends Record<string, unknown>>(input: T) =>
  Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined))

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

/** Merge CLI, OPEN_AZDO, and pipeline defaults in precedence order, then decode the resulting configuration. */
const resolveAppConfig = Effect.gen(function* () {
  const cliInput = yield* ReviewCommandInput
  const env = yield* EnvConfig

  const opencodeTimeout = yield* resolveOpenCodeTimeout(
    Option.getOrUndefined(cliInput.opencodeTimeout) ?? env.openAzdoTimeout,
  )

  const collectionUrl =
    Option.getOrUndefined(cliInput.collectionUrl) ?? env.openAzdoCollectionUrl ?? env.systemCollectionUri

  const organization =
    Option.getOrUndefined(cliInput.organization) ??
    env.openAzdoOrganization ??
    inferOrganizationFromCollectionUrl(collectionUrl ?? "")

  const merged = compactOptionalKeys({
    command: "review",
    model: Option.getOrUndefined(cliInput.model) ?? env.openAzdoModel,
    opencodeVariant: Option.getOrUndefined(cliInput.opencodeVariant) ?? env.openAzdoVariant,
    opencodeTimeout,
    workspace: Option.getOrUndefined(cliInput.workspace) ?? env.openAzdoWorkspace ?? env.buildSourcesDirectory,
    organization,
    project: Option.getOrUndefined(cliInput.project) ?? env.openAzdoProject ?? env.systemTeamProject,
    repositoryId: Option.getOrUndefined(cliInput.repositoryId) ?? env.openAzdoRepositoryId ?? env.buildRepositoryId,
    pullRequestId:
      Option.getOrUndefined(cliInput.pullRequestId) ??
      Number.parseInt(env.openAzdoPullRequestId ?? env.systemPullRequestPullRequestId ?? "", 10),
    collectionUrl,
    agent: Option.getOrUndefined(cliInput.agent) ?? env.openAzdoAgent ?? "azdo-review",
    promptFile: Option.getOrUndefined(cliInput.promptFile) ?? env.openAzdoPromptFile,
    dryRun: cliInput.dryRun,
    json: cliInput.json,
    systemAccessToken: env.systemAccessToken ? Redacted.make(env.systemAccessToken) : undefined,
    targetBranch: env.systemPullRequestTargetBranch,
    sourceCommitId: env.systemPullRequestSourceCommitId,
    sourceVersion: env.buildSourceVersion,
    buildId: env.buildBuildId,
    buildNumber: env.buildBuildNumber,
    buildUri: env.buildBuildUri,
  })

  const decoded = yield* Schema.decodeUnknownEffect(AppConfigSchema)(merged).pipe(
    Effect.mapError(
      (error) =>
        new ConfigError({
          message: "Invalid CLI flags or environment configuration.",
          issues: [String(error)],
        }),
    ),
  )

  yield* validateCollectionUrl(decoded.collectionUrl)

  return decoded
})

/** Decode review settings from the contextual command input and active configuration provider. */
export const AppConfigLive = Layer.effect(AppConfig, resolveAppConfig)
