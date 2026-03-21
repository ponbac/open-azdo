import { Layer } from "effect"
import { ProcessRunner } from "../../process-runner"
import { GitExec } from "../Services/GitExec"
export declare const GitExecLive: Layer.Layer<GitExec, never, ProcessRunner>
