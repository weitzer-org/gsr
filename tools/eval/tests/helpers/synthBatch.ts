import { BatchData, Manifest, RunRecord, prSlug } from '../../batch';
import { ReviewFinding } from '../../api-client';
import { DiffChunk } from '../../validation';

export interface SynthOpts {
  arms?: Array<{ name: string; role?: 'baseline' | 'control' | 'candidate' }>;
  prs?: Array<{ url: string; size: 'small' | 'large' }>;
  reps?: number;
  // (arm, pr, rep, mode) -> number of findings to emit; default 5
  findingCount?: (arm: string, prUrl: string, rep: number, mode: 'basic' | 'subagent') => number;
  stageFor?: (arm: string, mode: 'basic' | 'subagent' | 'shared', stage: string) => Record<string, any>;
  servedModel?: (arm: string) => string;
  extraFindings?: (arm: string, prUrl: string, rep: number) => ReviewFinding[];
}

export const ARM_MODEL: Record<string, string> = { BASE: 'gemini-3.1-pro-preview', BASE2: 'gemini-3.1-pro-preview', CAND: 'gemini-4-argon', C2: 'gemini-3.8-flash' };

export function stageSummary(model: string, over: Record<string, any> = {}) {
  return {
    calls: 2, successes: 2, failures: 0, requestedModels: { [model]: 2 }, servedModels: { [model]: 2 }, servedModelUnreported: 0,
    servedModelMismatches: 0, finishReasons: { STOP: 2 }, maxTokens: 0, timeouts: 0, parseFailures: 0, errorKinds: {},
    thinkingTokens: 100, inputTokens: 10_000, outputTokens: 2_000, latencyMs: [100, 200], ...over,
  };
}

export function synthBatch(opts: SynthOpts = {}): BatchData {
  const arms = opts.arms ?? [{ name: 'BASE', role: 'baseline' }, { name: 'BASE2', role: 'control' }, { name: 'CAND', role: 'candidate' }];
  const prs = opts.prs ?? [
    ...[1, 2, 3, 4, 5, 6].map(n => ({ url: `https://github.com/o/r/pull/${n}`, size: 'small' as const })),
    ...[7, 8, 9, 10, 11, 12].map(n => ({ url: `https://github.com/o/r/pull/${n}`, size: 'large' as const })),
  ];
  const reps = opts.reps ?? 2;
  const nFind = opts.findingCount ?? (() => 5);
  const diffs = new Map<string, DiffChunk[]>();
  const manifest: Manifest = {
    schema: 1, batch_id: 'batch-synth', created_at: '2026-11-12T00:00:00Z',
    git: { commit: 'abc123', branch: 'test', dirty: false },
    environment: { node: 'v22', platform: 'linux', execution_mode: 'local-multi-backend', hostname_redacted: true },
    concurrency: { arms_in_flight: arms.length, per_backend: '2 orchestrators x pool of 5', note: 'synthetic' },
    arms: arms.map((a, i) => ({
      name: a.name, role: a.role, env: {}, port: 8100 + i,
      routing: { stageModels: { discovery: ARM_MODEL[a.name] ?? 'm', remediation: ARM_MODEL[a.name] ?? 'm', basic: ARM_MODEL[a.name] ?? 'm', deduplicate: ARM_MODEL[a.name] ?? 'm', evaluate: ARM_MODEL[a.name] ?? 'm' }, maxOutputTokens: 32768, thinkingLevel: null, contextCaching: false },
    })),
    baseline_arm: arms.find(a => a.role === 'baseline')!.name,
    control_arm: arms.find(a => a.role === 'control')?.name,
    prs: prs.map(p => ({ url: p.url, slug: prSlug(p.url), changed_files: p.size === 'large' ? 12 : 3, size_class: p.size, group: 'synth' })),
    excluded_prs: [], reps, seed: 1, start_order: {}, max_attempts: 3, attempt_timeout_ms: 1000, max_review_calls: 1000, settings: {},
  };
  for (const p of prs) {
    // Lines 1..40 of a.ts are "added" lines in the diff, so findings on lines 1..40 are valid.
    const lines = Array.from({ length: 40 }, (_, i) => `+line${i + 1}`).join('\n');
    diffs.set(prSlug(p.url), [{ file: 'a.ts', content: `@@ -0,0 +1,40 @@\n${lines}` }]);
  }
  const runs: RunRecord[] = [];
  for (const a of arms) for (const p of prs) for (let rep = 1; rep <= reps; rep++) {
    const model = opts.servedModel ? opts.servedModel(a.name) : ARM_MODEL[a.name] ?? 'm';
    const findings: ReviewFinding[] = [];
    for (const mode of ['basic', 'subagent'] as const) {
      const n = nFind(a.name, p.url, rep, mode);
      for (let i = 1; i <= n; i++) findings.push({ fileName: 'a.ts', lineNumber: i * 5, issueDescription: `f${i}`, suggestion: '', severity: i === 1 ? 'HIGH' : 'MEDIUM', source: mode });
    }
    findings.push(...(opts.extraFindings?.(a.name, p.url, rep) ?? []));
    const stage = (src: 'basic' | 'subagent' | 'shared', name: string) => stageSummary(ARM_MODEL[a.name] ?? 'm', { servedModels: { [model]: 2 }, ...(opts.stageFor?.(a.name, src, name) ?? {}) });
    runs.push({
      schema: 1, batch_id: 'batch-synth', arm: a.name, pr: p.url, pr_slug: prSlug(p.url), rep,
      attempts: [{ n: 1, started_at: 't', duration_ms: 1000, complete: true, outcome: 'success', flags: [], concurrent_arms: arms.length }],
      first_attempt_complete: true, first_attempt_clean: true, retries: 0, accepted_attempt: 1,
      result: {
        findings,
        metrics: {
          inputTokens: 1, outputTokens: 1, calls: 4, durationMs: 60_000,
          subagentMetrics: { durationMs: 50_000 }, basicMetrics: { durationMs: 40_000 },
          stages: { subagent: { discovery: stage('subagent', 'discovery'), deduplicate: stage('subagent', 'deduplicate') }, basic: { discovery: stage('basic', 'discovery') }, shared: { evaluate: stage('shared', 'evaluate') } },
        },
      },
    });
  }
  return { dir: '/synthetic', manifest, runs, diffs };
}
