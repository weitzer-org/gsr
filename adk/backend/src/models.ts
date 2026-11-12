// Per-stage Gemini model routing plus the two generation knobs (output cap,
// thinking level) that model-upgrade experiments need to vary ONE at a time
// (docs/eval/model-upgrade-test-plan.md).
//
// Every setting here defaults to what the code did before it existed: with
// none of the new env vars set, every stage resolves to the same model it
// always did and no maxOutputTokens / thinkingConfig is sent.
//
//   stage        env var              falls back to
//   -----------  -------------------  -------------------------------
//   discovery    DISCOVERY_MODEL      GEMINI_MODEL, then DEFAULT_MODEL
//   remediation  REMEDIATION_MODEL    GEMINI_MODEL, then DEFAULT_MODEL
//   basic        BASIC_MODEL          GEMINI_MODEL, then DEFAULT_MODEL
//   evaluate     EVALUATOR_MODEL      GEMINI_MODEL, then DEFAULT_MODEL
//   deduplicate  DEDUPLICATOR_MODEL   DEFAULT_MODEL  (never GEMINI_MODEL — it
//                                      has always had its own default, so
//                                      changing GEMINI_MODEL alone leaves the
//                                      deduplicator on 3.1 Pro)
// Type-only on purpose: the enum's runtime values are plain strings (verified in
// node_modules/@google/genai/dist/genai.d.ts: LOW = "LOW" ...), and a runtime import would
// make every test that mocks '@google/genai' without the enum throw at load.
import type { ThinkingLevel } from '@google/genai';

export const DEFAULT_MODEL = 'gemini-3.1-pro-preview';

export type ModelStage = 'discovery' | 'remediation' | 'basic' | 'deduplicate' | 'evaluate';

export const MODEL_STAGES: readonly ModelStage[] = ['discovery', 'remediation', 'basic', 'deduplicate', 'evaluate'];

const STAGE_ENV: Record<ModelStage, string> = {
  discovery: 'DISCOVERY_MODEL',
  remediation: 'REMEDIATION_MODEL',
  basic: 'BASIC_MODEL',
  deduplicate: 'DEDUPLICATOR_MODEL',
  evaluate: 'EVALUATOR_MODEL',
};

type Env = Record<string, string | undefined>;

// Empty strings count as unset (`||`, not `??`), matching how the call sites
// read GEMINI_MODEL before this module existed.
export function resolveStageModel(stage: ModelStage, env: Env = process.env): string {
  const specific = env[STAGE_ENV[stage]];
  if (specific) return specific;
  if (stage === 'deduplicate') return DEFAULT_MODEL;
  return env.GEMINI_MODEL || DEFAULT_MODEL;
}

export function resolveAllStageModels(env: Env = process.env): Record<ModelStage, string> {
  const out = {} as Record<ModelStage, string>;
  for (const stage of MODEL_STAGES) out[stage] = resolveStageModel(stage, env);
  return out;
}

// GEMINI_MAX_OUTPUT_TOKENS: a positive integer, or unset (= no cap, as today).
// Anything else resolves to undefined here; assertModelEnvValid() is what
// makes a typo fail loudly at startup instead of silently running an uncapped
// arm.
export function resolveMaxOutputTokens(env: Env = process.env): number | undefined {
  const raw = env.GEMINI_MAX_OUTPUT_TOKENS;
  if (raw === undefined || raw === '') return undefined;
  if (!/^[1-9][0-9]*$/.test(raw.trim())) return undefined;
  const n = Number(raw.trim());
  return Number.isSafeInteger(n) ? n : undefined;
}

const THINKING_LEVELS: Record<string, ThinkingLevel> = {
  MINIMAL: 'MINIMAL' as ThinkingLevel,
  LOW: 'LOW' as ThinkingLevel,
  MEDIUM: 'MEDIUM' as ThinkingLevel,
  HIGH: 'HIGH' as ThinkingLevel,
};

// GEMINI_THINKING_LEVEL: MINIMAL | LOW | MEDIUM | HIGH (case-insensitive), or
// unset (= send no thinking config, as today). Whether a given MODEL accepts a
// level is a server-side fact — e.g. Sound Builder measured gemini-3.8-flash
// rejecting MINIMAL with HTTP 400 — so this only checks the value is a level
// the installed SDK knows.
export function resolveThinkingLevel(env: Env = process.env): ThinkingLevel | undefined {
  const raw = env.GEMINI_THINKING_LEVEL;
  if (raw === undefined || raw === '') return undefined;
  const key = raw.trim().toUpperCase();
  return Object.prototype.hasOwnProperty.call(THINKING_LEVELS, key) ? THINKING_LEVELS[key] : undefined;
}

// Spread into a generateContent `config` for the discovery / remediation /
// basic(legacy) calls. Returns {} when neither knob is set, so the request is
// byte-identical to the pre-existing one.
export function generationOverrides(env: Env = process.env): { maxOutputTokens?: number; thinkingConfig?: { thinkingLevel: ThinkingLevel } } {
  const out: { maxOutputTokens?: number; thinkingConfig?: { thinkingLevel: ThinkingLevel } } = {};
  const cap = resolveMaxOutputTokens(env);
  if (cap !== undefined) out.maxOutputTokens = cap;
  const level = resolveThinkingLevel(env);
  if (level !== undefined) out.thinkingConfig = { thinkingLevel: level };
  return out;
}

// Throws on a set-but-invalid knob. Called from the server entrypoint so a typo
// fails the deploy / the arm's startup instead of silently measuring the wrong
// configuration.
export function assertModelEnvValid(env: Env = process.env): void {
  const cap = env.GEMINI_MAX_OUTPUT_TOKENS;
  if (cap !== undefined && cap !== '' && resolveMaxOutputTokens(env) === undefined) {
    throw new Error(`GEMINI_MAX_OUTPUT_TOKENS must be a positive integer (got ${JSON.stringify(cap)}).`);
  }
  const level = env.GEMINI_THINKING_LEVEL;
  if (level !== undefined && level !== '' && resolveThinkingLevel(env) === undefined) {
    throw new Error(`GEMINI_THINKING_LEVEL must be one of ${Object.keys(THINKING_LEVELS).join(', ')} (got ${JSON.stringify(level)}).`);
  }
}

// Shape returned under /api/status so a harness can confirm which model each
// stage will actually request, without trusting its own env overlay.
export function describeModelRouting(env: Env = process.env): {
  stageModels: Record<ModelStage, string>;
  maxOutputTokens: number | null;
  thinkingLevel: string | null;
  contextCaching: boolean;
} {
  return {
    stageModels: resolveAllStageModels(env),
    maxOutputTokens: resolveMaxOutputTokens(env) ?? null,
    thinkingLevel: resolveThinkingLevel(env) ?? null,
    contextCaching: env.USE_CONTEXT_CACHING !== 'false',
  };
}
