import * as FileSystem from "effect/FileSystem"
import { Effect } from "effect"
import { PromptFileError } from "../errors"
import type { ReviewContext } from "./ReviewContext"
export declare const buildReviewPrompt: (
  promptFile: string | undefined,
  reviewContext: ReviewContext,
) => Effect.Effect<string, PromptFileError, FileSystem.FileSystem>
