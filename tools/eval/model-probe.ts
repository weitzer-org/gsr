// model-probe.ts: capability probe for a Gemini model change (gemini-4-upgrade-plan.md §5 steps 1-2).
//
// Sends GSR's real request shapes (discovery, remediation, deduplicate, feedback_classify) to each
// candidate model on a tiny frozen input, and keeps everything a diagnosis needs: the served model
// (modelVersion), finish reason, the full usageMetadata, latency, and the raw response text, even when
// it doesn't parse. It also checks the thinking-token accounting: whether
// totalTokenCount == prompt + candidates + thoughts (+ tool-use prompt), and how many tokens the visible
// text alone counts as (countTokens is free).
//
// It is a capability probe, not a quality benchmark: the input is two one-line seeded bugs from the
// witness testbed, so "found the bug" here says nothing about recall on real PRs.
//
// Usage (from tools/eval):
//   npx ts-node model-probe.ts                 # dry run: lists the calls, spends nothing
//   npx ts-node model-probe.ts --run           # makes the calls (needs GEMINI_API_KEY)
//   npx ts-node model-probe.ts --run --out model-probe-runs/<name>.json   (default: model-probe-runs/model-probe-<date>.json)
//
// The schemas and system instructions below are copied from adk/backend/src/agent.ts,
// deduplicator.ts and adjudicator.ts (as of the commit that added this file). If those change,
// update these copies before reusing the probe.
import { GoogleGenAI, Type, ThinkingLevel } from '@google/genai';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

const ROOT = path.resolve(__dirname, '../..');
const CASES = path.join(__dirname, 'fixtures/witness-testbed/cases');
const TIMEOUT_MS = 300_000; // GEMINI_TIMEOUT_MS default in adk/backend

// USD per 1M tokens, standard tier, rates in force on 2026-11-05. Same values as
// adk/backend/src/usage.ts's PRICE_TABLE.
const PRICES: Record<string, { input: number; output: number }> = {
  'gemini-3.1-pro-preview': { input: 2.0, output: 12.0 },
  'gemini-4-argon': { input: 2.0, output: 10.0 },
  'gemini-3.8-flash': { input: 0.75, output: 3.75 },
  'gemini-2.5-pro': { input: 1.25, output: 10.0 },
};

// --- Frozen inputs ---

interface Chunk { file: string; content: string }

function caseDiff(caseId: string): Chunk {
  const dir = path.join(CASES, caseId);
  let out = '';
  try {
    execFileSync('git', ['diff', '--no-index', '--', 'base', 'head'], { cwd: dir, encoding: 'utf8' });
  } catch (e: any) {
    out = e.stdout; // git diff --no-index exits 1 when the trees differ
  }
  const file = JSON.parse(fs.readFileSync(path.join(dir, 'case.json'), 'utf8')).finding.file as string;
  return { file, content: out.replace(/\b(a|b)\/(base|head)\//g, '$1/') };
}

const CHUNKS: Chunk[] = [caseDiff('go-regression'), caseDiff('js-regression')];
const KNOWN_FILES = CHUNKS.map(c => c.file);

const FIXED_ISSUES = [
  { file: 'pager/pager.go', line: 5, severity: 'HIGH', summary: 'Page now treats page numbers as 0-based, so page 1 skips the first page of items.' },
  { file: 'src/discount.js', line: 3, severity: 'HIGH', summary: 'applyDiscount treats pct as a fraction, so applyDiscount(200, 10) returns -1800.' },
];

// Near-duplicates of the same two root causes from three personas, plus one distinct finding:
// a correct merge returns 3 findings.
const DEDUP_INPUT = [
  { agent: 'Logic', file: 'pager/pager.go', line: 5, severity: 'HIGH', summary: 'Off-by-one: start index ignores 1-based page numbering.', description: 'start := page * size skips the first page.', suggestion: 'start := (page - 1) * size' },
  { agent: 'Testing', file: 'pager/pager.go', line: 6, severity: 'MEDIUM', summary: 'Page(…, 1, n) no longer returns the first page; no test covers it.', description: 'The change to start breaks 1-based paging and is untested.', suggestion: 'Add a test for Page(items, 1, 2).' },
  { agent: 'Architecture', file: 'pager/pager.go', line: 4, severity: 'LOW', summary: 'Doc comment says 1-based but code is now 0-based.', description: 'Contract and implementation disagree.', suggestion: 'Restore (page - 1) * size.' },
  { agent: 'Logic', file: 'src/discount.js', line: 3, severity: 'HIGH', summary: 'pct is treated as a fraction instead of a percentage.', description: 'applyDiscount(200, 10) returns -1800.', suggestion: 'return price * (1 - pct / 100);' },
  { agent: 'Security', file: 'src/discount.js', line: 3, severity: 'MEDIUM', summary: 'Discount can drive the price negative.', description: 'With pct > 1 the result is negative, which callers may credit.', suggestion: 'return price * (1 - pct / 100);' },
  { agent: 'Performance', file: 'pager/pager.go', line: 9, severity: 'LOW', summary: 'Slice is returned without copying, so callers can mutate the input.', description: 'items[start:end] aliases the caller\'s backing array.', suggestion: 'Return append([]int(nil), items[start:end]...).' },
];

const CLASSIFY_INPUT = [
  { commentId: 101, findingSummary: 'Page treats page numbers as 0-based.', replyText: 'Good catch, fixed in the next commit.' },
  { commentId: 102, findingSummary: 'Discount can drive the price negative.', replyText: 'Not a real issue: pct is validated to 0..100 upstream in checkout.ts.' },
  { commentId: 103, findingSummary: 'Slice aliases the caller\'s array.', replyText: 'Why would that matter here?' },
];

// --- Request shapes (copied from adk/backend) ---

const SEVERITY = { type: Type.STRING, enum: ['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'] };

const DISCOVERY_SCHEMA = {
  type: Type.OBJECT,
  description: 'Strict coverage wrapper for code review.',
  properties: {
    filesAnalyzed: { type: Type.ARRAY, description: 'A complete list of EVERY file path that was successfully read and checked for bugs.', items: { type: Type.STRING } },
    issues: {
      type: Type.ARRAY,
      description: 'A list of problematic locations found in the code.',
      items: {
        type: Type.OBJECT,
        properties: { file: { type: Type.STRING }, line: { type: Type.INTEGER }, severity: SEVERITY, summary: { type: Type.STRING } },
        required: ['file', 'line', 'severity', 'summary'],
      },
    },
  },
  required: ['filesAnalyzed', 'issues'],
};

const REMEDIATION_SCHEMA = {
  type: Type.ARRAY,
  description: 'A final list of highly educational code review fixes for the provided issues.',
  items: {
    type: Type.OBJECT,
    properties: {
      file: { type: Type.STRING }, line: { type: Type.INTEGER }, severity: SEVERITY, summary: { type: Type.STRING },
      description: { type: Type.STRING, description: 'A highly educational explanation of why this is a flaw and how the architectural pattern works.' },
      suggestion: { type: Type.STRING, description: 'A properly formatted multi-line Markdown code block demonstrating the exact fix.' },
    },
    required: ['file', 'line', 'severity', 'summary', 'description', 'suggestion'],
  },
};

const DEDUP_SCHEMA = {
  type: Type.ARRAY,
  description: 'A consolidated list of deduplicated code review findings.',
  items: {
    type: Type.OBJECT,
    properties: {
      file: { type: Type.STRING }, line: { type: Type.INTEGER }, severity: SEVERITY, summary: { type: Type.STRING },
      description: { type: Type.STRING }, suggestion: { type: Type.STRING, nullable: true }, agent: { type: Type.STRING, nullable: true },
    },
    required: ['file', 'line', 'severity', 'summary', 'description'],
  },
};

const CLASSIFY_SCHEMA = {
  type: Type.ARRAY,
  description: 'One stance classification per input reply.',
  items: {
    type: Type.OBJECT,
    properties: {
      commentId: { type: Type.INTEGER },
      stance: { type: Type.STRING, enum: ['accepted', 'rejected', 'question', 'neutral'] },
      confidence: { type: Type.NUMBER },
    },
    required: ['commentId', 'stance', 'confidence'],
  },
};

function readPrompt(rel: string): string {
  return fs.readFileSync(path.join(ROOT, 'adk/prompts', rel), 'utf8');
}

function diffsText(): string {
  return CHUNKS.map(c => `File: ${c.file}\n\`\`\`diff\n${c.content}\n\`\`\``).join('\n\n');
}

function discoveryRequest(name: string, promptContent: string) {
  const systemInstruction = `You are the ${name} discovery agent.\nYour ONLY goal is to scan the code and identify the exact lines where problems exist based on your specialty.\nEnsure you return your response in the strictly required JSON format.\nCRITICAL: You MUST include every single file you read in the \`filesAnalyzed\` array, even if there are 0 issues found in it. \nIf you skip a file, the system will fail.\n${promptContent}`;
  return { systemInstruction, contents: `<DIFF_CONTENTS>\n${diffsText()}\n</DIFF_CONTENTS>`, schema: DISCOVERY_SCHEMA };
}

function remediationRequest(name: string, promptContent: string) {
  const systemInstruction = `You are an elite, highly educational Staff Engineer acting as the ${name} remediation agent.
A junior system has already flagged the potential issues in the following JSON array.
Your job is to read these flagged locations, read the source code context, and synthesize a masterful, highly detailed, and educational explanation for each issue.
Most importantly, you MUST provide a complete, copy-pasteable markdown code block in the \`suggestion\` field showing exactly how the developers should rewrite the code to adhere to best architectural practices.
Your descriptions must elevate from simple linting to deep mentorship and architectural guidance.
${promptContent}`;
  return {
    systemInstruction,
    contents: `<FLAGGED_ISSUES>\n${JSON.stringify(FIXED_ISSUES, null, 2)}\n</FLAGGED_ISSUES>\n\n<DIFF_CONTENTS>\n${diffsText()}\n</DIFF_CONTENTS>`,
    schema: REMEDIATION_SCHEMA,
  };
}

function dedupRequest() {
  const src = fs.readFileSync(path.join(ROOT, 'adk/backend/src/deduplicator.ts'), 'utf8');
  const m = src.match(/const systemInstruction = `([\s\S]*?)`;/);
  if (!m) throw new Error('could not find the deduplicator system instruction in deduplicator.ts');
  return { systemInstruction: m[1], contents: JSON.stringify(DEDUP_INPUT), schema: DEDUP_SCHEMA };
}

function classifyRequest() {
  return { systemInstruction: readPrompt('feedback/classifier.md'), contents: JSON.stringify(CLASSIFY_INPUT), schema: CLASSIFY_SCHEMA };
}

// --- Minimal validator for the Type-based schemas above ---

function validate(value: any, schema: any, at = '$'): string[] {
  const errs: string[] = [];
  const t = schema.type;
  if (value === null || value === undefined) {
    return schema.nullable ? [] : [`${at}: missing`];
  }
  if (t === Type.OBJECT) {
    if (typeof value !== 'object' || Array.isArray(value)) return [`${at}: not an object`];
    for (const k of schema.required ?? []) if (!(k in value)) errs.push(`${at}.${k}: required field missing`);
    for (const [k, sub] of Object.entries<any>(schema.properties ?? {})) if (k in value) errs.push(...validate(value[k], sub, `${at}.${k}`));
  } else if (t === Type.ARRAY) {
    if (!Array.isArray(value)) return [`${at}: not an array`];
    value.forEach((v, i) => errs.push(...validate(v, schema.items, `${at}[${i}]`)));
  } else if (t === Type.STRING) {
    if (typeof value !== 'string') errs.push(`${at}: not a string`);
    else if (schema.enum && !schema.enum.includes(value)) errs.push(`${at}: "${value}" not in enum`);
  } else if (t === Type.INTEGER) {
    if (!Number.isInteger(value)) errs.push(`${at}: not an integer`);
  } else if (t === Type.NUMBER) {
    if (typeof value !== 'number' || !Number.isFinite(value)) errs.push(`${at}: not a number`);
  }
  return errs;
}

// --- Probe plan ---

interface Probe {
  id: string;
  model: string;
  callType: string;
  variant: string; // what differs from the production request
  build: () => { systemInstruction: string; contents: string; schema: any };
  thinking?: { thinkingBudget?: number; thinkingLevel?: ThinkingLevel };
}

function plan(): Probe[] {
  const logic = readPrompt('system_prompts/logic.md');
  const basic = readPrompt('basic_prompt/basic.md');
  const probes: Probe[] = [];
  const add = (p: Omit<Probe, 'id'>) => probes.push({ id: `${p.model}:${p.callType}:${p.variant}`, ...p });

  for (const model of ['gemini-3.1-pro-preview', 'gemini-4-argon', 'gemini-3.8-flash']) {
    add({ model, callType: 'discovery', variant: 'logic,default', build: () => discoveryRequest('Logic', logic) });
    add({ model, callType: 'discovery', variant: 'basic,default', build: () => discoveryRequest('Basic', basic) });
    add({ model, callType: 'remediation', variant: 'logic,default', build: () => remediationRequest('Logic', logic) });
    add({ model, callType: 'deduplicate', variant: 'thinkingBudget=4096 (prod)', build: dedupRequest, thinking: { thinkingBudget: 4096 } });
    add({ model, callType: 'feedback_classify', variant: 'default', build: classifyRequest });
    if (model !== 'gemini-3.1-pro-preview') {
      add({ model, callType: 'discovery', variant: 'logic,LOW', build: () => discoveryRequest('Logic', logic), thinking: { thinkingLevel: ThinkingLevel.LOW } });
      add({ model, callType: 'discovery', variant: 'logic,HIGH', build: () => discoveryRequest('Logic', logic), thinking: { thinkingLevel: ThinkingLevel.HIGH } });
      add({ model, callType: 'deduplicate', variant: 'LOW', build: dedupRequest, thinking: { thinkingLevel: ThinkingLevel.LOW } });
    }
  }
  // tools/eval's judges hard-code this id; check what it is served as.
  add({ model: 'gemini-2.5-pro', callType: 'feedback_classify', variant: 'served-id check', build: classifyRequest });
  return probes;
}

// --- Runner ---

async function runOne(ai: GoogleGenAI, p: Probe): Promise<any> {
  const req = p.build();
  const config: any = { systemInstruction: req.systemInstruction, responseMimeType: 'application/json', responseSchema: req.schema };
  if (p.thinking) config.thinkingConfig = p.thinking;
  const start = Date.now();
  let timer: NodeJS.Timeout | undefined;
  try {
    const res: any = await Promise.race([
      ai.models.generateContent({ model: p.model, contents: req.contents, config }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`ETIMEDOUT after ${TIMEOUT_MS}ms`)), TIMEOUT_MS); }),
    ]).finally(() => clearTimeout(timer));
    const latencyMs = Date.now() - start;
    const text: string = res.text ?? '';
    const u = res.usageMetadata ?? {};
    let parsed: any; let parseError: string | undefined;
    try { parsed = JSON.parse(text); } catch (e: any) { parseError = String(e.message); }
    const schemaErrors = parsed === undefined ? [] : validate(parsed, req.schema);
    let visibleTextTokens: number | undefined;
    if (text) {
      try { visibleTextTokens = (await ai.models.countTokens({ model: p.model, contents: text })).totalTokens; } catch { /* countTokens is best-effort */ }
    }
    const sumParts = (u.promptTokenCount ?? 0) + (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0) + (u.toolUsePromptTokenCount ?? 0);
    const price = PRICES[p.model];
    const cost = (out: number) => price ? ((u.promptTokenCount ?? 0) * price.input + out * price.output) / 1e6 : undefined;
    return {
      ...p, build: undefined,
      ok: true, latencyMs, servedModel: res.modelVersion, finishReason: res.candidates?.[0]?.finishReason,
      usageMetadata: u,
      totalEqualsPromptPlusCandidatesPlusThoughts: u.totalTokenCount === sumParts,
      visibleTextTokens,
      costUsdCandidatesOnly: cost(u.candidatesTokenCount ?? 0),
      costUsdWithThoughts: cost((u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0)),
      parseError, schemaErrors, parsed, rawText: text,
    };
  } catch (e: any) {
    return { ...p, build: undefined, ok: false, latencyMs: Date.now() - start, error: String(e?.message ?? e), status: e?.status };
  }
}

async function main() {
  const args = process.argv.slice(2);
  const run = args.includes('--run');
  const outIdx = args.indexOf('--out');
  const out = outIdx >= 0 ? args[outIdx + 1] : path.join(__dirname, 'model-probe-runs', `model-probe-${new Date().toISOString().slice(0, 10)}.json`);
  const probes = plan();

  console.log(`${probes.length} generateContent calls (plus one free countTokens per response):`);
  for (const p of probes) console.log(`  ${p.id}${p.thinking ? ' ' + JSON.stringify(p.thinking) : ''}`);
  if (!run) { console.log('\nDry run. Pass --run to make the calls.'); return; }
  if (!process.env.GEMINI_API_KEY) throw new Error('GEMINI_API_KEY is not set');

  const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  // One sequential lane per model, lanes in parallel: latency is comparable within a model and the
  // run doesn't hammer any one model with concurrent requests.
  const lanes = new Map<string, Probe[]>();
  for (const p of probes) lanes.set(p.model, [...(lanes.get(p.model) ?? []), p]);
  const results: any[] = [];
  await Promise.all([...lanes.values()].map(async lane => {
    for (const p of lane) {
      const r = await runOne(ai, p);
      results.push(r);
      const u = r.usageMetadata ?? {};
      console.log(`${r.ok ? 'ok ' : 'ERR'} ${p.id} served=${r.servedModel ?? '-'} finish=${r.finishReason ?? '-'} ` +
        `${r.latencyMs}ms in=${u.promptTokenCount ?? '-'} cand=${u.candidatesTokenCount ?? '-'} thoughts=${u.thoughtsTokenCount ?? 0} ` +
        `total=${u.totalTokenCount ?? '-'} visible=${r.visibleTextTokens ?? '-'} parse=${r.parseError ? 'FAIL' : 'ok'} schemaErrs=${r.schemaErrors?.length ?? '-'}` +
        `${r.error ? ' error=' + r.error.slice(0, 200) : ''}`);
    }
  }));
  results.sort((a, b) => probes.findIndex(p => p.id === a.id) - probes.findIndex(p => p.id === b.id));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), knownFiles: KNOWN_FILES, fixedIssues: FIXED_ISSUES, results }, null, 2));
  console.log(`\nWrote ${out}`);
}

main().catch(e => { console.error(e); process.exit(1); });
