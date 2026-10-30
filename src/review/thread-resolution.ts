import { Type, type Static } from "typebox"

export const RESOLVE_THREAD_TOOL = "resolve_thread"

export const ResolveThreadParameters = Type.Object({
  reason: Type.Union([Type.Literal("fixed"), Type.Literal("withdrawn")], {
    description:
      "fixed when the head shows the finding's problem gone; withdrawn when the reply showed the finding was mistaken",
  }),
  evidence: Type.String({
    description: "The head's path:line that settles it: the fix, or what shows the finding was wrong",
  }),
})

export type ResolveThreadArgs = Static<typeof ResolveThreadParameters>

export type ResolveRefusal =
  | "no_evidence"
  | "not_answering"
  | "already_resolved"
  | "resolved_by_this_answer"
  | "unreachable"

export type ResolveOutcome =
  | { readonly kind: "resolved"; readonly reason: ResolveThreadArgs["reason"] }
  | { readonly kind: "refused"; readonly refusal: ResolveRefusal }

export function evidenceProblem(evidence: string): "no_evidence" | undefined {
  return evidence.trim() === "" ? "no_evidence" : undefined
}

export function answeringGuard(
  runningOperation: string | undefined,
  answerDeliveryId: string | undefined,
): "not_answering" | undefined {
  if (answerDeliveryId === undefined || runningOperation !== `chat:${answerDeliveryId}`) return "not_answering"
  return undefined
}

export function resolveOutcomeText(outcome: ResolveOutcome): string {
  if (outcome.kind === "resolved") {
    return outcome.reason === "fixed"
      ? "The thread is resolved as fixed. Say in a sentence what you checked."
      : "The thread is resolved; the finding is withdrawn. Say in a sentence why."
  }
  switch (outcome.refusal) {
    case "no_evidence":
      return "Not resolved: give the head's path:line as evidence, the fix or what shows the finding was wrong."
    case "not_answering":
      return "Not resolved: resolve_thread acts only while answering a reply in one of my threads; a review lists fixed threads in addressed_threads."
    case "already_resolved":
      return "Not resolved: the thread was already resolved, by a review that found it fixed. Say nothing more about it."
    case "resolved_by_this_answer":
      return "The thread is already resolved by this answer; nothing more to do."
    case "unreachable":
      return "Not resolved: I couldn't reach GitHub. Say what you checked and that the thread stays open."
  }
}
