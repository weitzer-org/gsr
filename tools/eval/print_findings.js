const fs = require('fs');
const data = JSON.parse(fs.readFileSync('pr24_findings.json', 'utf8'));

console.log('--- BASIC AGENT FINDINGS ---');
data.basicFindings.forEach((f, i) => {
    console.log(`\n[Basic ${i+1}] ${f.severity} in ${f.fileName || '?'}:${f.lineNumber || '?'}`);
    console.log(`Issue: ${f.issueDescription}`);
});

console.log('\n\n--- SUBAGENT FINDINGS ---');
data.findings.forEach((f, i) => {
    console.log(`\n[Subagent ${i+1}] ${f.severity.toUpperCase()} in ${f.fileName || '?'}:${f.lineNumber || '?'}`);
    console.log(`Issue: ${f.issueDescription}`);
});

console.log('\n\n--- COMPARISON EVALUATION ---');
console.log(data.comparisonEvaluation.reasoning);
