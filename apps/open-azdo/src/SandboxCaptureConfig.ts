import { existsSync } from "node:fs"
import { dirname, join, parse, resolve } from "node:path"

import { Config, Effect, Layer, Option, Redacted, Schema, Context } from "effect"

import { ConfigError } from "./errors"
import { resolveOpenCodeTimeout, validateCollectionUrl } from "./ConfigParsing"
import { inferOrganizationFromCollectionUrl } from "./AppConfig"

const NonEmptyString = Schema.String.check(Schema.isMinLength(1))
const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0))

export type SandboxCaptureCliInput = {
  readonly model: Option.Option<string>
  readonly opencodeVariant: Option.Option<string>
  readonly opencodeTimeout: Option.Option<string>
  readonly workspace: Option.Option<string>
  readonly organization: Option.Option<string>
  readonly project: Option.Option<string>
  readonly repositoryId: Option.Option<string>
  readonly pullRequestId: Option.Option<number>
  readonly collectionUrl: Option.Option<string>
  readonly output: Option.Option<string>
  readonly json: boolean
}

/** Parsed capture flags supplied by the command boundary. */
export class SandboxCaptureCommandInput extends Context.Service<SandboxCaptureCommandInput, SandboxCaptureCliInput>()(
  "open-azdo/cli/SandboxCaptureCommandInput",
) {}

const SandboxCaptureConfigSchema = Schema.Struct({
  command: Schema.Literal("sandbox-capture"),
  model: NonEmptyString,
  opencodeVariant: Schema.optionalKey(NonEmptyString),
  opencodeTimeout: Schema.Duration,
  workspace: Schema.optionalKey(NonEmptyString),
  organization: NonEmptyString,
  project: NonEmptyString,
  repositoryId: NonEmptyString,
  pullRequestId: PositiveInt,
  collectionUrl: NonEmptyString,
  output: NonEmptyString,
  json: Schema.Boolean,
  accessToken: Schema.Redacted(NonEmptyString),
})

/** Validated capture settings consumed by the capture workflow. */
export interface SandboxCaptureSettings extends Schema.Schema.Type<typeof SandboxCaptureConfigSchema> {}

export class SandboxCaptureConfig extends Context.Service<SandboxCaptureConfig, SandboxCaptureSettings>()(
  "open-azdo/config/SandboxCaptureConfig",
) {}

const optionalStringConfig = (name: string) =>
  Config.String(name).pipe(Config.option, Config.map(Option.getOrUndefined))

const EnvConfig = Config.all({
  model: optionalStringConfig("OPEN_AZDO_LIVE_MODEL"),
  variant: optionalStringConfig("OPEN_AZDO_LIVE_OPENCODE_VARIANT"),
  timeout: optionalStringConfig("OPEN_AZDO_LIVE_OPENCODE_TIMEOUT"),
  workspace: optionalStringConfig("OPEN_AZDO_LIVE_WORKSPACE"),
  organization: optionalStringConfig("OPEN_AZDO_LIVE_ORGANIZATION"),
  project: optionalStringConfig("OPEN_AZDO_LIVE_PROJECT"),
  repositoryId: optionalStringConfig("OPEN_AZDO_LIVE_REPOSITORY_ID"),
  pullRequestId: optionalStringConfig("OPEN_AZDO_LIVE_PULL_REQUEST_ID"),
  collectionUrl: optionalStringConfig("OPEN_AZDO_LIVE_COLLECTION_URL"),
  output: optionalStringConfig("OPEN_AZDO_LIVE_OUTPUT"),
  accessToken: optionalStringConfig("OPEN_AZDO_LIVE_ACCESS_TOKEN"),
  systemAccessToken: optionalStringConfig("SYSTEM_ACCESSTOKEN"),
})

const optionalNonBlankString = (option: Option.Option<string>) =>
  Option.getOrUndefined(Option.filter(option, (value) => value.trim().length > 0))

/**
 * Resolve the capture output under the nearest enclosing git repository so the
 * artifact stays local to the checked-out repo instead of the package cwd.
 */
const resolveRepositoryRoot = (startDirectory: string) => {
  let current = resolve(startDirectory)

  while (true) {
    if (existsSync(join(current, ".git"))) {
      return current
    }

    const parent = dirname(current)

    if (parent === current || current === parse(current).root) {
      return resolve(startDirectory)
    }

    current = parent
  }
}

const defaultOutputPath = ({
  organization,
  project,
  pullRequestId,
}: {
  readonly organization: string
  readonly project: string
  readonly pullRequestId: number
}) =>
  join(resolveRepositoryRoot(process.cwd()), ".captures", `${organization}-${project}-pr-${String(pullRequestId)}.json`)

const requireString = (value: string | undefined, name: string) => {
  if (value && value.trim().length > 0) {
    return Effect.succeed(value)
  }

  return Effect.fail(
    new ConfigError({
      message: "Missing sandbox capture configuration.",
      issues: [`${name} is required.`],
    }),
  )
}

const requireInt = (parsed: number, name: string) => {
  if (Number.isInteger(parsed) && parsed > 0) {
    return Effect.succeed(parsed)
  }

  return Effect.fail(
    new ConfigError({
      message: "Missing sandbox capture configuration.",
      issues: [`${name} must be a positive integer.`],
    }),
  )
}

/** Resolve CLI overrides and live environment defaults, reporting invalid inputs as typed configuration failures. */
const resolveSandboxCaptureConfig = Effect.gen(function* () {
  const input = yield* SandboxCaptureCommandInput
  const env = yield* EnvConfig
  const collectionUrl = optionalNonBlankString(input.collectionUrl) ?? env.collectionUrl

  const organization =
    optionalNonBlankString(input.organization) ??
    env.organization ??
    inferOrganizationFromCollectionUrl(collectionUrl ?? "")

  const project = optionalNonBlankString(input.project) ?? env.project
  const repositoryId = optionalNonBlankString(input.repositoryId) ?? env.repositoryId

  const pullRequestId = Option.getOrElse(
    Option.filter(input.pullRequestId, (value) => Number.isInteger(value) && value > 0),
    () => Number.parseInt(env.pullRequestId ?? "", 10),
  )

  const resolvedPullRequestId = yield* requireInt(pullRequestId, "OPEN_AZDO_LIVE_PULL_REQUEST_ID")
  const resolvedOrganization = yield* requireString(organization, "OPEN_AZDO_LIVE_ORGANIZATION")
  const opencodeVariant = optionalNonBlankString(input.opencodeVariant) ?? env.variant
  const workspace = optionalNonBlankString(input.workspace) ?? env.workspace

  const model = yield* requireString(optionalNonBlankString(input.model) ?? env.model, "OPEN_AZDO_LIVE_MODEL")
  const opencodeTimeout = yield* resolveOpenCodeTimeout(optionalNonBlankString(input.opencodeTimeout) ?? env.timeout)
  const resolvedProject = yield* requireString(project, "OPEN_AZDO_LIVE_PROJECT")
  const resolvedRepositoryId = yield* requireString(repositoryId, "OPEN_AZDO_LIVE_REPOSITORY_ID")
  const resolvedCollectionUrl = yield* requireString(collectionUrl, "OPEN_AZDO_LIVE_COLLECTION_URL")

  let config: SandboxCaptureSettings = {
    command: "sandbox-capture" as const,
    model,
    opencodeTimeout,
    organization: resolvedOrganization,
    project: resolvedProject,
    repositoryId: resolvedRepositoryId,
    pullRequestId: resolvedPullRequestId,
    collectionUrl: resolvedCollectionUrl,
    output:
      optionalNonBlankString(input.output) ??
      env.output ??
      defaultOutputPath({
        organization: resolvedOrganization,
        project: resolvedProject,
        pullRequestId: resolvedPullRequestId,
      }),
    json: input.json,
    accessToken: Redacted.make(
      yield* requireString(env.accessToken ?? env.systemAccessToken, "OPEN_AZDO_LIVE_ACCESS_TOKEN"),
    ),
  }

  if (opencodeVariant) {
    config = { ...config, opencodeVariant }
  }

  if (workspace) {
    config = { ...config, workspace }
  }

  yield* validateCollectionUrl(config.collectionUrl)

  return yield* Schema.decodeUnknownEffect(SandboxCaptureConfigSchema)(config)
}).pipe(
  Effect.mapError((error) =>
    error instanceof ConfigError
      ? error
      : new ConfigError({
          message: "Invalid sandbox capture configuration.",
          issues: [String(error)],
        }),
  ),
)

/** Decode capture settings from the contextual command input and active configuration provider. */
export const SandboxCaptureConfigLive = Layer.effect(SandboxCaptureConfig, resolveSandboxCaptureConfig)
