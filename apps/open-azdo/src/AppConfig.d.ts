import { Config, Layer, Option, Schema, ServiceMap } from "effect"
import * as Duration from "effect/Duration"
import { ConfigError } from "./errors"
export declare const ModelId: Schema.brand<Schema.String, "ModelId">
export type ModelId = typeof ModelId.Type
export declare const WorkspacePath: Schema.brand<Schema.String, "WorkspacePath">
export type WorkspacePath = typeof WorkspacePath.Type
export declare const CollectionUrl: Schema.brand<Schema.String, "CollectionUrl">
export type CollectionUrl = typeof CollectionUrl.Type
export declare const PullRequestId: Schema.brand<Schema.Int, "PullRequestId">
export type PullRequestId = typeof PullRequestId.Type
export declare const AgentName: Schema.brand<Schema.String, "AgentName">
export type AgentName = typeof AgentName.Type
export declare const SystemAccessToken: Schema.brand<Schema.Redacted<Schema.String>, "SystemAccessToken">
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
  readonly sourceCommitId?: string
  readonly sourceVersion?: string
  readonly buildId?: string
  readonly buildNumber?: string
  readonly buildUri?: string
}
declare const AppConfig_base: ServiceMap.ServiceClass<AppConfig, "open-azdo/config/AppConfig", AppConfigShape>
export declare class AppConfig extends AppConfig_base {}
export declare const inferOrganizationFromCollectionUrl: (collectionUrl: string) => string
export declare const makeAppConfigLayer: (
  cliInput: ReviewCliInput,
) => Layer.Layer<AppConfig, Config.ConfigError | ConfigError, never>
export {}
