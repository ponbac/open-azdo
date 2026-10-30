import type { ReviewSummarySubject } from "./ReviewSummary"

export const buildReviewSummaryPrompt = (subjects: ReadonlyArray<ReviewSummarySubject>) =>
  [
    "You are writing the human-facing summary for an Azure DevOps pull-request review.",
    "You are not reviewing the repository.",
    "Do not inspect the repo, diff, pull request, work items, or thread bodies.",
    "Do not use repository, shell, or search tools, or ask to use them. The only tool you may use is the provided result submission tool.",
    "You may only summarize the structured review subjects provided below.",
    "Do not introduce any issue, risk, or concern that is not present in the subject list.",
    "Group related subject IDs together when that improves the summary.",
    "Do not invent verdicts, counts, or status text. The caller renders those separately.",
    "Return strict JSON only with the shape:",
    JSON.stringify({
      highlights: [
        {
          subjectIds: ["subject-id"],
          text: "string",
        },
      ],
    }),
    "Each `text` value should be concise, markdown-ready, and must not start with a bullet marker.",
    "Every highlight must reference only the provided subject IDs.",
    "Use emojis if appropriate.",
    "Structured review subjects:",
    JSON.stringify(subjects),
  ].join("\n\n")
