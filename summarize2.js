const fs = require('fs');
async function run() {
  const r = await fetch('http://localhost:8080/api/evals/results/eval-run_2026-03-21T13-24-42-810Z.json');
  const d = await r.json();
  console.log(d.aggregate_report);
}
run();
