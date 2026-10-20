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
import { createAppJwt, fetchInstallationToken, type InstallationToken } from "./github/app-auth.ts"
import {
  canCommand,
  GitHubClient,
  type Comparison,
  type PullRequestInfo,
  type RepoRef,
  type ReviewEvent,
  type UpdateCheckRun,
} from "./github/client.ts"
import { indexCommentableLines, type ChangedFile, type MarkedLines } from "./github/diff.ts"
import { log, logError, errorText } from "./log.ts"
import { outputLimitOf, reviewThinkingLevel, withForcedResubmission, withOutputLimit } from "./models.ts"
import { bundledSkills } from "./review/bundled-skills.ts"
import {
  failedCheckRun,
  postedCheckRun,
  replacedCheckRun,
  startedCheckRun,
  summaryCommentLink,
  supersededCheckRun,
  unchangedCheckRun,
} from "./review/check.ts"
import { describeFailure } from "./review/failure.ts"
import {
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
  pathsNeedingRows,
  planThreads,
  promptFiles,
  resolveThreads,
  ReviewedRecord,
  ReviewScope,
  StoredFinding,
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
} from "./review/prompt.ts"
import {
  chooseReviewEvent,
  incompleteNote,
  renderReviewBody,
  renderSummaryComment,
  renderUnpostedNote,
  renderUnpostedSummary,
  SUMMARY_MARKER,
  type Coverage,
  type RetryOutcome,
} from "./review/render.ts"
import { renderActivatedSkill, renderSkillWithResources } from "./review/skills.ts"
import { createReviewExtension, type ReviewHost, type SubmitOutcome } from "./review/tools.ts"
import { summarizeTranscript, transcriptFields } from "./review/transcript.ts"
import { isOlder, versionOf, type Version } from "./version.ts"

export interface PullRequestKey {
  installationId: number
  owner: string
  repo: string
  number: number
}

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
    }

type ReviewIncoming = Extract<Incoming, { kind: "review" }>
type CommentIncoming = Extract<Incoming, { kind: "comment" }>
type Replacement = Extract<FlightDecision, { kind: "replace" }>
type RunOwner = Pick<PendingReview, "headSha" | "deliveryId">

interface PostedReview {
  reviewId: number
  event: ReviewEvent
  at: number
  fingerprint?: string
  model?: string
}

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
    const cached = await this.ctx.storage.get<InstallationToken>("token")
    if (cached && cached.expiresAt - Date.now() > 5 * 60_000) return new GitHubClient(cached.token)
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
    const posted = await this.ctx.storage.get<PostedReview>(`posted:${pending.headSha}`)
    if (posted) {
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
    const validated = validateFindings(submission.findings, indexCommentableLines(files))
    const scoped = applyDeltaPolicy(validated, deltaScopeOf(scope))
    const missing = missingWalkthrough(submission, pathsNeedingRows(scope, files))
    log("review.findings", {
      number: pr.number,
      head: short(pr.head.sha),
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
    log("review.incomplete", { number: pr.number, head: short(pr.head.sha), missing: missing.length })
    const note = incompleteNote(missing)
    await this.upsertSummary(renderUnpostedSummary({ botLogin: this.botLogin(), headSha: pr.head.sha, note }))
    await this.failOwnRun(pending.deliveryId, note)
    this.#incompleteDelivery = pending.deliveryId
    await this.releasePending(pending.deliveryId)
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
    const openBlocking = scope.mode === "fresh" ? undefined : openBlockingAfter(scope, resolved)
    const workflow = this.env.REQUEST_CHANGES_WORKFLOW === "true"
    const event = chooseReviewEvent(submission, scoped.accepted, scoped.rejected, workflow, openBlocking)
    const key = await this.key()
    const github = await this.github()
    const attribution = attributionOf(pending)
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
      event,
      submission: { ...submission, summary: reviewed.summary, walkthrough: reviewed.walkthrough },
      accepted: scoped.accepted,
      droppedCount: scoped.rejected.length,
      model: attribution?.model,
      skillsFingerprint: attribution?.fingerprint,
      linkedIssues: pending.linkedIssues ?? [],
      since: reviewed.since,
    })
    await this.upsertSummary(summary)
    const review = await github.createReview(key, key.number, {
      commit_id: pr.head.sha,
      event,
      body: renderReviewBody(event, scoped.accepted, scoped.rejected, coverageOf(scope, pr.head.sha, resolved.length)),
      comments: scoped.accepted.map(toReviewComment),
    })
    await this.replyFixed(pr, resolved)
    await this.storeFindings(pr, scoped.accepted, review.id)
    await this.ctx.storage.put<ReviewedRecord>("reviewed", reviewed)
    await this.ctx.storage.put<PostedReview>(`posted:${pr.head.sha}`, {
      reviewId: review.id,
      event,
      at: Date.now(),
      ...attribution,
    })
    await this.completeOwnRun(
      pending.deliveryId,
      postedCheckRun(event, scoped.accepted, summary, await this.summaryCommentUrl(), Date.now()),
    )
    await this.releasePending(pending.deliveryId)
    const dropped =
      scoped.rejected.length > 0
        ? ` ${scoped.rejected.length} finding(s) that still failed the checks were dropped.`
        : ""
    return {
      text: `Posted review ${review.id} (${event}) with ${scoped.accepted.length} inline comment(s).${dropped}`,
      done: true,
    }
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
      head: short(pr.head.sha),
      resolved: resolved.length,
      attempted: threads.length,
    })
    return resolved
  }

  private async replyFixed(pr: PullRequestInfo, threads: readonly OpenThread[]): Promise<void> {
    for (const thread of threads) {
      try {
        const key = await this.key()
        const reply = `Fixed in \`${short(pr.head.sha)}\`.`
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
        was: short(incoming.headSha),
        now: short(pr.head.sha),
        number: pr.number,
      })
      return
    }
    if (!incoming.full && (await this.isPosted(pr))) {
      log("review.skip", { reason: "already_reviewed", head: short(pr.head.sha), number: pr.number })
      return
    }
    const skillsFingerprint = (await bundledSkills()).fingerprint
    const flight = await this.clearFlight(pr.head.sha)
    if (flight.kind === "skip") {
      log("review.skip", { reason: "in_progress", head: short(pr.head.sha), number: pr.number })
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
    })
    await this.runReview(pr, incoming, run)
  }

  private async clearFlight(headSha: string): Promise<FlightDecision> {
    const pending = await this.readPending()
    const operations = await this.operationsOf(pending)
    const decision = decideFlight(pending, headSha, operations.length > 0 || withinGrace(pending))
    if (decision.kind !== "replace") return decision
    log("review.replaced", {
      because: decision.because,
      previous: short(decision.previous.headSha),
      head: short(headSha),
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
        head: short(pr.head.sha),
        files: files.length,
        linkedIssues: issues.length,
        promptChars: prompt.length,
        model: this.env.REVIEW_MODEL,
        thinkingLevel: this.env.REVIEW_THINKING_LEVEL,
        maxOutputTokens: this.outputLimit(),
        skillsFingerprint: run.skillsFingerprint,
        full: incoming.full,
        mode: scope.mode,
        since: scope.from === undefined ? undefined : short(scope.from),
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
          head: short(pr.head.sha),
          outcome: "posted",
          source,
          skills: `review@${run.skillsFingerprint.slice(0, 8)}`,
          ms: Date.now() - run.started,
        })
      }
      await this.releasePending(run.deliveryId)
    } catch (error) {
      await this.failOwnRun(run.deliveryId, errorText(error))
      await this.releasePending(run.deliveryId)
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
    const threads = mode === "fresh" ? undefined : await this.threadPlan(pr, mode, covered, since)
    const scope = buildScope({ deliveryId: run.deliveryId, mode, from: reviewed?.headSha, covered, threads })
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
      logError("review.compare_failed", { number: pr.number, since: short(since), error: errorText(error) })
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
    log("review.skip", { reason: "no_new_changes", head: short(pr.head.sha), since: short(since), number: pr.number })
    const reviewed = await this.readReviewed()
    if (reviewed)
      await this.ctx.storage.put<ReviewedRecord>("reviewed", { ...reviewed, headSha: pr.head.sha, at: Date.now() })
    await this.completeOwnRun(run.deliveryId, unchangedCheckRun(since, Date.now()))
    await this.releasePending(run.deliveryId)
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
        head: short(pr.head.sha),
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
    log("review.text_refused", { number: pr.number, head: short(pr.head.sha), refusal: outcome.text })
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
    if (await this.replaced(pr, run)) return undefined
    await this.restartGrace(run.deliveryId)
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
    const standing = runStanding(await this.readPending(), run.deliveryId, this.#incompleteDelivery)
    if (standing === "replaced") {
      log("review.superseded", { number: pr.number, head: short(pr.head.sha), delivery: run.deliveryId })
    }
    return standing !== "in_flight"
  }

  private async headMoved(pr: PullRequestInfo, run: ReviewRun): Promise<boolean> {
    const now = await this.freshPullRequest()
    if (now.head.sha === pr.head.sha) return false
    log("review.skip", {
      reason: "superseded",
      was: short(pr.head.sha),
      now: short(now.head.sha),
      number: pr.number,
      ms: Date.now() - run.started,
    })
    await this.completeOwnRun(run.deliveryId, supersededCheckRun(now.head.sha, Date.now()))
    return true
  }

  private async isPosted(pr: PullRequestInfo): Promise<boolean> {
    return (await this.ctx.storage.get(`posted:${pr.head.sha}`)) !== undefined
  }

  private async reportFailedReview(pr: PullRequestInfo, result: PiPromptResponse, run: ReviewRun): Promise<void> {
    const failure = describeFailure(result, await this.storedFailureDetail(run.operationId))
    logError("review.failed", {
      number: pr.number,
      head: short(pr.head.sha),
      reason: failure,
      ms: Date.now() - run.started,
      staleBuild: run.staleBuild,
    })
    if (await this.headMoved(pr, run)) return
    const note = `_The review did not complete: ${failure}._`
    await this.upsertSummary(renderUnpostedSummary({ botLogin: this.botLogin(), headSha: pr.head.sha, note }))
    await this.failOwnRun(run.deliveryId, note)
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
    const fields = { number: pr.number, head: short(pr.head.sha), wrote: written.kind, ms: Date.now() - run.started }
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
    await this.failOwnRun(run.deliveryId, note)
  }

  private async comment(incoming: CommentIncoming, callerVersion?: Version): Promise<void> {
    const command = parseCommand(incoming.body, this.botLogin())
    if (!command) return
    const key = await this.key()
    const github = await this.github()
    if (!canCommand(await github.getCollaboratorPermission(key, incoming.author))) {
      log("command.ignored", { reason: "no_write_access", author: incoming.author, number: key.number })
      return
    }
    log("command.received", { kind: command.kind, author: incoming.author, number: key.number })
    switch (command.kind) {
      case "help":
        await github.createIssueComment(key, key.number, helpText(this.botLogin()))
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
      case "chat": {
        await this.harness.session().setModel(this.reviewModel())
        const operationId = `chat:${incoming.deliveryId}`
        const skill = await loadSkill((await bundledSkills()).source, "answer")
        const prompt = answerPrompt(incoming.author, command.text, renderActivatedSkill(skill))
        const result = await this.harness.prompt(prompt, { operationId })
        const answer =
          result.status === "done" && result.text?.trim()
            ? result.text.trim()
            : `I could not answer that: ${
                result.status === "done"
                  ? "the model returned nothing"
                  : describeFailure(result, await this.storedFailureDetail(operationId))
              }.`
        await github.createIssueComment(key, key.number, `@${incoming.author} ${answer}`)
        return
      }
    }
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
    const key = await this.ctx.storage.get<PullRequestKey>("key")
    if (!key) throw new Error("this object has not received an event yet")
    return key
  }

  private async upsertSummary(body: string): Promise<void> {
    const key = await this.key()
    const github = await this.github()
    const ref: RepoRef = key
    let commentId = await this.ctx.storage.get<number>("summaryCommentId")
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

  private async summaryCommentUrl(): Promise<string | undefined> {
    const commentId = await this.ctx.storage.get<number>("summaryCommentId")
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
    log("check.started", { id: created.id, head: short(pr.head.sha), delivery: run.deliveryId })
    return created.id
  }

  private async completeOwnRun(deliveryId: string, update: UpdateCheckRun): Promise<void> {
    const pending = await this.pendingFor(deliveryId)
    if (pending?.checkRunId === undefined) return
    await this.completeCheckRun(pending.checkRunId, pending, update)
  }

  private async failOwnRun(deliveryId: string, note: string): Promise<void> {
    await this.completeOwnRun(deliveryId, await this.failedRun(note))
  }

  private async failedRun(note: string): Promise<UpdateCheckRun> {
    return failedCheckRun(note, await this.summaryCommentUrl(), Date.now())
  }

  private async completeAsPostedEarlier(deliveryId: string, posted: PostedReview): Promise<void> {
    const summary = `Review ${posted.reviewId} was posted by an earlier run of this head.`
    const update = postedCheckRun(posted.event, [], summary, await this.summaryCommentUrl(), Date.now())
    await this.completeOwnRun(deliveryId, update)
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
      head: short(owner.headSha),
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
const GRACE_MS = 120_000
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
    head: short(pr.head.sha),
    after,
    status: result.status,
    ...transcriptFields(summarizeTranscript(result.messages)),
  })
}

function retryOutcome(failure: string | undefined, refusal: string | undefined): RetryOutcome {
  if (failure !== undefined) return { kind: "failed", reason: failure }
  if (refusal !== undefined) return { kind: "refused", refusal }
  return { kind: "unanswered" }
}

const NOT_IN_FLIGHT_REFUSAL = "Not posted: this call is not the review in flight for this head. Stop here."

function short(sha: string): string {
  return sha.slice(0, 7)
}

function ownsOperation(pending: PendingReview, operationId: string): boolean {
  return operationId === pending.operationId || operationId.startsWith(`${pending.operationId}:`)
}

function withinGrace(pending: PendingReview | undefined): boolean {
  return pending !== undefined && Date.now() - pending.started < GRACE_MS
}

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
