// Feedback-loop Action-input resolution (design doc §7.2), split out of
// action-entrypoint.ts (PR #61 self-review finding: action-entrypoint.ts's
// top-level `main().catch(...)` call runs on import, since it's meant to be
// invoked as `node dist/src/action-entrypoint.js`, not imported as a
// library — pulling these pure, side-effect-free resolvers into their own
// module is what lets tests/action-entrypoint.test.ts import and unit-test
// them directly without also triggering the whole Action). No behavior
// change from where these lived before.
import { FeedbackLoopMode } from './feedbackLoop';

// resolveFeedbackLoopMode validates FEEDBACK_LOOP_MODE (the `feedback-loop`
// Action input, off by default — even observe mode spends the consumer's
// own Gemini quota, so this never silently turns itself on). An unrecognized
// value degrades to 'off' with a warning rather than failing the whole run
// over a typo in an opt-in input.
export function resolveFeedbackLoopMode(): FeedbackLoopMode {
  // Self-review finding: YAML block scalars / accidental trailing
  // whitespace in a workflow file (e.g. "observe ") would otherwise fail
  // this comparison silently and fall back to "off" with no indication why.
  const raw = (process.env.FEEDBACK_LOOP_MODE || 'off').trim().toLowerCase();
  if (raw === 'off' || raw === 'observe' || raw === 'respond') return raw;
  console.warn(`[GSR Action] Unrecognized feedback-loop mode "${raw}" — must be "off", "observe", or "respond". Disabling the feedback loop for this run.`);
  return 'off';
}

// resolveFeedbackMinConfidence / resolveFeedbackMaxReplies (Phase 2 inputs,
// design doc §7.2) follow resolveFeedbackLoopMode's same "warn and fall
// back to a safe default" pattern rather than throwing over a typo'd input.
// PR #61 self-review + CodeRabbit finding: `parseFloat`/`parseInt` are too
// permissive to rely on for this — they parse a leading numeric prefix and
// silently discard trailing garbage, so `parseFloat("0..7")` is `0` (not
// NaN, despite what an earlier version of this comment claimed) and
// `parseInt("3.5", 10)` is `3`. A `minConfidence` of `0` clears the floor
// for every `pushback_incorrect` verdict — worse than the failure this
// function exists to guard against, and with no warning logged. `Number()`
// rejects any trailing/malformed characters outright (`Number("0..7")` is
// NaN), so the existing `Number.isFinite`/`Number.isInteger` checks below
// now actually catch what they're meant to.
export function resolveFeedbackMinConfidence(): number {
  const raw = process.env.FEEDBACK_MIN_CONFIDENCE;
  if (raw === undefined || raw.trim() === '') return 0.7;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed < 0 || parsed > 1) {
    console.warn(`[GSR Action] Invalid feedback-min-confidence "${raw}" — must be a number between 0 and 1. Using default 0.7.`);
    return 0.7;
  }
  return parsed;
}

export function resolveFeedbackMaxReplies(): number {
  const raw = process.env.FEEDBACK_MAX_REPLIES;
  if (raw === undefined || raw.trim() === '') return 3;
  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0) {
    console.warn(`[GSR Action] Invalid feedback-max-replies "${raw}" — must be a non-negative integer. Using default 3.`);
    return 3;
  }
  return parsed;
}

// resolveFeedbackPostEnabled (Phase 2b's arm switch, `feedback-post` Action
// input) is deliberately a SEPARATE opt-in from `feedback-loop: respond`,
// not a new mode value — see feedbackLoop.ts's module doc comment for the
// full reasoning (independent design review, before this was implemented).
// Default false/unset preserves "respond" as dry-run-only, exactly as
// documented before this build; only an explicit "true" arms real posting.
// Same fail-closed convention as resolveFeedbackLoopMode: any value other
// than a recognized boolean-ish string degrades to false with a warning
// rather than the run guessing what the operator meant for a switch this
// consequential.
export function resolveFeedbackPostEnabled(): boolean {
  const raw = (process.env.FEEDBACK_POST || 'false').trim().toLowerCase();
  if (raw === 'true') return true;
  if (raw === 'false' || raw === '') return false;
  console.warn(`[GSR Action] Unrecognized feedback-post value "${raw}" — must be "true" or "false". Disabling real posting for this run (feedback-loop, if "respond", still runs in dry-run only).`);
  return false;
}

// feedbackPostMisconfigurationWarning is a pure helper (same reason this
// whole module exists — testable without importing action-entrypoint.ts,
// see the file doc comment above) for the one cross-check that needs BOTH
// resolved values at once: feedback-post only does anything when
// feedback-loop is "respond". action-entrypoint.ts calls this right after
// resolving both and logs the result via console.warn if non-null — kept
// as a pure string-or-undefined return here so the condition itself is
// unit-testable independent of how the caller chooses to surface it.
export function feedbackPostMisconfigurationWarning(mode: FeedbackLoopMode, postEnabled: boolean): string | undefined {
  if (postEnabled && mode !== 'respond') {
    return '[GSR Action] feedback-post is "true" but feedback-loop is not "respond" — feedback-post has no effect unless feedback-loop is "respond". No rebuttals will be posted this run.';
  }
  return undefined;
}
