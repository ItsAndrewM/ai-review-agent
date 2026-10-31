import {
  filterGlobs,
  indexCommentableLines,
  isFiltered,
  reviewableFiles,
  type ChangedFile,
} from "../../src/github/diff.ts"
import type { BasisContext } from "../../src/review/basis.ts"
import {
  missingWalkthrough,
  validateFindings,
  walkthroughPaths,
  type FindingInput,
  type Rejected,
  type ReviewSubmissionInput,
  type ValidatedReview,
} from "../../src/review/findings.ts"
import { problemsText } from "../../src/review/prompt.ts"
import type { SubmitOutcome } from "../../src/review/tools.ts"

export const NO_BASIS: BasisContext = { hasLinkedIssues: false, instructionFiles: [], activatedSkills: [], docs: [] }

export interface PostedReview {
  submission: ReviewSubmissionInput
  accepted: FindingInput[]
  rejected: Rejected[]
}

export interface HostOutcome extends SubmitOutcome {
  posted?: PostedReview
  incomplete?: boolean
}

export class ReviewHost {
  readonly #reviewable: ChangedFile[]
  readonly #globs: ReturnType<typeof filterGlobs>
  readonly #basis: BasisContext
  #returned = false
  #posted: PostedReview | undefined

  constructor(files: readonly ChangedFile[], pathFilters: readonly string[], basis: BasisContext) {
    this.#reviewable = reviewableFiles(files, pathFilters)
    this.#globs = filterGlobs(pathFilters)
    this.#basis = basis
  }

  rejectionsReturned(): boolean {
    return this.#returned
  }

  markRejectionsReturned(): void {
    this.#returned = true
  }

  posted(): PostedReview | undefined {
    return this.#posted
  }

  rowsNeeded(): string[] {
    return walkthroughPaths(this.#reviewable)
  }

  submit(submission: ReviewSubmissionInput): HostOutcome {
    const validated = this.validate(submission.findings)
    const missing = missingWalkthrough(submission, this.rowsNeeded())
    if (!this.#returned && (validated.rejected.length > 0 || missing.length > 0)) {
      this.#returned = true
      return { text: problemsText(validated.rejected, missing), done: false }
    }
    if (missing.length > 0) {
      return {
        text: `Not posted: no walkthrough row for ${missing.join(", ")}. The review ends here.`,
        done: true,
        incomplete: true,
      }
    }
    const posted = { submission, accepted: validated.accepted, rejected: validated.rejected }
    this.#posted = posted
    const count = posted.accepted.length
    return { text: `Posted the review with ${count} ${count === 1 ? "finding" : "findings"}.`, done: true, posted }
  }

  private validate(findings: readonly FindingInput[]): ValidatedReview {
    const validated = validateFindings(findings, indexCommentableLines(this.#reviewable), this.#basis)
    const rejected = validated.rejected.map((rejection) =>
      isFiltered(rejection.finding.path, this.#globs)
        ? {
            finding: rejection.finding,
            reason: `path "${rejection.finding.path}" is left out of the review by path_filters; drop the finding`,
            unfounded: true,
          }
        : rejection,
    )
    return { ...validated, rejected }
  }
}
