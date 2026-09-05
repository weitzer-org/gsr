#!/usr/bin/env node
// Summarizes the per-call LLM token/latency/cost/error records
// adk/backend/src/usage.ts writes to S3_REVIEW_BUCKET under usage/<date>/ —
// see docs/usage_analytics_reference.md for the full schema and query
// recipes. This is a manual, on-demand tool, not something the app runs
// automatically or on a schedule.
//
// Usage:
//   node usage-report.js                                  # today, UTC
//   node usage-report.js --date 2026-07-29
//   node usage-report.js --from 2026-07-23 --to 2026-07-29
//   node usage-report.js --date 2026-07-29 --write-rollup  # also persist
//
// --write-rollup additionally persists each date's computed summary to
// usage/rollups/<date>.json so a future dashboard can read one small object
// instead of re-listing/re-reading every call record for that day.
// Report-only (writes nothing) by default.
const { listFiles, downloadJson, uploadJson } = require('./tools/eval/usage-report-client');

// mapWithConcurrency mirrors adk/backend/src/pool.ts's PromisePool usage —
// this script has no TS build step to import that class directly, so it's a
// minimal inline equivalent: bounded-concurrency reads instead of one
// downloadJson per file awaited sequentially, which turns into a
// multi-second-or-worse fetch on a heavy-usage day.
async function mapWithConcurrency(items, concurrency, fn) {
  const results = new Array(items.length);
  let next = 0;
  async function worker() {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, worker));
  return results;
}

function parseArgs(argv) {
  const args = { writeRollup: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--date') args.date = argv[++i];
    else if (a === '--from') args.from = argv[++i];
    else if (a === '--to') args.to = argv[++i];
    else if (a === '--write-rollup') args.writeRollup = true;
  }
  return args;
}

// resolveDates turns the CLI's mutually-exclusive --date / --from+--to flags
// into an explicit list of "YYYY-MM-DD" strings to look up, one per day in
// the requested range.
function resolveDates({ date, from, to }) {
  if (date && (from || to)) throw new Error('--date is mutually exclusive with --from/--to');
  if (date) return [date];
  if (from && to) {
    const start = new Date(`${from}T00:00:00Z`);
    const end = new Date(`${to}T00:00:00Z`);
    if (Number.isNaN(start.getTime())) throw new Error(`invalid --from ${JSON.stringify(from)} (expected YYYY-MM-DD)`);
    if (Number.isNaN(end.getTime())) throw new Error(`invalid --to ${JSON.stringify(to)} (expected YYYY-MM-DD)`);
    if (end < start) throw new Error(`--to (${to}) is before --from (${from})`);
    const dates = [];
    for (let d = start; d <= end; d = new Date(d.getTime() + 86400000)) {
      dates.push(d.toISOString().slice(0, 10));
    }
    return dates;
  }
  if (from || to) throw new Error('--from and --to must be used together');
  return [new Date().toISOString().slice(0, 10)];
}

// Bumped in lockstep with adk/backend/src/usage.ts's CURRENT_SCHEMA_VERSION
// — the API's getOrBuildDayRollup() treats a cached usage/rollups/<date>.json
// with a stale schemaVersion as untrustworthy and rebuilds it, which is what
// keeps a --write-rollup run here from silently reintroducing an old-shape
// rollup if this copy ever falls behind usage.ts's.
const SCHEMA_VERSION = 6;
const UNTAGGED_REPOSITORY_LABEL = 'gsr (hosted)';

// Mirrors adk/backend/src/usage.ts's KNOWN_REVIEW_CALL_TYPES allowlist —
// keep both in sync. See that file's comment for the invariant (must never
// overlap with any ingested source's own callType vocabulary).
const KNOWN_REVIEW_CALL_TYPES = new Set([
  'legacy',
  'discovery',
  'remediation',
  'deduplicate',
  'feedback_classify',
  'feedback_adjudicate',
  'debug_test_deduplicator',
  'debug_single',
]);

function workloadOf(rec) {
  if (rec.callType === 'evaluate' || (typeof rec.callType === 'string' && rec.callType.startsWith('llm_compare'))) {
    return 'eval';
  }
  if (KNOWN_REVIEW_CALL_TYPES.has(rec.callType)) return 'review';
  return 'product';
}

// See adk/backend/src/usage.ts's addToBucket comment: `key` comes from
// record fields read straight out of S3 JSON objects, which could in
// principle be `__proto__` — for a plain object literal that's a live
// accessor to the real, process-wide Object.prototype, so `!map[key]` would
// be falsy (skipping init) and `b.calls++` would corrupt every plain object
// in the process. Guard against it and use hasOwnProperty instead of a
// truthiness check.
const UNSAFE_BUCKET_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

// Same guard, for byErrorKind's plain Record<string, number> shape.
function incrementCount(map, key, by) {
  if (!key || UNSAFE_BUCKET_KEYS.has(key)) return;
  const current = Object.prototype.hasOwnProperty.call(map, key) ? map[key] : 0;
  map[key] = current + by;
}

function addToBucket(map, key, rec) {
  if (!key || UNSAFE_BUCKET_KEYS.has(key)) return;
  if (!Object.prototype.hasOwnProperty.call(map, key)) {
    map[key] = { calls: 0, successCount: 0, failureCount: 0, inputTokens: 0, outputTokens: 0, thinkingTokens: 0, costUsd: 0 };
  }
  const b = map[key];
  b.calls++;
  if (rec.success) b.successCount++; else b.failureCount++;
  b.inputTokens += rec.inputTokens || 0;
  b.outputTokens += rec.outputTokens || 0;
  b.thinkingTokens += rec.thinkingTokens || 0;
  b.costUsd += rec.costUsd || 0;
}

// aggregate mirrors adk/backend/src/usage.ts's `aggregate` function — kept
// as a separate, plain-JS copy here rather than importing the compiled TS
// output, matching this directory's existing convention for ad hoc scripts
// (list-gcs.js, summarize.js are similarly self-contained). Keep the two in
// sync if the Rollup/Record shape changes.
function aggregate(date, records) {
  const rollup = {
    schemaVersion: SCHEMA_VERSION,
    date, totalCalls: 0, successCount: 0, failureCount: 0,
    totalInputTokens: 0, totalOutputTokens: 0, totalThinkingTokens: 0, totalCostUsd: 0,
    totalLatencyMs: 0, avgLatencyMs: 0,
    byCallType: {}, byModel: {}, byErrorKind: {},
    byRepository: {}, byWorkload: {},
    byModelRepository: {}, byModelWorkload: {}, byRepositoryWorkload: {},
  };
  for (const rec of records) {
    rollup.totalCalls++;
    if (rec.success) {
      rollup.successCount++;
    } else {
      rollup.failureCount++;
      incrementCount(rollup.byErrorKind, rec.errorKind, 1);
    }
    rollup.totalInputTokens += rec.inputTokens || 0;
    rollup.totalOutputTokens += rec.outputTokens || 0;
    rollup.totalThinkingTokens += rec.thinkingTokens || 0;
    rollup.totalCostUsd += rec.costUsd || 0;
    rollup.totalLatencyMs += rec.latencyMs || 0;

    const repository = rec.repository || UNTAGGED_REPOSITORY_LABEL;
    const workload = workloadOf(rec);
    addToBucket(rollup.byCallType, rec.callType, rec);
    addToBucket(rollup.byModel, rec.model, rec);
    addToBucket(rollup.byRepository, repository, rec);
    addToBucket(rollup.byWorkload, workload, rec);
    addToBucket(rollup.byModelRepository, `${rec.model}|${repository}`, rec);
    addToBucket(rollup.byModelWorkload, `${rec.model}|${workload}`, rec);
    addToBucket(rollup.byRepositoryWorkload, `${repository}|${workload}`, rec);
  }
  if (rollup.totalCalls > 0) rollup.avgLatencyMs = rollup.totalLatencyMs / rollup.totalCalls;
  return rollup;
}

async function listRecordsForDate(date) {
  const files = await listFiles(`usage/${date}/`);
  const results = await mapWithConcurrency(files, 20, async (f) => {
    try {
      return await downloadJson(f.name);
    } catch (err) {
      console.error(`Failed to read/parse ${f.name}:`, err.message);
      return undefined;
    }
  });
  return results.filter((r) => r !== undefined);
}

function printBuckets(label, map) {
  const keys = Object.keys(map).sort();
  if (keys.length === 0) return;
  console.log(`${label}:`);
  for (const k of keys) {
    const b = map[k];
    console.log(`  ${k.padEnd(30)} calls=${b.calls} success=${b.successCount} failure=${b.failureCount} input=${b.inputTokens} output=${b.outputTokens} thinking=${b.thinkingTokens} cost=$${b.costUsd.toFixed(4)}`);
  }
}

function printRollup(r) {
  console.log(`=== ${r.date} ===`);
  console.log(`Calls: ${r.totalCalls} (success=${r.successCount}, failure=${r.failureCount})`);
  console.log(`Tokens: input=${r.totalInputTokens} output=${r.totalOutputTokens} thinking=${r.totalThinkingTokens}`);
  console.log(`Cost: $${r.totalCostUsd.toFixed(4)}`);
  console.log(`Avg latency: ${r.avgLatencyMs.toFixed(0)}ms`);
  printBuckets('By call type', r.byCallType);
  printBuckets('By model', r.byModel);
  printBuckets('By repository (consuming project)', r.byRepository);
  printBuckets('By workload', r.byWorkload);
  const errKeys = Object.keys(r.byErrorKind).sort();
  if (errKeys.length > 0) {
    console.log('By error kind:');
    for (const k of errKeys) console.log(`  ${k.padEnd(20)} ${r.byErrorKind[k]}`);
  }
  console.log('');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  let dates;
  try {
    dates = resolveDates(args);
  } catch (err) {
    console.error(`usage-report: ${err.message}`);
    process.exit(1);
  }

  const combined = [];
  for (const date of dates) {
    const records = await listRecordsForDate(date);
    const rollup = aggregate(date, records);
    printRollup(rollup);
    combined.push(...records);

    if (args.writeRollup) {
      await uploadJson(`usage/rollups/${date}.json`, rollup);
      console.log(`(rollup written to usage/rollups/${date}.json)\n`);
    }
  }

  if (dates.length > 1) {
    console.log('=== Combined ===');
    printRollup(aggregate(`${dates[0]}..${dates[dates.length - 1]}`, combined));
  }
}

main().catch(err => {
  console.error('usage-report failed:', err);
  process.exit(1);
});
