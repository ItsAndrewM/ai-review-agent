import type { ExpectedFinding, HeadCase, KnownFinding } from "./schema.ts"

export interface Case {
  pr: number
  head: string
  base?: string
  expects: ExpectedFinding[]
  verdict: HeadCase["verdict"]
  summary?: string
  allowed: KnownFinding[]
  knownFalse: KnownFinding[]
  note?: string
}

type Expectation = Omit<ExpectedFinding, "id">

function expects(pr: number, findings: readonly Expectation[]): ExpectedFinding[] {
  return findings.map((finding, index) => ({ id: `${pr}-${index + 1}`, ...finding }))
}

const RESUBMIT_COLLISION =
  "endsWith|RESUBMIT_REQUEST|resubmi(t|ssion) (prompt|request).*(comment|user)|user (comment|text).*(resubmit|retry|JSON)|chat.*(json|JSON)"

export const cases: readonly Case[] = [
  {
    pr: 87,
    head: "046afadb037b16aba4b098170b3c80afcc9f2fc2",
    expects: expects(87, [
      {
        path: "src/pull-request.ts",
        lines: [1665, 1673],
        severity: "blocking",
        basis_kind: "defect",
        scenario:
          "A re-check reads GitHub while a later suite's completion restarts the chain; when the older re-check finishes it pushes its next attempt under the one job id and replaces the newer chain's scheduled first attempt.",
        pattern:
          "(newer|later|another|second|new|different) (chain|suite|completion|delivery).*(replac|overwrit|clobber|lost|drop|cancel)|(replac|overwrit|clobber|cancel).*(newer|later|another|new|different) (chain|suite|completion|delivery)|same (job )?id.*(race|replac|overwrit|collid)|RECHECK_JOB.*(race|replac|overwrit)|(older|stale|earlier) re-?check.*(push|schedul|replac)",
        evidence: "CodeRabbit's Major on #87, fixed in 0383d8d (ownsRecheck)",
      },
    ]),
    verdict: "request_changes",
    allowed: [],
    knownFalse: [],
  },
  {
    pr: 102,
    head: "7c2b870063bc67970c316a0aac48fb3c00472a39",
    expects: expects(102, [
      {
        path: "src/repository/tar.ts",
        lines: [87, 98],
        severity: "suggestion",
        basis_kind: "defect",
        scenario:
          "paxRecord accepts a record whose field holds no `=`, so a malformed pax header such as `8 pathX\\n` passes as a field instead of throwing malformedPax.",
        pattern:
          'key=value|key.value|["\'`]=["\'`]|equals sign|without an? =|no =|missing =|contains? an? =|includes\\("="\\)|malformed.*(accept|pass)',
        evidence: "CodeRabbit on #102, fixed in ea459f0",
      },
    ]),
    verdict: "comment",
    allowed: [],
    knownFalse: [],
  },
  {
    pr: 66,
    head: "89a836a4f23f69cd566a675752c58c881a8fddf3",
    expects: expects(66, [
      {
        path: "src/review/cost.ts",
        lines: [113, 118],
        severity: "suggestion",
        basis_kind: "defect",
        scenario:
          "priceText compares the unpriced list with the count of every model, not with the models that reported tokens, so a priced model with no tokens beside an unpriced one with tokens prints a price instead of cost unknown.",
        pattern:
          "unpriced.*(every|all|each) model|(every|all|each) models?.*unpriced|models? (with|without|that reported) (no )?tokens|cost unknown.*(when|although|even|only)|unpriced\\.length === models|spend\\.length",
        evidence: "CodeRabbit on #66, fixed in db79804",
      },
    ]),
    verdict: "comment",
    allowed: [],
    knownFalse: [
      {
        id: "66-f1",
        path: "src/review/cost.ts",
        pattern: "priced.*conflat|ledger has dollars|flag that means|conflates",
        note: "#31 audit: the priced-name criticism (4341994189) is false",
      },
    ],
  },
  {
    pr: 56,
    head: "0ddf0b08106b99b916d7623ff1c85b7b417c420e",
    expects: expects(56, [
      {
        path: "src/review/findings.ts",
        lines: [76, 79],
        severity: "nitpick",
        basis_kind: "spec",
        scenario:
          "The summary's description asks to name each omitted requirement but not in the issue's own words, so the model paraphrases and the omission can't be matched back to the issue.",
        pattern: "issue'?s? (own )?words|in the issue'?s|quote.*(issue|requirement)|verbatim|paraphras",
        evidence: "CodeRabbit on #56, fixed in 34a54f4",
      },
    ]),
    verdict: "comment",
    allowed: [],
    knownFalse: [],
  },
  {
    pr: 65,
    head: "2d32ec31c694e1b644c5cda0ef3bddbfe153784a",
    expects: expects(65, [
      {
        path: "docs/superpowers/specs/2026-10-17-skills-design.md",
        lines: [3, 151],
        severity: "nitpick",
        basis_kind: "standard",
        scenario:
          "Section D is marked decided, while lines 3, 24, 32, 39 and 151 still call the slice deferred or provisional and list the config file as a non-goal.",
        pattern: "deferred|provisional|out of date|contradict|stale|non-goal|still (say|describ|list|mark|call)",
        evidence: "CodeRabbit on #65, resolved on the thread",
      },
      {
        path: "src/review/render.ts",
        lines: [148, 148],
        severity: "nitpick",
        basis_kind: "standard",
        scenario:
          "standardsLine wraps untrusted paths in backticks without escaping one, so a backtick in a path ends the code span early.",
        pattern: "backtick|code span|escap",
        evidence: "andabot's finding 4338910273 on #65, judged valid by the audit and fixed",
      },
    ]),
    verdict: "comment",
    allowed: [],
    knownFalse: [],
  },
  {
    pr: 91,
    head: "64d6ba67ef774739ad9e7fe06803af23156fc249",
    expects: expects(91, [
      {
        path: "src/pull-request.ts",
        lines: [1738, 1740],
        severity: "suggestion",
        basis_kind: "defect",
        scenario:
          "With no reviewed record, storeSummary returns the answer unchanged, so a walkthrough row the model wrote for a filtered file renders although path_filters leave that file out.",
        pattern:
          "walkthrough.*(filter|reviewable|left out)|filtered.*(walkthrough|row)|rows?.*filtered|path_filters.*(walkthrough|row)",
        evidence: "CodeRabbit on #91, open as #119",
      },
    ]),
    verdict: "comment",
    allowed: [],
    knownFalse: [],
  },
  {
    pr: 105,
    head: "fd543e1b93e57e0d46bd4d73ff929033693579c0",
    expects: expects(105, [
      {
        path: "src/repository/context.ts",
        lines: [118, 131],
        severity: "nitpick",
        basis_kind: "defect",
        scenario:
          "carriedBodies carries a donor entry stored without a mode, so a symlink recorded before modes were kept carries its target's body under an unchanged blob sha.",
        pattern: "mode|symlink.*(donor|carr|record)|(donor|carried).*symlink|before (the )?modes",
        evidence: "CodeRabbit on #105, open; the audit judged it contrived",
      },
    ]),
    verdict: "comment",
    allowed: [],
    knownFalse: [],
    note: "contrived",
  },
  {
    pr: 112,
    head: "735a1162d1755296352628da81ca5884c265f408",
    expects: expects(112, [
      {
        path: "docs/design.md",
        lines: [134, 134],
        severity: "nitpick",
        basis_kind: "standard",
        scenario:
          "design.md says a symlinked skill file is never loaded, but a skill's CLAUDE.md is also a nested instruction file the standards path still reads.",
        pattern:
          "never loaded|instruction file|nested CLAUDE|as (a )?skill file|still (be )?(read|loaded)|overstate|too (broad|strong)",
        evidence: "CodeRabbit on #112, open",
      },
      {
        path: "docs/superpowers/plans/2026-10-24-symlinked-skill-files.md",
        lines: [78, 84],
        severity: "nitpick",
        basis_kind: "standard",
        scenario:
          "The plan's steps keep a symlinked SKILL.md discoverable and cap it in stateOf, while the delivered code removes it before discovery, so a worker following the plan would let it shadow a regular skill.",
        pattern:
          "stateOf|discover|before discovery|plan.*(match|describe|deliver|dropped|differ)|steps?.*(dropped|no longer|differ|match)",
        evidence: "CodeRabbit on #112, open",
      },
    ]),
    verdict: "comment",
    allowed: [],
    knownFalse: [],
  },
  {
    pr: 66,
    head: "b5b9d4732d3d1dd72a20e1b7da95395e6fd5fec9",
    expects: [
      {
        id: "66-k1",
        path: "src/review/cost.ts",
        lines: [130, 134],
        severity: "suggestion",
        basis_kind: "defect",
        scenario:
          "The dollar delta is clamped to 0 on float rounding, and isUnpriced reads usd 0 as no price, so a priced model is labelled unpriced.",
        pattern: "clamp|unpriced.*(zero|\\b0\\b)|usd === 0|rounding|float",
        evidence: "andabot's finding 4338905683 on #66, judged valid by the audit and fixed",
      },
      {
        id: "66-k2",
        path: "src/review/cost.ts",
        lines: [46, 50],
        severity: "suggestion",
        basis_kind: "spec",
        scenario:
          "#32 asks for a price table in code with the pricing page as its source; the code reads pi-ai's registry instead.",
        pattern: "price table|pricing page|registry|catalog.*(issue|#32)|#32.*(table|source)",
        evidence: "andabot's finding 4338905689 on #66, judged valid by the audit",
      },
      {
        id: "66-k3",
        path: "src/pull-request.ts",
        lines: [905, 925],
        severity: "suggestion",
        basis_kind: "test",
        scenario:
          "The unreadable-ledger paths (usage_unreadable, the empty return, spendOf with no baseline) ship without a test.",
        pattern: "unreadable|usage_unreadable|ledger.*(test|untested)|without a test|no test|untested",
        evidence: "andabot's finding 4338905701 on #66, judged valid by the audit and fixed",
      },
    ],
    verdict: "comment",
    allowed: [],
    knownFalse: [],
  },
  {
    pr: 88,
    head: "d320027d229ae367e6027ec571af591b2ff71f58",
    expects: [
      {
        id: "88-k1",
        path: "src/review/tools.ts",
        lines: [90, 100],
        severity: "suggestion",
        basis_kind: "spec",
        scenario:
          '#30 asks for replay: "safe" on grep and tree; the code ships them unsafe without the issue being updated.',
        pattern: "replay.*safe|unsafe|replay:",
        evidence: "andabot's finding 4361057856 on #88, judged valid by the audit",
      },
      {
        id: "88-k2",
        path: "src/repository/snapshot-host.ts",
        lines: [100, 106],
        severity: "suggestion",
        basis_kind: "defect",
        scenario:
          "access counts the call before checking the remembered failure, so a retry after an unavailable search burns one of the 40 calls without reaching grep or tree.",
        pattern:
          "(budget|call).*(consum|count|charg|burn|spent).*(fail|unavailab)|(fail|unavailab).*(consum|count|charg|burn|spent).*(budget|call)|40 calls|counted before",
        evidence: "andabot's finding 4361057868 on #88, judged valid by the audit and fixed",
      },
    ],
    verdict: "comment",
    allowed: [],
    knownFalse: [],
  },
  {
    pr: 57,
    head: "d35a04eb338847ed11efb2d6edbf100102a5db6b",
    expects: [
      {
        id: "57-k1",
        path: "src/review/check.ts",
        lines: [55, 62],
        severity: "nitpick",
        basis_kind: "defect",
        scenario:
          "The check run's summary promises a Details link even when detailsUrl is undefined, so the reader is told to open a link that isn't there.",
        pattern: "Details|details_url|detailsUrl|summary comment.*(undefined|missing)",
        evidence: "andabot's finding 4331323993 on #57, judged valid by the audit and fixed",
      },
    ],
    verdict: "comment",
    allowed: [],
    knownFalse: [],
  },
  {
    pr: 71,
    head: "358ed2b0874c89f0bc9b724b0ecada1d9141173b",
    expects: [
      {
        id: "71-k1",
        path: "src/pull-request.ts",
        lines: [330, 340],
        severity: "nitpick",
        basis_kind: "defect",
        scenario:
          "pathFilters feeds any stored scope into filtersInForce without checking a review is in flight, so a later chat turn marks files filtered under the last review's filters.",
        pattern:
          "stored scope|scope.*(stale|in flight|finished|deliveryId|previous|last review)|filtersInForce|last review'?s filters",
        evidence: "andabot's finding 4344021661 on #71, judged valid by the audit and fixed",
      },
    ],
    verdict: "comment",
    allowed: [],
    knownFalse: [],
  },
  {
    pr: 9,
    head: "eccf31d364a1fcd4d9987e8c7b5136813ff7c349",
    expects: expects(9, [
      {
        path: "src/github/diff.ts",
        lines: [32, 32],
        severity: "blocking",
        basis_kind: "defect",
        scenario:
          "A pre-increment on newLine numbers every added line one past its real line, so every RIGHT anchor is off by one.",
        pattern:
          "off.by.one|\\+\\+newLine|pre-?increment|line number.*(shift|wrong|one|misnumber)|misnumber|anchor.*(wrong|shift|off)|one (line )?(too )?(high|late|ahead)",
        evidence: "answer key on #2 (b4e819f)",
      },
      {
        path: "src/github/client.ts",
        lines: [86, 86],
        severity: "blocking",
        basis_kind: "defect",
        scenario: "Every non-OK status, not only 404, returns undefined, so a 500 or a 403 reads as a missing file.",
        pattern:
          "swallow|non-?404|every (error|status|failure)|any (error|failure|status).*(undefined|missing|not found)|(5\\d\\d|500|403|401|rate).*(undefined|missing file|not found)|silently",
        evidence: "answer key on #2 (2c58015)",
      },
      {
        path: "src/pull-request.ts",
        lines: [179, 179],
        severity: "blocking",
        basis_kind: "defect",
        scenario: "A storage write is not awaited, so the review record can be lost and a rejection is unhandled.",
        pattern: "await|floating promise|unawaited|fire-and-forget|not waited",
        evidence: "answer key on #2 (810e304)",
      },
      {
        path: "src/version.ts",
        lines: [14, 14],
        severity: "blocking",
        basis_kind: "defect",
        scenario: "The comparison is inverted, so a build is called stale exactly when it is newer.",
        pattern:
          "invert|revers|backward|wrong way|flipped|stale.*(newer|older)|(newer|older).*stale|should be <|should be >|opposite",
        evidence: "answer key on #2 (d579dc0)",
      },
      {
        path: "src/pull-request.ts",
        lines: [200, 204],
        severity: "suggestion",
        basis_kind: "defect",
        scenario:
          "The superseded-head guard is deleted, so a stale event starts a review on a head the pull request has moved past.",
        pattern:
          "supersed|stale (event|head|delivery)|head.*(moved|changed|match|differ)|guard|older (event|head)|out-?of-?date head|trusted",
        evidence: "answer key on #2 (eccf31d)",
      },
    ]),
    verdict: "request_changes",
    allowed: [],
    knownFalse: [],
  },
  {
    pr: 38,
    head: "d1bd6f79cd89367bd5e4589dc34ad6fd94e75b1e",
    expects: expects(38, [
      {
        path: "src/pull-request.ts",
        lines: [460, 468],
        severity: "blocking",
        basis_kind: "defect",
        scenario:
          "postedRetryText answers a boolean, so the host's refusal of the retry's JSON is only logged; reportUnpostedReview then posts a summary that never says why the review was not posted.",
        pattern:
          "refusal.*(drop|lost|never|not (shown|returned|passed|reported|surfaced)|discard|swallow|only logged)|(drop|lose|loses|lost|discard).*refusal|postedRetryText.*(boolean|refus)|reportUnpostedReview.*(refus|reason)|why.*(not posted|wasn't posted|unposted)",
        evidence: "answer key on #2 (the #38 baseline: the refusal is dropped)",
      },
    ]),
    verdict: "request_changes",
    allowed: [],
    knownFalse: [
      {
        id: "38-f1",
        path: "src/models.ts",
        pattern: RESUBMIT_COLLISION,
        note: "#31 audit: answerPrompt already protects this path (4330021512)",
      },
      {
        id: "38-f2",
        path: "src/review/prompt.ts",
        pattern: RESUBMIT_COLLISION,
        note: "#31 audit: answerPrompt already protects this path (4330057699)",
      },
      {
        id: "38-f3",
        path: "src/models.ts",
        pattern: "spread.*undefined|undefined.*spread|TypeError",
        note: "#31 audit: spreading undefined does not throw (4318503063)",
      },
      {
        id: "38-f4",
        path: "test/models.test.ts",
        pattern: "duplicat|REVIEW_AS_JSON|drift",
        note: "#31 audit: the test assertion is not a defect (4330057723, 4318356095)",
      },
    ],
  },
  {
    pr: 54,
    head: "b7b89ae8674ee3994a213d571c063aa0f313f280",
    expects: expects(54, [
      {
        path: "src/pull-request.ts",
        lines: [598, 598],
        severity: "blocking",
        basis_kind: "defect",
        scenario: "ms is run.started minus now, so the logged elapsed time is negative.",
        pattern:
          "negat|sign|backward|run\\.started - Date|started - Date\\.now|less than zero|below zero|wrong (order|way)",
        evidence: "answer key on #2 (#50 fixture: the negated ms)",
      },
      {
        path: "src/pull-request.ts",
        lines: [599, 599],
        severity: "suggestion",
        basis_kind: "spec",
        scenario: "#50 asks for one decimal; the code rounds to whole seconds.",
        pattern: "decimal|whole second|tenth|Math\\.round|0\\.1|fraction|precision",
        evidence: "answer key on #2 (#50 fixture: whole seconds)",
      },
    ]),
    verdict: "request_changes",
    summary: "footer",
    allowed: [],
    knownFalse: [],
  },
  {
    pr: 142,
    head: "7476bb2091219903027e268c649d5884ce7e068c",
    expects: expects(142, [
      {
        path: "src/review/cost.ts",
        lines: [162, 172],
        severity: "blocking",
        basis_kind: "defect",
        scenario:
          "Parts with a zero count are dropped, so 3600 s renders 1h instead of 1h 0m 0s and 120 s renders 2m instead of 2m 0s; the pinned test fails.",
        pattern:
          "0m|0s|1h 0m 0s|2m 0s|zero|drop(s|ped)?.*(minute|second|part|unit)|(minute|second|part|unit).*(drop|omit|skip|filter|miss)|count > 0|filter.*count|test.*(fail|expect|pin)|empty string|exactly zero",
        evidence: "#135 fixture, planted test failure",
      },
    ]),
    verdict: "request_changes",
    allowed: [],
    knownFalse: [],
  },
  {
    pr: 143,
    head: "e4b2c96a76d01121a611a8e420a8def70f0d613d",
    expects: expects(143, [
      {
        path: "src/sandbox/checks.ts",
        lines: [28, 31],
        severity: "blocking",
        basis_kind: "defect",
        scenario:
          "checkTimeoutOf now returns undefined for a missing value, but its caller passes the result as a number, so typecheck fails (TS2322) and the default timeout is gone.",
        pattern:
          "undefined|TS2322|type ?check|timeoutMs|default (timeout|value)|caller|not assignable|number \\| undefined",
        evidence: "#135 fixture, planted type error",
      },
    ]),
    verdict: "request_changes",
    allowed: [],
    knownFalse: [],
  },
  {
    pr: 144,
    head: "888044be4988b46e1626a339926a6a29e6187151",
    expects: [],
    verdict: "approve",
    allowed: [],
    knownFalse: [],
    note: "docs only; expects nothing",
  },
  {
    pr: 151,
    head: "b09ae16486985a5d1b5e8c7ab9bc35a362545fd3",
    expects: expects(151, [
      {
        path: "src/sandbox/checks.ts",
        lines: [44, 49],
        severity: "blocking",
        basis_kind: "defect",
        scenario:
          "The `..` segment check is removed from onePathProblem, so a path such as ../secret leaves the repository and the sandbox runs a check on it.",
        pattern: "\\.\\.|parent director|traversal|leaves? the repositor|escape|outside the repo",
        evidence: "#123 fixture, planted at b09ae16 and fixed in 3cf1c47",
      },
    ]),
    verdict: "request_changes",
    allowed: [
      {
        id: "151-a1",
        path: "src/review/cost.ts",
        pattern: "clamp|negative|Math\\.max",
        note: "a correct nitpick on the planted clamp, argued and held on #151",
      },
    ],
    knownFalse: [],
  },
]
