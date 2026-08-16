# PR Comment Feedback Loop — PRD

> **Status:** proposal, not yet signed off. Everything below is a recommendation
> to argue with, unlike `finding-feedback-requirements.md`, whose §5 decisions
> were already confirmed. Engineering detail lives in the companion
> [`pr-comment-feedback-loop-design.md`](./pr-comment-feedback-loop-design.md).

## 1. Problem

GSR posts a finding on a pull request and then stops listening. Whatever the
developer says back — "fixed it", "good catch", "this is a false positive, the
call is intentional" — lands in a GitHub thread nobody on GSR's side ever reads.

Two costs follow from that, and both are already documented with real evidence
in this repo:

- **GSR repeats itself.** `review-quality-design.md` §2 traced a single HIGH
  finding on `job_tracker` PR #17 being re-posted **seven times** across ~45
  minutes — including after the author had added a code comment explaining why
  the flagged call was deliberate. Every run starts from zero knowledge of the
  conversation it already had.
- **GSR never defends a correct finding.** The flip side is worse for trust: a
  developer (or their coding agent) can wave off a genuine CRITICAL with "nah,
  false positive" and GSR has no mechanism to say "actually, here's why it
  isn't." A reviewer that silently folds every time it's contradicted has the
  authority of a linter with a mute button.

`finding-feedback-requirements.md` addresses a related but distinct gap: an
external coding agent **proactively pushing** structured feedback to a new GSR
API endpoint. That's a push mechanism, and it only works for consumers who
integrate with it deliberately. This document covers the **pull** side: GSR
reading the feedback that developers are *already leaving for free*, in the PR
thread, in ordinary English, with zero integration work on their part.

## 2. Primary use case

1. GSR (via the GitHub Action) posts an inline finding on a PR:
   *"HIGH · Logic — `WriteHeader` before `Write` bypasses Content-Type sniffing."*
2. The developer, or an AI coding agent working the PR, replies in that thread:
   either **"fixed in a4b1c2"** or **"disagree — this is deliberate, we set the
   header explicitly two lines up."**
3. The developer pushes another commit. The GSR Action re-runs (this already
   happens today on `synchronize`).
4. Before reviewing the new diff, GSR reads its own threads on that PR and looks
   at what came back:
   - **Accepted** → record the outcome ("finding X was accepted on PR Y, here's
     the developer's words"), and stop re-raising it.
   - **Rejected** → GSR judges the pushback on its merits, using the original
     finding, the reply, and the code as it now stands.
     - If the developer was right → record that GSR was wrong. Say nothing on
       the PR. Stop re-raising it.
     - If the developer was wrong → **reply in that same thread**, once, with a
       concrete rebuttal explaining why the finding still stands.

### 2.1 Secondary use case

The hosted web UI shows a reviewer the state of the conversation on a PR — which
findings were accepted, which were disputed, and how GSR adjudicated the
disputes — without them scrolling GitHub. Read-only in v1 (see §4).

## 3. Goals

| # | Goal | Why it matters |
|---|---|---|
| G1 | GSR notices replies to its own findings on a re-run, on every surface it runs on | The whole feature; today this data is discarded |
| G2 | Accepted findings are recorded with the developer's own words | Raw material for prompt improvement (`finding-feedback-requirements.md` §9.1) — and it's free, unlike a push integration |
| G3 | Disputed findings get an explicit, reasoned GSR verdict | Turns "GSR was contradicted" into a labelled data point: was GSR wrong, or was the developer? |
| G4 | GSR pushes back **once** on a wrong rejection, in-thread, with reasoning | Recovers the credibility a silent fold costs |
| G5 | The conversation terminates. Always. | A bot that argues indefinitely is worse than one that never argues |
| G6 | Identical behaviour and identical code across the Action and the hosted backend | CLAUDE.md's "all surfaces" requirement; the Action is where the real traffic is |
| G7 | Bounded, visible cost | Gemini spend is a stated project constraint; every extra call needs a ceiling |

## 4. Non-goals for v1

- **Answering questions.** A reply like *"why is this a problem in Go?"* is
  neither acceptance nor rejection. v1 records it and stays silent. Turning GSR
  into a conversational Q&A partner on PRs is a bigger product than this.
- **Multi-round debate.** GSR gets exactly one rebuttal per thread, ever. If the
  developer replies again, GSR records it and shuts up. Non-negotiable (G5).
- **Posting replies from the hosted web-UI path.** The hosted `/api/review` flow
  **never posts anything to GitHub today** — only the Action does. Giving the
  backend a write path would mean posting under a human's PAT, i.e. a rebuttal
  that looks like it came from that person. v1's UI surface is read-only:
  same code, same classification, same records, no writes. See the design doc
  §3.2 for why this is the honest reading of G6 rather than a dodge.
- **Cross-PR memory.** "This team always rejects Testing findings" is a real
  insight and explicitly out of scope. Feed it from the records later.
- **Automatically changing prompts.** Same deferral as
  `finding-feedback-requirements.md` §3 — v1 collects, it does not learn.
- **Top-level PR conversation comments.** v1 reads and writes **inline review
  threads** only. Findings that GSR's own fallback path folded into a summary
  issue comment (`github.ts`'s `postReviewComments` batch-failure path) have no
  thread to reply in and are out of scope.
- **Detecting "Resolve conversation" clicks.** That state isn't exposed by the
  REST API GSR already uses. Noted as a strong positive signal to pick up in
  v1.1 (design doc §5.4).

## 5. Success criteria

| Criterion | Target for v1 |
|---|---|
| Termination | **Zero** threads anywhere with more than one GSR rebuttal. Verifiable by inspection, not sampling. |
| Rebuttal quality | In a manual audit of the first 30 rebuttals GSR posts, ≥80% judged "a reasonable thing for a senior reviewer to say", ≤10% judged "GSR was clearly the wrong one here". |
| Conservatism | GSR concedes more often than it argues. If >50% of rejections are adjudicated "developer was wrong", the adjudicator is miscalibrated and the confidence threshold goes up. |
| Repeat-noise reduction | The PR #17 pattern (same finding re-posted 7×) does not recur once markers + accepted-finding suppression ship. |
| Cost | The feedback pass adds <10% to the Gemini cost of a re-run in the typical case, with a hard per-run ceiling (design doc §8). |
| Blast radius | No consuming repo ever gets a GSR reply it didn't opt into — the feature ships off by default. |

## 6. Rollout shape

Three user-visible stages, deliberately ordered so the risky part ships last:

1. **Observe.** GSR reads threads, classifies replies, writes what it found to
   the Action's Job Summary. Posts nothing. This alone answers "how often do
   people actually reply, and what do they say?" — currently unknown.
2. **Respond.** GSR posts rebuttals, capped, opt-in per repo.
3. **Report.** Records ship to the central feedback store defined in
   [`finding-feedback-requirements.md`](./finding-feedback-requirements.md) §7,
   over the same opt-in transport already used for usage reporting.

Stage 1 is worth shipping on its own even if 2 and 3 never happen.

## 7. Relationship to the push-based feedback feature

`finding-feedback-requirements.md` and this document are **two transports onto
one data model**, not competing designs:

|  | Push (`finding-feedback-requirements.md`) | Pull (this doc) |
|---|---|---|
| Trigger | An agent decides to tell GSR something | GSR re-runs and goes looking |
| Coverage | Only consumers who integrate | Every PR GSR already comments on |
| Signal quality | Structured, deliberate, high fidelity | Free-text, inferred, noisier |
| Can GSR respond? | No — it's a write-only ingest | Yes, in-thread. This is the new capability |
| Needs a new secret? | Yes (`FEEDBACK_SHARED_SECRET`) | **No**, for stages 1–2 |

**Is the push endpoint a prerequisite?** No — and this is the main product call
in this document. The pull loop's core behaviour needs no backend, no endpoint
and no secret, because the PR thread itself carries the state (design doc §4).
Building the push endpoint first would delay the useful part behind
infrastructure the useful part doesn't need. But the push doc's *storage
decisions* — one feedback bucket, append-only, self-describing records — are the
right sink for stage 3, and this feature should adopt them rather than invent a
parallel store.

## 8. Open product questions

1. **Should GSR ever concede out loud?** When the adjudicator agrees the
   developer was right, v1 says nothing (keeps PRs quiet). A one-line
   *"agreed, withdrawing this"* would be better manners and a visible trust
   signal. Cheap either way — this is a taste call, not a technical one.
2. **Default posture: opt-in or opt-out?** v1 ships off-by-default (§5, blast
   radius). Once the stage-1 data is in, is "respond" a sane default for the
   Action, or does it stay opt-in permanently for other people's repos?
3. **Does a defended CRITICAL escalate?** GSR can already fail a workflow via
   `fail-on-severity`. Should "developer rejected it, GSR adjudicated the
   rejection wrong, severity is CRITICAL" become a build failure — or is a
   comment always the ceiling? (Recommendation: comment only in v1. A bot that
   can block a merge by disagreeing with you is a different product.)
4. **Tone.** A rebuttal is GSR's most confrontational output. Do we want
   collegial ("worth a second look — here's the case for keeping this") or
   direct ("this is still a bug, and here's the reproduction")? Affects the
   prompt, and it's the thing consumers will judge the feature on.
5. **Whose findings?** v1 only reads threads GSR itself started. Replies to
   *CodeRabbit's* or *gemini-code-assist's* findings are visible in the same API
   response and deliberately ignored. Is there ever a reason to want them?
6. **Question-shaped replies.** §4 defers these. If stage 1 shows questions are
   the *most common* reply type, that reprioritises the roadmap significantly —
   which is a good argument for shipping stage 1 first.
