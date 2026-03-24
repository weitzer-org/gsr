// 
// Handles fetching GCS eval data, kicking off runs, and populating the UI.

export function initEvals() {
    const runEvalBtn = document.getElementById('run-eval-btn');
    const statusNotice = document.getElementById('run-status-notice');
    const runList = document.getElementById('run-list');
    const evalMain = document.getElementById('eval-main');

    const aggReportEl = document.getElementById('aggregate-report');
    const metricAInput = document.getElementById('metric-a-input');
    const metricAOutput = document.getElementById('metric-a-output');
    const metricACalls = document.getElementById('metric-a-calls');
    const metricBInput = document.getElementById('metric-b-input');
    const metricBOutput = document.getElementById('metric-b-output');
    const metricBCalls = document.getElementById('metric-b-calls');
    const labelATokens = document.getElementById('label-metric-a-tokens');
    const labelACalls = document.getElementById('label-metric-a-calls');
    const labelBTokens = document.getElementById('label-metric-b-tokens');
    const labelBCalls = document.getElementById('label-metric-b-calls');
    const runDateBadge = document.getElementById('run-date-badge');
    const prAccordion = document.getElementById('pr-accordion');

    const comparisonGroupSelect = document.getElementById('comparison-group');
    const branchNameInput = document.getElementById('branch-name');

    // UI Logic for Comparison Dropdown
    if (window.location.hostname.includes('run.app')) {
        // Remove local options if running in production
        for (let i = comparisonGroupSelect.options.length - 1; i >= 0; i--) {
            if (comparisonGroupSelect.options[i].value.includes('local')) {
                comparisonGroupSelect.remove(i);
            }
        }
        
        // Also remove local executor option
        const evalRunnerSelect = document.getElementById('eval-runner');
        for (let i = evalRunnerSelect.options.length - 1; i >= 0; i--) {
            if (evalRunnerSelect.options[i].value === 'local') {
                evalRunnerSelect.remove(i);
            }
        }
    }

    comparisonGroupSelect.addEventListener('change', (e) => {
        if (e.target.value.includes('branch')) {
            branchNameInput.classList.remove('hidden');
        } else {
            branchNameInput.classList.add('hidden');
        }
    });
    // Trigger initial state
    comparisonGroupSelect.dispatchEvent(new Event('change'));

    let currentLoadingFile = null;

    // Load available runs
    fetchRuns();

    runEvalBtn.addEventListener('click', async () => {
        runEvalBtn.disabled = true;
        statusNotice.textContent = "Starting evaluation harness in background...";
        statusNotice.classList.remove('hidden', 'success', 'error');
        statusNotice.classList.add('info');

        const comparisonGroup = comparisonGroupSelect.value;
        const branchName = branchNameInput.value.trim();
        const evalVersion = document.getElementById('eval-version').value;
        const evalRunner = document.getElementById('eval-runner').value;

        if (comparisonGroup.includes('branch') && !branchName) {
            statusNotice.textContent = "Error: Please specify a Branch Name.";
            statusNotice.classList.replace('info', 'error');
            runEvalBtn.disabled = false;
            return;
        }

        try {
            const res = await fetch('/api/evals/start', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ comparisonGroup, branchName, evalVersion, evalRunner })
            });

            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error(data.error || 'Failed to start evaluation');
            }

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

        // Safe metrics rendering, mapped dynamically
        const aggM = data.aggregate_metrics || { targetA: {}, targetB: {} };
        const labelALit = data.targetA_label || 'Local';
        const labelBLit = data.targetB_label || 'Production';

        labelATokens.textContent = `${labelALit} Tokens`;
        labelACalls.textContent = `${labelALit} LLM Calls`;
        labelBTokens.textContent = `${labelBLit} Tokens`;
        labelBCalls.textContent = `${labelBLit} LLM Calls`;

        metricAInput.textContent = aggM.targetA?.inputTokens || aggM.local?.inputTokens || 0;
        metricAOutput.textContent = aggM.targetA?.outputTokens || aggM.local?.outputTokens || 0;
        metricACalls.textContent = aggM.targetA?.calls || aggM.local?.calls || 0;

        metricBInput.textContent = aggM.targetB?.inputTokens || aggM.production?.inputTokens || 0;
        metricBOutput.textContent = aggM.targetB?.outputTokens || aggM.production?.outputTokens || 0;
        metricBCalls.textContent = aggM.targetB?.calls || aggM.production?.calls || 0;

        if (data.aggregate_report) {
            aggReportEl.innerHTML = marked.parse(data.aggregate_report);
        } else {
            aggReportEl.innerHTML = '<em>No aggregate summary generated for this run.</em>';
        }

        renderPRBreakdowns(data.results || [], labelALit, labelBLit);
    }

    function renderPRBreakdowns(results, labelALit, labelBLit) {
        prAccordion.innerHTML = '';
        results.forEach((r, idx) => {
            const taFindings = r.targetA?.findings || r.local?.findings || [];
            const tbFindings = r.targetB?.findings || r.production?.findings || [];

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
                                <h4>${labelALit} Findings (${taFindings.length})</h4>
                                ${buildFindingsHtml(taFindings)}
                            </div>
                            <div class="pane prod-pane">
                                <h4>${labelBLit} Findings (${tbFindings.length})</h4>
                                ${buildFindingsHtml(tbFindings)}
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
}

if (typeof document !== 'undefined' && typeof window !== 'undefined') {
    document.addEventListener('DOMContentLoaded', initEvals);
}
