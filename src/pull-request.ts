/**
 * One Durable Object per pull request. It holds the PR's state, runs Pi
 * Durable through the Agents SDK's PiHarness, and posts to GitHub.
 */

import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { createModels } from "@earendil-works/pi-ai/models"
import { createRegistry, Harness } from "@earendil-works/pi-durable"
import { PiHarness, ROOT_SESSION } from "agents/harness/pi"
import { Lifecycle } from "agents/lifecycle"
import { createAI, type WorkersAIModelId } from "agents/models/pi-ai"
import { DurableObject } from "cloudflare:workers"
import { helpText, parseCommand } from "./commands.ts"
import { createAppJwt, fetchInstallationToken, type InstallationToken } from "./github/app-auth.ts"
import { canCommand, GitHubClient, type PullRequestInfo, type RepoRef } from "./github/client.ts"
import { indexCommentableLines, type ChangedFile } from "./github/diff.ts"
import { log, logError, errorText } from "./log.ts"
import { withOutputLimit } from "./models.ts"
import { describeFailure } from "./review/failure.ts"
import { toReviewComment, validateFindings, type ReviewSubmissionInput } from "./review/findings.ts"
import { chatPrompt, reviewPrompt } from "./review/prompt.ts"
import { chooseReviewEvent, renderReviewBody, renderSummaryComment, SUMMARY_MARKER } from "./review/render.ts"
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
      /** The head the event was about. A later head supersedes the review. */
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

interface PendingReview {
  headSha: string
  deliveryId: string
}

interface PostedReview {
  reviewId: number
  event: string
  at: number
}

export class PullRequest extends DurableObject<Env> implements ReviewHost {
  readonly ai = createAI({ binding: this.env.AI })
  readonly registry = createRegistry()
  readonly harness = new PiHarness({
    harness: ({ storage, context }) => {
      this.registry.install(createReviewExtension(this))
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

  /** The configured model, with an explicit output cap. Pi applies `defaults` to new sessions only, so each run sets it again. */
  reviewModel() {
    return this.ai(this.env.REVIEW_MODEL as WorkersAIModelId, { maxTokens: REVIEW_MAX_OUTPUT_TOKENS })
  }

  /** The build this object is running. */
  private version(): Version {
    return versionOf(this.env.CF_VERSION_METADATA)
  }

  // ---- RPC from the Worker ------------------------------------------------

  /** Records the event and handles it in the background. Returns at once so the webhook gets its 202. */
  async accept(incoming: Incoming, callerVersion?: Version): Promise<"accepted"> {
    await this.ctx.storage.put("key", incoming.key)
    this.ctx.waitUntil(
      this.handle(incoming, callerVersion).catch((error) =>
        logError("event.failed", { delivery: incoming.deliveryId, kind: incoming.kind, error: errorText(error) }),
      ),
    )
    return "accepted"
  }

  // ---- ReviewHost -------------------------------------------------------------

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
    const pending = await this.ctx.storage.get<PendingReview>("pending")
    if (!pending) return "Nothing to post: no review is pending. Answer in text instead."
    const posted = await this.ctx.storage.get<PostedReview>(`posted:${pending.headSha}`)
    if (posted) return `Posted already: review ${posted.reviewId} for this head. Nothing more to do.`

    // Validate against the head as it is now, not as it was when the review started.
    this.#pr = undefined
    this.#files = undefined
    const pr = await this.pullRequest()
    if (pr.head.sha !== pending.headSha) {
      return `Not posted: the pull request moved from ${pending.headSha.slice(0, 7)} to ${pr.head.sha.slice(0, 7)} while you reviewed. A new review will run for the new head; stop here.`
    }
    const files = await this.changedFiles()
    const { accepted, rejected } = validateFindings(submission.findings, indexCommentableLines(files))
    if (rejected.length > 0 && accepted.length + rejected.length <= 3 && accepted.length === 0) {
      // Everything was rejected and there is little of it: let the model fix the anchors.
      return rejectedMessage(rejected)
    }
    const event = chooseReviewEvent(submission, accepted, this.env.REQUEST_CHANGES_WORKFLOW === "true")
    const key = await this.key()
    const github = await this.github()
    await this.upsertSummary(
      renderSummaryComment({
        botLogin: this.botLogin(),
        headSha: pr.head.sha,
        event,
        submission,
        accepted,
        droppedCount: rejected.length,
      }),
    )
    const review = await github.createReview(key, key.number, {
      commit_id: pr.head.sha,
      event,
      body: renderReviewBody(event, accepted),
      comments: accepted.map(toReviewComment),
    })
    await this.ctx.storage.put<PostedReview>(`posted:${pr.head.sha}`, { reviewId: review.id, event, at: Date.now() })
    await this.ctx.storage.delete("pending")
    const dropped =
      rejected.length > 0 ? ` ${rejected.length} finding(s) were dropped: ${rejectedMessage(rejected)}` : ""
    return `Posted review ${review.id} (${event}) with ${accepted.length} inline comment(s).${dropped}`
  }

  // ---- handlers -----------------------------------------------------------------

  private async handle(incoming: Incoming, callerVersion?: Version): Promise<void> {
    switch (incoming.kind) {
      case "review":
        return this.review(incoming, callerVersion)
      case "comment":
        return this.comment(incoming, callerVersion)
    }
  }

  private async review(incoming: Extract<Incoming, { kind: "review" }>, callerVersion?: Version): Promise<void> {
    const own = this.version()
    const stale = isOlder(own, callerVersion)
    this.#pr = undefined
    this.#files = undefined
    const pr = await this.pullRequest()
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
    if (!incoming.full && (await this.ctx.storage.get(`posted:${pr.head.sha}`))) {
      log("review.skip", { reason: "already_reviewed", head: short(pr.head.sha), number: pr.number })
      return
    }
    if (incoming.full) await this.ctx.storage.delete(`posted:${pr.head.sha}`)
    const files = await this.changedFiles()
    await this.ctx.storage.put<PendingReview>("pending", { headSha: pr.head.sha, deliveryId: incoming.deliveryId })
    const prompt = reviewPrompt(pr, files, incoming.full)
    const operationId = `review:${incoming.deliveryId}`
    const started = Date.now()
    log("review.start", {
      number: pr.number,
      head: short(pr.head.sha),
      files: files.length,
      promptChars: prompt.length,
      model: this.env.REVIEW_MODEL,
      full: incoming.full,
      build: own.id,
      // A review that runs on an older build than the Worker that triggered it
      // may use that build's model or logic. Visible so a deploy-timed failure
      // is not a mystery; the next event or a manual review uses the new build.
      ...(stale ? { staleBuild: true, callerBuild: callerVersion?.id } : {}),
    })

    // Each review is independent: start from a clean context so prior reviews
    // (and their large prompts) do not accumulate or overflow the window.
    await this.harness.session().reset()
    await this.harness.session().setModel(this.reviewModel())
    const result = await this.harness.prompt(prompt, { operationId })

    if (await this.ctx.storage.get(`posted:${pr.head.sha}`)) {
      log("review.done", { number: pr.number, head: short(pr.head.sha), outcome: "posted", ms: Date.now() - started })
      await this.ctx.storage.delete("pending")
      return
    }
    // The run ended without submit_review posting anything. Leave a trace rather than silence.
    const failure =
      result.status === "done" ? undefined : describeFailure(result, await this.failureDetail(operationId))
    if (failure) {
      logError("review.failed", {
        number: pr.number,
        head: short(pr.head.sha),
        reason: failure,
        ms: Date.now() - started,
        staleBuild: stale,
      })
    } else {
      log("review.no_submission", { number: pr.number, head: short(pr.head.sha), ms: Date.now() - started })
    }
    const note =
      result.status === "done"
        ? result.text?.trim() || "_The reviewer finished without submitting a structured review._"
        : `_The review did not complete: ${failure}._`
    await this.upsertSummary(
      `${SUMMARY_MARKER}\n## ${this.botLogin()} review\n\n**Head:** \`${short(pr.head.sha)}\`\n\n${note}`,
    )
    await this.ctx.storage.delete("pending")
  }

  private async comment(incoming: Extract<Incoming, { kind: "comment" }>, callerVersion?: Version): Promise<void> {
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
        this.#pr = undefined
        const pr = await this.pullRequest()
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
        const result = await this.harness.prompt(chatPrompt(incoming.author, command.text), { operationId })
        const answer =
          result.status === "done" && result.text?.trim()
            ? result.text.trim()
            : `I could not answer that: ${
                result.status === "done"
                  ? "the model returned nothing"
                  : describeFailure(result, await this.failureDetail(operationId))
              }.`
        await github.createIssueComment(key, key.number, `@${incoming.author} ${answer}`)
        return
      }
    }
  }

  // ---- helpers -----------------------------------------------------------------

  /** Pi's stored detail for an unanswered submission, which the harness result leaves out. */
  private async failureDetail(operationId: string): Promise<string | undefined> {
    try {
      const storage = await this.harness.storage()
      const conversation = await this.harness.conversation(ROOT_SESSION)
      const record = await storage.submissionByRequest(conversation.id, operationId, BACKGROUND_CONTEXT)
      if (record?.status !== "unanswered" || record.detail === undefined) return undefined
      return (typeof record.detail === "string" ? record.detail : JSON.stringify(record.detail)).slice(0, 800)
    } catch (error) {
      console.warn("andabot: failure detail unavailable", error)
      return undefined
    }
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
      const existing = (await github.listIssueComments(ref, key.number)).find((c) => c.body.startsWith(SUMMARY_MARKER))
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
}

/** The model's output ceiling per request. gpt-oss reasons before the tool call, so leave generous room. */
const REVIEW_MAX_OUTPUT_TOKENS = 16_000

function short(sha: string): string {
  return sha.slice(0, 7)
}

function rejectedMessage(rejected: { finding: { path: string; line: number }; reason: string }[]): string {
  return `Rejected findings:\n${rejected.map((r) => `- ${r.finding.path}:${r.finding.line}: ${r.reason}`).join("\n")}\nFix the anchors or drop these, then call submit_review again.`
}
