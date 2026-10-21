import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { createModels } from "@earendil-works/pi-ai/models"
import { createRegistry, Harness } from "@earendil-works/pi-durable"
import { PiHarness, ROOT_SESSION, type PiPromptResponse } from "agents/harness/pi"
import { Lifecycle } from "agents/lifecycle"
import { createAI } from "agents/models/pi-ai"
import type { SkillContent, SkillResource, SkillSource } from "agents/skills"
import { DurableObject } from "cloudflare:workers"
import { Type } from "typebox"
import { Value } from "typebox/value"
import { helpText, parseCommand } from "./commands.ts"
import { createAppJwt, fetchInstallationToken, InstallationToken } from "./github/app-auth.ts"
import {
  canCommand,
  GitHubClient,
  type Comparison,
  type PullRequestInfo,
  type RepoRef,
  type ReviewThread,
  type UpdateCheckRun,
} from "./github/client.ts"
import { indexCommentableLines, type ChangedFile, type MarkedLines } from "./github/diff.ts"
import { log, logError, errorText } from "./log.ts"
import { outputLimitOf, reviewThinkingLevel, withForcedResubmission, withOutputLimit } from "./models.ts"
import { PostedReview, PullRequestKey, SummaryCommentId } from "./records.ts"
import {
  checksState,
  decideApproval,
  evaluatesAfterReview,
  LastReview,
  lastReviewOf,
  openBlockingIn,
  verdictAfterChecks,
  type ApprovalState,
  type ApprovalTrigger,
  type ChecksState,
  type WaitReason,
  type WebhookTrigger,
} from "./review/approval.ts"
import { bundledSkills } from "./review/bundled-skills.ts"
import {
  failedCheckRun,
  postedCheckRun,
  postedEarlierCheckRun,
  replacedCheckRun,
  startedCheckRun,
  summaryCommentLink,
  supersededCheckRun,
  unchangedCheckRun,
} from "./review/check.ts"
import {
  callsByModel,
  spendFields,
  spendSince,
  usageTotals,
  type ReviewSpend,
  type UsageTotals,
} from "./review/cost.ts"
import { describeFailure } from "./review/failure.ts"
import {
  countBySeverity,
  missingWalkthrough,
  parseWrittenReview,
  toReviewComment,
  validateFindings,
  type FindingInput,
  type ReviewSubmissionInput,
  type WrittenReview,
} from "./review/findings.ts"
import {
  decideFlight,
  migratePending,
  ownsOperation,
  replacedExit,
  runStanding,
  StoredPending,
  type FlightDecision,
  type PendingReview,
} from "./review/flight.ts"
import {
  addressedThreads,
  applyDeltaPolicy,
  buildScope,
  chooseMode,
  coveredFiles,
  coveredMap,
  deltaScopeOf,
  findingRecords,
  freshScope,
  nextReviewed,
  nothingToReview,
  openBlockingAfter,
  pathsChangedSince,
  pathsNeedingRows,
  planThreads,
  promptFiles,
  resolveThreads,
  ReviewedRecord,
  ReviewScope,
  StoredFinding,
  submissionFromRecord,
  threadLists,
  type OpenThread,
  type ReviewMode,
  type ReviewPlan,
  type ScopedReview,
  type ThreadPlan,
} from "./review/incremental.ts"
import { linkedIssueNumbers, linkedIssuesFrom, readLinkedIssues, type LinkedIssue } from "./review/linked-issues.ts"
import {
  answerPrompt,
  fullPrompt,
  incrementalPrompt,
  problemsText,
  resubmitPrompt,
  reviewPrompt,
  threadAnswerPrompt,
} from "./review/prompt.ts"
import {
  approvalBody,
  chooseReviewEvent,
  incompleteNote,
  renderReviewBody,
  renderSummaryComment,
  renderUnpostedNote,
  renderUnpostedSummary,
  reviewEventOf,
  SUMMARY_MARKER,
  withApprovedVerdict,
  type Coverage,
  type RetryOutcome,
  type Verdict,
} from "./review/render.ts"
import { renderActivatedSkill, renderSkillWithResources } from "./review/skills.ts"
import { commandInThread, threadIgnoreReason, threadOf } from "./review/thread-question.ts"
import { createReviewExtension, type ReviewHost, type SubmitOutcome } from "./review/tools.ts"
import { summarizeTranscript, transcriptFields } from "./review/transcript.ts"
import { shortSha } from "./sha.ts"
import { isOlder, versionOf, type Version } from "./version.ts"

export type Incoming =
  | {
      kind: "review"
      key: PullRequestKey
      deliveryId: string
      headSha: string
      full: boolean
      requestedBy?: string
    }
  | {
      kind: "comment"
      key: PullRequestKey
      deliveryId: string
      author: string
      body: string
      thread?: ThreadContext
    }
  | {
      kind: "approval"
      key: PullRequestKey
      deliveryId: string
      trigger: WebhookTrigger
    }

export interface ThreadContext {
  commentId: number
  rootId: number
  path: string
  line: number | null
  diffHunk: string
}

type ReviewIncoming = Extract<Incoming, { kind: "review" }>
type CommentIncoming = Extract<Incoming, { kind: "comment" }>
type Replacement = Extract<FlightDecision, { kind: "replace" }>
type RunOwner = Pick<PendingReview, "headSha" | "deliveryId">

interface Attribution {
  model: string
  fingerprint: string
}

interface CheckedSubmission {
  scope: ReviewScope
  scoped: ScopedReview
  missing: string[]
}

interface ReviewRun {
  operationId: string
  deliveryId: string
  started: number
  staleBuild: boolean
  callerBuild: string | undefined
  skillsFingerprint: string
}

type ReviewSource = "tool" | "text" | "retry" | "retry_text"

interface ApprovalContext {
  number: number
  head: string
  trigger: ApprovalTrigger
  delivery: string | undefined
}

const StoredDetailText = Type.String()

export class PullRequest extends DurableObject<Env> implements ReviewHost {
  readonly ai = createAI({ binding: this.env.AI })
  readonly registry = createRegistry()
  readonly harness = new PiHarness({
    harness: ({ storage, context }) => {
      this.registry.install(createReviewExtension(this))
      const models = createModels()
      models.setProvider(withForcedResubmission(withOutputLimit(this.ai.provider, this.outputLimit())))
      return Harness.open(
        storage,
        {
          models,
          registry: this.registry,
          settings: { retry: { enabled: true, maxRetries: 4, baseDelayMs: 1000 } },
          onReport: (error) => console.warn("pi report", error),
        },
        context,
      )
    },
    defaults: { model: this.reviewModel(), thinkingLevel: reviewThinkingLevel(this.env.REVIEW_THINKING_LEVEL) },
  })
  readonly lifecycle = Lifecycle.install(this).use(this.harness)

  #pr: PullRequestInfo | undefined
  #files: ChangedFile[] | undefined
  #incompleteDelivery: string | undefined
  #approving = new Set<string>()

  reviewModel() {
    return this.ai(this.env.REVIEW_MODEL)
  }

  private outputLimit(): number {
    return outputLimitOf(this.env.MAX_OUTPUT_TOKENS)
  }

  private version(): Version {
    return versionOf(this.env.CF_VERSION_METADATA)
  }

  async accept(incoming: Incoming, callerVersion?: Version): Promise<"accepted"> {
    await this.ctx.storage.put("key", incoming.key)
    this.ctx.waitUntil(
      this.handle(incoming, callerVersion).catch((error) =>
        logError("event.failed", { delivery: incoming.deliveryId, kind: incoming.kind, error: errorText(error) }),
      ),
    )
    return "accepted"
  }

  botLogin(): string {
    return this.env.BOT_LOGIN
  }

  async github(): Promise<GitHubClient> {
    const key = await this.key()
    const cached = await this.ctx.storage.get("token")
    if (Value.Check(InstallationToken, cached) && cached.expiresAt - Date.now() > 5 * 60_000) {
      return new GitHubClient(cached.token)
    }
    const jwt = await createAppJwt(this.env.GITHUB_APP_ID, this.env.GITHUB_PRIVATE_KEY)
    const token = await fetchInstallationToken(jwt, key.installationId)
    await this.ctx.storage.put("token", token)
    return new GitHubClient(token.token)
  }

  async pullRequest(): Promise<PullRequestInfo> {
    if (this.#pr) return this.#pr
    const key = await this.key()
    this.#pr = await (await this.github()).getPullRequest(key, key.number)
    return this.#pr
  }

  async changedFiles(): Promise<ChangedFile[]> {
    if (this.#files) return this.#files
    const key = await this.key()
    this.#files = await (await this.github()).listPullRequestFiles(key, key.number)
    return this.#files
  }

  async submitReview(submission: ReviewSubmissionInput): Promise<SubmitOutcome> {
    const pending = await this.readPending()
    if (!pending) return { text: "Nothing to post: no review is pending. Answer in text instead.", done: false }
    if (!(await this.callerIsReviewInFlight(pending))) return { text: NOT_IN_FLIGHT_REFUSAL, done: false }
    return this.postReview(submission, pending.deliveryId)
  }

  private async postReview(submission: ReviewSubmissionInput, deliveryId: string): Promise<SubmitOutcome> {
    const pending = await this.pendingFor(deliveryId)
    if (!pending) return { text: NOT_IN_FLIGHT_REFUSAL, done: false }
    const posted = await this.ctx.storage.get(`posted:${pending.headSha}`)
    if (Value.Check(PostedReview, posted)) {
      await this.completeAsPostedEarlier(deliveryId, posted)
      return { text: `Posted already: review ${posted.reviewId} for this head. Nothing more to do.`, done: true }
    }

    const pr = await this.freshPullRequest()
    if (pr.head.sha !== pending.headSha) {
      return {
        text: `Not posted: the pull request moved from ${pending.headSha.slice(0, 7)} to ${pr.head.sha.slice(0, 7)} while you reviewed. A new review will run for the new head; stop here.`,
        done: false,
      }
    }
    const checked = await this.checkSubmission(submission, pr, pending)
    const returned = [...checked.scoped.rejected, ...checked.scoped.duplicates]
    if (pending.rejectionsReturned !== true && (returned.length > 0 || checked.missing.length > 0)) {
      await this.markRejectionsReturned(pending.deliveryId)
      return { text: problemsText(returned, checked.missing), done: false }
    }
    if (checked.missing.length > 0) return this.endIncomplete(pr, pending, checked.missing)
    return this.publishReview(pr, pending, submission, checked)
  }

  private async checkSubmission(
    submission: ReviewSubmissionInput,
    pr: PullRequestInfo,
    pending: PendingReview,
  ): Promise<CheckedSubmission> {
    const files = await this.changedFiles()
    const scope = await this.scopeFor(pending.deliveryId)
    const hasLinkedIssues = (pending.linkedIssues?.length ?? 0) > 0
    const validated = validateFindings(submission.findings, indexCommentableLines(files), hasLinkedIssues)
    const scoped = applyDeltaPolicy(validated, deltaScopeOf(scope))
    const missing = missingWalkthrough(submission, pathsNeedingRows(scope, files))
    log("review.findings", {
      number: pr.number,
      head: shortSha(pr.head.sha),
      mode: scope.mode,
      accepted: scoped.accepted.length,
      relocated: validated.relocated,
      suggestionsDropped: validated.suggestionsDropped,
      rejected: scoped.rejected.length,
      duplicates: scoped.duplicates.length,
      missingRows: missing.length,
      rejectionsReturned: pending.rejectionsReturned === true,
    })
    return { scope, scoped, missing }
  }

  private async endIncomplete(
    pr: PullRequestInfo,
    pending: PendingReview,
    missing: readonly string[],
  ): Promise<SubmitOutcome> {
    log("review.incomplete", {
      number: pr.number,
      head: shortSha(pr.head.sha),
      missing: missing.length,
      ...spendFields(await this.spendOf(pending)),
    })
    const note = incompleteNote(missing)
    await this.upsertSummary(renderUnpostedSummary({ botLogin: this.botLogin(), headSha: pr.head.sha, note }))
    this.#incompleteDelivery = pending.deliveryId
    await this.endOwnRun(pending.deliveryId, await this.failedRun(note))
    return { text: `Not posted: no walkthrough row for ${missing.join(", ")}. The review ends here.`, done: true }
  }

  private async publishReview(
    pr: PullRequestInfo,
    pending: PendingReview,
    submission: ReviewSubmissionInput,
    { scope, scoped }: CheckedSubmission,
  ): Promise<SubmitOutcome> {
    const resolved = await this.resolveAddressed(
      pr,
      addressedThreads(submission.addressed_threads, scope.recheck).resolve,
    )
    const verdict = await this.reviewVerdict(pr, submission, scoped, openBlockingAfter(scope, resolved))
    const event = reviewEventOf(verdict)
    const key = await this.key()
    const github = await this.github()
    const attribution = attributionOf(pending)
    const spend = await this.spendOf(pending)
    const reviewed = nextReviewed({
      previous: await this.readReviewed(),
      scope,
      headSha: pr.head.sha,
      baseRef: pr.base.ref,
      at: Date.now(),
      submission,
      resolved: resolved.length,
    })
    const summary = renderSummaryComment({
      botLogin: this.botLogin(),
      headSha: pr.head.sha,
      event: verdict,
      submission: submissionFromRecord(submission, reviewed),
      accepted: scoped.accepted,
      droppedCount: scoped.rejected.length,
      model: attribution?.model,
      skillsFingerprint: attribution?.fingerprint,
      spend,
      linkedIssues: pending.linkedIssues ?? [],
      since: reviewed.since,
    })
    await this.upsertSummary(summary)
    const review = await github.createReview(key, key.number, {
      commit_id: pr.head.sha,
      event,
      body: renderReviewBody(
        verdict,
        scoped.accepted,
        scoped.rejected,
        coverageOf(scope, pr.head.sha, resolved.length),
      ),
      comments: scoped.accepted.map(toReviewComment),
    })
    await this.ctx.storage.put<LastReview>(
      "lastReview",
      lastReviewOf({
        reviewId: review.id,
        event,
        headSha: pr.head.sha,
        verdict: submission.verdict,
        rejected: scoped.rejected,
        at: Date.now(),
      }),
    )
    await this.replyFixed(pr, resolved)
    await this.storeFindings(pr, scoped.accepted, review.id)
    await this.ctx.storage.put<ReviewedRecord>("reviewed", reviewed)
    await this.ctx.storage.put<PostedReview>(`posted:${pr.head.sha}`, {
      reviewId: review.id,
      event,
      at: Date.now(),
      counts: countBySeverity(scoped.accepted),
      spend,
      ...attribution,
    })
    await this.endOwnRun(
      pending.deliveryId,
      postedCheckRun(verdict, scoped.accepted, summary, await this.summaryCommentUrl(), Date.now()),
    )
    if (evaluatesAfterReview(event, scoped.accepted)) {
      this.ctx.waitUntil(this.evaluateApproval("review", pending.deliveryId))
    }
    const dropped =
      scoped.rejected.length > 0
        ? ` ${scoped.rejected.length} finding(s) that still failed the checks were dropped.`
        : ""
    return {
      text: `Posted review ${review.id} (${event}) with ${scoped.accepted.length} inline comment(s).${dropped}`,
      done: true,
    }
  }

  private async reviewVerdict(
    pr: PullRequestInfo,
    submission: ReviewSubmissionInput,
    scoped: ScopedReview,
    openBlocking: number | "unknown",
  ): Promise<Verdict> {
    const workflow = this.env.REQUEST_CHANGES_WORKFLOW === "true"
    const event = chooseReviewEvent(submission, scoped.accepted, scoped.rejected, workflow, openBlocking)
    const checks = event === "APPROVE" ? await this.checksOn(pr.head.sha) : undefined
    return verdictAfterChecks(event, checks)
  }

  private async storeFindings(pr: PullRequestInfo, accepted: readonly FindingInput[], reviewId: number): Promise<void> {
    if (accepted.length === 0) return
    try {
      const key = await this.key()
      const comments = await (await this.github()).listReviewComments(key, key.number, reviewId)
      const records = findingRecords(accepted, comments)
      await this.ctx.storage.put(Object.fromEntries([...records].map(([id, record]) => [`finding:${id}`, record])))
    } catch (error) {
      logError("review.findings_unrecorded", { number: pr.number, review: reviewId, error: errorText(error) })
    }
  }

  private async resolveAddressed(pr: PullRequestInfo, threads: readonly OpenThread[]): Promise<OpenThread[]> {
    if (threads.length === 0) return []
    const { resolved, failed } = await resolveThreads(await this.github(), threads)
    for (const { thread, error } of failed) {
      logError("review.resolve_failed", { number: pr.number, thread: thread.handle, step: "resolve", error })
    }
    log("review.resolved", {
      number: pr.number,
      head: shortSha(pr.head.sha),
      resolved: resolved.length,
      attempted: threads.length,
    })
    return resolved
  }

  private async replyFixed(pr: PullRequestInfo, threads: readonly OpenThread[]): Promise<void> {
    for (const thread of threads) {
      try {
        const key = await this.key()
        const reply = `Fixed in \`${shortSha(pr.head.sha)}\`.`
        await (await this.github()).replyToReviewComment(key, key.number, thread.firstCommentId, reply)
      } catch (error) {
        logError("review.resolve_failed", {
          number: pr.number,
          thread: thread.handle,
          step: "reply",
          error: errorText(error),
        })
      }
    }
  }

  private async markRejectionsReturned(deliveryId: string): Promise<void> {
    const pending = await this.pendingFor(deliveryId)
    if (pending) await this.ctx.storage.put<PendingReview>("pending", { ...pending, rejectionsReturned: true })
  }

  private async handle(incoming: Incoming, callerVersion?: Version): Promise<void> {
    switch (incoming.kind) {
      case "review":
        return this.review(incoming, callerVersion)
      case "comment":
        return this.comment(incoming, callerVersion)
      case "approval":
        return this.evaluateApproval(incoming.trigger, incoming.deliveryId)
    }
  }

  private async review(incoming: ReviewIncoming, callerVersion?: Version): Promise<void> {
    const staleBuild = isOlder(this.version(), callerVersion)
    const pr = await this.freshPullRequest()
    if (pr.state !== "open") {
      log("review.skip", { reason: "not_open", state: pr.state, number: pr.number })
      return
    }
    if (pr.head.sha !== incoming.headSha) {
      log("review.skip", {
        reason: "superseded",
        was: shortSha(incoming.headSha),
        now: shortSha(pr.head.sha),
        number: pr.number,
      })
      return
    }
    if (!incoming.full && (await this.isPosted(pr))) {
      log("review.skip", { reason: "already_reviewed", head: shortSha(pr.head.sha), number: pr.number })
      return
    }
    const skillsFingerprint = (await bundledSkills()).fingerprint
    const flight = await this.clearFlight(pr.head.sha)
    if (flight.kind === "skip") {
      log("review.skip", { reason: "in_progress", head: shortSha(pr.head.sha), number: pr.number })
      return
    }
    if (incoming.full) await this.ctx.storage.delete(`posted:${pr.head.sha}`)
    const run = {
      operationId: `review:${incoming.deliveryId}`,
      deliveryId: incoming.deliveryId,
      started: Date.now(),
      staleBuild,
      callerBuild: callerVersion?.id,
      skillsFingerprint,
    }
    await this.ctx.storage.put<PendingReview>("pending", {
      headSha: pr.head.sha,
      deliveryId: incoming.deliveryId,
      operationId: run.operationId,
      started: run.started,
      model: this.env.REVIEW_MODEL,
      fingerprint: skillsFingerprint,
      ...(await this.usageBaseline()),
    })
    await this.runReview(pr, incoming, run)
  }

  private async clearFlight(headSha: string): Promise<FlightDecision> {
    const pending = await this.readPending()
    const operations = await this.operationsOf(pending)
    const decision = decideFlight(pending, headSha, { running: operations.length > 0, now: Date.now() })
    if (decision.kind !== "replace") return decision
    log("review.replaced", {
      because: decision.because,
      previous: shortSha(decision.previous.headSha),
      head: shortSha(headSha),
    })
    await this.ctx.storage.delete("pending")
    for (const operationId of operations) await this.abortOperation(operationId)
    await this.endReplacedRun(decision, headSha)
    return decision
  }

  private async abortOperation(operationId: string): Promise<void> {
    try {
      await this.harness.abort({ operationId })
    } catch (error) {
      logError("review.abort_failed", { operation: operationId, error: errorText(error) })
    }
  }

  private async operationsOf(pending: PendingReview | undefined): Promise<string[]> {
    if (pending === undefined) return []
    const operations = await this.harness.pending()
    return operations.map(({ operationId }) => operationId).filter((operationId) => ownsOperation(pending, operationId))
  }

  private async endReplacedRun({ previous, because }: Replacement, headSha: string): Promise<void> {
    if (previous.checkRunId === undefined) return
    const update =
      because === "superseded"
        ? supersededCheckRun(headSha, Date.now())
        : await this.failedRun("The object stopped before the review finished.")
    await this.completeCheckRun(previous.checkRunId, previous, update)
  }

  private async openRun(pr: PullRequestInfo, run: ReviewRun): Promise<ChangedFile[]> {
    const files = await this.changedFiles()
    const checkRunId = await this.startCheckRun(pr, files, run)
    if (checkRunId === undefined) return files
    const pending = await this.pendingFor(run.deliveryId)
    if (pending === undefined) await this.cancelUnrecordedRun(pr, run, checkRunId)
    else await this.ctx.storage.put<PendingReview>("pending", { ...pending, checkRunId })
    return files
  }

  private async linkedIssues(pr: PullRequestInfo): Promise<LinkedIssue[]> {
    const key = await this.key()
    const github = await this.github()
    const reads = await readLinkedIssues(
      linkedIssueNumbers(pr.body, pr.head.ref),
      (number) => github.getIssue(key, number),
      (issue, error) => logError("review.issue_unreadable", { number: pr.number, issue, error }),
    )
    return linkedIssuesFrom(reads)
  }

  private async recordLinkedIssues(deliveryId: string, issues: readonly LinkedIssue[]): Promise<void> {
    const pending = await this.pendingFor(deliveryId)
    const linkedIssues = issues.map(({ number }) => number)
    if (pending) await this.ctx.storage.put<PendingReview>("pending", { ...pending, linkedIssues })
  }

  private async runReview(pr: PullRequestInfo, incoming: ReviewIncoming, run: ReviewRun): Promise<void> {
    try {
      const files = await this.openRun(pr, run)
      const issues = await this.linkedIssues(pr)
      await this.recordLinkedIssues(run.deliveryId, issues)
      const { scope, since } = await this.planReview(pr, files, incoming, run)
      const prompt = promptFor(pr, files, scope, since, issues)
      log("review.start", {
        number: pr.number,
        head: shortSha(pr.head.sha),
        files: files.length,
        linkedIssues: issues.length,
        promptChars: prompt.length,
        model: this.env.REVIEW_MODEL,
        thinkingLevel: this.env.REVIEW_THINKING_LEVEL,
        maxOutputTokens: this.outputLimit(),
        skillsFingerprint: run.skillsFingerprint,
        full: incoming.full,
        mode: scope.mode,
        since: scope.from === undefined ? undefined : shortSha(scope.from),
        covered: scope.covered.length,
        recheck: scope.recheck.length,
        build: this.version().id,
        staleBuild: run.staleBuild,
        callerBuild: run.callerBuild,
        delivery: run.deliveryId,
      })
      if (await this.replaced(pr, run)) return
      if (nothingToReview(scope)) return await this.skipUnchanged(pr, run, scope)
      await this.harness.session().reset()
      await this.harness.session().setModel(this.reviewModel())
      await this.configureReview()
      if (await this.replaced(pr, run)) return
      const result = await this.harness.prompt(prompt, { operationId: run.operationId })
      logTranscript(pr, "review", result)
      await this.restartGrace(run.deliveryId)
      const source = await this.finishReview(pr, result, run)
      if (source) {
        log("review.done", {
          number: pr.number,
          head: shortSha(pr.head.sha),
          outcome: "posted",
          source,
          skills: `review@${run.skillsFingerprint.slice(0, 8)}`,
          ms: Date.now() - run.started,
          ...spendFields(await this.postedSpend(pr)),
        })
      }
      await this.releasePending(run.deliveryId)
    } catch (error) {
      await this.endOwnRun(run.deliveryId, await this.failedRun(errorText(error)))
      throw error
    }
  }

  private async planReview(
    pr: PullRequestInfo,
    files: readonly ChangedFile[],
    incoming: ReviewIncoming,
    run: ReviewRun,
  ): Promise<ReviewPlan> {
    const reviewed = await this.readReviewed()
    const comparison =
      incoming.full || reviewed === undefined ? undefined : await this.compareSince(pr, reviewed.headSha)
    const mode = chooseMode({ full: incoming.full, reviewed, baseRef: pr.base.ref, compareStatus: comparison?.status })
    const since = mode === "incremental" ? (comparison?.files ?? []) : []
    const covered = coveredFiles(files, since)
    const threads = await this.threadPlan(pr, mode, covered, since)
    const changed = pathsChangedSince(files, since)
    const scope = buildScope({ deliveryId: run.deliveryId, mode, from: reviewed?.headSha, covered, threads, changed })
    if (await this.ownsPending(run.deliveryId)) await this.ctx.storage.put<ReviewScope>("scope", scope)
    return { scope, since }
  }

  private async readReviewed(): Promise<ReviewedRecord | undefined> {
    const stored = await this.ctx.storage.get("reviewed")
    return Value.Check(ReviewedRecord, stored) ? stored : undefined
  }

  private async scopeFor(deliveryId: string): Promise<ReviewScope> {
    const stored = await this.ctx.storage.get("scope")
    return Value.Check(ReviewScope, stored) && stored.deliveryId === deliveryId ? stored : freshScope(deliveryId)
  }

  private async compareSince(pr: PullRequestInfo, since: string): Promise<Comparison | undefined> {
    try {
      const key = await this.key()
      return await (await this.github()).compareCommits(key, since, pr.head.sha)
    } catch (error) {
      logError("review.compare_failed", { number: pr.number, since: shortSha(since), error: errorText(error) })
      return undefined
    }
  }

  private async threadPlan(
    pr: PullRequestInfo,
    mode: ReviewMode,
    covered: ReadonlyMap<string, MarkedLines>,
    since: readonly ChangedFile[],
  ): Promise<ThreadPlan | undefined> {
    try {
      const key = await this.key()
      const threads = await (await this.github()).listReviewThreads(key, key.number)
      const findings = await this.storedFindings(threads.map((thread) => thread.firstCommentId))
      return planThreads({ threads, findings, botLogin: this.botLogin(), mode, covered, since })
    } catch (error) {
      logError("review.threads_failed", { number: pr.number, error: errorText(error) })
      return undefined
    }
  }

  private async storedFindings(commentIds: readonly number[]): Promise<Map<number, StoredFinding>> {
    const findings = new Map<number, StoredFinding>()
    for (let start = 0; start < commentIds.length; start += MOST_KEYS_PER_GET) {
      const ids = commentIds.slice(start, start + MOST_KEYS_PER_GET)
      const stored = await this.ctx.storage.get(ids.map((id) => `finding:${id}`))
      for (const id of ids) {
        const record = stored.get(`finding:${id}`)
        if (Value.Check(StoredFinding, record)) findings.set(id, record)
      }
    }
    return findings
  }

  private async skipUnchanged(pr: PullRequestInfo, run: ReviewRun, scope: ReviewScope): Promise<void> {
    const since = scope.from ?? pr.base.sha
    log("review.skip", {
      reason: "no_new_changes",
      head: shortSha(pr.head.sha),
      since: shortSha(since),
      number: pr.number,
    })
    const reviewed = await this.readReviewed()
    if (reviewed)
      await this.ctx.storage.put<ReviewedRecord>("reviewed", { ...reviewed, headSha: pr.head.sha, at: Date.now() })
    await this.endOwnRun(run.deliveryId, unchangedCheckRun(since, Date.now()))
  }

  private async configureReview(): Promise<void> {
    const { source } = await bundledSkills()
    const skill = await loadSkill(source, "review")
    const references = await loadReferences(source, skill)
    const root = await (await this.harness.pi()).root(BACKGROUND_CONTEXT)
    await root.configure(
      {
        instructions: renderSkillWithResources(skill, references),
        thinkingLevel: reviewThinkingLevel(this.env.REVIEW_THINKING_LEVEL),
      },
      BACKGROUND_CONTEXT,
    )
  }

  private async finishReview(
    pr: PullRequestInfo,
    result: PiPromptResponse,
    run: ReviewRun,
  ): Promise<ReviewSource | undefined> {
    if (await this.isPosted(pr)) return "tool"
    if (await this.replaced(pr, run)) return undefined
    if (result.status !== "done") {
      await this.reportFailedReview(pr, result, run)
      return undefined
    }
    const text = result.text ?? ""
    const written = parseWrittenReview(text)
    if (written.kind === "unfit") {
      log("review.unfit_json", {
        number: pr.number,
        head: shortSha(pr.head.sha),
        problem: written.problem,
        chars: text.length,
        text: text.slice(0, MAX_LOGGED_TEXT_CHARS),
      })
    }
    if (written.kind !== "submission") return this.askAgain(pr, written, undefined, run)
    const outcome = await this.postReview(written.submission, run.deliveryId).catch((cause) => ({
      text: errorText(cause),
      done: false,
    }))
    if (await this.isPosted(pr)) return "text"
    if (outcome.done) return undefined
    log("review.text_refused", { number: pr.number, head: shortSha(pr.head.sha), refusal: outcome.text })
    return this.askAgain(pr, written, outcome.text, run)
  }

  private async askAgain(
    pr: PullRequestInfo,
    written: WrittenReview,
    refusal: string | undefined,
    run: ReviewRun,
  ): Promise<ReviewSource | undefined> {
    const rowsNeeded =
      refusal === undefined ? pathsNeedingRows(await this.scopeFor(run.deliveryId), await this.changedFiles()) : []
    if (await this.headMoved(pr, run)) return undefined
    await this.restartGrace(run.deliveryId)
    if (await this.replaced(pr, run)) return undefined
    const retry = await this.harness.prompt(resubmitPrompt(refusal, rowsNeeded), {
      operationId: `${run.operationId}:retry`,
    })
    logTranscript(pr, "retry", retry)
    await this.restartGrace(run.deliveryId)
    if (await this.isPosted(pr)) return "retry"
    const retryRefusal = await this.postRetryText(retry, run)
    if (await this.isPosted(pr)) return "retry_text"
    if (await this.replaced(pr, run)) return undefined
    if (await this.headMoved(pr, run)) return undefined
    await this.reportUnpostedReview(pr, written, retry, retryRefusal, run)
    return undefined
  }

  private async postRetryText(retry: PiPromptResponse, run: ReviewRun): Promise<string | undefined> {
    if (retry.status !== "done") return undefined
    const written = parseWrittenReview(retry.text ?? "")
    if (written.kind !== "submission") return undefined
    await this.markRejectionsReturned(run.deliveryId)
    return this.postReview(written.submission, run.deliveryId).then(
      ({ text, done }) => (done ? undefined : text),
      errorText,
    )
  }

  private async replaced(pr: PullRequestInfo, run: ReviewRun): Promise<boolean> {
    const current = await this.readPending()
    const standing = runStanding(current, run.deliveryId, this.#incompleteDelivery)
    if (standing === "replaced") {
      const newerHeadSha = current?.headSha ?? (await this.latestHeadSha(pr))
      log(replacedExit(newerHeadSha, pr.head.sha), {
        number: pr.number,
        head: shortSha(pr.head.sha),
        delivery: run.deliveryId,
      })
    }
    return standing !== "in_flight"
  }

  private async latestHeadSha(pr: PullRequestInfo): Promise<string | undefined> {
    try {
      return (await this.freshPullRequest()).head.sha
    } catch (error) {
      logError("review.head_unreadable", { number: pr.number, error: errorText(error) })
      return undefined
    }
  }

  private async headMoved(pr: PullRequestInfo, run: ReviewRun): Promise<boolean> {
    const now = await this.freshPullRequest()
    if (now.head.sha === pr.head.sha) return false
    log("review.skip", {
      reason: "superseded",
      was: shortSha(pr.head.sha),
      now: shortSha(now.head.sha),
      number: pr.number,
      ms: Date.now() - run.started,
    })
    await this.endOwnRun(run.deliveryId, supersededCheckRun(now.head.sha, Date.now()))
    return true
  }

  private async isPosted(pr: PullRequestInfo): Promise<boolean> {
    return (await this.ctx.storage.get(`posted:${pr.head.sha}`)) !== undefined
  }

  private async usageNow(): Promise<UsageTotals> {
    return usageTotals(await (await this.harness.pi()).usage(BACKGROUND_CONTEXT))
  }

  private async usageBaseline(): Promise<Pick<StoredPending, "usageBefore">> {
    try {
      return { usageBefore: await this.usageNow() }
    } catch (error) {
      logError("review.usage_unreadable", { when: "start", error: errorText(error) })
      return {}
    }
  }

  private async spendOf(pending: PendingReview): Promise<ReviewSpend> {
    if (pending.usageBefore === undefined) return []
    try {
      const calls = callsByModel(await this.harness.session().messages())
      return spendSince(pending.usageBefore, await this.usageNow(), calls)
    } catch (error) {
      logError("review.usage_unreadable", { when: "spend", error: errorText(error) })
      return []
    }
  }

  private async runSpend(deliveryId: string): Promise<ReviewSpend> {
    const pending = await this.pendingFor(deliveryId)
    return pending === undefined ? [] : this.spendOf(pending)
  }

  private async postedSpend(pr: PullRequestInfo): Promise<ReviewSpend | undefined> {
    const posted = await this.ctx.storage.get(`posted:${pr.head.sha}`)
    return Value.Check(PostedReview, posted) ? posted.spend : undefined
  }

  private async reportFailedReview(pr: PullRequestInfo, result: PiPromptResponse, run: ReviewRun): Promise<void> {
    const failure = describeFailure(result, await this.storedFailureDetail(run.operationId))
    logError("review.failed", {
      number: pr.number,
      head: shortSha(pr.head.sha),
      reason: failure,
      ms: Date.now() - run.started,
      staleBuild: run.staleBuild,
      ...spendFields(await this.runSpend(run.deliveryId)),
    })
    if (await this.headMoved(pr, run)) return
    const note = `_The review did not complete: ${failure}._`
    await this.upsertSummary(renderUnpostedSummary({ botLogin: this.botLogin(), headSha: pr.head.sha, note }))
    await this.endOwnRun(run.deliveryId, await this.failedRun(note))
  }

  private async reportUnpostedReview(
    pr: PullRequestInfo,
    written: WrittenReview,
    retry: PiPromptResponse,
    retryRefusal: string | undefined,
    run: ReviewRun,
  ): Promise<void> {
    const failure =
      retry.status === "done" ? undefined : describeFailure(retry, await this.storedFailureDetail(retry.operationId))
    const fields = {
      number: pr.number,
      head: shortSha(pr.head.sha),
      wrote: written.kind,
      ms: Date.now() - run.started,
      ...spendFields(await this.runSpend(run.deliveryId)),
    }
    if (failure === undefined) {
      log("review.no_submission", {
        ...fields,
        retryText: retry.text?.slice(0, MAX_LOGGED_TEXT_CHARS),
        retryRefusal,
      })
    } else {
      logError("review.failed", { ...fields, reason: failure, retry: true, staleBuild: run.staleBuild })
    }
    const note = renderUnpostedNote(written, retryOutcome(failure, retryRefusal))
    await this.upsertSummary(renderUnpostedSummary({ botLogin: this.botLogin(), headSha: pr.head.sha, note }))
    await this.endOwnRun(run.deliveryId, await this.failedRun(note))
  }

  private async comment(incoming: CommentIncoming, callerVersion?: Version): Promise<void> {
    const key = await this.key()
    const github = await this.github()
    const thread = await this.threadFor(github, key, incoming.thread)
    const command = incoming.thread
      ? commandInThread(incoming.body, this.botLogin(), thread)
      : parseCommand(incoming.body, this.botLogin())
    if (!command) {
      this.ignored(incoming, thread, key.number)
      return
    }
    if (!canCommand(await github.getCollaboratorPermission(key, incoming.author))) {
      log("command.ignored", { reason: "no_write_access", author: incoming.author, number: key.number })
      return
    }
    const where = incoming.thread ? "thread" : "conversation"
    log("command.received", { kind: command.kind, author: incoming.author, number: key.number, where })
    switch (command.kind) {
      case "help":
        await this.respond(github, key, incoming, helpText(this.botLogin()))
        return
      case "review": {
        const pr = await this.freshPullRequest()
        await this.review(
          {
            kind: "review",
            key,
            deliveryId: incoming.deliveryId,
            headSha: pr.head.sha,
            full: command.full,
            requestedBy: incoming.author,
          },
          callerVersion,
        )
        return
      }
      case "chat":
        await this.answer(github, key, incoming, command.text, thread)
        return
    }
  }

  private async evaluateApproval(trigger: ApprovalTrigger, deliveryId: string | undefined): Promise<void> {
    try {
      const pr = await this.currentPullRequest()
      const decision = decideApproval(await this.approvalState(pr))
      const context = { number: pr.number, head: shortSha(pr.head.sha), trigger, delivery: deliveryId }
      if (decision.kind === "wait") return logWait(context, decision.reason)
      await this.approve(pr.head.sha, context)
    } catch (error) {
      logError("approval.failed", { trigger, delivery: deliveryId, error: errorText(error) })
    }
  }

  private async currentPullRequest(): Promise<PullRequestInfo> {
    const key = await this.key()
    return (await this.github()).getPullRequest(key, key.number)
  }

  private async approvalState(pr: PullRequestInfo): Promise<ApprovalState> {
    return {
      workflow: this.env.REQUEST_CHANGES_WORKFLOW === "true",
      paused: await this.isPaused(),
      open: pr.state === "open" && pr.draft !== true,
      reviewInFlight: (await this.readPending()) !== undefined,
      headSha: pr.head.sha,
      reviewedHead: (await this.readReviewed())?.headSha,
      lastReview: await this.readLastReview(),
      openBlocking: openBlockingIn(await this.threadPlan(pr, "fresh", new Map<string, MarkedLines>(), [])),
      checks: await this.checksOn(pr.head.sha),
    }
  }

  private async isPaused(): Promise<boolean> {
    return (await this.ctx.storage.get("paused")) === true
  }

  private async readLastReview(): Promise<LastReview | undefined> {
    const stored = await this.ctx.storage.get("lastReview")
    return Value.Check(LastReview, stored) ? stored : undefined
  }

  private async checksOn(sha: string): Promise<ChecksState> {
    try {
      const key = await this.key()
      return checksState(await (await this.github()).listCheckRuns(key, sha), this.botLogin())
    } catch (error) {
      logError("approval.checks_failed", { head: shortSha(sha), error: errorText(error) })
      return "unknown"
    }
  }

  private async approve(head: string, context: ApprovalContext): Promise<void> {
    if (this.#approving.has(head)) return logWait(context, "approving")
    this.#approving.add(head)
    try {
      await this.submitApproval(head, context)
    } finally {
      this.#approving.delete(head)
    }
  }

  private async submitApproval(head: string, context: ApprovalContext): Promise<void> {
    if ((await this.currentPullRequest()).head.sha !== head) return logWait(context, "head_moved")
    if ((await this.readLastReview())?.event === "APPROVE") return logWait(context, "approved")
    const key = await this.key()
    const review = await (
      await this.github()
    ).createReview(key, key.number, {
      commit_id: head,
      event: "APPROVE",
      body: approvalBody(head),
      comments: [],
    })
    await this.ctx.storage.put<LastReview>("lastReview", {
      reviewId: review.id,
      event: "APPROVE",
      headSha: head,
      heldBack: 0,
      at: Date.now(),
    })
    await this.rewriteSummaryVerdict(head)
    log("approval.posted", { ...context, review: review.id })
  }

  private async rewriteSummaryVerdict(headSha: string): Promise<void> {
    try {
      const commentId = await this.summaryCommentId()
      if (commentId === undefined) return
      const key = await this.key()
      const github = await this.github()
      const comment = await github.getIssueComment(key, commentId)
      const body = withApprovedVerdict(comment.body ?? "", headSha)
      if (body !== undefined) await github.updateIssueComment(key, commentId, body)
    } catch (error) {
      logError("approval.summary_failed", { head: shortSha(headSha), error: errorText(error) })
    }
  }

  private ignored(incoming: CommentIncoming, thread: ReviewThread | undefined, number: number): void {
    const reason = incoming.thread ? threadIgnoreReason(this.botLogin(), thread) : "no_command"
    log("command.ignored", { reason, author: incoming.author, number, root: incoming.thread?.rootId })
  }

  private async threadFor(
    github: GitHubClient,
    key: PullRequestKey,
    context: ThreadContext | undefined,
  ): Promise<ReviewThread | undefined> {
    if (!context) return undefined
    try {
      return threadOf(await github.listReviewThreads(key, key.number), context.rootId)
    } catch (error) {
      logError("thread.lookup_failed", { number: key.number, root: context.rootId, error: errorText(error) })
      return undefined
    }
  }

  private async answer(
    github: GitHubClient,
    key: PullRequestKey,
    incoming: CommentIncoming,
    text: string,
    thread: ReviewThread | undefined,
  ): Promise<void> {
    await this.harness.session().setModel(this.reviewModel())
    const operationId = `chat:${incoming.deliveryId}`
    const skill = renderActivatedSkill(await loadSkill((await bundledSkills()).source, "answer"))
    const prompt = incoming.thread
      ? threadAnswerPrompt(incoming.author, text, skill, {
          path: incoming.thread.path,
          line: incoming.thread.line,
          diffHunk: incoming.thread.diffHunk,
          opening: thread?.firstCommentBody,
        })
      : answerPrompt(incoming.author, text, skill)
    const result = await this.harness.prompt(prompt, { operationId })
    const answer =
      result.status === "done" && result.text?.trim()
        ? result.text.trim()
        : `I could not answer that: ${
            result.status === "done"
              ? "the model returned nothing"
              : describeFailure(result, await this.storedFailureDetail(operationId))
          }.`
    await this.respond(github, key, incoming, `@${incoming.author} ${answer}`)
  }

  private async respond(github: GitHubClient, key: PullRequestKey, incoming: CommentIncoming, body: string) {
    if (incoming.thread) await github.replyToReviewComment(key, key.number, incoming.thread.rootId, body)
    else await github.createIssueComment(key, key.number, body)
  }

  private async storedFailureDetail(operationId: string): Promise<string | undefined> {
    try {
      const storage = await this.harness.storage()
      const conversation = await this.harness.conversation(ROOT_SESSION)
      const record = await storage.submissionByRequest(conversation.id, operationId, BACKGROUND_CONTEXT)
      if (record?.status !== "unanswered" || record.detail === undefined) return undefined
      const detail = Value.Check(StoredDetailText, record.detail) ? record.detail : JSON.stringify(record.detail)
      return detail.slice(0, 800)
    } catch (error) {
      console.warn("andabot: failure detail unavailable", error)
      return undefined
    }
  }

  private async freshPullRequest(): Promise<PullRequestInfo> {
    this.#pr = undefined
    this.#files = undefined
    return this.pullRequest()
  }

  private async key(): Promise<PullRequestKey> {
    const key = await this.ctx.storage.get("key")
    if (!Value.Check(PullRequestKey, key)) throw new Error("this object has not received an event yet")
    return key
  }

  private async upsertSummary(body: string): Promise<void> {
    const key = await this.key()
    const github = await this.github()
    const ref: RepoRef = key
    let commentId = await this.summaryCommentId()
    if (commentId === undefined) {
      const existing = (await github.listIssueComments(ref, key.number)).find((c) => c.body?.startsWith(SUMMARY_MARKER))
      commentId = existing?.id
    }
    if (commentId !== undefined) {
      try {
        await github.updateIssueComment(ref, commentId, body)
        await this.ctx.storage.put("summaryCommentId", commentId)
        return
      } catch (error) {
        console.warn("andabot: summary comment update failed, creating a new one", error)
      }
    }
    const created = await github.createIssueComment(ref, key.number, body)
    await this.ctx.storage.put("summaryCommentId", created.id)
  }

  private async summaryCommentId(): Promise<number | undefined> {
    const stored = await this.ctx.storage.get("summaryCommentId")
    return Value.Check(SummaryCommentId, stored) ? stored : undefined
  }

  private async summaryCommentUrl(): Promise<string | undefined> {
    const commentId = await this.summaryCommentId()
    if (commentId === undefined) return undefined
    const key = await this.key()
    return summaryCommentLink(key, key.number, commentId)
  }

  private async startCheckRun(
    pr: PullRequestInfo,
    files: readonly ChangedFile[],
    run: ReviewRun,
  ): Promise<number | undefined> {
    const key = await this.key()
    const start = startedCheckRun({
      name: this.botLogin(),
      headSha: pr.head.sha,
      deliveryId: run.deliveryId,
      fileCount: files.length,
      model: this.env.REVIEW_MODEL,
      startedAt: run.started,
    })
    const created = await this.guardedCheck("create", async () => (await this.github()).createCheckRun(key, start))
    if (created === undefined) return undefined
    log("check.started", { id: created.id, head: shortSha(pr.head.sha), delivery: run.deliveryId })
    return created.id
  }

  private async endOwnRun(deliveryId: string, update: UpdateCheckRun): Promise<void> {
    const pending = await this.pendingFor(deliveryId)
    if (pending === undefined) return
    await this.ctx.storage.delete(["pending", "scope"])
    if (pending.checkRunId !== undefined) await this.completeCheckRun(pending.checkRunId, pending, update)
  }

  private async failedRun(note: string): Promise<UpdateCheckRun> {
    return failedCheckRun(note, await this.summaryCommentUrl(), Date.now())
  }

  private async completeAsPostedEarlier(deliveryId: string, posted: PostedReview): Promise<void> {
    await this.endOwnRun(deliveryId, postedEarlierCheckRun(posted, await this.summaryCommentUrl(), Date.now()))
  }

  private async cancelUnrecordedRun(pr: PullRequestInfo, run: ReviewRun, checkRunId: number): Promise<void> {
    const current = await this.readPending()
    const update =
      current === undefined || current.headSha === pr.head.sha
        ? replacedCheckRun(Date.now())
        : supersededCheckRun(current.headSha, Date.now())
    await this.completeCheckRun(checkRunId, { headSha: pr.head.sha, deliveryId: run.deliveryId }, update)
  }

  private async completeCheckRun(checkRunId: number, owner: RunOwner, update: UpdateCheckRun): Promise<void> {
    const key = await this.key()
    const completed = await this.guardedCheck("complete", async () =>
      (await this.github()).updateCheckRun(key, checkRunId, update),
    )
    if (completed === undefined) return
    log("check.completed", {
      id: completed.id,
      conclusion: update.conclusion,
      head: shortSha(owner.headSha),
      delivery: owner.deliveryId,
    })
  }

  private async readPending(): Promise<PendingReview | undefined> {
    const stored = await this.ctx.storage.get("pending")
    return Value.Check(StoredPending, stored) ? migratePending(stored) : undefined
  }

  private async pendingFor(deliveryId: string): Promise<PendingReview | undefined> {
    const pending = await this.readPending()
    return pending?.deliveryId === deliveryId ? pending : undefined
  }

  private async ownsPending(deliveryId: string): Promise<boolean> {
    return (await this.pendingFor(deliveryId)) !== undefined
  }

  private async releasePending(deliveryId: string): Promise<void> {
    if (await this.ownsPending(deliveryId)) await this.ctx.storage.delete(["pending", "scope"])
  }

  private async restartGrace(deliveryId: string): Promise<void> {
    const pending = await this.pendingFor(deliveryId)
    if (pending) await this.ctx.storage.put<PendingReview>("pending", { ...pending, started: Date.now() })
  }

  private async callerIsReviewInFlight(pending: PendingReview): Promise<boolean> {
    const running = (await this.harness.pending()).find((op) => op.status === "running")
    return running !== undefined && ownsOperation(pending, running.operationId)
  }

  private async guardedCheck<T>(step: string, call: () => Promise<T>): Promise<T | undefined> {
    try {
      return await call()
    } catch (error) {
      logError("check.failed", { step, error: errorText(error) })
      return undefined
    }
  }
}

const MAX_LOGGED_TEXT_CHARS = 8_000
const MOST_KEYS_PER_GET = 128

function promptFor(
  pr: PullRequestInfo,
  files: readonly ChangedFile[],
  scope: ReviewScope,
  since: readonly ChangedFile[],
  issues: readonly LinkedIssue[],
): string {
  if (scope.mode === "fresh") return reviewPrompt(pr, files, true, issues)
  const lists = threadLists(scope.open, scope.recheck)
  if (scope.mode === "full" || scope.from === undefined) return fullPrompt(pr, files, lists, issues)
  return incrementalPrompt(pr, {
    from: scope.from,
    marked: coveredMap(scope),
    ...promptFiles(files, since, scope),
    ...lists,
    issues,
  })
}

function coverageOf(scope: ReviewScope, headSha: string, resolved: number): Coverage {
  const coverage = { mode: scope.mode, to: headSha, files: scope.covered.length, resolved }
  return scope.from === undefined ? coverage : { ...coverage, from: scope.from }
}

function logTranscript(pr: PullRequestInfo, after: "review" | "retry", result: PiPromptResponse): void {
  log("review.transcript", {
    number: pr.number,
    head: shortSha(pr.head.sha),
    after,
    status: result.status,
    ...transcriptFields(summarizeTranscript(result.messages)),
  })
}

function logWait(context: ApprovalContext, reason: WaitReason): void {
  log("approval.decided", { ...context, decision: "wait", reason })
}

function retryOutcome(failure: string | undefined, refusal: string | undefined): RetryOutcome {
  if (failure !== undefined) return { kind: "failed", reason: failure }
  if (refusal !== undefined) return { kind: "refused", refusal }
  return { kind: "unanswered" }
}

const NOT_IN_FLIGHT_REFUSAL = "Not posted: this call is not the review in flight for this head. Stop here."

function attributionOf({ model, fingerprint }: PendingReview): Attribution | undefined {
  if (model === undefined || fingerprint === undefined) return undefined
  return { model, fingerprint }
}

async function loadSkill(source: SkillSource, name: string): Promise<SkillContent> {
  const skill = await source.load(name)
  if (!skill) throw new Error(`the ${name} skill is missing from the bundle`)
  return skill
}

function loadReferences(source: SkillSource, skill: SkillContent): Promise<SkillResource[]> {
  const references = (skill.resources ?? []).filter(({ kind }) => kind === "reference")
  return Promise.all(references.map(({ path }) => loadReference(source, skill.name, path)))
}

async function loadReference(source: SkillSource, name: string, path: string): Promise<SkillResource> {
  const reference = await source.readResource?.(name, path)
  if (!reference) throw new Error(`the ${name} skill's reference ${path} is missing from the bundle`)
  return reference
}
