// Per-stage summary of what the Gemini calls inside one review actually did:
// which models were requested, which model SERVED them, how they finished.
// Built from the same UsageRecords trackGeminiCall already produces, in
// process, and returned in the /api/review `done` frame's metrics so an eval
// harness can see served-model mismatches, MAX_TOKENS truncations, timeouts
// and parse failures per stage without reading object storage.
//
// Stages are the usage callTypes: discovery, remediation, legacy (the
// USE_TRIAGE_AGENT=false per-file path), deduplicate, evaluate. Two
// collectors exist per review — one per orchestrator ("subagent" swarm,
// "basic") — because both run discovery/remediation and they must not be
// pooled (basic findings skip dedup and are what consumer repos run).
import type { UsageRecord } from './usage';

export interface StageSummary {
  calls: number;            // records observed (successes + API failures + parse failures)
  successes: number;        // records with success=true
  failures: number;         // records with success=false (API errors and parse failures)
  requestedModels: Record<string, number>;
  servedModels: Record<string, number>;       // only records that reported a modelVersion
  servedModelUnreported: number;              // successful calls with no modelVersion
  servedModelMismatches: number;              // strict: served id != requested id (after "models/" strip)
  finishReasons: Record<string, number>;
  maxTokens: number;        // finishReason === 'MAX_TOKENS'
  timeouts: number;         // client-side ETIMEDOUT (agent/deduplicator Promise.race) + errorKind 'timeout'
  parseFailures: number;    // JSON.parse failures on a response that itself succeeded (annotation; not an extra call)
  errorKinds: Record<string, number>;
  thinkingTokens: number;
  inputTokens: number;
  outputTokens: number;
  latencyMs: number[];      // per-call latency, for percentiles
}

export type StageMetrics = Record<string, StageSummary>;

function emptySummary(): StageSummary {
  return {
    calls: 0, successes: 0, failures: 0,
    requestedModels: {}, servedModels: {}, servedModelUnreported: 0, servedModelMismatches: 0,
    finishReasons: {}, maxTokens: 0, timeouts: 0, parseFailures: 0, errorKinds: {},
    thinkingTokens: 0, inputTokens: 0, outputTokens: 0, latencyMs: [],
  };
}

const UNSAFE = new Set(['__proto__', 'constructor', 'prototype']);

function bump(m: Record<string, number>, key: string | undefined): void {
  if (!key || UNSAFE.has(key)) return;
  m[key] = (Object.prototype.hasOwnProperty.call(m, key) ? m[key] : 0) + 1;
}

export function stripModelsPrefix(model: string): string {
  return model.replace(/^models\//, '');
}

export class StageCollector {
  private stages = new Map<string, StageSummary>();

  private get(stage: string): StageSummary {
    let s = this.stages.get(stage);
    if (!s) {
      s = emptySummary();
      this.stages.set(stage, s);
    }
    return s;
  }

  observe(record: UsageRecord): void {
    const s = this.get(record.callType);
    // recordParseFailure() writes a SECOND record for a call trackGeminiCall already recorded as a
    // success (same tokens, latency, finishReason, servedModel; cost 0). It only annotates that
    // call, so counting it as another call would double every figure above.
    if (record.errorKind === 'parse_error') {
      s.parseFailures++;
      bump(s.errorKinds, 'parse_error');
      return;
    }
    s.calls++;
    if (record.success) s.successes++; else s.failures++;
    bump(s.requestedModels, stripModelsPrefix(record.model));
    if (record.success) {
      if (record.servedModel) {
        const served = stripModelsPrefix(record.servedModel);
        bump(s.servedModels, served);
        if (served !== stripModelsPrefix(record.model)) s.servedModelMismatches++;
      } else {
        s.servedModelUnreported++;
      }
    }
    bump(s.finishReasons, record.finishReason);
    if (record.finishReason === 'MAX_TOKENS') s.maxTokens++;
    if (record.errorKind === 'timeout') s.timeouts++;
    if (!record.success) bump(s.errorKinds, record.errorKind ?? 'unknown');
    s.thinkingTokens += record.thinkingTokens ?? 0;
    s.inputTokens += record.inputTokens;
    s.outputTokens += record.outputTokens;
    s.latencyMs.push(record.latencyMs);
  }

  // A client-side timeout: the agent's Promise.race gave up on a call whose
  // own tracked record has not been written (and may never be, or arrives
  // later as a success). Counted separately so the stage still shows it.
  timeout(stage: string, model: string): void {
    const s = this.get(stage);
    s.timeouts++;
    bump(s.errorKinds, 'client_timeout');
    bump(s.requestedModels, stripModelsPrefix(model));
  }

  summary(): StageMetrics {
    const out: StageMetrics = {};
    for (const [stage, s] of this.stages) out[stage] = { ...s, latencyMs: [...s.latencyMs] };
    return out;
  }
}
