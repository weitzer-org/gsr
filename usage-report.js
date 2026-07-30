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

function addToBucket(map, key, rec) {
  if (!key) return;
  if (!map[key]) {
    map[key] = { calls: 0, successCount: 0, failureCount: 0, inputTokens: 0, outputTokens: 0, costUsd: 0 };
  }
  const b = map[key];
  b.calls++;
  if (rec.success) b.successCount++; else b.failureCount++;
  b.inputTokens += rec.inputTokens || 0;
  b.outputTokens += rec.outputTokens || 0;
  b.costUsd += rec.costUsd || 0;
}

// aggregate mirrors adk/backend/src/usage.ts's `aggregate` function — kept
// as a separate, plain-JS copy here rather than importing the compiled TS
// output, matching this directory's existing convention for ad hoc scripts
// (list-gcs.js, summarize.js are similarly self-contained). Keep the two in
// sync if the Rollup/Record shape changes.
function aggregate(date, records) {
  const rollup = {
    date, totalCalls: 0, successCount: 0, failureCount: 0,
    totalInputTokens: 0, totalOutputTokens: 0, totalCostUsd: 0, avgLatencyMs: 0,
    byCallType: {}, byModel: {}, byErrorKind: {},
  };
  let totalLatencyMs = 0;
  for (const rec of records) {
    rollup.totalCalls++;
    if (rec.success) {
      rollup.successCount++;
    } else {
      rollup.failureCount++;
      if (rec.errorKind) rollup.byErrorKind[rec.errorKind] = (rollup.byErrorKind[rec.errorKind] || 0) + 1;
    }
    rollup.totalInputTokens += rec.inputTokens || 0;
    rollup.totalOutputTokens += rec.outputTokens || 0;
    rollup.totalCostUsd += rec.costUsd || 0;
    totalLatencyMs += rec.latencyMs || 0;
    addToBucket(rollup.byCallType, rec.callType, rec);
    addToBucket(rollup.byModel, rec.model, rec);
  }
  if (rollup.totalCalls > 0) rollup.avgLatencyMs = totalLatencyMs / rollup.totalCalls;
  return rollup;
}

async function listRecordsForDate(date) {
  const files = await listFiles(`usage/${date}/`);
  const records = [];
  for (const f of files) {
    try {
      records.push(await downloadJson(f.name));
    } catch (err) {
      console.error(`Failed to read/parse ${f.name}:`, err.message);
    }
  }
  return records;
}

function printBuckets(label, map) {
  const keys = Object.keys(map).sort();
  if (keys.length === 0) return;
  console.log(`${label}:`);
  for (const k of keys) {
    const b = map[k];
    console.log(`  ${k.padEnd(20)} calls=${b.calls} success=${b.successCount} failure=${b.failureCount} input=${b.inputTokens} output=${b.outputTokens} cost=$${b.costUsd.toFixed(4)}`);
  }
}

function printRollup(r) {
  console.log(`=== ${r.date} ===`);
  console.log(`Calls: ${r.totalCalls} (success=${r.successCount}, failure=${r.failureCount})`);
  console.log(`Tokens: input=${r.totalInputTokens} output=${r.totalOutputTokens}`);
  console.log(`Cost: $${r.totalCostUsd.toFixed(4)}`);
  console.log(`Avg latency: ${r.avgLatencyMs.toFixed(0)}ms`);
  printBuckets('By call type', r.byCallType);
  printBuckets('By model', r.byModel);
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
