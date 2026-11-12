// Arm definitions for multi-arm local runs: N backends started from ONE checkout, each with its own
// environment overlay, so a comparison changes the model (or one setting) and nothing else.
//
// The overlay may only contain the allow-listed, non-secret keys below. That is a safety property,
// not a convenience: the resolved routing and the overlay are written into manifest.json, which is
// meant to be shared. Secrets (GEMINI_API_KEY, tokens, S3 keys) come from the parent environment,
// are passed to the child process, and are never recorded.
import * as fs from 'fs';
import { describeModelRouting, MODEL_STAGES } from '../../adk/backend/src/models';
import { scrubStorageEnv, sinkEnv } from './nullS3';

export interface ArmConfig {
  name: string;
  description?: string;
  // 'baseline' is the reference every other arm is compared with; 'control' is a second copy of it
  // (an A/A noise floor); everything else is a candidate.
  role?: 'baseline' | 'control' | 'candidate';
  env: Record<string, string>;
}

export const ALLOWED_OVERLAY_KEYS: ReadonlySet<string> = new Set([
  'GEMINI_MODEL', 'DISCOVERY_MODEL', 'REMEDIATION_MODEL', 'BASIC_MODEL', 'DEDUPLICATOR_MODEL', 'EVALUATOR_MODEL',
  'GEMINI_MAX_OUTPUT_TOKENS', 'GEMINI_THINKING_LEVEL', 'USE_CONTEXT_CACHING', 'USE_DEDUPLICATOR', 'USE_TRIAGE_AGENT',
  'GEMINI_TIMEOUT_MS', 'MAX_REVIEW_FILES',
]);

// Removed from the parent environment before an overlay is applied, so an arm never inherits a
// stray setting from the operator's shell (a leftover GEMINI_MODEL would silently contaminate it).
export const SCRUBBED_KEYS: readonly string[] = [...ALLOWED_OVERLAY_KEYS, 'PORT', 'UI_PASSWORD', 'SESSION_SECRET', 'NODE_ENV'];

const EXPLICIT_STAGE_KEYS = ['DISCOVERY_MODEL', 'REMEDIATION_MODEL', 'BASIC_MODEL', 'DEDUPLICATOR_MODEL', 'EVALUATOR_MODEL'] as const;

export function validateArms(arms: ArmConfig[]): void {
  if (!Array.isArray(arms) || arms.length < 2) throw new Error('An arms file needs at least two arms.');
  const names = new Set<string>();
  for (const a of arms) {
    if (!/^[A-Za-z][A-Za-z0-9_]*$/.test(a.name ?? '')) throw new Error(`Arm name ${JSON.stringify(a.name)} must match [A-Za-z][A-Za-z0-9_]*.`);
    if (names.has(a.name)) throw new Error(`Duplicate arm name ${a.name}.`);
    names.add(a.name);
    for (const [k, v] of Object.entries(a.env ?? {})) {
      if (!ALLOWED_OVERLAY_KEYS.has(k)) throw new Error(`Arm ${a.name}: env key ${k} is not allowed in an overlay (allowed: ${[...ALLOWED_OVERLAY_KEYS].join(', ')}).`);
      if (typeof v !== 'string') throw new Error(`Arm ${a.name}: env value for ${k} must be a string.`);
    }
  }
  const baselines = arms.filter(a => a.role === 'baseline');
  if (baselines.length !== 1) throw new Error(`Exactly one arm must have role "baseline" (found ${baselines.length}).`);
}

export function loadArms(file: string): ArmConfig[] {
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const arms: ArmConfig[] = Array.isArray(raw) ? raw : raw.arms;
  validateArms(arms);
  return arms;
}

// The environment a backend process is started with: the parent's, minus every tunable, plus the
// arm's overlay, plus the port. Storage is ALWAYS redirected: every inherited S3_* / AWS_* /
// ingest / feedback variable is removed and the backend is pointed at a local null sink (or, when
// none is given, at a closed local port), so an eval backend can never write review history or
// usage records into the operator's real bucket.
export function buildBackendEnv(parent: NodeJS.ProcessEnv, arm: ArmConfig, port: number, sinkEndpoint = 'http://127.0.0.1:9'): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...parent };
  for (const k of SCRUBBED_KEYS) delete env[k];
  for (const k of Object.keys(env)) if (k.startsWith('ABLATE_')) delete env[k];
  scrubStorageEnv(env);
  Object.assign(env, sinkEnv(sinkEndpoint, arm.name));
  Object.assign(env, arm.env);
  env.PORT = String(port);
  return env;
}

// Uses the backend's own resolver, so the manifest records what the server will resolve, not a
// second implementation's opinion of it. The harness still re-checks against the running
// server's /api/status after start.
export function resolveArmRouting(arm: ArmConfig, parent: NodeJS.ProcessEnv = {}) {
  return describeModelRouting(buildBackendEnv(parent, arm, 0));
}

// "Every stage's model set explicitly": for a comparison, an arm that leaves a stage to fall back
// to GEMINI_MODEL or the default is one config change away from running a different model.
export function assertExplicitRouting(arms: ArmConfig[]): void {
  for (const a of arms) {
    const missing = EXPLICIT_STAGE_KEYS.filter(k => !a.env[k]);
    if (missing.length) throw new Error(`Arm ${a.name} leaves ${missing.join(', ')} unset; set every stage's model explicitly.`);
    if (a.env.USE_CONTEXT_CACHING !== 'false') throw new Error(`Arm ${a.name}: USE_CONTEXT_CACHING must be "false" on every arm (parity; Argon's model metadata lists no createCachedContent).`);
    if (!a.env.GEMINI_MAX_OUTPUT_TOKENS) throw new Error(`Arm ${a.name}: GEMINI_MAX_OUTPUT_TOKENS must be set on every arm.`);
  }
}

// Settings that must be identical on every arm for a one-variable comparison. Anything NOT listed
// here is allowed to differ — that is the experiment.
const PARITY_KEYS = ['GEMINI_MAX_OUTPUT_TOKENS', 'USE_CONTEXT_CACHING', 'USE_DEDUPLICATOR', 'USE_TRIAGE_AGENT', 'GEMINI_TIMEOUT_MS', 'MAX_REVIEW_FILES'] as const;

export function assertParity(arms: ArmConfig[]): void {
  for (const k of PARITY_KEYS) {
    const values = new Set(arms.map(a => a.env[k] ?? '<unset>'));
    if (values.size > 1) throw new Error(`${k} differs across arms (${[...values].join(' vs ')}); it must be identical so the model is the only variable.`);
  }
}

// What each arm should look like when the server reports it. Returns mismatches (empty = OK).
export function diffRoutingAgainstStatus(expected: ReturnType<typeof describeModelRouting>, status: any): string[] {
  const problems: string[] = [];
  for (const stage of MODEL_STAGES) {
    const got = status?.stageModels?.[stage];
    if (got !== expected.stageModels[stage]) problems.push(`stage ${stage}: expected ${expected.stageModels[stage]}, server reports ${got ?? '<missing>'}`);
  }
  if ((status?.maxOutputTokens ?? null) !== expected.maxOutputTokens) problems.push(`maxOutputTokens: expected ${expected.maxOutputTokens}, server reports ${status?.maxOutputTokens ?? '<missing>'}`);
  if ((status?.thinkingLevel ?? null) !== expected.thinkingLevel) problems.push(`thinkingLevel: expected ${expected.thinkingLevel}, server reports ${status?.thinkingLevel ?? '<missing>'}`);
  if (status?.contextCaching !== expected.contextCaching) problems.push(`contextCaching: expected ${expected.contextCaching}, server reports ${status?.contextCaching ?? '<missing>'}`);
  return problems;
}
