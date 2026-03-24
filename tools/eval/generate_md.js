const fs = require('fs');
const data = JSON.parse(fs.readFileSync('pr24_findings.json', 'utf8'));

let md = `# PR 24 - Code Review Findings\n\n`;

md += `## 🤖 Basic Agent Findings (${data.findings.filter(f => f.source === 'basic').length})\n\n`;
data.findings.filter(f => f.source === 'basic').forEach((f, i) => {
    md += `### [${i+1}] ${f.severity || f.Severity || 'Unknown'} - ${f.file || f.fileName || 'General'}:${f.line || f.lineNumber || 'N/A'}\n`;
    md += `**Description:** ${f.description || f.issueDescription || f.issue || f.summary || ''}\n\n`;
    md += `**Suggestion:**\n${f.suggestion || ''}\n\n`;
});

md += `## 🚀 Subagent Findings (${data.findings.filter(f => f.source === 'subagent').length})\n\n`;
data.findings.filter(f => f.source === 'subagent').forEach((f, i) => {
    md += `### [${i+1}] ${f.severity || f.Severity || 'Unknown'} - ${f.file || f.fileName || 'General'}:${f.line || f.lineNumber || 'N/A'} (Agent: ${f.agent || 'Deduplicator'})\n`;
    md += `**Description:** ${f.description || f.issueDescription || f.issue || f.summary || ''}\n\n`;
    md += `**Suggestion:**\n${f.suggestion || ''}\n\n`;
});

md += `## ⚖️ Evaluator Comparison Summary\n\n`;
md += `${data.evaluation}\n`;

fs.writeFileSync('pr24_review.md', md);
