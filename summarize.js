const fs = require('fs');

async function run() {
  const res = await fetch('http://localhost:8080/api/evals/results');
  const files = await res.json();
  const recent = files.slice(0, 3);
  
  for (const f of recent) {
    console.log(`\n\n=== RUN: ${f.name} ===\n`);
    const r = await fetch(`http://localhost:8080/api/evals/results/${f.name}`);
    const data = await r.json();
    console.log(`Target A: ${data.targetA_label}, Target B: ${data.targetB_label}`);
    console.log(`Metrics A: ${JSON.stringify(data.aggregate_metrics.targetA)}`);
    console.log(`Metrics B: ${JSON.stringify(data.aggregate_metrics.targetB)}`);
    console.log(`Report Snippet: ${data.aggregate_report?.slice(0, 500)}...`);
  }
}
run();
