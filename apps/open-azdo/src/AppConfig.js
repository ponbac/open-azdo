import { Config, Effect, Layer, Option, Redacted, Schema, ServiceMap } from "effect"
import * as Duration from "effect/Duration"
import { ConfigError } from "./errors"
const NonEmptyString = Schema.String.check(Schema.isMinLength(1))
const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0))
const DEFAULT_OPENCODE_TIMEOUT = Duration.minutes(10)
const BARE_DURATION_REGEXP = /^-?\d+(?:\.\d+)?$/
export const ModelId = NonEmptyString.pipe(Schema.brand("ModelId"))
export const WorkspacePath = NonEmptyString.pipe(Schema.brand("WorkspacePath"))
export const CollectionUrl = NonEmptyString.pipe(Schema.brand("CollectionUrl"))
export const PullRequestId = PositiveInt.pipe(Schema.brand("PullRequestId"))
export const AgentName = NonEmptyString.pipe(Schema.brand("AgentName"))
export const SystemAccessToken = Schema.Redacted(NonEmptyString).pipe(Schema.brand("SystemAccessToken"))
export class AppConfig extends ServiceMap.Service()("open-azdo/config/AppConfig") {}
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
const optionalStringConfig = (name) => Config.string(name).pipe(Config.option, Config.map(Option.getOrUndefined))
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
const optionOrUndefined = (option) => Option.getOrUndefined(option)
const compactOptionalKeys = (input) =>
  Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined))
const invalidOpenCodeTimeout = (value, issue) =>
  new ConfigError({
    message: "Invalid OpenCode timeout.",
    issues: [`${issue} Received ${JSON.stringify(value)}.`, 'Use values like "300 seconds" or "5 minutes".'],
  })
const decodeOpenCodeTimeout = (value) => {
  const trimmed = value.trim()
  if (trimmed.length === 0) {
    throw invalidOpenCodeTimeout(value, "Timeout cannot be empty.")
  }
  if (BARE_DURATION_REGEXP.test(trimmed)) {
    throw invalidOpenCodeTimeout(value, "Timeout must include an explicit unit.")
  }
  const maybeDuration = Duration.fromInput(trimmed)
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
const toPositiveInt = (value) => {
  if (typeof value === "number") {
    return value
  }
  if (!value) {
    return Number.NaN
  }
  return Number.parseInt(value, 10)
}
const resolveOpenCodeTimeout = (value) =>
  value === undefined
    ? Effect.succeed(DEFAULT_OPENCODE_TIMEOUT)
    : Effect.try({
        try: () => decodeOpenCodeTimeout(value),
        catch: (error) =>
          error instanceof ConfigError
            ? error
            : invalidOpenCodeTimeout(value, "Timeout must use Effect duration syntax with an explicit unit."),
      })
export const inferOrganizationFromCollectionUrl = (collectionUrl) => {
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
const resolveAppConfig = (cliInput) =>
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
      sourceCommitId: env.systemPullRequestSourceCommitId,
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
export const makeAppConfigLayer = (cliInput) => Layer.effect(AppConfig, resolveAppConfig(cliInput))
const validateCollectionUrl = (collectionUrl) =>
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
