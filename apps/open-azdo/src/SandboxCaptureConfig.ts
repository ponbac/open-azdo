import { existsSync } from "node:fs"
import { dirname, join, parse, resolve } from "node:path"

import { Config, Effect, Layer, Option, Redacted, Schema, ServiceMap } from "effect"
import * as Duration from "effect/Duration"

import { ConfigError } from "./errors"
import { inferOrganizationFromCollectionUrl } from "./AppConfig"

const NonEmptyString = Schema.String.check(Schema.isMinLength(1))
const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0))
const DEFAULT_OPENCODE_TIMEOUT = Duration.minutes(10)
const BARE_DURATION_REGEXP = /^-?\d+(?:\.\d+)?$/

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

export type SandboxCaptureConfigShape = {
  readonly command: "sandbox-capture"
  readonly model: string
  readonly opencodeVariant?: string
  readonly opencodeTimeout: Duration.Duration
  readonly workspace?: string
  readonly organization: string
  readonly project: string
  readonly repositoryId: string
  readonly pullRequestId: number
  readonly collectionUrl: string
  readonly output: string
  readonly json: boolean
  readonly accessToken: Redacted.Redacted<string>
}

export class SandboxCaptureConfig extends ServiceMap.Service<SandboxCaptureConfig, SandboxCaptureConfigShape>()(
  "open-azdo/config/SandboxCaptureConfig",
) {}

const optionalStringConfig = (name: string) =>
  Config.string(name).pipe(Config.option, Config.map(Option.getOrUndefined))

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

const optionOrUndefined = <A>(option: Option.Option<A>) => {
  const value = Option.getOrUndefined(option)
  return typeof value === "string" ? (value.trim().length > 0 ? value : undefined) : value
}

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
    return value
  }

  throw new ConfigError({
    message: "Missing sandbox capture configuration.",
    issues: [`${name} is required.`],
  })
}

const requireInt = (value: string | number | undefined, name: string) => {
  const parsed = typeof value === "number" ? value : Number.parseInt(value ?? "", 10)
  if (Number.isInteger(parsed) && parsed > 0) {
    return parsed
  }

  throw new ConfigError({
    message: "Missing sandbox capture configuration.",
    issues: [`${name} must be a positive integer.`],
  })
}

const resolveSandboxCaptureConfig = (input: SandboxCaptureCliInput) =>
  Effect.gen(function* () {
    const env = yield* EnvConfig.asEffect()
    const collectionUrl = optionOrUndefined(input.collectionUrl) ?? env.collectionUrl
    const organization =
      optionOrUndefined(input.organization) ??
      env.organization ??
      inferOrganizationFromCollectionUrl(collectionUrl ?? "")
    const project = optionOrUndefined(input.project) ?? env.project
    const repositoryId = optionOrUndefined(input.repositoryId) ?? env.repositoryId
    const inputPullRequestId = optionOrUndefined(input.pullRequestId)
    const pullRequestId =
      typeof inputPullRequestId === "number" && Number.isInteger(inputPullRequestId) && inputPullRequestId > 0
        ? inputPullRequestId
        : env.pullRequestId
    const resolvedPullRequestId = requireInt(pullRequestId, "OPEN_AZDO_LIVE_PULL_REQUEST_ID")
    const resolvedOrganization = requireString(organization, "OPEN_AZDO_LIVE_ORGANIZATION")
    const opencodeVariant = optionOrUndefined(input.opencodeVariant) ?? env.variant
    const workspace = optionOrUndefined(input.workspace) ?? env.workspace

    const config = {
      command: "sandbox-capture" as const,
      model: requireString(optionOrUndefined(input.model) ?? env.model, "OPEN_AZDO_LIVE_MODEL"),
      ...(opencodeVariant ? { opencodeVariant } : {}),
      opencodeTimeout: yield* resolveOpenCodeTimeout(optionOrUndefined(input.opencodeTimeout) ?? env.timeout),
      ...(workspace ? { workspace } : {}),
      organization: resolvedOrganization,
      project: requireString(project, "OPEN_AZDO_LIVE_PROJECT"),
      repositoryId: requireString(repositoryId, "OPEN_AZDO_LIVE_REPOSITORY_ID"),
      pullRequestId: resolvedPullRequestId,
      collectionUrl: requireString(collectionUrl, "OPEN_AZDO_LIVE_COLLECTION_URL"),
      output:
        optionOrUndefined(input.output) ??
        env.output ??
        defaultOutputPath({
          organization: resolvedOrganization,
          project: requireString(project, "OPEN_AZDO_LIVE_PROJECT"),
          pullRequestId: resolvedPullRequestId,
        }),
      json: input.json,
      accessToken: Redacted.make(
        requireString(env.accessToken ?? env.systemAccessToken, "OPEN_AZDO_LIVE_ACCESS_TOKEN"),
      ),
    }

    yield* validateCollectionUrl(config.collectionUrl)
    return Schema.decodeUnknownSync(
      Schema.Struct({
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
      }),
    )(config)
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

export const makeSandboxCaptureConfigLayer = (input: SandboxCaptureCliInput) =>
  Layer.effect(SandboxCaptureConfig, resolveSandboxCaptureConfig(input))
