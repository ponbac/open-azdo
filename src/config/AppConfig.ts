import { Config, Effect, Layer, Option, Redacted, Schema, ServiceMap } from "effect"
import * as Duration from "effect/Duration"

import { ConfigError } from "../errors"

const NonEmptyString = Schema.String.check(Schema.isMinLength(1))
const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0))
const DEFAULT_OPENCODE_TIMEOUT = Duration.minutes(10)
const BARE_DURATION_REGEXP = /^-?\d+(?:\.\d+)?$/
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

export type AppConfigShape = {
  readonly command: "review"
  readonly model: ModelId
  readonly opencodeVariant?: string
  readonly opencodeTimeout: Duration.Duration
  readonly workspace: WorkspacePath
  readonly organization: string
  readonly project: string
  readonly repositoryId: string
  readonly pullRequestId: PullRequestId
  readonly collectionUrl: CollectionUrl
  readonly agent: AgentName
  readonly promptFile?: string
  readonly dryRun: boolean
  readonly json: boolean
  readonly systemAccessToken: SystemAccessToken
  readonly targetBranch?: string
  readonly sourceVersion?: string
  readonly buildId?: string
  readonly buildNumber?: string
  readonly buildUri?: string
}

export type AzureContext = {
  readonly organization: string
  readonly project: string
  readonly collectionUrl: string
  readonly repositoryId: string
  readonly pullRequestId: number
  readonly buildId?: string
  readonly buildNumber?: string
  readonly buildUri?: string
  readonly sourceVersion?: string
  readonly targetBranch?: string
}

export class AppConfig extends ServiceMap.Service<AppConfig, AppConfigShape>()("open-azdo/config/AppConfig") {}

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
  sourceVersion: Schema.optionalKey(NonEmptyString),
  buildId: Schema.optionalKey(NonEmptyString),
  buildNumber: Schema.optionalKey(NonEmptyString),
  buildUri: Schema.optionalKey(NonEmptyString),
})

type EnvConfig = {
  readonly openAzdoModel?: string
  readonly openAzdoVariant?: string
  readonly openAzdoTimeout?: string
  readonly openAzdoWorkspace?: string
  readonly openAzdoOrganization?: string
  readonly openAzdoProject?: string
  readonly openAzdoRepositoryId?: string
  readonly openAzdoPullRequestId?: string
  readonly openAzdoCollectionUrl?: string
  readonly openAzdoAgent?: string
  readonly openAzdoPromptFile?: string
  readonly systemAccessToken?: string
  readonly systemCollectionUri?: string
  readonly systemTeamProject?: string
  readonly buildRepositoryId?: string
  readonly systemPullRequestPullRequestId?: string
  readonly buildSourcesDirectory?: string
  readonly systemPullRequestTargetBranch?: string
  readonly buildSourceVersion?: string
  readonly buildBuildId?: string
  readonly buildBuildNumber?: string
  readonly buildBuildUri?: string
}

const optionalStringConfig = (name: string) =>
  Config.string(name).pipe(Config.option, Config.map(Option.getOrUndefined))

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
  buildSourceVersion: optionalStringConfig("BUILD_SOURCEVERSION"),
  buildBuildId: optionalStringConfig("BUILD_BUILDID"),
  buildBuildNumber: optionalStringConfig("BUILD_BUILDNUMBER"),
  buildBuildUri: optionalStringConfig("BUILD_BUILDURI"),
})

const optionOrUndefined = <A>(option: Option.Option<A>) => Option.getOrUndefined(option)

const compactOptionalKeys = <T extends Record<string, unknown>>(input: T) =>
  Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined))

const invalidOpenCodeTimeout = (value: string, issue: string) =>
  new ConfigError({
    message: "Invalid OpenCode timeout.",
    issues: [`${issue} Received ${JSON.stringify(value)}.`, 'Use values like "300 seconds" or "5 minutes".'],
  })

const decodeOpenCodeTimeout = (value: string): Duration.Duration => {
  const trimmed = value.trim()

  if (trimmed.length === 0) {
    throw invalidOpenCodeTimeout(value, "Timeout cannot be empty.")
  }

  if (BARE_DURATION_REGEXP.test(trimmed)) {
    throw invalidOpenCodeTimeout(value, "Timeout must include an explicit unit.")
  }

  const maybeDuration = Duration.fromInput(trimmed as Duration.Input)
  const duration = optionOrUndefined(maybeDuration)
  if (duration === undefined) {
    throw invalidOpenCodeTimeout(value, "Timeout must use Effect duration syntax with an explicit unit.")
  }

  if (!Duration.isFinite(duration)) {
    throw invalidOpenCodeTimeout(value, "Timeout must be finite.")
  }

  if (!Duration.isPositive(duration)) {
    throw invalidOpenCodeTimeout(value, "Timeout must be greater than zero.")
  }

  return duration
}

const toPositiveInt = (value: string | number | undefined) => {
  if (typeof value === "number") {
    return value
  }

  if (!value) {
    return Number.NaN
  }

  return Number.parseInt(value, 10)
}

const resolveOpenCodeTimeout = (value: string | undefined) =>
  value === undefined
    ? Effect.succeed(DEFAULT_OPENCODE_TIMEOUT)
    : Effect.try({
        try: () => decodeOpenCodeTimeout(value),
        catch: (error) =>
          error instanceof ConfigError
            ? error
            : invalidOpenCodeTimeout(value, "Timeout must use Effect duration syntax with an explicit unit."),
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

export const createAzureContext = (config: AppConfig["Service"]): AzureContext => ({
  organization: config.organization,
  project: config.project,
  collectionUrl: config.collectionUrl.replace(/\/+$/, ""),
  repositoryId: config.repositoryId,
  pullRequestId: config.pullRequestId,
  ...(config.buildId !== undefined ? { buildId: config.buildId } : {}),
  ...(config.buildNumber !== undefined ? { buildNumber: config.buildNumber } : {}),
  ...(config.buildUri !== undefined ? { buildUri: config.buildUri } : {}),
  ...(config.sourceVersion !== undefined ? { sourceVersion: config.sourceVersion } : {}),
  ...(config.targetBranch !== undefined ? { targetBranch: config.targetBranch } : {}),
})

export const buildBuildLink = (config: AppConfig["Service"]) => {
  if (config.buildUri) {
    return config.buildUri
  }

  if (!config.buildId) {
    return undefined
  }

  return `${config.collectionUrl.replace(/\/+$/, "")}/${encodeURIComponent(config.project)}/_build/results?buildId=${encodeURIComponent(
    config.buildId,
  )}`
}

const resolveAppConfig = (cliInput: ReviewCliInput) =>
  Effect.gen(function* () {
    const env = yield* EnvConfig.asEffect()
    const opencodeTimeout = yield* resolveOpenCodeTimeout(
      optionOrUndefined(cliInput.opencodeTimeout) ?? env.openAzdoTimeout,
    )

    const collectionUrl =
      optionOrUndefined(cliInput.collectionUrl) ?? env.openAzdoCollectionUrl ?? env.systemCollectionUri
    const organization =
      optionOrUndefined(cliInput.organization) ??
      env.openAzdoOrganization ??
      inferOrganizationFromCollectionUrl(collectionUrl ?? "")

    const merged = compactOptionalKeys({
      command: "review",
      model: optionOrUndefined(cliInput.model) ?? env.openAzdoModel,
      opencodeVariant: optionOrUndefined(cliInput.opencodeVariant) ?? env.openAzdoVariant,
      opencodeTimeout,
      workspace: optionOrUndefined(cliInput.workspace) ?? env.openAzdoWorkspace ?? env.buildSourcesDirectory,
      organization,
      project: optionOrUndefined(cliInput.project) ?? env.openAzdoProject ?? env.systemTeamProject,
      repositoryId: optionOrUndefined(cliInput.repositoryId) ?? env.openAzdoRepositoryId ?? env.buildRepositoryId,
      pullRequestId: toPositiveInt(
        optionOrUndefined(cliInput.pullRequestId) ?? env.openAzdoPullRequestId ?? env.systemPullRequestPullRequestId,
      ),
      collectionUrl,
      agent: optionOrUndefined(cliInput.agent) ?? env.openAzdoAgent ?? "azdo-review",
      promptFile: optionOrUndefined(cliInput.promptFile) ?? env.openAzdoPromptFile,
      dryRun: cliInput.dryRun,
      json: cliInput.json,
      systemAccessToken: env.systemAccessToken ? Redacted.make(env.systemAccessToken) : undefined,
      targetBranch: env.systemPullRequestTargetBranch,
      sourceVersion: env.buildSourceVersion,
      buildId: env.buildBuildId,
      buildNumber: env.buildBuildNumber,
      buildUri: env.buildBuildUri,
    })

    const decoded = yield* Effect.try({
      try: () => Schema.decodeUnknownSync(AppConfigSchema)(merged),
      catch: (error) =>
        new ConfigError({
          message: "Invalid CLI flags or environment configuration.",
          issues: [String(error)],
        }),
    })

    yield* validateCollectionUrl(decoded.collectionUrl)
    return decoded
  })

export const makeAppConfigLayer = (cliInput: ReviewCliInput) => Layer.effect(AppConfig, resolveAppConfig(cliInput))

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
