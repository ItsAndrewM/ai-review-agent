import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { createModels } from "@earendil-works/pi-ai/models"
import { createRegistry, Harness } from "@earendil-works/pi-durable"
import { PiHarness, ROOT_SESSION, skills, type PiPromptResponse } from "agents/harness/pi"
import { Lifecycle } from "agents/lifecycle"
import { createAI } from "agents/models/pi-ai"
import type { SkillContent, SkillSource } from "agents/skills"
import { DurableObject } from "cloudflare:workers"
import { Type } from "typebox"
import { Value } from "typebox/value"
import { helpText, parseCommand } from "./commands.ts"
import { createAppJwt, fetchInstallationToken, type InstallationToken } from "./github/app-auth.ts"
import {
  canCommand,
  GitHubClient,
  type PullRequestInfo,
  type RepoRef,
  type ReviewEvent,
  type UpdateCheckRun,
} from "./github/client.ts"
import { indexCommentableLines, type ChangedFile } from "./github/diff.ts"
import { log, logError, errorText } from "./log.ts"
import { withOutputLimit } from "./models.ts"
import { bundledSkills } from "./review/bundled-skills.ts"
import {
  failedCheckRun,
  postedCheckRun,
  replacedCheckRun,
  startedCheckRun,
  summaryCommentLink,
  supersededCheckRun,
} from "./review/check.ts"
import { describeFailure } from "./review/failure.ts"
import {
  parseWrittenReview,
  toReviewComment,
  validateFindings,
  type ReviewSubmissionInput,
  type WrittenReview,
} from "./review/findings.ts"
import {
  decideFlight,
  migratePending,
  StoredPending,
  type FlightDecision,
  type PendingReview,
} from "./review/flight.ts"
import { answerPrompt, rejectionsText, resubmitPrompt, reviewPrompt } from "./review/prompt.ts"
import {
  chooseReviewEvent,
  renderReviewBody,
  renderSummaryComment,
  renderUnpostedNote,
  renderUnpostedSummary,
  SUMMARY_MARKER,
} from "./review/render.ts"
import { renderActivatedSkill } from "./review/skills.ts"
import { createReviewExtension, type ReviewHost } from "./review/tools.ts"
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

interface ReviewRun {
  operationId: string
  deliveryId: string
  started: number
  staleBuild: boolean
  callerBuild: string | undefined
  skillsFingerprint: string
}

type ReviewSource = "tool" | "text" | "retry"

const StoredDetailText = Type.String()

export class PullRequest extends DurableObject<Env> implements ReviewHost {
  readonly ai = createAI({ binding: this.env.AI })
  readonly registry = createRegistry()
  readonly harness = new PiHarness({
    harness: async ({ storage, context }) => {
      this.registry.install(createReviewExtension(this))
      const bundled = await bundledSkills()
      this.registry.install(await skills([bundled.source]))
      const models = createModels()
      models.setProvider(withOutputLimit(this.ai.provider))
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
    defaults: { model: this.reviewModel(), thinkingLevel: "low" },
  })
  readonly lifecycle = Lifecycle.install(this).use(this.harness)

  #pr: PullRequestInfo | undefined
  #files: ChangedFile[] | undefined

  reviewModel() {
    return this.ai(this.env.REVIEW_MODEL, { maxTokens: REVIEW_MAX_OUTPUT_TOKENS })
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

  async submitReview(submission: ReviewSubmissionInput): Promise<string> {
    const pending = await this.readPending()
    if (!pending) return "Nothing to post: no review is pending. Answer in text instead."
    if (!(await this.callerIsReviewInFlight(pending))) return NOT_IN_FLIGHT_REFUSAL
    return this.postReview(submission, pending.deliveryId)
  }

  private async postReview(submission: ReviewSubmissionInput, deliveryId: string): Promise<string> {
    const pending = await this.pendingFor(deliveryId)
    if (!pending) return NOT_IN_FLIGHT_REFUSAL
    const posted = await this.ctx.storage.get<PostedReview>(`posted:${pending.headSha}`)
    if (posted) {
      await this.completeAsPostedEarlier(deliveryId, posted)
      return `Posted already: review ${posted.reviewId} for this head. Nothing more to do.`
    }

    const pr = await this.freshPullRequest()
    if (pr.head.sha !== pending.headSha) {
      return `Not posted: the pull request moved from ${pending.headSha.slice(0, 7)} to ${pr.head.sha.slice(0, 7)} while you reviewed. A new review will run for the new head; stop here.`
    }
    const files = await this.changedFiles()
    const { accepted, rejected, relocated, suggestionsDropped } = validateFindings(
      submission.findings,
      indexCommentableLines(files),
    )
    log("review.findings", {
      number: pr.number,
      head: short(pr.head.sha),
      accepted: accepted.length,
      relocated,
      suggestionsDropped,
      rejected: rejected.length,
      rejectionsReturned: pending.rejectionsReturned === true,
    })
    if (rejected.length > 0 && pending.rejectionsReturned !== true) {
      await this.markRejectionsReturned(pending.deliveryId)
      return rejectionsText(rejected)
    }
    const event = chooseReviewEvent(submission, accepted, rejected, this.env.REQUEST_CHANGES_WORKFLOW === "true")
    const key = await this.key()
    const github = await this.github()
    const attribution = attributionOf(pending)
    const summary = renderSummaryComment({
      botLogin: this.botLogin(),
      headSha: pr.head.sha,
      event,
      submission,
      accepted,
      droppedCount: rejected.length,
      model: attribution?.model,
      skillsFingerprint: attribution?.fingerprint,
    })
    await this.upsertSummary(summary)
    const review = await github.createReview(key, key.number, {
      commit_id: pr.head.sha,
      event,
      body: renderReviewBody(event, accepted, rejected),
      comments: accepted.map(toReviewComment),
    })
    await this.ctx.storage.put<PostedReview>(`posted:${pr.head.sha}`, {
      reviewId: review.id,
      event,
      at: Date.now(),
      ...attribution,
    })
    await this.completeOwnRun(
      pending.deliveryId,
      postedCheckRun(event, accepted, summary, await this.summaryCommentUrl(), Date.now()),
    )
    await this.releasePending(pending.deliveryId)
    const dropped =
      rejected.length > 0 ? ` ${rejected.length} finding(s) that still failed the checks were dropped.` : ""
    return `Posted review ${review.id} (${event}) with ${accepted.length} inline comment(s).${dropped}`
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

  private async runReview(pr: PullRequestInfo, incoming: ReviewIncoming, run: ReviewRun): Promise<void> {
    try {
      const files = await this.openRun(pr, run)
      const prompt = reviewPrompt(pr, files, incoming.full)
      log("review.start", {
        number: pr.number,
        head: short(pr.head.sha),
        files: files.length,
        promptChars: prompt.length,
        model: this.env.REVIEW_MODEL,
        skillsFingerprint: run.skillsFingerprint,
        full: incoming.full,
        build: this.version().id,
        staleBuild: run.staleBuild,
        callerBuild: run.callerBuild,
        delivery: run.deliveryId,
      })
      if (await this.replaced(pr, run)) return
      await this.harness.session().reset()
      await this.harness.session().setModel(this.reviewModel())
      await this.activateReviewSkill()
      const result = await this.harness.prompt(prompt, { operationId: run.operationId })
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

  private async activateReviewSkill(): Promise<void> {
    const skill = await loadSkill((await bundledSkills()).source, "review")
    const root = await (await this.harness.pi()).root(BACKGROUND_CONTEXT)
    await root.configure({ instructions: renderActivatedSkill(skill) }, BACKGROUND_CONTEXT)
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
    const refusal = await this.postReview(written.submission, run.deliveryId).catch(errorText)
    if (await this.isPosted(pr)) return "text"
    log("review.text_refused", { number: pr.number, head: short(pr.head.sha), refusal })
    return this.askAgain(pr, written, refusal, run)
  }

  private async askAgain(
    pr: PullRequestInfo,
    written: WrittenReview,
    refusal: string | undefined,
    run: ReviewRun,
  ): Promise<ReviewSource | undefined> {
    if (await this.headMoved(pr, run)) return undefined
    if (await this.replaced(pr, run)) return undefined
    await this.restartGrace(run.deliveryId)
    const retry = await this.harness.prompt(resubmitPrompt(refusal), { operationId: `${run.operationId}:retry` })
    await this.restartGrace(run.deliveryId)
    if (await this.isPosted(pr)) return "retry"
    if (await this.replaced(pr, run)) return undefined
    if (await this.headMoved(pr, run)) return undefined
    await this.reportUnpostedReview(pr, written, retry, run)
    return undefined
  }

  private async replaced(pr: PullRequestInfo, run: ReviewRun): Promise<boolean> {
    if (await this.ownsPending(run.deliveryId)) return false
    log("review.superseded", { number: pr.number, head: short(pr.head.sha), delivery: run.deliveryId })
    return true
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
    run: ReviewRun,
  ): Promise<void> {
    const failure =
      retry.status === "done" ? undefined : describeFailure(retry, await this.storedFailureDetail(retry.operationId))
    const fields = { number: pr.number, head: short(pr.head.sha), wrote: written.kind, ms: Date.now() - run.started }
    if (failure === undefined) {
      log("review.no_submission", { ...fields, retryText: retry.text?.slice(0, MAX_LOGGED_TEXT_CHARS) })
    } else {
      logError("review.failed", { ...fields, reason: failure, retry: true, staleBuild: run.staleBuild })
    }
    const note = renderUnpostedNote(written, failure)
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
    if (await this.ownsPending(deliveryId)) await this.ctx.storage.delete("pending")
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

const REVIEW_MAX_OUTPUT_TOKENS = 16_000
const MAX_LOGGED_TEXT_CHARS = 8_000
const GRACE_MS = 120_000
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
