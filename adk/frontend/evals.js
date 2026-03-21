// evals.js
// Handles fetching GCS eval data, kicking off runs, and populating the UI.

document.addEventListener('DOMContentLoaded', () => {
    const runEvalBtn = document.getElementById('run-eval-btn');
    const statusNotice = document.getElementById('run-status-notice');
    const runList = document.getElementById('run-list');
    const evalMain = document.getElementById('eval-main');

    const aggReportEl = document.getElementById('aggregate-report');
    const metricLocalInput = document.getElementById('metric-local-input');
    const metricLocalOutput = document.getElementById('metric-local-output');
    const metricLocalCalls = document.getElementById('metric-local-calls');
    const metricProdInput = document.getElementById('metric-prod-input');
    const metricProdOutput = document.getElementById('metric-prod-output');
    const metricProdCalls = document.getElementById('metric-prod-calls');
    const runDateBadge = document.getElementById('run-date-badge');
    const prAccordion = document.getElementById('pr-accordion');

    let currentLoadingFile = null;

    // Load available runs
    fetchRuns();

    runEvalBtn.addEventListener('click', async () => {
        runEvalBtn.disabled = true;
        statusNotice.textContent = "Starting evaluation harness in background...";
        statusNotice.classList.remove('hidden', 'success', 'error');
        statusNotice.classList.add('info');

        try {
            const res = await fetch('/api/evals/start', { method: 'POST' });
            if (!res.ok) throw new Error('Failed to start evaluation');

            statusNotice.textContent = "Harness running... Check back in ~3-5 mins for new results.";
            statusNotice.classList.replace('info', 'success');
        } catch (e) {
            statusNotice.textContent = "Error: " + e.message;
            statusNotice.classList.replace('info', 'error');
            runEvalBtn.disabled = false;
        }
    });

    async function fetchRuns() {
        try {
            const res = await fetch('/api/evals/results');
            if (!res.ok) throw new Error('Failed to fetch run list');
            const data = await res.json();
            renderRunList(data);
        } catch (e) {
            runList.innerHTML = `<li class="error-msg">Error loading history: ${e.message}</li>`;
        }
    }

    function renderRunList(files) {
        runList.innerHTML = '';
        if (files.length === 0) {
            runList.innerHTML = '<li>No eval runs found.</li>';
            return;
        }

        files.forEach((file) => {
            const li = document.createElement('li');
            li.className = 'run-item';
            li.innerHTML = `
                <div class="run-title">${new Date(file.updated).toLocaleString()}</div>
                <div class="run-meta">${(file.size / 1024).toFixed(1)} KB</div>
            `;
            li.addEventListener('click', () => loadRunData(file.name, li));
            runList.appendChild(li);
        });
    }

    async function loadRunData(fileName, listItemElement) {
        if (currentLoadingFile === fileName) return;
        currentLoadingFile = fileName;

        // Visual selection
        document.querySelectorAll('.run-item').forEach(el => el.classList.remove('active'));
        if (listItemElement) listItemElement.classList.add('active');

        evalMain.classList.remove('hidden');
        aggReportEl.innerHTML = '<div class="spinner"></div> Loading report...';
        prAccordion.innerHTML = '';

        try {
            const res = await fetch(`/api/evals/results/${encodeURIComponent(fileName)}`);
            if (!res.ok) throw new Error('Failed to fetch specific run data');
            const data = await res.json();
            
            renderDashboard(data);
        } catch (e) {
            aggReportEl.innerHTML = `<div class="error-msg">Error: ${e.message}</div>`;
        }
    }

    function renderDashboard(data) {
        runDateBadge.textContent = new Date(data.run_date).toLocaleString();

        // Safe metrics rendering
        const aggM = data.aggregate_metrics || { local: {}, production: {} };
        metricLocalInput.textContent = aggM.local.inputTokens || 0;
        metricLocalOutput.textContent = aggM.local.outputTokens || 0;
        metricLocalCalls.textContent = aggM.local.calls || 0;

        metricProdInput.textContent = aggM.production.inputTokens || 0;
        metricProdOutput.textContent = aggM.production.outputTokens || 0;
        metricProdCalls.textContent = aggM.production.calls || 0;

        if (data.aggregate_report) {
            aggReportEl.innerHTML = marked.parse(data.aggregate_report);
        } else {
            aggReportEl.innerHTML = '<em>No aggregate summary generated for this run.</em>';
        }

        renderPRBreakdowns(data.results || []);
    }

    function renderPRBreakdowns(results) {
        prAccordion.innerHTML = '';
        results.forEach((r, idx) => {
            const detailStr = `
                <details class="pr-detail">
                    <summary class="pr-summary">
                        <h3>PR #${idx + 1}: ${r.prUrl.split('/').pop()}</h3>
                        <span class="pr-arrow">▼</span>
                    </summary>
                    <div class="pr-content">
                        <div class="pr-llm-comparison markdown-body">
                            <h4>Targeted LLM Comparison Report</h4>
                            ${marked.parse(r.llm_comparison_report || 'No specific comparison report generated.')}
                        </div>
                        <div class="pr-split-pane">
                            <div class="pane local-pane">
                                <h4>Local Findings (${r.local.findings ? r.local.findings.length : 0})</h4>
                                ${buildFindingsHtml(r.local.findings || [])}
                            </div>
                            <div class="pane prod-pane">
                                <h4>Production Findings (${r.production.findings ? r.production.findings.length : 0})</h4>
                                ${buildFindingsHtml(r.production.findings || [])}
                            </div>
                        </div>
                    </div>
                </details>
            `;
            prAccordion.insertAdjacentHTML('beforeend', detailStr);
        });
    }

    function buildFindingsHtml(findings) {
        if (!findings || findings.length === 0) return '<em>No findings found.</em>';
        let html = '<ul class="finding-list">';
        findings.forEach(f => {
            const badgeClass = `severity-${f.severity.toLowerCase()}`;
            html += `
                <li class="finding-item">
                    <div class="finding-header">
                        <span class="finding-file">${f.file}:${f.line}</span>
                        <span class="finding-severity ${badgeClass}">${f.severity}</span>
                    </div>
                    <div class="finding-title">${f.description.split('.')[0]}.</div>
                    <p class="finding-desc">${f.description}</p>
                </li>
            `;
        });
        html += '</ul>';
        return html;
    }
});
