import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import { Layer } from "effect"
import { ProcessRunner } from "../../process-runner"
import { OpenCodeRunner } from "../Services/OpenCodeRunner"
export declare const buildOpenCodeConfig: (agentName: string) => {
  $schema: string
  permission: {
    edit: string
    read: string
    grep: string
    list: string
    glob: string
    webfetch: string
    websearch: string
    codesearch: string
    bash: {
      "*": string
      "git diff *": string
      "git show *": string
      "git log *": string
      "git status *": string
      "git rev-parse *": string
      "rg *": string
      "grep *": string
      "find *": string
      "ls *": string
      "cat *": string
      "sed *": string
    }
  }
  agent: {
    [x: string]: {
      mode: string
      description: string
      prompt: string
      permission: {
        edit: string
        webfetch: string
        websearch: string
        codesearch: string
      }
    }
  }
}
export declare const extractFinalResponse: (output: string) => string
export declare const OpenCodeRunnerLive: Layer.Layer<
  OpenCodeRunner,
  never,
  FileSystem.FileSystem | Path.Path | ProcessRunner
>
