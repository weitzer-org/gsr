// Capability probe: which of the candidate models can do what GSR needs, measured with the RAW
// genai client (no GSR code, no fallback, no retries), with the served model checked on every call.
//
//   npx ts-node probe-models.ts                          dry run (default): prints the plan, calls nothing
//   npx ts-node probe-models.ts --live --max-calls 24    live, hard-capped
//
// Per candidate model (6 cases): structured JSON with GSR's real discovery schema; the
// deduplicator's thinkingBudget 4096; thinking LOW; thinking MINIMAL; caches.create; a tiny
// maxOutputTokens (does thinking eat the cap?). Judge models get one plain call each ("does it still
// answer"). About 20 calls. Raw results are saved as JSON, with response text truncated and no
// secrets (the API key never enters a result).
import * as fs from 'fs';
import * as path from 'path';
import 'dotenv/config';
import { GoogleGenAI, Type } from '@google/genai';
import { CallBudget, requireCap } from './budget';
import { DEFAULT_JUDGE_MODEL } from './llm-comparator-v2';

// GSR's discovery-pass response schema, serialized from adk/backend/src/agent.ts's
// DISCOVERY_RESPONSE_SCHEMA. Read from a fixture (not imported) because tools/eval is installed on its
// own in CI, where the backend's node_modules do not exist; adk/backend/tests/discovery-schema.test.ts
// fails if the fixture ever drifts from the real schema.
export const DISCOVERY_RESPONSE_SCHEMA = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'discovery-schema.json'), 'utf8'));

export type ProbeKind = 'schema' | 'thinking_budget_4096' | 'thinking_low' | 'thinking_minimal' | 'caches_create' | 'max_output_small' | 'judge_plain';

export interface ProbeCase { id: string; model: string; kind: ProbeKind }

export const CANDIDATE_MODELS = ['gemini-3.1-pro-preview', 'gemini-4-argon', 'gemini-3.8-flash'] as const;
const CANDIDATE_KINDS: ProbeKind[] = ['schema', 'thinking_budget_4096', 'thinking_low', 'thinking_minimal', 'caches_create', 'max_output_small'];

export function buildProbePlan(candidates: readonly string[], judges: readonly string[]): ProbeCase[] {
  const plan: ProbeCase[] = [];
  for (const model of candidates) for (const kind of CANDIDATE_KINDS) plan.push({ id: `${model}:${kind}`, model, kind });
  for (const model of judges) if (!plan.some(p => p.model === model)) plan.push({ id: `${model}:judge_plain`, model, kind: 'judge_plain' });
  return plan;
}

const DIFF_PROMPT = `<DIFF_CONTENTS>
File: src/cache.ts
\`\`\`diff
@@ -10,3 +10,9 @@ export class Cache {
   get(key: string) {
     return this.map.get(key);
   }
+  set(key: string, value: unknown) {
+    // BUG: no eviction, grows without bound
+    this.map.set(key, value);
+    this.history.push({ key, value, at: Date.now() });
+  }
\`\`\`
</DIFF_CONTENTS>`;

const DISCOVERY_SYSTEM = 'You are the Logic discovery agent. Scan the diff and identify the exact lines where problems exist. Return strictly the required JSON. You MUST list every file you read in `filesAnalyzed`.';

// Long enough to clear the minimum size for explicit caching (GSR's own threshold is 2048 tokens).
export function longInstruction(): string {
  const sentence = 'Review code diffs for correctness, security, and maintainability, citing exact file paths and line numbers, and never invent symbols that are not in the diff. ';
  return sentence.repeat(400);
}

const DEDUP_SCHEMA = {
  type: Type.ARRAY,
  items: {
    type: Type.OBJECT,
    properties: { file: { type: Type.STRING }, line: { type: Type.INTEGER }, severity: { type: Type.STRING, enum: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] }, summary: { type: Type.STRING }, description: { type: Type.STRING } },
    required: ['file', 'line', 'severity', 'summary', 'description'],
  },
};

export function buildRequest(c: ProbeCase): { model: string; contents: string; config: any } | { cache: true } {
  const discovery = (thinking?: any) => ({
    model: c.model, contents: DIFF_PROMPT,
    config: { systemInstruction: DISCOVERY_SYSTEM, responseMimeType: 'application/json', responseSchema: DISCOVERY_RESPONSE_SCHEMA, maxOutputTokens: 32768, ...(thinking ? { thinkingConfig: thinking } : {}) },
  });
  switch (c.kind) {
    case 'schema': return discovery();
    case 'thinking_low': return discovery({ thinkingLevel: 'LOW' });
    case 'thinking_minimal': return discovery({ thinkingLevel: 'MINIMAL' });
    case 'thinking_budget_4096':
      return {
        model: c.model,
        contents: JSON.stringify([
          { file: 'src/cache.ts', line: 15, severity: 'HIGH', summary: 'unbounded growth', description: 'map grows without eviction', agent: 'Performance' },
          { file: 'src/cache.ts', line: 16, severity: 'MEDIUM', summary: 'unbounded history', description: 'history array never trimmed', agent: 'Logic' },
        ]),
        config: { systemInstruction: 'Merge findings that share a root cause within 10 lines of the same file into one; keep the highest severity. Return a JSON array.', thinkingConfig: { thinkingBudget: 4096 }, responseMimeType: 'application/json', responseSchema: DEDUP_SCHEMA },
      };
    case 'max_output_small':
      return { model: c.model, contents: 'Explain in two short paragraphs what makes a code review comment actionable.', config: { maxOutputTokens: 64 } };
    case 'judge_plain':
      return { model: c.model, contents: 'Reply with the single word: ready', config: { temperature: 0.2 } };
    case 'caches_create': return { cache: true };
  }
}

export interface ProbeResult {
  id: string; model: string; kind: ProbeKind;
  ok: boolean;
  error?: { status?: number; message: string };
  servedModel?: string;
  servedMatches?: boolean;
  finishReason?: string;
  usage?: { prompt?: number; candidates?: number; thoughts?: number; total?: number; cached?: number };
  // total - prompt - candidates - thoughts: 0 when the total is exactly the sum of the three
  // (thoughts reported separately from candidates); equal to -thoughts when candidates already
  // includes them. Evidence for the "are thinking tokens billed on top?" question, not an answer.
  usageResidual?: number;
  textPreview?: string;
  jsonParsed?: boolean;
  jsonMatchesSchemaShape?: boolean;
  latencyMs: number;
  cacheName?: string;
}

const norm = (m?: string) => (m ?? '').replace(/^models\//, '');

export async function runCase(ai: GoogleGenAI, c: ProbeCase): Promise<ProbeResult> {
  const t0 = Date.now();
  const base: ProbeResult = { id: c.id, model: c.model, kind: c.kind, ok: false, latencyMs: 0 };
  try {
    const req = buildRequest(c);
    if ('cache' in req) {
      const cache = await ai.caches.create({ model: `models/${c.model}`, config: { systemInstruction: longInstruction(), ttl: '300s' } });
      base.ok = true;
      base.cacheName = cache.name;
      try { if (cache.name) await ai.caches.delete({ name: cache.name }); } catch { /* best effort; the 300s TTL expires it */ }
    } else {
      const res: any = await ai.models.generateContent(req as any);
      const u = res.usageMetadata ?? {};
      base.ok = true;
      base.servedModel = res.modelVersion;
      base.servedMatches = norm(res.modelVersion) === c.model;
      base.finishReason = res.candidates?.[0]?.finishReason;
      base.usage = { prompt: u.promptTokenCount, candidates: u.candidatesTokenCount, thoughts: u.thoughtsTokenCount, total: u.totalTokenCount, cached: u.cachedContentTokenCount };
      if (u.totalTokenCount !== undefined) base.usageResidual = u.totalTokenCount - (u.promptTokenCount ?? 0) - (u.candidatesTokenCount ?? 0) - (u.thoughtsTokenCount ?? 0);
      const text: string = res.text ?? '';
      base.textPreview = text.slice(0, 400);
      if (req && (req as any).config?.responseMimeType === 'application/json') {
        try {
          const parsed = JSON.parse(text);
          base.jsonParsed = true;
          base.jsonMatchesSchemaShape = c.kind === 'thinking_budget_4096' ? Array.isArray(parsed) : Array.isArray(parsed?.filesAnalyzed) && Array.isArray(parsed?.issues);
        } catch { base.jsonParsed = false; base.jsonMatchesSchemaShape = false; }
      }
    }
  } catch (e: any) {
    base.ok = false;
    base.error = { status: e?.status ?? e?.code, message: String(e?.message ?? e).slice(0, 500) };
  }
  base.latencyMs = Date.now() - t0;
  return base;
}

export interface ModelAssessment {
  model: string;
  dropped: boolean;
  reasons: string[];          // why it was dropped (must-have failures)
  notes: string[];            // everything else worth knowing
  supports: Record<string, boolean | undefined>;
}

// Must-haves for ANY arm: structured JSON with GSR's schema (every swarm call), the deduplicator's
// thinkingBudget 4096, and being served as requested. Thinking LOW is a must-have only for the
// FLASH38_LOW arm (it drops that arm, not the model). MINIMAL, caching and a tiny output cap are
// recorded, not required: the arms run with caching off and never use MINIMAL.
export function assessProbe(results: ProbeResult[], candidates: readonly string[]): ModelAssessment[] {
  return candidates.map(model => {
    const rs = results.filter(r => r.model === model);
    const get = (k: ProbeKind) => rs.find(r => r.kind === k);
    const reasons: string[] = [];
    const notes: string[] = [];
    const schema = get('schema');
    if (!schema) reasons.push('schema case not run');
    else if (!schema.ok) reasons.push(`structured JSON with the discovery schema failed: ${schema.error?.message}`);
    else if (!schema.jsonParsed || !schema.jsonMatchesSchemaShape) reasons.push('structured JSON did not parse into the discovery shape');
    const budget = get('thinking_budget_4096');
    if (!budget) reasons.push('thinkingBudget case not run');
    else if (!budget.ok) reasons.push(`thinkingBudget 4096 (the deduplicator's setting) failed: ${budget.error?.message}`);
    for (const r of rs) if (r.ok && r.servedMatches === false) reasons.push(`${r.kind}: requested ${r.model} but served as ${r.servedModel}`);
    const low = get('thinking_low');
    if (low && !low.ok) notes.push(`thinking LOW rejected (${low.error?.message}) — FLASH38_LOW cannot run on this model`);
    const minimal = get('thinking_minimal');
    if (minimal && !minimal.ok) notes.push(`thinking MINIMAL rejected (${minimal.error?.message})`);
    const cache = get('caches_create');
    if (cache && !cache.ok) notes.push(`caches.create rejected (${cache.error?.message}) — keep USE_CONTEXT_CACHING=false`);
    const small = get('max_output_small');
    if (small?.ok && small.finishReason === 'MAX_TOKENS' && !(small.textPreview ?? '').trim()) notes.push('maxOutputTokens=64 produced EMPTY output with MAX_TOKENS: thinking consumed the cap');
    return {
      model, dropped: reasons.length > 0, reasons, notes,
      supports: { schema: schema?.ok, thinkingBudget4096: budget?.ok, thinkingLow: low?.ok, thinkingMinimal: minimal?.ok, cachesCreate: cache?.ok, smallCap: small?.ok },
    };
  });
}

async function main() {
  const live = process.argv.includes('--live');
  const judge1 = process.env.JUDGE_MODEL || DEFAULT_JUDGE_MODEL;
  const judges = [judge1, process.env.JUDGE_MODEL_2 || 'gemini-3.8-flash', ...(process.env.JUDGE_MODEL_2_ALTERNATES || 'gemini-4-argon').split(',')].map(s => s.trim()).filter(Boolean);
  const plan = buildProbePlan(CANDIDATE_MODELS, judges);
  console.log(`Probe plan: ${plan.length} call(s)`);
  for (const p of plan) console.log(`  ${p.id}`);
  if (!live) { console.log('\nDRY RUN: nothing was called. Add --live --max-calls N.'); return; }
  if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is required.');
  const idx = process.argv.indexOf('--max-calls');
  const budget = new CallBudget('probe calls', requireCap('--max-calls', idx > 0 ? process.argv[idx + 1] : process.env.EVAL_MAX_PROBE_CALLS));
  if (budget.max < plan.length) throw new Error(`--max-calls ${budget.max} is below the plan's ${plan.length} calls.`);
  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  const results: ProbeResult[] = [];
  for (const c of plan) {
    budget.take();
    const r = await runCase(ai, c);
    results.push(r);
    console.log(`  ${r.ok ? 'ok  ' : 'FAIL'} ${c.id}${r.servedModel ? ` (served ${r.servedModel})` : ''}${r.error ? ` — ${r.error.status ?? ''} ${r.error.message.slice(0, 120)}` : ''}`);
  }
  const assessments = assessProbe(results, CANDIDATE_MODELS);
  const outIdx = process.argv.indexOf('--out');
  const out = outIdx > 0 ? process.argv[outIdx + 1] : path.resolve(__dirname, '../../docs/eval/data', `probe-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ ran_at: new Date().toISOString(), calls: budget.callsUsed, results, assessments }, null, 2));
  console.log(`\nSaved ${out}`);
  for (const a of assessments) console.log(`${a.dropped ? 'DROPPED' : 'ok     '} ${a.model}${a.reasons.length ? `: ${a.reasons.join('; ')}` : ''}${a.notes.length ? ` [${a.notes.join('; ')}]` : ''}`);
}

if (require.main === module) {
  main().catch(err => { console.error('\n💥', err.message ?? err); process.exitCode = 1; });
}
