// Automated witness author: the system prompt (adk/prompts/witness/author*.md)
// plus one input bundle in, WitnessAuthorOutput out, via the real Gemini API.
// Every call goes through trackGeminiCall (tools/eval/usage.ts), so tokens,
// latency and cost are recorded the same way as the judge calls. The call's
// own usage is also returned so a benchmark can aggregate without re-reading
// the usage store.

import { GoogleGenAI } from '@google/genai';
import * as fs from 'fs';
import * as path from 'path';
import type { WitnessAuthorOutput } from '../../../adk/backend/src/witness/types';
import { computeCostUsd, trackGeminiCall } from '../usage';

export const AUTHOR_MODEL = process.env.WITNESS_AUTHOR_MODEL || 'gemini-3.1-pro-preview';
export const PROMPT_DIR = path.join(__dirname, '..', '..', '..', 'adk', 'prompts', 'witness');
export const PROMPT_FILES: Record<string, string> = { v1: 'author.md', v2: 'author.v2.md' };

export function loadPrompt(version: string): string {
  const file = PROMPT_FILES[version];
  if (!file) throw new Error(`unknown prompt version ${version}; known: ${Object.keys(PROMPT_FILES).join(', ')}`);
  return fs.readFileSync(path.join(PROMPT_DIR, file), 'utf8');
}

export interface AuthorUsage {
  inputTokens: number;
  outputTokens: number;
  thinkingTokens: number;
  /** Prompt tokens served from Gemini's implicit cache (repeat prompts, e.g. n>1 samples). */
  cachedTokens: number;
  /** Cost by usage.ts's convention: cached input is not billed and thinking tokens are NOT billed on top of outputTokens. */
  costUsd: number;
  /** Same, if thinking tokens are billed as output (unverified assumption; see the PR). */
  costUsdWithThinking: number;
  latencyMs: number;
}

export interface AuthorResult {
  /** Null when the model call failed or its reply was not a valid WitnessAuthorOutput. */
  output: WitnessAuthorOutput | null;
  /** 'api_error' | 'bad_json' | 'bad_shape', set iff output is null. */
  failure?: string;
  detail?: string;
  raw: string;
  usage: AuthorUsage;
}

/** Strict enough to reject a reply that would crash the pipeline, loose about extras. */
export function parseAuthorOutput(raw: string): { output?: WitnessAuthorOutput; failure?: string; detail?: string } {
  // The prompt forbids fences; tolerate them anyway rather than count a formatting slip as a failed claim.
  const text = raw.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let json: unknown;
  try { json = JSON.parse(text); } catch (e) { return { failure: 'bad_json', detail: (e as Error).message }; }
  const o = json as Partial<WitnessAuthorOutput> | null;
  const claim = o?.claim as Partial<WitnessAuthorOutput['claim']> | undefined;
  if (!o || typeof o !== 'object' || !claim || typeof claim !== 'object' || typeof claim.testable !== 'boolean') {
    return { failure: 'bad_shape', detail: 'missing claim.testable' };
  }
  if (claim.testable) {
    const w = o.witness;
    const okClaim = ['language', 'file', 'symbol', 'input', 'expected', 'actual'].every((k) => typeof (claim as Record<string, unknown>)[k] === 'string');
    if (!okClaim) return { failure: 'bad_shape', detail: 'claim fields missing' };
    // A testable claim with no witness is a legitimate model output; the pipeline records it as no_witness.
    if (w !== null && w !== undefined && (typeof w !== 'object' || typeof w.path !== 'string' || typeof w.source !== 'string' || typeof w.language !== 'string' || typeof w.framework !== 'string')) {
      return { failure: 'bad_shape', detail: 'witness fields missing' };
    }
  }
  return { output: { claim: claim as WitnessAuthorOutput['claim'], witness: o.witness ?? null } };
}

const RETRYABLE = /\b(429|500|502|503|504)\b|overloaded|unavailable|ECONNRESET|ETIMEDOUT/i;

/** The one SDK method the author uses; tests inject a stub instead of the real client. */
export interface AuthorClient { models: { generateContent: GoogleGenAI['models']['generateContent'] } }

export async function authorWitness(
  bundle: string,
  opts: { systemPrompt: string; model?: string; apiKey?: string; maxAttempts?: number; client?: AuthorClient; retryDelayMs?: number },
): Promise<AuthorResult> {
  const model = opts.model ?? AUTHOR_MODEL;
  let ai = opts.client;
  if (!ai) {
    const apiKey = opts.apiKey ?? process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY is not set');
    ai = new GoogleGenAI({ apiKey });
  }
  const usage: AuthorUsage = { inputTokens: 0, outputTokens: 0, thinkingTokens: 0, cachedTokens: 0, costUsd: 0, costUsdWithThinking: 0, latencyMs: 0 };

  const attempts = opts.maxAttempts ?? 3;
  let lastErr = '';
  for (let i = 0; i < attempts; i++) {
    const started = Date.now();
    try {
      const response = await trackGeminiCall({ callType: 'witness_author', model }, () => ai.models.generateContent({
        model,
        contents: bundle,
        config: { systemInstruction: opts.systemPrompt, responseMimeType: 'application/json' },
      }));
      const u = response.usageMetadata;
      usage.inputTokens += u?.promptTokenCount ?? 0;
      usage.outputTokens += u?.candidatesTokenCount ?? 0;
      usage.thinkingTokens += u?.thoughtsTokenCount ?? 0;
      usage.cachedTokens += u?.cachedContentTokenCount ?? 0;
      usage.latencyMs += Date.now() - started;
      const raw = response.text ?? '';
      const parsed = parseAuthorOutput(raw);
      finishCost(usage, model);
      return parsed.output ? { output: parsed.output, raw, usage } : { output: null, failure: parsed.failure, detail: parsed.detail, raw, usage };
    } catch (err) {
      // A failed call is already recorded (success:false) by trackGeminiCall; its cost is 0.
      usage.latencyMs += Date.now() - started;
      lastErr = String((err as Error)?.message ?? err).slice(0, 300);
      if (!RETRYABLE.test(lastErr) || i === attempts - 1) break;
      await new Promise((r) => setTimeout(r, (opts.retryDelayMs ?? 2000) * 2 ** i));
    }
  }
  finishCost(usage, model);
  return { output: null, failure: 'api_error', detail: lastErr, raw: '', usage };
}

export function finishCost(u: AuthorUsage, model: string) {
  u.costUsd = computeCostUsd(model, u.inputTokens, u.outputTokens, u.cachedTokens);
  u.costUsdWithThinking = computeCostUsd(model, u.inputTokens, u.outputTokens + u.thinkingTokens, u.cachedTokens);
}
