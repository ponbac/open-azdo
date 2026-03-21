import { ChildProcessSpawner } from "effect/unstable/process/ChildProcessSpawner"
import { Layer } from "effect"
import { ProcessRunner } from "../Services/ProcessRunner"
export declare const ProcessRunnerLive: Layer.Layer<ProcessRunner, never, ChildProcessSpawner>
