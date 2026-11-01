import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context"
import { createModels } from "@earendil-works/pi-ai/models"
import {
  createRegistry,
  Harness,
  type AgentChange,
  type ConversationId,
  type EntryRecord,
  type Extension,
} from "@earendil-works/pi-durable"
import {
  PiHarness,
  ROOT_SESSION,
  skills as skillsExtension,
  type PiModel,
  type PiPendingOperation,
  type PiPromptResponse,
  type PiSession,
} from "agents/harness/pi"
import { Lifecycle, type LifecycleJobContext, type LifecycleJobOutcome } from "agents/lifecycle"
import { createAI } from "agents/models/pi-ai"
import type { SkillContent, SkillResource, SkillSource } from "agents/skills"
import { DurableObject } from "cloudflare:workers"
import { Type } from "typebox"
import { Value } from "typebox/value"
import { helpText, parseCommand, skippedReviewText, type Command, type ReviewSkip } from "./commands.ts"
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
import {
  everyFileFiltered,
  indexCommentableLines,
  reviewableFiles,
  type ChangedFile,
  type MarkedLines,
} from "./github/diff.ts"
import { errorOf, failureSummary, isTransient, softenUnlessTransient, TransientFailure } from "./github/errors.ts"
import { log, logError, errorText } from "./log.ts"
import { outputLimitOf, reviewThinkingLevel, withBudgetRefusal, withForcedJson, withOutputLimit } from "./models.ts"
import { reactWithEyes } from "./reaction.ts"
import { PostedReview, PullRequestKey, StoredSessionId, SummaryCommentId } from "./records.ts"
import {
  CONFIG_PREFIX,
  configKey,
  configReadOf,
  configStatus,
  isCacheable,
  pullRequestFacts,
  readConfig,
  requestChangesWorkflow,
  reviewTrigger,
  runSettings,
  shouldReview,
  staleConfigKeys,
  StoredConfig,
  storedConfig,
  type AndabotConfig,
  type ConfigRead,
  type ConfigStatus,
  type SkipReason,
} from "./repository/config.ts"
import {
  CONTEXT_PREFIX,
  contextInputs,
  contextKey,
  donorKey,
  loadRepositoryContext,
  readRepositoryContext,
  repositoryRecord,
  reviewInstructions,
  reviewRepository,
  staleContextKeys,
  StoredRepositoryContext,
  type RepositoryContext,
  type ReviewRepository,
} from "./repository/context.ts"
import {
  docMatcher,
  docMentions,
  docPathsAtHead,
  docsInChange,
  changedLinesByDoc,
  docsStartFields,
  searchableCode,
  type DocMatcher,
  type DocMentions,
  type DocsInChange,
  type DocsSearch,
} from "./repository/docs.ts"
import type { PathInstruction } from "./repository/instructions.ts"
import { loadSnapshot } from "./repository/load-snapshot.ts"
import {
  catalogFor,
  installCatalog,
  restoredCatalog,
  skillLogs,
  skillsStartFields,
  type ReportSkippedRestore,
} from "./repository/skills.ts"
import { SnapshotRuns, snapshotSource } from "./repository/snapshot-host.ts"
import type { SnapshotFiles } from "./repository/snapshot.ts"
import { SqlSnapshotFiles } from "./repository/sql-snapshot.ts"
import {
  approvalRecord,
  approvedPostedIfNeeded,
  checksState,
  decideApproval,
  evaluatesAfterReview,
  evaluatesReviewedHead,
  evaluationWorkflow,
  LastReview,
  lastReviewOf,
  nextRecheck,
  retriesAtDoor,
  openBlockingIn,
  ownsRecheck,
  RecheckJob,
  verdictAfterChecks,
  type ApprovalOutcome,
  type Recheck,
  type ApprovalState,
  type ApprovalTrigger,
  type ChecksState,
  type WaitReason,
  type WorkflowState,
} from "./review/approval.ts"
import type { BasisContext } from "./review/basis.ts"
import {
  budgetBlock,
  budgetNote,
  budgetStanding,
  refusesRequest,
  reviewBudgetOf,
  type BudgetStanding,
} from "./review/budget.ts"
import { bundledSkills } from "./review/bundled-skills.ts"
import {
  failedCheckRun,
  postedCheckRun,
  approvedCheckRun,
  postedEarlierCheckRun,
  replacedCheckRun,
  startedCheckRun,
  summaryCommentLink,
  supersededCheckRun,
  unchangedCheckRun,
} from "./review/check.ts"
import { closesBlockOf } from "./review/closes.ts"
import { plural, were } from "./review/copy.ts"
import {
  neuronsSince,
  reviewSpend,
  sandboxFields,
  spendFields,
  usageBaseline,
  usageTotals,
  type ReviewSpend,
  type UsageLedger,
} from "./review/cost.ts"
import {
  abandonReplyWanted,
  Deliveries,
  RETRY_JOB,
  RetryJob,
  StoredDelivery,
  type DeliveryHost,
  type Incoming,
  type ThreadContext,
} from "./review/delivery.ts"
import { describeFailure } from "./review/failure.ts"
import {
  countBySeverity,
  missingWalkthrough,
  parseWrittenReview,
  toReviewComment,
  validateFindings,
  type FindingInput,
  type ReviewSubmissionInput,
  type SummarySubmissionInput,
  type ValidatedReview,
  type WrittenReview,
} from "./review/findings.ts"
import {
  afterReviewThrow,
  decideFlight,
  elapsedSeconds,
  resumedPending,
  migratePending,
  ownsOperation,
  replacedExit,
  reviewOperations,
  runStanding,
  standingAfterVerify,
  StoredPending,
  submitStanding,
  type FlightDecision,
  type PendingReview,
  type SubmitStanding,
} from "./review/flight.ts"
import {
  addressedThreads,
  applyDeltaPolicy,
  buildScope,
  chooseMode,
  coveredFiles,
  coveredMap,
  deltaScopeOf,
  filtersInForce,
  findingRecords,
  freshScope,
  nextReviewed,
  nothingToReview,
  openBlockingAfter,
  pathFiltersSkip,
  pathsChangedSince,
  pathsNeedingRows,
  threadLink,
  changesSinceMissing,
  planThreads,
  promptFiles,
  resolveThreads,
  stillOpen,
  type AddressedResolution,
  ReviewedRecord,
  ReviewScope,
  scopedFiles,
  StoredFinding,
  submissionFromRecord,
  threadLists,
  withFilteredUnfounded,
  type OpenThread,
  type ReviewMode,
  type ReviewPlan,
  type ScopedReview,
  type ThreadPlan,
} from "./review/incremental.ts"
import { linkedIssueNumbers, linkedIssuesFrom, readLinkedIssues, type LinkedIssue } from "./review/linked-issues.ts"
import {
  evaluatesAfterCatchUp,
  headReviewed,
  NOT_PAUSED_REPLY,
  pausedLine,
  PausedBy,
  pauseReply,
  pausesReview,
  resumeReply,
  resumeStep,
  withoutPausedLine,
  withPausedLine,
  type ResumeStep,
} from "./review/pause.ts"
import {
  ACTIVATE_SKILL_TOOL,
  answerPrompt,
  fullPrompt,
  incrementalPrompt,
  type DocsSections,
  problemsText,
  resubmitPrompt,
  reviewPrompt,
  summaryPrompt,
  threadAnswerPrompt,
  type ThreadQuestion,
} from "./review/prompt.ts"
import {
  budgetReason,
  checkReasons,
  omittedIn,
  type ApprovalReason,
  type CheckedReasons,
  type OmittedRequirementInput,
} from "./review/reasons.ts"
import {
  approvalBody,
  decideReviewVerdict,
  incompleteNote,
  renderReviewBody,
  renderSummaryComment,
  renderSummaryRun,
  renderUnpostedNote,
  renderUnpostedSummary,
  reviewEventOf,
  SUMMARY_MARKER,
  withApprovedVerdict,
  type Coverage,
  type RetryOutcome,
  type Verdict,
  type VerifyDisplay,
  type ChecksDisplay,
} from "./review/render.ts"
import { approvalNote, resolveRefusal, resolveReply, resolveTargets, type ResolveScope } from "./review/resolve.ts"
import { renderActivatedSkill, renderSkillWithResources } from "./review/skills.ts"
import {
  oneClause,
  parseWrittenSummary,
  recordedVerdict,
  Summarizing,
  summarizedRecord,
  unrecordedSummary,
  summaryLive,
  summaryReply,
  type SummaryOutcome,
  type WrittenSummary,
} from "./review/summary.ts"
import { commandInThread, threadIgnoreReason, threadOf } from "./review/thread-question.ts"
import {
  answeringFor,
  evidenceProblem,
  resolveOutcomeText,
  startAnswering,
  type Answering,
  type ResolveOutcome,
  type ResolveThreadArgs,
} from "./review/thread-resolution.ts"
import {
  createReviewExtension,
  fileAt,
  type RequestBudget,
  type ReviewHost,
  type RunCheckArgs,
  type SearchAccess,
  type SubmitOutcome,
} from "./review/tools.ts"
import { summarizeTranscript, transcriptFields } from "./review/transcript.ts"
import { createVerifyExtension, verifyHostOf, VerifyPasses, withoutVerifyByDefault } from "./review/verify-tools.ts"
import {
  answerAfter,
  attemptOrFailed,
  backstopReason,
  backstopTimer,
  findingContexts,
  linkedIssueText,
  unverifiedDisplay,
  verdictFields,
  verifiedReview,
  verifyCandidates,
  verifyCounts,
  VERIFY_BACKSTOP_MS,
  verifyOperationId,
  verifyPrompt,
  verifyRunId,
  verifyWithRetry,
  whileUnsettled,
  type FindingContext,
  type VerifyAttempt,
  type VerifyCandidate,
} from "./review/verify.ts"
import { objectName } from "./route.ts"
import type { Manager } from "./sandbox/checkout.ts"
import {
  accessRefusal,
  argvFromTemplate,
  CHECK_ENV,
  checkKey,
  checkRecordOf,
  checkText,
  checkTimeoutOf,
  existsArgv,
  fallbackArgv,
  knownChecksOf,
  missingPath,
  pathProblem,
  refusalText,
  type CheckName,
  type CheckRefusal,
  type CheckRun,
} from "./sandbox/checks.ts"
import { sandboxTokenScope } from "./sandbox/probe.ts"
import { SandboxRecord } from "./sandbox/record.ts"
import { DEFAULT_TAIL_BYTES } from "./sandbox/run.ts"
import {
  accessSummary,
  LEASE_GRACE_MS,
  sandboxBudgetOf,
  sandboxOn,
  SandboxRuns,
  type AccessSummary,
  type SandboxAccess,
  type SandboxCalls,
  type SandboxHead,
  type SandboxHost,
} from "./sandbox/runs.ts"
import { shortSha } from "./sha.ts"
import { isOlder, versionOf, type Version } from "./version.ts"

export type { Incoming, ThreadContext } from "./review/delivery.ts"

type ReviewIncoming = Extract<Incoming, { kind: "review" }>
type CommentIncoming = Extract<Incoming, { kind: "comment" }>
type Replacement = Extract<FlightDecision, { kind: "replace" }>
type RunOwner = Pick<PendingReview, "headSha" | "deliveryId">
type HeadSkip = "not_open" | "superseded" | "already_reviewed"
type SettingsSkip = SkipReason | "path_filters"
type SubmitRefusal = Exclude<SubmitStanding["kind"], "post"> | "head_moved" | "posted_already"
type RefusalDetail = { was: string; now: string } | { callerIsRoot: boolean; running: string | undefined }

interface CommandCall {
  github: GitHubClient
  key: PullRequestKey
  incoming: CommentIncoming
  thread: ReviewThread | undefined
}

interface Attribution {
  model: string
  fingerprint: string
}

interface CheckedSubmission {
  scope: ReviewScope
  files: ChangedFile[]
  validated: ValidatedReview
  scoped: ScopedReview
  missing: string[]
  changesSinceMissing: boolean
  reasons: CheckedReasons
}

interface SearchedDocs {
  found: DocMentions | undefined
  search: DocsSearch
  headDocs: string[]
}

interface Publication {
  checked: CheckedSubmission
  verify: VerifyDisplay | undefined
}

interface VerifyRun {
  pr: PullRequestInfo
  pending: PendingReview
  submission: ReviewSubmissionInput
  checked: CheckedSubmission
  candidates: VerifyCandidate[]
  model: string
}

interface VerifyAttempts {
  run: VerifyRun
  runId: string
  prompt: string
  aborting: Promise<void>
}

type SessionKey = "summarySession" | "verifySession"

interface SkillSetup {
  skill: string
  reference: string
  tools: Pick<AgentChange, "extensions" | "modelTools">
  model: PiModel
}

interface ReviewRun {
  operationId: string
  deliveryId: string
  started: number
  openedAt: number
  checkRunId?: number
  staleBuild: boolean
  callerBuild: string | undefined
  skillsFingerprint: string
  config: AndabotConfig
  configStatus: ConfigStatus
}

interface SummaryFiles {
  read: ConfigRead
  changed: readonly ChangedFile[]
  reviewable: readonly ChangedFile[]
}

type ReviewSource = "tool" | "text" | "retry" | "retry_text"

interface ApprovalContext {
  number: number
  head: string
  trigger: ApprovalTrigger
  delivery: string | undefined
}

interface SpentReview {
  pending: PendingReview
  standing: Extract<BudgetStanding, { kind: "spent" }>
}

const StoredDetailText = Type.String()

export class PullRequest extends DurableObject<Env> implements ReviewHost {
  readonly ai = createAI({ binding: this.env.AI })
  readonly registry = createRegistry()
  #catalog: Extension | undefined
  readonly #verifyPasses = new VerifyPasses<ConversationId>()
  readonly #verifyTools = createVerifyExtension(verifyHostOf(this, this.#verifyPasses))
  readonly harness = new PiHarness({
    harness: async ({ storage, context }) => {
      this.registry.install(createReviewExtension(this))
      this.registry.install(this.#verifyTools)
      await this.restoreCatalog()
      const models = createModels()
      models.setProvider(withBudgetRefusal(withForcedJson(withOutputLimit(this.ai.provider, this.outputLimit()))))
      return Harness.open(
        storage,
        {
          models,
          registry: this.registry,
          settings: withoutVerifyByDefault(this.registry, {
            retry: { enabled: true, maxRetries: 4, baseDelayMs: 1000 },
          }),
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
  #refusedCalls = 0
  #budgetBlocked = 0
  #requestsPastBudget = 0
  #activated: string[] = []
  #snapshot: SqlSnapshotFiles | undefined
  #runs = new SnapshotRuns(
    () => this.#snapshotFiles(),
    async (files, sha) => loadSnapshot(snapshotSource(await this.github(), await this.key()), files, sha),
  )
  #sandbox = new SandboxRuns(this.#sandboxHost(), sandboxBudgetOf(this.env.MAX_SANDBOX_SECONDS))
  #deliveries = new Deliveries(this.#deliveryHost())

  #deliveryHost(): DeliveryHost {
    return {
      store: async (key, record) => {
        await this.ctx.storage.put<StoredDelivery>(key, record)
      },
      load: async (key) => {
        const stored = await this.ctx.storage.get(key)
        return Value.Check(StoredDelivery, stored) ? stored : undefined
      },
      forget: async (key) => {
        await this.ctx.storage.delete(key)
      },
      schedule: async (id, time, payload) => {
        await this.lifecycle.jobs.push({ id, fn: RETRY_JOB, time, payload })
      },
      now: () => Date.now(),
    }
  }

  #sandboxHost(): SandboxHost {
    const leases = () => this.env.SANDBOX_LEASES.getByName("leases")
    return {
      enabled: async () =>
        sandboxOn(this.env.SANDBOX) && (await this.repositoryConfig(await this.pullRequest())).config.reviews.sandbox,
      lease: async (ttlMs) => leases().acquire(objectName(await this.key()), ttlMs),
      unlease: async () => leases().release(objectName(await this.key())),
      token: async () => this.sandboxToken(),
      sandbox: async (): Promise<SandboxCalls> => this.env.REVIEW_SANDBOX.getByName(objectName(await this.key())),
      head: async (): Promise<SandboxHead> => {
        const pr = await this.pullRequest()
        return { number: pr.number, key: await this.key(), sha: pr.head.sha }
      },
      now: () => Date.now(),
      load: async () => {
        const stored = await this.ctx.storage.get("sandbox")
        return Value.Check(SandboxRecord, stored) ? stored : undefined
      },
      save: async (record) => {
        if (record === undefined) await this.ctx.storage.delete("sandbox")
        else await this.ctx.storage.put<SandboxRecord>("sandbox", record)
      },
      scheduleDrop: async (time) => {
        await this.lifecycle.jobs.push({ id: SANDBOX_DROP_JOB, fn: SANDBOX_DROP_JOB, time })
      },
      cancelDrop: async () => {
        await this.lifecycle.jobs.cancel(SANDBOX_DROP_JOB)
      },
    }
  }

  private async sandboxToken(): Promise<string> {
    const key = await this.key()
    const jwt = await createAppJwt(this.env.GITHUB_APP_ID, this.env.GITHUB_PRIVATE_KEY)
    return (await fetchInstallationToken(jwt, key.installationId, sandboxTokenScope(key))).token
  }

  async prepareSandbox(key: PullRequestKey): Promise<AccessSummary> {
    await this.ctx.storage.put("key", key)
    return accessSummary(await this.#sandbox.access())
  }

  async probeCheck(key: PullRequestKey, name: CheckName, paths: readonly string[]): Promise<string> {
    await this.ctx.storage.put("key", key)
    return this.#check({ name, paths: [...paths] })
  }

  async endSandbox(key: PullRequestKey): Promise<{ ended: true }> {
    await this.ctx.storage.put("key", key)
    await this.#sandbox.dropIdle("review_end")
    return { ended: true }
  }

  #checkQueue: Promise<void> = Promise.resolve()
  #packageJson: { base: string; text: string | undefined } | undefined

  #answers = new Map<string, Answering>()

  async resolveThread(args: ResolveThreadArgs, _conversationId: ConversationId): Promise<string> {
    return resolveOutcomeText(await this.#resolveAnswerThread(args))
  }

  async #resolveAnswerThread(args: ResolveThreadArgs): Promise<ResolveOutcome> {
    const answering = answeringFor(await this.runningRootOperation(), this.#answers)
    if (answering === undefined) return { kind: "refused", refusal: "not_answering" }
    if (answering.resolved) return { kind: "refused", refusal: "resolved_by_this_answer" }
    const problem = evidenceProblem(args.evidence)
    if (problem !== undefined) return { kind: "refused", refusal: problem }
    const key = await this.key()
    try {
      const github = await this.github()
      const live = threadOf(await github.listReviewThreads(key, key.number), answering.thread.firstCommentId)
      if (live?.resolved) return { kind: "refused", refusal: "already_resolved" }
      await github.resolveReviewThread(answering.thread.id)
    } catch (cause) {
      logError("thread.resolve_failed", { number: key.number, thread: answering.thread.id, error: errorText(cause) })
      return { kind: "refused", refusal: "unreachable" }
    }
    answering.resolved = true
    log("thread.resolved", { number: key.number, thread: answering.thread.id, reason: args.reason, by: "answer" })
    return { kind: "resolved", reason: args.reason }
  }

  async runCheck(args: RunCheckArgs): Promise<string> {
    if ((await this.readPending()) === undefined) return this.#checkRefused(args.name, { kind: "ended" })
    return this.#check(args)
  }

  async #check(args: RunCheckArgs): Promise<string> {
    const paths = args.paths ?? []
    const problem = pathProblem(paths)
    if (problem !== undefined) return this.#checkRefused(args.name, { kind: "bad_path", problem })
    const pr = await this.pullRequest()
    const key = checkKey(pr.head.sha, args.name, paths)
    const cached = await this.#cachedCheck(pr, key)
    if (cached !== undefined) return cached
    const access = await this.#sandbox.access()
    if (access.kind !== "ready") return this.#checkRefused(args.name, accessRefusal(access))
    return this.#queuedCheck(
      async () => (await this.#cachedCheck(pr, key)) ?? (await this.#runCheckNow(access, pr, args.name, paths, key)),
    )
  }

  async #checksDisplay(): Promise<ChecksDisplay | undefined> {
    const status = await this.#sandbox.status()
    const checks = await this.#sandbox.checks()
    if (status.kind === "none" && checks.size === 0) return undefined
    const runs = [...checks.values()].map(checkRecordOf)
    return { status: status.kind, reason: status.kind === "unavailable" ? status.reason : undefined, runs }
  }

  async #cachedCheck(pr: PullRequestInfo, key: string): Promise<string | undefined> {
    const cached = (await this.#sandbox.checks()).get(key)
    if (cached === undefined) return undefined
    log("check.cached", { number: pr.number, name: cached.name, paths: cached.paths.join(" ") })
    return checkText(cached)
  }

  #queuedCheck<T>(work: () => Promise<T>): Promise<T> {
    const run = this.#checkQueue.then(work)
    this.#checkQueue = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }

  async #runCheckNow(
    access: Extract<SandboxAccess, { kind: "ready" }>,
    pr: PullRequestInfo,
    name: CheckName,
    paths: readonly string[],
    key: string,
  ): Promise<string> {
    const began = Date.now()
    const argv = await this.#checkArgv(pr, name, access.manager, paths)
    if (argv === undefined) return this.#checkRefused(name, { kind: "no_command" })
    const used = paths.filter((path) => argv.includes(path))
    const missing = await this.#missingPath(access, used)
    if (missing !== undefined) return this.#checkRefused(name, { kind: "missing_path", path: missing })
    const outcome = await access.sandbox.run(argv, {
      cwd: access.dir,
      env: { ...CHECK_ENV },
      timeoutMs: checkTimeoutOf(this.env.SANDBOX_CHECK_TIMEOUT),
      tailBytes: DEFAULT_TAIL_BYTES,
    })
    const run: CheckRun = { name, paths, outcome, ms: Date.now() - began }
    await this.#sandbox.remember(key, run)
    log("check.run", {
      number: pr.number,
      name,
      paths: paths.join(" "),
      outcome: outcome.outcome,
      exitCode: outcome.outcome === "exited" ? outcome.exitCode : undefined,
      ms: run.ms,
      bytes: new TextEncoder().encode(outcome.tail).length,
      cut: outcome.cut,
    })
    return checkText(run)
  }

  async #missingPath(access: Extract<SandboxAccess, { kind: "ready" }>, paths: readonly string[]) {
    if (paths.length === 0) return undefined
    return missingPath(await access.sandbox.run(existsArgv(paths), { cwd: access.dir, timeoutMs: 60_000 }))
  }

  async #checkArgv(pr: PullRequestInfo, name: CheckName, manager: Manager, paths: readonly string[]) {
    const template = (await this.repositoryConfig(pr)).config.checks?.[name]
    if (template !== undefined) return argvFromTemplate(template, paths)
    return fallbackArgv(name, manager, await this.#packageJsonAt(pr.base.sha), paths)
  }

  async #packageJsonAt(base: string): Promise<string | undefined> {
    if (this.#packageJson?.base === base) return this.#packageJson.text
    try {
      const text = await (await this.github()).getFileContent(await this.key(), "package.json", base)
      this.#packageJson = { base, text }
      return text
    } catch (cause) {
      logError("check.package_unreadable", { base: shortSha(base), error: errorText(cause) })
      return undefined
    }
  }

  async #checkRefused(name: CheckName, refusal: CheckRefusal): Promise<string> {
    log("check.refused", { number: (await this.pullRequest()).number, name, reason: refusal.kind })
    return refusalText(name, refusal)
  }

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
    this.ctx.waitUntil(this.#deliveries.accept(incoming, (replay) => this.handle(replay, callerVersion)))
    return "accepted"
  }

  async onJob({ job }: LifecycleJobContext): Promise<LifecycleJobOutcome> {
    if (job.fn === SANDBOX_DROP_JOB) return this.#dropJob()
    if (job.fn === RETRY_JOB && Value.Check(RetryJob, job.payload)) return this.#retryJob(job.payload)
    if (job.fn !== RECHECK_JOB || !Value.Check(RecheckJob, job.payload)) {
      logError("job.unreadable", { id: job.id, fn: job.fn })
      return
    }
    await this.evaluateWithRecheck("recheck", job.payload.delivery, job.payload.attempt)
  }

  async #retryJob(payload: RetryJob): Promise<LifecycleJobOutcome> {
    await this.#deliveries.retry(
      payload,
      (replay) => this.handle(replay),
      (incoming, error, _attempts, sinceMs) => this.#abandon(incoming, error, sinceMs),
    )
    return undefined
  }

  async #abandon(incoming: Incoming, error: Error, sinceMs: number): Promise<void> {
    const minutes = Math.round(sinceMs / 60_000)
    if (incoming.kind === "review") await this.#abandonReview(incoming, error, minutes)
    if (incoming.kind === "comment") await this.#abandonComment(incoming, error, minutes)
  }

  async #abandonReview(incoming: ReviewIncoming, error: Error, minutes: number): Promise<void> {
    const text = `GitHub was unreachable for ${minutes} minutes (${failureSummary(error)}); comment \`@andabot review\` to retry.`
    const update = await this.failedRun(text)
    const pending = await this.pendingFor(incoming.deliveryId)
    if (pending?.checkRunId === undefined) {
      const key = await this.key()
      const github = await this.github()
      const start = startedCheckRun({
        name: this.botLogin(),
        headSha: incoming.headSha,
        deliveryId: incoming.deliveryId,
        fileCount: 0,
        model: this.env.REVIEW_MODEL,
        startedAt: Date.now(),
      })
      const created = await github.createCheckRun(key, start)
      await github.updateCheckRun(key, created.id, update)
    }
    await this.endOwnRun(incoming.deliveryId, update)
  }

  async #abandonComment(incoming: CommentIncoming, error: Error, minutes: number): Promise<void> {
    const ownThread = incoming.thread ? (await this.storedFindings([incoming.thread.rootId])).size > 0 : false
    if (!abandonReplyWanted(incoming.body, this.botLogin(), ownThread)) return
    const text = `I couldn't act on this: GitHub was unreachable for ${minutes} minutes (${failureSummary(error)}). Say it again and I'll try again.`
    await this.respond(await this.github(), await this.key(), incoming, `@${incoming.author} ${text}`)
  }

  async #dropJob(): Promise<LifecycleJobOutcome> {
    const active = await this.#sandbox.dropIdle("review_end")
    return active ? { rescheduleAt: Date.now() + LEASE_GRACE_MS } : undefined
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

  async repositorySearch(tool: "grep" | "tree"): Promise<SearchAccess> {
    return this.#runs.access(tool, async () => {
      const pr = await this.pullRequest()
      return { number: pr.number, sha: pr.head.sha }
    })
  }

  loadedSnapshot(): SnapshotFiles | undefined {
    return this.#snapshotFiles()
  }

  #snapshotFiles(): SqlSnapshotFiles {
    this.#snapshot ??= new SqlSnapshotFiles(this.ctx.storage.sql)
    return this.#snapshot
  }

  async pathFilters(): Promise<readonly string[]> {
    const pending = await this.readPending()
    const stored = await this.ctx.storage.get("scope")
    const inFlight = Value.Check(ReviewScope, stored) && stored.deliveryId === pending?.deliveryId ? stored : undefined
    return filtersInForce(inFlight, async () => {
      const { config } = await this.repositoryConfig(await this.pullRequest())
      return config.reviews.path_filters
    })
  }

  async budgetBlockFor(toolName: string, conversationId: ConversationId): Promise<string | undefined> {
    const spent = await this.spentReview(conversationId)
    if (spent === undefined) return undefined
    const message = budgetBlock(spent.standing, toolName)
    if (message === undefined) return undefined
    const first = this.#budgetBlocked === 0
    this.#budgetBlocked += 1
    if (first) log("review.budget_spent", { ...(await this.budgetFields(spent)), tool: toolName })
    return message
  }

  async requestBudget(conversationId: ConversationId): Promise<RequestBudget> {
    const spent = await this.spentReview(conversationId)
    if (spent === undefined) return "allow"
    const requestsPastBudget = this.#requestsPastBudget
    if (!refusesRequest(spent.standing, requestsPastBudget)) {
      this.#requestsPastBudget += 1
      return "allow"
    }
    log("review.budget_refused", { ...(await this.budgetFields(spent)), requestsPastBudget })
    return "refuse"
  }

  async submitReview(submission: ReviewSubmissionInput, conversationId: ConversationId): Promise<SubmitOutcome> {
    const root = (await this.harness.conversation(ROOT_SESSION)).id
    const pending = await this.readPending()
    const running = await this.runningRootOperation()
    const callerIsRoot = conversationId === root
    const standing = submitStanding({ caller: conversationId, root, pending, running })
    if (standing.kind !== "post") await this.logRefusal(standing.kind, pending, { callerIsRoot, running })
    if (standing.kind === "no_review") {
      return { text: "Nothing to post: no review is pending. Answer in text instead.", done: false }
    }
    if (standing.kind === "not_in_flight") return { text: NOT_IN_FLIGHT_REFUSAL, done: false }
    return this.postReview(submission, standing.deliveryId)
  }

  private async logRefusal(
    reason: SubmitRefusal,
    pending: PendingReview | undefined,
    detail?: RefusalDetail,
  ): Promise<void> {
    this.#refusedCalls += 1
    log("review.refused", {
      number: await this.storedNumber(),
      reason,
      head: pending === undefined ? undefined : shortSha(pending.headSha),
      delivery: pending?.deliveryId,
      ...detail,
    })
  }

  private async postReview(submission: ReviewSubmissionInput, deliveryId: string): Promise<SubmitOutcome> {
    const pending = await this.pendingFor(deliveryId)
    if (!pending) {
      await this.logRefusal("not_in_flight", await this.readPending())
      return { text: NOT_IN_FLIGHT_REFUSAL, done: false }
    }
    const posted = await this.ctx.storage.get(`posted:${pending.headSha}`)
    if (Value.Check(PostedReview, posted)) {
      await this.logRefusal("posted_already", pending)
      await this.completeAsPostedEarlier(deliveryId, posted)
      return { text: `Posted already: review ${posted.reviewId} for this head. Nothing more to do.`, done: true }
    }

    const pr = await this.freshPullRequest()
    if (pr.head.sha !== pending.headSha) return this.headMovedRefusal(pending, pr.head.sha)
    const checked = await this.checkSubmission(submission, pr, pending)
    const returned = [...checked.scoped.rejected, ...checked.scoped.duplicates]
    const reasonsRejected = checked.reasons.rejected
    const problems =
      returned.length > 0 || checked.missing.length > 0 || reasonsRejected.length > 0 || checked.changesSinceMissing
    if (pending.rejectionsReturned !== true && problems) {
      await this.markRejectionsReturned(pending.deliveryId)
      return {
        text: problemsText(returned, checked.missing, reasonsRejected, checked.changesSinceMissing),
        done: false,
      }
    }
    if (checked.missing.length > 0) return this.endIncomplete(pr, pending, checked.missing)
    return this.verifyAndPublish(pr, pending, submission, checked)
  }

  private async headMovedRefusal(pending: PendingReview, headNow: string): Promise<SubmitOutcome> {
    await this.logRefusal("head_moved", pending, { was: shortSha(pending.headSha), now: shortSha(headNow) })
    return {
      text: `Not posted: the pull request moved from ${shortSha(pending.headSha)} to ${shortSha(headNow)} while you reviewed. A new review will run for the new head; stop here.`,
      done: false,
    }
  }

  private async checkSubmission(
    submission: ReviewSubmissionInput,
    pr: PullRequestInfo,
    pending: PendingReview,
  ): Promise<CheckedSubmission> {
    const files = await this.changedFiles()
    const scope = await this.scopeFor(pending.deliveryId)
    const validated = withFilteredUnfounded(
      validateFindings(
        submission.findings,
        indexCommentableLines(scopedFiles(scope, files)),
        basisContextOf(pending),
        knownChecksOf(await this.#sandbox.checks(), pr.head.sha),
      ),
      scope,
    )
    const scoped = applyDeltaPolicy(validated, deltaScopeOf(scope))
    const missing = missingWalkthrough(submission, pathsNeedingRows(scope, files))
    const missingChangesSince = changesSinceMissing(submission, scope)
    const reasons = checkReasons(submission, {
      linkedIssues: pending.linkedIssues ?? [],
      title: pr.title,
      body: pr.body,
    })
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
      changesSinceMissing: missingChangesSince,
      reasons: reasons.accepted.length,
      reasonsRejected: reasons.rejected.length,
      rejectionsReturned: pending.rejectionsReturned === true,
    })
    return {
      scope,
      files,
      validated,
      scoped,
      missing,
      changesSinceMissing: missingChangesSince,
      reasons,
    }
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
    await this.upsertSummary(
      renderUnpostedSummary({ botLogin: this.botLogin(), headSha: pr.head.sha, note, closes: closesBlockOf(pr) }),
    )
    this.#incompleteDelivery = pending.deliveryId
    await this.endOwnRun(pending.deliveryId, await this.failedRun(note))
    return { text: `Not posted: no walkthrough row for ${missing.join(", ")}. The review ends here.`, done: true }
  }

  private async verifyAndPublish(
    pr: PullRequestInfo,
    pending: PendingReview,
    submission: ReviewSubmissionInput,
    checked: CheckedSubmission,
  ): Promise<SubmitOutcome> {
    const candidates = verifyCandidates(checked.scoped)
    const model = pending.verifyModel
    const drafted = { checked }
    if (model === undefined || candidates.length === 0) {
      return this.publishReview(pr, pending, submission, { ...drafted, verify: undefined })
    }
    if (await this.spentBeforeVerify(pr, pending, model)) {
      return this.publishReview(pr, pending, submission, { ...drafted, verify: unverifiedDisplay(model, "budget") })
    }
    const publication = await this.verify({ pr, pending, submission, checked, candidates, model })
    const headNow = (await this.freshPullRequest()).head.sha
    const current = await this.readPending()
    const standing = standingAfterVerify(current, pending.deliveryId, headNow)
    if (standing === "moved") return this.headMovedRefusal(pending, headNow)
    if (standing === "replaced") {
      await this.logRefusal("not_in_flight", current)
      return { text: NOT_IN_FLIGHT_REFUSAL, done: false }
    }
    return this.publishReview(pr, pending, submission, publication)
  }

  private async spentBeforeVerify(pr: PullRequestInfo, pending: PendingReview, model: string): Promise<boolean> {
    const standing = await this.budgetStandingOf(pending)
    if (standing.kind !== "spent") return false
    log("verify.skip", {
      number: pr.number,
      head: shortSha(pr.head.sha),
      reason: "budget",
      model,
      neurons: Math.round(standing.neurons * 10) / 10,
      budget: standing.budget,
    })
    return true
  }

  private async verify(run: VerifyRun): Promise<Publication> {
    const started = Date.now()
    const outcome = await this.runVerify(run)
    const fields = { ...verifyFields(run), ms: Date.now() - started, attempts: outcome.attempts }
    if (outcome.kind === "failed") {
      logError("verify.failed", { ...fields, reason: outcome.reason })
      return { checked: run.checked, verify: unverifiedDisplay(run.model, outcome.failure) }
    }
    const { checked, candidates } = run
    const draft = {
      validated: checked.validated,
      scoped: checked.scoped,
      scope: deltaScopeOf(checked.scope),
      candidates,
    }
    const verified = verifiedReview(draft, outcome.verdicts)
    for (const verdictLog of verdictFields(candidates, outcome.verdicts, verified.report)) {
      log("verify.verdict", { ...verifyFields(run), ...verdictLog })
    }
    log("verify.done", { ...fields, ...verifyCounts(candidates, verified.report) })
    return {
      checked: { ...checked, scoped: verified.scoped },
      verify: { kind: "verified", model: run.model, report: verified.report, leftOut: verified.leftOut },
    }
  }

  private async runVerify(run: VerifyRun): Promise<VerifyAttempt & { attempts: number }> {
    const attempts: VerifyAttempts = {
      run,
      runId: verifyRunId(),
      prompt: verifyPrompt(await this.verifyContexts(run)),
      aborting: Promise.resolve(),
    }
    try {
      return await verifyWithRetry(
        (n, signal) => this.verifyAttempt(attempts, n, signal),
        VERIFY_BACKSTOP_MS,
        backstopTimer,
      )
    } finally {
      this.#verifyPasses.close(attempts.runId)
    }
  }

  private async verifyAttempt(attempts: VerifyAttempts, n: 1 | 2, signal: AbortSignal): Promise<VerifyAttempt> {
    await attempts.aborting
    const answer = await attemptOrFailed(() => this.askVerify(attempts, n, signal))
    if (answer.kind === "failed" && !signal.aborted) {
      logError("verify.attempt_failed", { ...verifyFields(attempts.run), attempt: n, reason: answer.reason })
    }
    return answer
  }

  private async askVerify(attempts: VerifyAttempts, n: 1 | 2, signal: AbortSignal): Promise<VerifyAttempt> {
    const { run } = attempts
    if (!(await this.ownsPending(run.pending.deliveryId))) return REPLACED_BEFORE_ATTEMPT
    await this.restartGrace(run.pending.deliveryId)
    log("verify.start", { ...verifyFields(run), candidates: run.candidates.length, attempt: n })
    const session = await this.sessionAt("verifySession")
    const operationId = verifyOperationId(run.pending.operationId, attempts.runId, n)
    const onBackstop = () => {
      logError("verify.attempt_failed", {
        ...verifyFields(run),
        attempt: n,
        reason: backstopReason(VERIFY_BACKSTOP_MS),
      })
      attempts.aborting = this.abortOperation({ session: session.id, operationId })
    }
    return whileUnsettled(signal, onBackstop, () => this.promptVerify(session, attempts, operationId))
  }

  private async promptVerify(
    session: PiSession,
    attempts: VerifyAttempts,
    operationId: string,
  ): Promise<VerifyAttempt> {
    const { id } = await this.harness.conversation(session.id)
    const submitted = this.#verifyPasses.open(id, attempts.runId, operationId)
    await this.configureSkillSession(session, {
      skill: "verify",
      reference: SEVERITY_REFERENCE,
      tools: { extensions: [this.#verifyTools] },
      model: this.ai(attempts.run.model),
    })
    return answerAfter(() => session.prompt(attempts.prompt, { operationId }), submitted)
  }

  private async verifyContexts({ pr, pending, candidates }: VerifyRun): Promise<FindingContext[]> {
    return findingContexts(candidates, {
      files: await this.changedFiles(),
      read: async (path, ref) => (await fileAt(this, path, ref)).content,
      unreadable: (path, ref, error) => logError("verify.file_unreadable", { number: pr.number, path, ref, error }),
      issue: await this.verifyIssueText(pr, pending, candidates),
    })
  }

  private async verifyIssueText(
    pr: PullRequestInfo,
    pending: PendingReview,
    candidates: readonly VerifyCandidate[],
  ): Promise<string | undefined> {
    const numbers = pending.linkedIssues ?? []
    if (numbers.length === 0 || !candidates.some(({ finding }) => finding.basis_kind === "spec")) return undefined
    const key = await this.key()
    const github = await this.github()
    const reads = await readLinkedIssues(
      numbers,
      (number) => github.getIssue(key, number),
      (issue, error) => logError("verify.issue_unreadable", { number: pr.number, issue, error }),
    )
    return linkedIssueText(linkedIssuesFrom(reads))
  }

  private async resetVerifySession(): Promise<void> {
    const stored = await this.storedSessionId("verifySession")
    if (stored !== undefined) await this.harness.session(stored).reset()
  }

  private async publishReview(
    pr: PullRequestInfo,
    pending: PendingReview,
    submission: ReviewSubmissionInput,
    publication: Publication,
  ): Promise<SubmitOutcome> {
    const { scope, scoped } = publication.checked
    const reasons = [...publication.checked.reasons.accepted, ...this.budgetReasons()]
    const unverified = publication.verify?.kind === "unverified"
    const { resolved, closed } = await this.resolveAddressed(
      pr,
      addressedThreads(submission.addressed_threads, scope.recheck).resolve,
    )
    const workflow = requestChangesWorkflow(pending.requestChangesWorkflow, this.env.REQUEST_CHANGES_WORKFLOW)
    const settled = [...resolved, ...closed]
    const verdict = await this.reviewVerdict(pr, scoped, openBlockingAfter(scope, settled), workflow, reasons)
    const event = reviewEventOf(verdict)
    const key = await this.key()
    const github = await this.github()
    const attribution = attributionOf(pending)
    const spend = await this.spendOf(pending)
    const sandboxSeconds = await this.#sandbox.seconds()
    const checks = await this.#checksDisplay()
    const reviewed = nextReviewed({
      previous: await this.readReviewed(),
      scope,
      headSha: pr.head.sha,
      baseRef: pr.base.ref,
      at: Date.now(),
      submission,
      resolved: resolved.length,
      omitted: omittedIn(reasons),
      files: publication.checked.files,
      linkOf: (thread) => threadLink(pr.base.repo.full_name, pr.number, thread),
      seconds: elapsedSeconds(openedAt(pending), Date.now()),
    })
    this.noteChangesSinceMissing(pr, publication.checked.changesSinceMissing)
    const summary = renderSummaryComment({
      botLogin: this.botLogin(),
      seconds: reviewed.seconds,
      closes: closesBlockOf(pr),
      headSha: pr.head.sha,
      event: verdict,
      submission: submissionFromRecord(submission, reviewed),
      accepted: scoped.accepted,
      droppedCount: scoped.rejected.length,
      model: attribution?.model,
      skillsFingerprint: attribution?.fingerprint,
      repoSkillsFingerprint: pending.repoSkillsFingerprint,
      spend,
      budgetNote: this.budgetNoteOf(),
      linkedIssues: pending.linkedIssues ?? [],
      instructionFiles: pending.instructionFiles ?? [],
      since: reviewed.since,
      verify: publication.verify,
      configError: pending.configError,
      checks,
      sandboxSeconds,
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
        reasons,
      ),
      comments: scoped.accepted.map(toReviewComment),
    })
    const lastReview = lastReviewOf({
      reviewId: review.id,
      event,
      headSha: pr.head.sha,
      withheld: reasons.length,
      shown: verdict,
      accepted: scoped.accepted,
      rejected: scoped.rejected,
      at: Date.now(),
      requestChangesWorkflow: workflow,
    })
    await this.ctx.storage.put<LastReview>("lastReview", lastReview)
    await this.replyFixed(pr, resolved)
    await this.storeFindings(pr, scoped.accepted, review.id)
    await this.ctx.storage.put<ReviewedRecord>("reviewed", reviewed)
    const posted: PostedReview = {
      reviewId: review.id,
      event,
      shown: verdict,
      at: Date.now(),
      counts: countBySeverity(scoped.accepted),
      spend,
      unverified,
      ...attribution,
    }
    withOptionalPostedFields(posted, sandboxSeconds, checks, pending.checkRunId)
    await this.ctx.storage.put<PostedReview>(`posted:${pr.head.sha}`, posted)
    await this.endOwnRun(
      pending.deliveryId,
      postedCheckRun(verdict, scoped.accepted, summary, await this.summaryCommentUrl(), Date.now(), unverified),
    )
    if (evaluatesAfterReview(lastReview, scoped.accepted)) {
      this.ctx.waitUntil(this.evaluateApproval("review", pending.deliveryId))
    }
    const dropped =
      scoped.rejected.length > 0
        ? ` ${plural(scoped.rejected.length, "finding")} that still failed the checks ${were(scoped.rejected.length)} dropped.`
        : ""
    return {
      text: `Posted review ${review.id} (${event}) with ${plural(scoped.accepted.length, "inline comment")}.${dropped}`,
      done: true,
    }
  }

  private async reviewVerdict(
    pr: PullRequestInfo,
    scoped: ScopedReview,
    openBlocking: number | "unknown",
    workflow: boolean,
    reasons: readonly ApprovalReason[],
  ): Promise<Verdict> {
    const { accepted, rejected } = scoped
    const verdict = decideReviewVerdict({ accepted, rejected, workflow, openBlocking, reasons })
    const checks = verdict === "APPROVE" ? await this.checksOn(pr.head.sha) : undefined
    return verdictAfterChecks(verdict, checks)
  }

  private budgetReasons(): ApprovalReason[] {
    const reason = budgetReason(this.#budgetBlocked, reviewBudgetOf(this.env.MAX_REVIEW_NEURONS))
    return reason === undefined ? [] : [reason]
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

  async #liveThreadsOrUnknown(pr: PullRequestInfo): Promise<ReviewThread[] | undefined> {
    try {
      const key = await this.key()
      return await (await this.github()).listReviewThreads(key, key.number)
    } catch (error) {
      logError("review.resolve_unchecked", { number: pr.number, error: errorText(error) })
      return undefined
    }
  }

  private async resolveAddressed(pr: PullRequestInfo, threads: readonly OpenThread[]): Promise<AddressedResolution> {
    if (threads.length === 0) return { resolved: [], closed: [] }
    const github = await this.github()
    const { open, closed } = stillOpen(threads, await this.#liveThreadsOrUnknown(pr))
    for (const thread of closed) log("review.resolve_skipped", { number: pr.number, thread: thread.handle })
    const { resolved, failed } = await resolveThreads(github, open)
    for (const { thread, error } of failed) {
      logError("review.resolve_failed", { number: pr.number, thread: thread.handle, step: "resolve", error })
    }
    log("review.resolved", {
      number: pr.number,
      head: shortSha(pr.head.sha),
      resolved: resolved.length,
      attempted: threads.length,
    })
    return { resolved, closed }
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
        await this.review(incoming, callerVersion)
        return
      case "comment":
        return this.comment(incoming, callerVersion)
      case "reaction":
        return reactWithEyes(await this.github(), incoming.nodeId, incoming.key.number)
      case "approval": {
        const { outcome, recheck } = await this.evaluateWithRecheck(incoming.trigger, incoming.deliveryId, 0)
        if (retriesAtDoor(outcome, recheck)) throw new TransientFailure(`approval after ${incoming.trigger}`)
        return
      }
      case "closed":
        this.#runs.dropIdle(incoming.key.number, "closed")
        await this.#sandbox.dropIdle("closed")
        return
    }
  }

  private async review(incoming: ReviewIncoming, callerVersion?: Version): Promise<ReviewSkip | undefined> {
    this.#runs.dropIdle(incoming.key.number, "stale")
    if (pausesReview(incoming, await this.isPaused())) {
      log("review.skip", { reason: "paused", head: shortSha(incoming.headSha), number: incoming.key.number })
      return "paused"
    }
    const staleBuild = isOlder(this.version(), callerVersion)
    const pr = await this.freshPullRequest()
    const headSkip = await this.headSkip(pr, incoming)
    if (headSkip !== undefined) return headSkip
    const read = await this.repositoryConfig(pr)
    const settingsSkip = await this.settingsSkip(pr, incoming, read)
    if (settingsSkip !== undefined) return settingsSkip
    const skillsFingerprint = (await bundledSkills()).fingerprint
    const flight = await this.clearFlight(pr.head.sha, incoming.deliveryId)
    if (flight.kind === "skip") {
      log("review.skip", { reason: "in_progress", head: shortSha(pr.head.sha), number: pr.number })
      return "in_progress"
    }
    if (incoming.full) await this.ctx.storage.delete(`posted:${pr.head.sha}`)
    const settings = {
      staleBuild,
      callerBuild: callerVersion?.id,
      skillsFingerprint,
      config: read.config,
      configStatus: configStatus(read),
    }
    if (flight.kind === "resume") {
      log("review.resumed", { number: pr.number, head: shortSha(pr.head.sha), delivery: incoming.deliveryId })
      const previous = resumedPending(flight.previous, Date.now())
      await this.ctx.storage.put<PendingReview>("pending", previous)
      const resumed: ReviewRun = {
        operationId: previous.operationId,
        deliveryId: previous.deliveryId,
        started: previous.started,
        openedAt: openedAt(previous),
        ...settings,
      }
      if (previous.checkRunId !== undefined) resumed.checkRunId = previous.checkRunId
      await this.runReview(pr, incoming, resumed)
      return undefined
    }
    const started = Date.now()
    const run = {
      operationId: `review:${incoming.deliveryId}`,
      deliveryId: incoming.deliveryId,
      started,
      openedAt: started,
      ...settings,
    }
    await this.ctx.storage.put<PendingReview>("pending", {
      headSha: pr.head.sha,
      deliveryId: incoming.deliveryId,
      operationId: run.operationId,
      started: run.started,
      openedAt: run.openedAt,
      model: this.env.REVIEW_MODEL,
      fingerprint: skillsFingerprint,
      ...runSettings(read, this.env.REQUEST_CHANGES_WORKFLOW, this.env.VERIFY_MODEL),
      ...(await this.usageBaseline()),
    })
    await this.runReview(pr, incoming, run)
    return undefined
  }

  private async headSkip(pr: PullRequestInfo, incoming: ReviewIncoming): Promise<HeadSkip | undefined> {
    if (pr.state !== "open") {
      log("review.skip", { reason: "not_open", state: pr.state, number: pr.number })
      return "not_open"
    }
    if (pr.head.sha !== incoming.headSha) {
      log("review.skip", {
        reason: "superseded",
        was: shortSha(incoming.headSha),
        now: shortSha(pr.head.sha),
        number: pr.number,
      })
      return "superseded"
    }
    if (incoming.full || !(await this.isPosted(pr))) return undefined
    log("review.skip", { reason: "already_reviewed", head: shortSha(pr.head.sha), number: pr.number })
    if (evaluatesReviewedHead(pr, reviewTrigger(incoming))) {
      await this.evaluateApproval("already_reviewed", incoming.deliveryId)
    }
    return "already_reviewed"
  }

  private async settingsSkip(
    pr: PullRequestInfo,
    incoming: ReviewIncoming,
    read: ConfigRead,
  ): Promise<SettingsSkip | undefined> {
    const decision = shouldReview(read.config, pullRequestFacts(pr), reviewTrigger(incoming))
    const reason = decision.review ? await this.filesSkip(read.config) : decision.reason
    if (reason !== undefined) {
      log("review.skip", { reason, head: shortSha(pr.head.sha), number: pr.number, config: configStatus(read) })
    }
    return reason
  }

  private async filesSkip(config: AndabotConfig): Promise<"path_filters" | undefined> {
    return pathFiltersSkip(config.reviews.path_filters, () => this.changedFiles())
  }

  private async clearFlight(headSha: string, deliveryId: string): Promise<FlightDecision> {
    const pending = await this.readPending()
    const operations = await this.operationsOf(pending)
    const decision = decideFlight(pending, headSha, { running: operations.length > 0, now: Date.now() }, deliveryId)
    if (decision.kind !== "replace") return decision
    log("review.replaced", {
      because: decision.because,
      previous: shortSha(decision.previous.headSha),
      head: shortSha(headSha),
    })
    await this.ctx.storage.delete("pending")
    for (const operation of operations) await this.abortOperation(operation)
    await this.endReplacedRun(decision, headSha)
    if (decision.because === "superseded") await this.#sandbox.dropIdle("new_head")
    return decision
  }

  private async abortOperation({
    session,
    operationId,
  }: Pick<PiPendingOperation, "session" | "operationId">): Promise<void> {
    try {
      await this.harness.abort({ session, operationId })
    } catch (error) {
      logError("review.abort_failed", { operation: operationId, session, error: errorText(error) })
    }
  }

  private async operationsOf(pending: PendingReview | undefined): Promise<PiPendingOperation[]> {
    if (pending === undefined) return []
    const verify = await this.storedSessionId("verifySession")
    return reviewOperations(
      pending,
      await this.harness.pending({ session: ROOT_SESSION }),
      verify === undefined ? [] : await this.harness.pending({ session: verify }),
    )
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
    const checkRunId = run.checkRunId ?? (await this.startCheckRun(pr, files, run))
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

  private async repositoryContext(
    pr: PullRequestInfo,
    files: readonly ChangedFile[],
    pathInstructions: readonly PathInstruction[],
    deliveryId: string,
  ): Promise<ReviewRepository> {
    const { baseSha, changed } = contextInputs(pr, files)
    const context = await this.loadedContext(pr.number, baseSha, changed, deliveryId)
    const repository = await reviewRepository(context, changed, pathInstructions)
    for (const { event, fields } of skillLogs(pr.number, repository.skills)) log(event, fields)
    return repository
  }

  private async repositoryConfig(pr: PullRequestInfo): Promise<ConfigRead> {
    const baseSha = pr.base.sha
    const cached = await this.cachedConfig(baseSha)
    if (cached !== undefined) return cached
    const fields = { number: pr.number, base: shortSha(baseSha) }
    const read = await readConfig(await this.github(), await this.key(), baseSha, (error) =>
      logError("config.unreadable", { ...fields, error }),
    )
    if (isCacheable(read)) await this.cacheConfig(baseSha, read)
    return read
  }

  private async cachedConfig(baseSha: string): Promise<ConfigRead | undefined> {
    const key = configKey(baseSha)
    const stored = await this.ctx.storage.get(key)
    if (Value.Check(StoredConfig, stored)) return configReadOf(stored)
    if (stored !== undefined) await this.ctx.storage.delete(key)
    return undefined
  }

  private async cacheConfig(baseSha: string, read: ConfigRead): Promise<void> {
    try {
      const listed = await this.ctx.storage.list({ prefix: CONFIG_PREFIX })
      const stale = staleConfigKeys([...listed.keys()], baseSha)
      if (stale.length > 0) await this.ctx.storage.delete(stale)
      await this.ctx.storage.put(configKey(baseSha), storedConfig(baseSha, read))
    } catch (error) {
      logError("config.uncached", { base: shortSha(baseSha), error: errorText(error) })
    }
  }

  private async loadedContext(
    number: number,
    baseSha: string,
    changed: readonly string[],
    deliveryId: string,
  ): Promise<RepositoryContext | undefined> {
    const github = await this.github()
    const key = await this.key()
    const cached = await this.cachedContext(baseSha)
    const donor = cached === undefined ? await this.donorContext(baseSha) : undefined
    const fields = { number, base: shortSha(baseSha) }
    const unreadableFile = (path: string, error: string): void =>
      logError("context.unreadable", { ...fields, path, error })
    const context = await readRepositoryContext(
      () => loadRepositoryContext(github, key, baseSha, changed, unreadableFile, cached, donor),
      (error) => logError("context.unreadable", { ...fields, error }),
    )
    if (context !== undefined && context !== cached && (await this.ownsPending(deliveryId))) {
      await this.cacheContext(context)
    }
    return context
  }

  private async cachedContext(baseSha: string): Promise<RepositoryContext | undefined> {
    const key = contextKey(baseSha)
    const stored = await this.ctx.storage.get(key)
    if (Value.Check(StoredRepositoryContext, stored)) return stored
    if (stored !== undefined) await this.ctx.storage.delete(key)
    return undefined
  }

  private async donorContext(baseSha: string): Promise<RepositoryContext | undefined> {
    const listed = await this.ctx.storage.list({ prefix: CONTEXT_PREFIX })
    const key = donorKey([...listed.keys()], baseSha)
    const stored = key === undefined ? undefined : listed.get(key)
    return Value.Check(StoredRepositoryContext, stored) ? stored : undefined
  }

  private async cacheContext(context: RepositoryContext): Promise<void> {
    try {
      const listed = await this.ctx.storage.list({ prefix: CONTEXT_PREFIX })
      const stale = staleContextKeys([...listed.keys()], context.baseSha)
      if (stale.length > 0) await this.ctx.storage.delete(stale)
      await this.ctx.storage.put(contextKey(context.baseSha), context)
    } catch (error) {
      logError("context.uncached", { base: shortSha(context.baseSha), error: errorText(error) })
    }
  }

  private async restoreCatalog(): Promise<void> {
    const number = await this.storedNumber()
    try {
      const listed = await this.ctx.storage.list({ prefix: CONTEXT_PREFIX })
      const contexts = [...listed.values()].flatMap((stored) =>
        Value.Check(StoredRepositoryContext, stored) ? [stored] : [],
      )
      const pending = await this.readPending()
      const skipped: ReportSkippedRestore = (records, reason) =>
        log("skills.restore_skipped", { number, records, reason })
      const sources = await restoredCatalog(
        (await bundledSkills()).source,
        contexts,
        listed.size,
        pending === undefined ? { pending: false } : { pending: true, fingerprint: pending.repoSkillsFingerprint },
        skipped,
      )
      this.#catalog = await installCatalog(
        this.registry,
        this.#catalog,
        sources,
        skillsExtension,
        (name, conversationId) => this.reportActivation(name, conversationId),
      )
    } catch (error) {
      logError("skills.restore_failed", { number, error: errorText(error) })
    }
  }

  private async reportActivation(name: string, conversationId: ConversationId | undefined): Promise<void> {
    this.#activated.push(name)
    log("skills.activated", {
      number: await this.storedNumber(),
      head: await this.pendingHead(),
      name,
    })
    try {
      const pending = await this.reviewActivating(conversationId)
      if (pending === undefined) return
      await this.ctx.storage.put<PendingReview>("pending", {
        ...pending,
        activated: [...(pending.activated ?? []), name],
      })
    } catch (error) {
      logError("skills.activation_unrecorded", { name, error: errorText(error) })
    }
  }

  private async reviewActivating(conversationId: ConversationId | undefined): Promise<PendingReview | undefined> {
    if (conversationId === undefined) return undefined
    const root = (await this.harness.conversation(ROOT_SESSION)).id
    if (conversationId !== root) return undefined
    const pending = await this.readPending()
    if (pending === undefined) return undefined
    return (await this.reviewIsRunning(pending)) ? pending : undefined
  }

  private async storedNumber(): Promise<number | undefined> {
    try {
      const key = await this.ctx.storage.get("key")
      return Value.Check(PullRequestKey, key) ? key.number : undefined
    } catch {
      return undefined
    }
  }

  private async pendingHead(): Promise<string | undefined> {
    try {
      const pending = await this.readPending()
      return pending === undefined ? undefined : shortSha(pending.headSha)
    } catch {
      return undefined
    }
  }

  private async docsFor(
    pr: PullRequestInfo,
    files: readonly ChangedFile[],
    since: readonly ChangedFile[],
    scope: ReviewScope,
    globs: readonly string[],
    pathFilters: readonly string[],
    deliveryId: string,
  ): Promise<DocsSections> {
    const isDoc = docMatcher(globs, pathFilters)
    const incremental = scope.mode === "incremental" && scope.from !== undefined
    const sorted = docsInChange(incremental ? promptFiles(files, since, scope).covered : files, isDoc)
    const searched = await this.searchDocs(sorted, isDoc)
    await this.recordDocs(deliveryId, searched.headDocs)
    const fields = docsStartFields(sorted, searched.found, searched.search)
    log("review.docs", { number: pr.number, head: shortSha(pr.head.sha), ...fields })
    const { found, search } = searched
    const mentions = found?.mentions ?? []
    return { under: sorted.under, mentions, overflow: found?.overflow ?? 0, search, longLines: found?.longLines ?? 0 }
  }

  private async searchDocs(sorted: DocsInChange, isDoc: DocMatcher): Promise<SearchedDocs> {
    const underPaths = sorted.under.map((file) => file.filename).sort()
    if (searchableCode(sorted.code).length === 0) return { found: undefined, search: "ready", headDocs: underPaths }
    const access = await this.repositorySearch("grep")
    if (access.kind !== "ready") return { found: undefined, search: docsSearchOf(access.kind), headDocs: underPaths }
    const found = docMentions(access.files, access.work, isDoc, sorted.code, changedLinesByDoc(sorted.under))
    const mentioned = found.mentions.map((mention) => mention.path)
    const headDocs = docPathsAtHead(access.files.paths(), isDoc, [...underPaths, ...mentioned])
    return { found, search: found.stopped ? "stopped" : "ready", headDocs }
  }

  private async recordDocs(deliveryId: string, docs: readonly string[]): Promise<void> {
    const pending = await this.pendingFor(deliveryId)
    if (pending) await this.ctx.storage.put<PendingReview>("pending", { ...pending, docs: [...docs] })
  }

  private async recordRepository(deliveryId: string, repository: ReviewRepository): Promise<void> {
    const pending = await this.pendingFor(deliveryId)
    if (pending) await this.ctx.storage.put<PendingReview>("pending", { ...pending, ...repositoryRecord(repository) })
  }

  private async runReview(pr: PullRequestInfo, incoming: ReviewIncoming, run: ReviewRun): Promise<void> {
    this.#refusedCalls = 0
    this.#budgetBlocked = 0
    this.#requestsPastBudget = 0
    this.#activated = []
    this.#runs.start()
    await this.#sandbox.start()
    try {
      const files = await this.openRun(pr, run)
      const issues = await this.linkedIssues(pr)
      await this.recordLinkedIssues(run.deliveryId, issues)
      const repository = await this.repositoryContext(pr, files, run.config.reviews.path_instructions, run.deliveryId)
      await this.recordRepository(run.deliveryId, repository)
      const { standards } = repository
      const reviewable = reviewableFiles(files, run.config.reviews.path_filters)
      const { scope, since } = await this.planReview(pr, reviewable, incoming, run)
      const { docs: docGlobs, path_filters } = run.config.reviews
      const docs = await this.docsFor(pr, reviewable, since, scope, docGlobs, path_filters, run.deliveryId)
      const prompt = promptFor(pr, reviewable, scope, since, issues, (await this.readReviewed())?.omitted ?? [], docs)
      log("review.start", {
        number: pr.number,
        head: shortSha(pr.head.sha),
        base: shortSha(pr.base.sha),
        config: run.configStatus,
        files: files.length,
        filesFiltered: files.length - reviewable.length,
        linkedIssues: issues.length,
        instructionFiles: standards.used.length,
        standardsCut: standards.cut.length,
        instructionLoadsSkipped: standards.loadsSkipped,
        treeTruncated: standards.treeTruncated,
        ...skillsStartFields(repository.skills),
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
      await this.resetVerifySession()
      await this.harness.session().setModel(this.reviewModel())
      const offeredTools = await this.configureReview(repository)
      log("review.tools", {
        number: pr.number,
        head: shortSha(pr.head.sha),
        tools: offeredTools.join(" "),
        catalog: offeredTools.includes(ACTIVATE_SKILL_TOOL),
      })
      if (await this.replaced(pr, run)) return
      const result = await this.harness.prompt(prompt, { operationId: run.operationId })
      this.logTranscript(pr, "review", result)
      await this.restartGrace(run.deliveryId)
      const source = await this.finishReview(pr, result, run)
      if (source) {
        log("review.done", {
          number: pr.number,
          head: shortSha(pr.head.sha),
          outcome: "posted",
          source,
          skills: `review@${run.skillsFingerprint.slice(0, 8)}`,
          seconds: elapsedSeconds(run.openedAt, Date.now()),
          ...this.#runs.usage(),
          ...sandboxFields(await this.#sandbox.seconds()),
          checks: (await this.#sandbox.checks()).size,
          ...spendFields(await this.postedSpend(pr)),
        })
      }
      await this.releasePending(run.deliveryId)
    } catch (error) {
      if (afterReviewThrow(errorOf(error)) === "release") {
        await this.endOwnRun(run.deliveryId, await this.failedRun(errorText(error)))
      }
      throw error
    } finally {
      await this.#runs.end(pr.number, "review_end")
      await this.#sandbox.end("review_end")
    }
  }

  private logTranscript(pr: PullRequestInfo, after: "review" | "retry", result: PiPromptResponse): void {
    log("review.transcript", {
      number: pr.number,
      head: shortSha(pr.head.sha),
      after,
      status: result.status,
      ...transcriptFields(summarizeTranscript(result.messages)),
      refusedCalls: this.#refusedCalls,
      budgetBlocked: this.#budgetBlocked,
      activated: this.#activated.join(" "),
    })
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
    const scope = buildScope({
      deliveryId: run.deliveryId,
      mode,
      from: reviewed?.headSha,
      covered,
      threads,
      changed,
      pathFilters: run.config.reviews.path_filters,
    })
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
      softenUnlessTransient(errorOf(error))
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
      softenUnlessTransient(errorOf(error))
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

  private async configureReview({ standards, skills }: ReviewRepository): Promise<readonly string[]> {
    const { source } = await bundledSkills()
    const skill = await loadSkill(source, "review")
    const references = await loadReferences(source, skill)
    const root = await (await this.harness.pi()).root(BACKGROUND_CONTEXT)
    await root.configure(
      {
        instructions: reviewInstructions(renderSkillWithResources(skill, references), [standards.text]),
        thinkingLevel: reviewThinkingLevel(this.env.REVIEW_THINKING_LEVEL),
      },
      BACKGROUND_CONTEXT,
    )
    const sources = catalogFor(source, skills.offered)
    this.#catalog = await installCatalog(
      this.registry,
      this.#catalog,
      sources,
      skillsExtension,
      (name, conversationId) => this.reportActivation(name, conversationId),
    )
    return (await root.agent(BACKGROUND_CONTEXT)).tools.map(({ name }) => name)
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
    this.logTranscript(pr, "retry", retry)
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
      softenUnlessTransient(errorOf(error))
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

  private usageLedger(): UsageLedger {
    return {
      usage: async () => (await this.harness.pi()).usage(BACKGROUND_CONTEXT),
      messages: async () => [...(await this.harness.session().messages()), ...(await this.verifyMessages())],
    }
  }

  private async verifyMessages(): Promise<EntryRecord[]> {
    const stored = await this.storedSessionId("verifySession")
    return stored === undefined ? [] : this.harness.session(stored).messages()
  }

  private async usageBaseline(): Promise<Pick<StoredPending, "usageBefore">> {
    const usageBefore = await usageBaseline(this.usageLedger())
    return usageBefore === undefined ? {} : { usageBefore }
  }

  private spendOf(pending: PendingReview): Promise<ReviewSpend> {
    return reviewSpend(this.usageLedger(), pending.usageBefore)
  }

  private async runSpend(deliveryId: string): Promise<ReviewSpend> {
    const pending = await this.pendingFor(deliveryId)
    return pending === undefined ? [] : this.spendOf(pending)
  }

  private async spentReview(conversationId: ConversationId): Promise<SpentReview | undefined> {
    try {
      return await this.readSpentReview(conversationId)
    } catch (error) {
      logError("review.budget_unreadable", { error: errorText(error) })
      return undefined
    }
  }

  private async readSpentReview(conversationId: ConversationId): Promise<SpentReview | undefined> {
    const root = (await this.harness.conversation(ROOT_SESSION)).id
    const pending = conversationId === root ? await this.readPending() : undefined
    if (pending === undefined) return undefined
    const standing = await this.budgetStandingOf(pending)
    if (standing.kind !== "spent" || !(await this.reviewIsRunning(pending))) return undefined
    return { pending, standing }
  }

  private async reviewIsRunning(pending: PendingReview): Promise<boolean> {
    const running = await this.runningRootOperation()
    return running !== undefined && ownsOperation(pending, running)
  }

  private async budgetStandingOf(pending: PendingReview): Promise<BudgetStanding> {
    const budget = reviewBudgetOf(this.env.MAX_REVIEW_NEURONS)
    if (pending.usageBefore === undefined) return budgetStanding(undefined, budget)
    try {
      const now = usageTotals(await this.usageLedger().usage())
      return budgetStanding(neuronsSince(pending.usageBefore, now), budget)
    } catch (error) {
      logError("review.usage_unreadable", { when: "budget", error: errorText(error) })
      return budgetStanding(undefined, budget)
    }
  }

  private async budgetFields({ pending, standing }: SpentReview) {
    return {
      number: await this.storedNumber(),
      head: shortSha(pending.headSha),
      neurons: Math.round(standing.neurons * 10) / 10,
      budget: standing.budget,
    }
  }

  private budgetNoteOf(): string | undefined {
    return this.#budgetBlocked > 0 ? budgetNote(reviewBudgetOf(this.env.MAX_REVIEW_NEURONS)) : undefined
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
    await this.upsertSummary(
      renderUnpostedSummary({ botLogin: this.botLogin(), headSha: pr.head.sha, note, closes: closesBlockOf(pr) }),
    )
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
    await this.upsertSummary(
      renderUnpostedSummary({ botLogin: this.botLogin(), headSha: pr.head.sha, note, closes: closesBlockOf(pr) }),
    )
    await this.endOwnRun(run.deliveryId, await this.failedRun(note))
  }

  private async comment(incoming: CommentIncoming, callerVersion?: Version): Promise<void> {
    const key = await this.key()
    this.#runs.dropIdle(key.number, "stale")
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
    await reactWithEyes(github, incoming.nodeId, key.number)
    const where = incoming.thread ? "thread" : "conversation"
    log("command.received", { kind: command.kind, author: incoming.author, number: key.number, where })
    await this.runCommand(command, { github, key, incoming, thread }, callerVersion)
  }

  private async runCommand(command: Command, call: CommandCall, callerVersion?: Version): Promise<void> {
    switch (command.kind) {
      case "help":
        await this.respond(call.github, call.key, call.incoming, helpText(this.botLogin()))
        return
      case "review":
        await this.reviewOnRequest(call, command.full, callerVersion)
        return
      case "chat":
        await this.answer(call.github, call.key, call.incoming, command.text, call.thread)
        return
      case "pause":
        await this.pause(call)
        return
      case "resume":
        await this.resume(call, callerVersion)
        return
      case "resolve":
        await this.resolve(call)
        return
      case "summary":
        await this.summarize(call)
        return
    }
  }

  private async reviewOnRequest(call: CommandCall, full: boolean, callerVersion?: Version): Promise<void> {
    const pr = await this.freshPullRequest()
    const skipped = await this.review(requestedReview(call, pr.head.sha, full), callerVersion)
    if (skipped === undefined) return
    const text = skippedReviewText(skipped, pr.head.sha, this.botLogin())
    if (text !== undefined) await this.respond(call.github, call.key, call.incoming, text)
  }

  private async pause(call: CommandCall): Promise<void> {
    const alreadyPaused = await this.isPaused()
    if (!alreadyPaused) await this.startPause(call)
    await this.respond(call.github, call.key, call.incoming, pauseReply(alreadyPaused, this.botLogin()))
  }

  private async startPause({ key, incoming }: CommandCall): Promise<void> {
    await this.ctx.storage.put({ paused: true, pausedBy: incoming.author })
    log("command.paused", { number: key.number, author: incoming.author })
    await this.refreshPausedLine(key.number)
  }

  private async refreshPausedLine(number: number): Promise<void> {
    try {
      const commentId = await this.findSummaryComment()
      if (commentId !== undefined) await this.editPausedLine(commentId)
      else if (await this.isPaused()) await this.createPausedSummary()
    } catch (error) {
      logError("command.summary_failed", { number, error: errorText(error) })
    }
  }

  private async editPausedLine(commentId: number): Promise<void> {
    const key = await this.key()
    const github = await this.github()
    const body = (await github.getIssueComment(key, commentId)).body ?? ""
    const line = await this.shownPausedLine()
    const edited = line === undefined ? withoutPausedLine(body) : withPausedLine(body, line)
    if (edited !== body) await github.updateIssueComment(key, commentId, edited)
  }

  private async createPausedSummary(): Promise<void> {
    const pr = await this.currentPullRequest()
    const note = "_Not reviewed yet._"
    await this.upsertSummary(
      renderUnpostedSummary({ botLogin: this.botLogin(), headSha: pr.head.sha, note, closes: closesBlockOf(pr) }),
    )
  }

  private async resume(call: CommandCall, callerVersion?: Version): Promise<void> {
    if (await this.isPaused()) return this.resumePaused(call, callerVersion)
    await this.respond(call.github, call.key, call.incoming, NOT_PAUSED_REPLY)
  }

  private async resumePaused(call: CommandCall, callerVersion?: Version): Promise<void> {
    const { github, key, incoming } = call
    const pr = await this.freshPullRequest()
    await this.ctx.storage.delete(["paused", "pausedBy"])
    await this.refreshPausedLine(key.number)
    const step = await this.resumeStepFor(pr)
    log("command.resumed", { number: key.number, author: incoming.author, head: shortSha(pr.head.sha), step })
    await this.respond(github, key, incoming, resumeReply(step, pr.head.sha, this.botLogin()))
    await this.catchUp(step, pr, call, callerVersion)
  }

  private async resumeStepFor(pr: PullRequestInfo): Promise<ResumeStep> {
    return resumeStep({
      open: pr.state === "open",
      reviewRunning: await this.reviewRunning(pr.head.sha),
      reviewed: headReviewed(pr.head.sha, (await this.readReviewed())?.headSha, await this.isPosted(pr)),
      settingsSkip: await this.pushSettingsSkip(pr),
    })
  }

  private async pushSettingsSkip(pr: PullRequestInfo): Promise<SkipReason | undefined> {
    const read = await this.repositoryConfig(pr)
    const decision = shouldReview(read.config, pullRequestFacts(pr), "push")
    return decision.review ? undefined : decision.reason
  }

  private async reviewRunning(headSha: string): Promise<boolean> {
    const pending = await this.readPending()
    const running = (await this.operationsOf(pending)).length > 0
    return decideFlight(pending, headSha, { running, now: Date.now() }, NO_DELIVERY).kind === "skip"
  }

  private async catchUp(
    step: ResumeStep,
    pr: PullRequestInfo,
    call: CommandCall,
    callerVersion?: Version,
  ): Promise<void> {
    const deliveryId = call.incoming.deliveryId
    if (step === "evaluate") {
      await this.evaluateApproval("resume", deliveryId)
      return
    }
    if (step !== "review") return
    await this.review(requestedReview(call, pr.head.sha, false), callerVersion)
    if (await this.evaluatesAfterCatchUpReview(pr)) await this.evaluateApproval("resume", deliveryId)
  }

  private async evaluatesAfterCatchUpReview(pr: PullRequestInfo): Promise<boolean> {
    return evaluatesAfterCatchUp({
      headSha: pr.head.sha,
      reviewedHead: (await this.readReviewed())?.headSha,
      posted: await this.isPosted(pr),
      inFlight: (await this.readPending()) !== undefined,
    })
  }

  private async resolve(call: CommandCall): Promise<void> {
    const scope = await this.resolveScope(call)
    if (scope === undefined) return this.respond(call.github, call.key, call.incoming, resolveRefusal("unreadable"))
    const targets = resolveTargets(scope, this.botLogin())
    if (targets.kind !== "resolve") {
      return this.respond(call.github, call.key, call.incoming, resolveRefusal(targets.kind))
    }
    await this.resolveOwnThreads(call, scope.where, targets.threads)
  }

  private async resolveScope({ github, key, incoming, thread }: CommandCall): Promise<ResolveScope | undefined> {
    if (incoming.thread) return { where: "thread", thread }
    try {
      return { where: "conversation", threads: await github.listReviewThreads(key, key.number) }
    } catch (error) {
      softenUnlessTransient(errorOf(error))
      logError("command.resolve_failed", { number: key.number, step: "read", error: errorText(error) })
      return undefined
    }
  }

  private async resolveOwnThreads(
    call: CommandCall,
    where: ResolveScope["where"],
    threads: readonly OpenThread[],
  ): Promise<void> {
    const { github, key, incoming } = call
    const { resolved, failed } = await resolveThreads(github, threads)
    for (const { thread, error } of failed) {
      logError("command.resolve_failed", { number: key.number, step: "resolve", thread: thread.threadId, error })
    }
    const justResolved = new Set(resolved.map((thread) => thread.threadId))
    const outcome = await this.evaluateApproval("resolve", incoming.deliveryId, justResolved)
    const note = await this.approvalNoteFor(outcome, key.number)
    log("command.resolved", {
      number: key.number,
      author: incoming.author,
      where,
      resolved: resolved.length,
      failed: failed.length,
      approval: outcome.kind,
      reason: waitReasonOf(outcome),
    })
    await this.respond(github, key, incoming, resolveReply({ resolved: resolved.length, failed: failed.length, note }))
  }

  private async approvalNoteFor(outcome: ApprovalOutcome, number: number): Promise<string | undefined> {
    const lastReview = await this.readLastReview()
    if ((await this.noteWorkflow(lastReview, number)) === false) return undefined
    return approvalNote(outcome, lastReview, this.botLogin())
  }

  private async noteWorkflow(lastReview: LastReview | undefined, number: number): Promise<WorkflowState> {
    try {
      const readConfig = async () => this.repositoryConfig(await this.currentPullRequest())
      return await evaluationWorkflow(lastReview, readConfig, this.env.REQUEST_CHANGES_WORKFLOW)
    } catch (error) {
      logError("command.resolve_failed", { number, step: "workflow", error: errorText(error) })
      return "unknown"
    }
  }

  private async summarize(call: CommandCall): Promise<void> {
    const outcome = await this.summaryOutcome(call)
    await this.respond(call.github, call.key, call.incoming, summaryReply(outcome, this.botLogin()))
  }

  private async summaryOutcome({ key, incoming }: CommandCall): Promise<SummaryOutcome> {
    try {
      return await this.startSummary(incoming.deliveryId)
    } catch (error) {
      logError("summary.failed", { number: key.number, reason: errorText(error) })
      return unusableSummary(errorText(error))
    }
  }

  private async startSummary(deliveryId: string): Promise<SummaryOutcome> {
    const pr = await this.currentPullRequest()
    if (pr.state !== "open") {
      log("summary.skip", { reason: "not_open", state: pr.state, number: pr.number })
      return { kind: "closed" }
    }
    if (await this.summaryInFlight()) {
      log("summary.skip", { reason: "in_progress", head: shortSha(pr.head.sha), number: pr.number })
      return { kind: "busy" }
    }
    return this.summarizeOnce(pr, deliveryId)
  }

  private async summaryInFlight(): Promise<boolean> {
    const record = await this.readSummarizing()
    const running = record !== undefined && (await this.summaryOperationListed(record.operationId))
    return summaryLive(record, { running, now: Date.now() })
  }

  private async summaryOperationListed(operationId: string): Promise<boolean> {
    const session = await this.storedSessionId("summarySession")
    if (session === undefined) return false
    const operations = await this.harness.pending({ session })
    return operations.some((operation) => operation.operationId === operationId)
  }

  private async summarizeOnce(pr: PullRequestInfo, deliveryId: string): Promise<SummaryOutcome> {
    const run = { deliveryId, operationId: `summary:${deliveryId}:${pr.head.sha}`, started: Date.now() }
    await this.ctx.storage.put<Summarizing>("summarizing", run)
    try {
      return await this.runSummary(pr, run)
    } finally {
      await this.releaseSummarizing(deliveryId)
    }
  }

  private async releaseSummarizing(deliveryId: string): Promise<void> {
    if ((await this.readSummarizing())?.deliveryId === deliveryId) await this.ctx.storage.delete("summarizing")
  }

  private async restartSummaryGrace(deliveryId: string): Promise<void> {
    const record = await this.readSummarizing()
    if (record?.deliveryId === deliveryId) {
      await this.ctx.storage.put<Summarizing>("summarizing", { ...record, started: Date.now() })
    }
  }

  private async runSummary(pr: PullRequestInfo, run: Summarizing): Promise<SummaryOutcome> {
    const selection = await this.summaryFiles(pr)
    const { read, changed, reviewable } = selection
    if (everyFileFiltered(changed, read.config.reviews.path_filters)) {
      log("summary.skip", {
        reason: "path_filters",
        head: shortSha(pr.head.sha),
        number: pr.number,
        config: configStatus(read),
      })
      return { kind: "filtered" }
    }
    const issues = await this.linkedIssues(pr)
    const written = await this.askForSummary(pr, reviewable, issues, run.operationId)
    await this.restartSummaryGrace(run.deliveryId)
    if (written.kind === "unusable") {
      logError("summary.failed", { number: pr.number, head: shortSha(pr.head.sha), reason: written.reason })
      return unusableSummary(written.reason)
    }
    const now = await this.currentPullRequest()
    if (now.head.sha !== pr.head.sha) {
      log("summary.superseded", { number: pr.number, was: shortSha(pr.head.sha), now: shortSha(now.head.sha) })
      return { kind: "moved", from: pr.head.sha, to: now.head.sha }
    }
    return this.postSummary(pr, selection, issues, written.summary, run.started)
  }

  private async summaryFiles(pr: PullRequestInfo): Promise<SummaryFiles> {
    const read = await this.repositoryConfig(pr)
    const key = await this.key()
    const changed = await (await this.github()).listPullRequestFiles(key, key.number)
    return { read, changed, reviewable: reviewableFiles(changed, read.config.reviews.path_filters) }
  }

  private async askForSummary(
    pr: PullRequestInfo,
    files: readonly ChangedFile[],
    issues: readonly LinkedIssue[],
    operationId: string,
  ): Promise<WrittenSummary> {
    const session = await this.sessionAt("summarySession")
    await this.configureSkillSession(session, {
      skill: "summary",
      reference: MERGE_DANGER_REFERENCE,
      tools: { extensions: [], modelTools: [] },
      model: this.reviewModel(),
    })
    const result = await session.prompt(summaryPrompt(pr, files, issues), { operationId })
    if (result.status !== "done") return { kind: "unusable", reason: describeFailure(result) }
    return parseWrittenSummary(result.text ?? "")
  }

  private async sessionAt(key: SessionKey): Promise<PiSession> {
    const stored = await this.storedSessionId(key)
    if (stored !== undefined) return this.harness.session(stored)
    const session = await this.harness.sessions.create()
    await this.ctx.storage.put(key, session.id)
    return session
  }

  private async storedSessionId(key: SessionKey): Promise<string | undefined> {
    const stored = await this.ctx.storage.get(key)
    return Value.Check(StoredSessionId, stored) ? stored : undefined
  }

  private async configureSkillSession(session: PiSession, setup: SkillSetup): Promise<void> {
    const { source } = await bundledSkills()
    const skill = await loadSkill(source, setup.skill)
    const reference = await loadReference(source, "review", setup.reference)
    await session.reset()
    const conversation = await this.harness.conversation(session.id)
    await conversation.configure(
      {
        instructions: renderSkillWithResources(skill, [reference]),
        thinkingLevel: reviewThinkingLevel(this.env.REVIEW_THINKING_LEVEL),
        ...setup.tools,
      },
      BACKGROUND_CONTEXT,
    )
    await session.setModel(setup.model)
  }

  private async postSummary(
    pr: PullRequestInfo,
    { read, changed, reviewable }: SummaryFiles,
    issues: readonly LinkedIssue[],
    answer: SummarySubmissionInput,
    started: number,
  ): Promise<SummaryOutcome> {
    const reviewed = await this.readReviewed()
    const summary = await this.storeSummary(reviewed, answer, reviewable)
    await this.upsertSummary(
      renderSummaryRun({
        botLogin: this.botLogin(),
        headSha: pr.head.sha,
        verdict: recordedVerdict(await this.readLastReview(), reviewed, pr.head.sha),
        summary,
        model: this.env.REVIEW_MODEL,
        skillsFingerprint: (await bundledSkills()).fingerprint,
        linkedIssues: issues.map(({ number }) => number),
        configError: read.error,
        closes: closesBlockOf(pr),
      }),
    )
    log("summary.posted", {
      number: pr.number,
      head: shortSha(pr.head.sha),
      files: changed.length,
      filesFiltered: changed.length - reviewable.length,
      config: configStatus(read),
      model: this.env.REVIEW_MODEL,
      ms: Date.now() - started,
    })
    return { kind: "posted", head: pr.head.sha, link: await this.summaryCommentUrl() }
  }

  private async storeSummary(
    reviewed: ReviewedRecord | undefined,
    answer: SummarySubmissionInput,
    files: readonly ChangedFile[],
  ): Promise<SummarySubmissionInput> {
    if (reviewed === undefined) return unrecordedSummary(answer, files)
    const record = summarizedRecord(reviewed, answer, files)
    await this.ctx.storage.put<ReviewedRecord>("reviewed", record)
    return {
      summary: record.summary,
      walkthrough: record.walkthrough,
      merge_danger: record.merge_danger,
    }
  }

  private async readSummarizing(): Promise<Summarizing | undefined> {
    const stored = await this.ctx.storage.get("summarizing")
    return Value.Check(Summarizing, stored) ? stored : undefined
  }

  private async evaluateWithRecheck(
    trigger: ApprovalTrigger,
    deliveryId: string,
    attempt: number,
  ): Promise<{ outcome: ApprovalOutcome; recheck: Recheck | undefined }> {
    const outcome = await this.evaluateApproval(trigger, deliveryId)
    const recheck = nextRecheck(trigger, outcome, attempt)
    if (recheck === undefined) return { outcome, recheck }
    const scheduled = this.scheduledRecheck()
    if (!ownsRecheck(trigger, deliveryId, scheduled)) {
      log("approval.recheck_yielded", { delivery: deliveryId, to: scheduled?.delivery })
      return { outcome, recheck }
    }
    await this.lifecycle.jobs.push({
      id: RECHECK_JOB,
      fn: RECHECK_JOB,
      time: Date.now() + recheck.inMs,
      payload: { attempt: recheck.attempt, delivery: deliveryId } satisfies RecheckJob,
    })
    log("approval.recheck_scheduled", {
      number: (await this.key()).number,
      delivery: deliveryId,
      attempt: recheck.attempt,
      inMs: recheck.inMs,
    })
    return { outcome, recheck }
  }

  private scheduledRecheck(): RecheckJob | undefined {
    const payload = this.lifecycle.jobs.get(RECHECK_JOB)?.payload
    return Value.Check(RecheckJob, payload) ? payload : undefined
  }

  private async evaluateApproval(
    trigger: ApprovalTrigger,
    deliveryId: string | undefined,
    resolved: ReadonlySet<string> = new Set(),
  ): Promise<ApprovalOutcome> {
    try {
      const pr = await this.currentPullRequest()
      const decision = decideApproval(await this.approvalState(pr, resolved))
      const context = { number: pr.number, head: shortSha(pr.head.sha), trigger, delivery: deliveryId }
      if (decision.kind === "wait" && decision.reason === "approved") await this.reconcileApproval()
      if (decision.kind === "wait") return waited(context, decision.reason)
      return await this.approve(pr.head.sha, context)
    } catch (error) {
      logError("approval.failed", { trigger, delivery: deliveryId, error: errorText(error) })
      return { kind: "failed", transient: isTransient(errorOf(error)) }
    }
  }

  private async currentPullRequest(): Promise<PullRequestInfo> {
    const key = await this.key()
    return (await this.github()).getPullRequest(key, key.number)
  }

  private async approvalState(pr: PullRequestInfo, resolved: ReadonlySet<string>): Promise<ApprovalState> {
    const lastReview = await this.readLastReview()
    return {
      workflow: await evaluationWorkflow(
        lastReview,
        () => this.repositoryConfig(pr),
        this.env.REQUEST_CHANGES_WORKFLOW,
      ),
      paused: await this.isPaused(),
      open: pr.state === "open" && pr.draft !== true,
      reviewInFlight: (await this.readPending()) !== undefined,
      headSha: pr.head.sha,
      reviewedHead: (await this.readReviewed())?.headSha,
      lastReview,
      openBlocking: openBlockingIn(await this.threadPlan(pr, "fresh", new Map<string, MarkedLines>(), []), resolved),
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

  private async approve(head: string, context: ApprovalContext): Promise<ApprovalOutcome> {
    if (this.#approving.has(head)) return waited(context, "approving")
    this.#approving.add(head)
    try {
      return await this.submitApproval(head, context)
    } finally {
      this.#approving.delete(head)
    }
  }

  private async submitApproval(head: string, context: ApprovalContext): Promise<ApprovalOutcome> {
    if ((await this.currentPullRequest()).head.sha !== head) return waited(context, "head_moved")
    if ((await this.readLastReview())?.event === "APPROVE") return waited(context, "approved")
    const key = await this.key()
    const review = await (
      await this.github()
    ).createReview(key, key.number, {
      commit_id: head,
      event: "APPROVE",
      body: approvalBody(head),
      comments: [],
    })
    await this.ctx.storage.put<LastReview>(
      "lastReview",
      approvalRecord(await this.readLastReview(), review.id, head, Date.now()),
    )
    await this.rewriteSummaryVerdict(head)
    await this.markPostedApproved(head)
    log("approval.posted", { ...context, review: review.id })
    return { kind: "approved", head }
  }

  private async reconcileApproval(): Promise<void> {
    const last = await this.readLastReview()
    if (last?.event === "APPROVE") await this.markPostedApproved(last.headSha)
  }

  private async markPostedApproved(head: string): Promise<void> {
    const stored = await this.ctx.storage.get(`posted:${head}`)
    if (!Value.Check(PostedReview, stored)) return
    const posted = approvedPostedIfNeeded(stored)
    if (posted === undefined) return
    await this.ctx.storage.put<PostedReview>(`posted:${head}`, posted)
    if (posted.checkRunId === undefined) return
    try {
      const key = await this.key()
      const update = approvedCheckRun(posted, await this.summaryCommentUrl(), Date.now())
      await (await this.github()).updateCheckRun(key, posted.checkRunId, update)
    } catch (error) {
      logError("approval.check_run_failed", {
        head: shortSha(head),
        checkRunId: posted.checkRunId,
        error: errorText(error),
      })
    }
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
      softenUnlessTransient(errorOf(error))
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
    this.#runs.start()
    try {
      await this.harness.session().setModel(this.reviewModel())
      const operationId = `chat:${incoming.deliveryId}`
      const skill = renderActivatedSkill(await loadSkill((await bundledSkills()).source, "answer"))
      const prompt = incoming.thread
        ? threadAnswerPrompt(incoming.author, text, skill, await this.#threadQuestion(incoming.thread, thread))
        : answerPrompt(incoming.author, text, skill)
      const answering = incoming.thread ? startAnswering(thread, this.botLogin(), incoming.deliveryId) : undefined
      if (answering !== undefined) this.#answers.set(incoming.deliveryId, answering)
      const result = await this.harness.prompt(prompt, { operationId })
      const answer =
        result.status === "done" && result.text?.trim()
          ? result.text.trim()
          : `I could not answer that: ${
              result.status === "done"
                ? "the model returned nothing"
                : describeFailure(result, await this.storedFailureDetail(operationId))
            }.`
      await this.#replyUnlessClosed(github, key, incoming, `@${incoming.author} ${answer}`, answering)
    } finally {
      this.#answers.delete(incoming.deliveryId)
      await this.#runs.end(key.number, "answer_end")
    }
  }

  async #threadQuestion(context: ThreadContext, thread: ReviewThread | undefined): Promise<ThreadQuestion> {
    const pr = await this.#headForAnswer()
    const finding = (await this.storedFindings([context.rootId])).get(context.rootId)
    return {
      path: context.path,
      line: context.line,
      diffHunk: context.diffHunk,
      opening: thread?.firstCommentBody,
      severity: finding?.severity,
      title: finding?.title,
      headSha: pr.head.sha,
    }
  }

  async #headForAnswer(): Promise<PullRequestInfo> {
    try {
      return await this.currentPullRequest()
    } catch (cause) {
      softenUnlessTransient(errorOf(cause))
      logError("answer.head_unreadable", { error: errorText(cause) })
      return this.pullRequest()
    }
  }

  async #replyUnlessClosed(
    github: GitHubClient,
    key: PullRequestKey,
    incoming: CommentIncoming,
    body: string,
    answering: Answering | undefined,
  ): Promise<void> {
    if (answering !== undefined && !answering.resolved) {
      const live = await this.threadFor(github, key, incoming.thread)
      if (live?.resolved) {
        log("answer.skipped", { number: key.number, thread: answering.thread.id, reason: "thread_resolved" })
        return
      }
    }
    await this.respond(github, key, incoming, body)
    if (answering?.resolved) {
      await this.evaluateApproval("resolve", incoming.deliveryId, new Set([answering.thread.id]))
    }
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
    const commentId = await this.findSummaryComment()
    const line = await this.shownPausedLine()
    const shown = line === undefined ? body : withPausedLine(body, line)
    if (commentId !== undefined) {
      try {
        await github.updateIssueComment(ref, commentId, shown)
        await this.ctx.storage.put("summaryCommentId", commentId)
        return
      } catch (error) {
        console.warn("andabot: summary comment update failed, creating a new one", error)
      }
    }
    const created = await github.createIssueComment(ref, key.number, shown)
    await this.ctx.storage.put("summaryCommentId", created.id)
  }

  private async findSummaryComment(): Promise<number | undefined> {
    const stored = await this.summaryCommentId()
    if (stored !== undefined) return stored
    const key = await this.key()
    const comments = await (await this.github()).listIssueComments(key, key.number)
    return comments.find((comment) => comment.body?.startsWith(SUMMARY_MARKER))?.id
  }

  private async shownPausedLine(): Promise<string | undefined> {
    if (!(await this.isPaused())) return undefined
    return pausedLine(await this.pausedBy(), this.botLogin())
  }

  private async pausedBy(): Promise<string | undefined> {
    const stored = await this.ctx.storage.get("pausedBy")
    return Value.Check(PausedBy, stored) ? stored : undefined
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
    await this.#sandbox.dropIdle("review_end")
    if (pending.checkRunId !== undefined) await this.completeCheckRun(pending.checkRunId, pending, update)
  }

  private async failedRun(note: string): Promise<UpdateCheckRun> {
    return failedCheckRun(note, await this.summaryCommentUrl(), Date.now())
  }

  private noteChangesSinceMissing(pr: PullRequestInfo, missing: boolean): void {
    if (missing) log("review.changes_since_missing", { number: pr.number, head: shortSha(pr.head.sha) })
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
    if (!(await this.ownsPending(deliveryId))) return
    await this.ctx.storage.delete(["pending", "scope"])
    await this.#sandbox.dropIdle("review_end")
  }

  private async restartGrace(deliveryId: string): Promise<void> {
    const pending = await this.pendingFor(deliveryId)
    if (pending) await this.ctx.storage.put<PendingReview>("pending", { ...pending, started: Date.now() })
  }

  private async runningRootOperation(): Promise<string | undefined> {
    const running = (await this.harness.pending({ session: ROOT_SESSION })).find((op) => op.status === "running")
    return running?.operationId
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

const RECHECK_JOB = "approval.recheck"

const NO_DELIVERY = ""

const SANDBOX_DROP_JOB = "sandbox.drop"

const MAX_LOGGED_TEXT_CHARS = 8_000
const MOST_KEYS_PER_GET = 128

function withOptionalPostedFields(
  posted: PostedReview,
  sandboxSeconds: number | undefined,
  checks: ChecksDisplay | undefined,
  checkRunId: number | undefined,
): void {
  if (sandboxSeconds !== undefined) posted.sandboxSeconds = sandboxSeconds
  if (checks !== undefined) posted.checks = [...checks.runs]
  if (checkRunId !== undefined) posted.checkRunId = checkRunId
}

function openedAt(pending: PendingReview): number {
  return pending.openedAt ?? pending.started
}

function docsSearchOf(kind: SearchAccess["kind"]): DocsSearch {
  if (kind === "ready") return "ready"
  return kind === "spent" ? "spent" : "unavailable"
}

function basisContextOf(pending: PendingReview): BasisContext {
  return {
    hasLinkedIssues: (pending.linkedIssues?.length ?? 0) > 0,
    instructionFiles: pending.instructionFiles ?? [],
    activatedSkills: pending.activated ?? [],
    docs: pending.docs ?? [],
  }
}

function promptFor(
  pr: PullRequestInfo,
  files: readonly ChangedFile[],
  scope: ReviewScope,
  since: readonly ChangedFile[],
  issues: readonly LinkedIssue[],
  omitted: readonly OmittedRequirementInput[],
  docs: DocsSections,
): string {
  if (scope.mode === "fresh") return reviewPrompt(pr, files, true, issues, docs)
  const lists = threadLists(scope.open, scope.recheck)
  if (scope.mode === "full" || scope.from === undefined) return fullPrompt(pr, files, lists, issues, docs)
  return incrementalPrompt(pr, {
    from: scope.from,
    marked: coveredMap(scope),
    ...promptFiles(files, since, scope),
    ...lists,
    issues,
    omitted,
    docs,
  })
}

function requestedReview(call: CommandCall, headSha: string, full: boolean): ReviewIncoming {
  return {
    kind: "review",
    key: call.key,
    deliveryId: call.incoming.deliveryId,
    headSha,
    full,
    requestedBy: call.incoming.author,
  }
}

function coverageOf(scope: ReviewScope, headSha: string, resolved: number): Coverage {
  const coverage = { mode: scope.mode, to: headSha, files: scope.covered.length, resolved }
  return scope.from === undefined ? coverage : { ...coverage, from: scope.from }
}

function waited(context: ApprovalContext, reason: WaitReason): ApprovalOutcome {
  log("approval.decided", { ...context, decision: "wait", reason })
  return { kind: "wait", reason }
}

function waitReasonOf(outcome: ApprovalOutcome): WaitReason | undefined {
  return outcome.kind === "wait" ? outcome.reason : undefined
}

function retryOutcome(failure: string | undefined, refusal: string | undefined): RetryOutcome {
  if (failure !== undefined) return { kind: "failed", reason: failure }
  if (refusal !== undefined) return { kind: "refused", refusal }
  return { kind: "unanswered" }
}

const NOT_IN_FLIGHT_REFUSAL = "Not posted: this call is not the review in flight for this head. Stop here."

const MERGE_DANGER_REFERENCE = "references/merge-danger.md"

const SEVERITY_REFERENCE = "references/severity.md"

const REPLACED_BEFORE_ATTEMPT = {
  kind: "failed",
  failure: "model",
  reason: "the review was replaced before this attempt",
} as const

function verifyFields({ pr, model }: VerifyRun) {
  return { number: pr.number, head: shortSha(pr.head.sha), model }
}

function unusableSummary(reason: string): SummaryOutcome {
  return { kind: "unusable", reason: oneClause(reason) }
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
