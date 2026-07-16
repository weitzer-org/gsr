import { escapeHTML, parseStreamChunk, authFetch, wireLogoutLink } from './utils.js';

export function initApp() {

  wireLogoutLink();

  const form = document.getElementById('review-form');
  const submitBtn = document.getElementById('submit-btn');
  const btnText = document.querySelector('.btn-text');
  const spinner = document.querySelector('.spinner');
  const resultsContainer = document.getElementById('results-container');
  
  // Tab Elements
  const tabs = document.querySelectorAll('.tab-btn');
  const tabContents = document.querySelectorAll('.tab-content');
  
  // Findings Lists
  const subagentFindingsList = document.getElementById('subagent-findings-list');
  const basicFindingsList = document.getElementById('basic-findings-list');

  // Comparison
  const comparisonTableBody = document.getElementById('comparison-table-body');
  const comparisonTable = document.getElementById('comparison-table');
  const comparisonEvaluationPanel = document.getElementById('comparison-evaluation');
  const evaluationText = document.getElementById('evaluation-text');

  // History
  const historyContainer = document.getElementById('history-container');
  const historyList = document.getElementById('history-list');
  const refreshHistoryBtn = document.getElementById('refresh-history-btn');
  const viewMoreHistoryBtn = document.getElementById('view-more-history-btn');

  // Agent selection
  const agentCheckboxList = document.getElementById('agent-checkbox-list');
  const agentSelectToggle = document.getElementById('agent-select-toggle');
  const agentSelectionError = document.getElementById('agent-selection-error');

  let fullHistoryData = [];
  let currentHistoryLimit = 5;

  // Tab Setup
  tabs.forEach(tab => {
      tab.addEventListener('click', () => {
          tabs.forEach(t => t.classList.remove('active'));
          tabContents.forEach(c => c.classList.remove('active'));
          
          tab.classList.add('active');
          document.getElementById(tab.dataset.tab).classList.add('active');
      });
  });
  // Using relative URLs for production deployment
  const API_URL = '/api/review';
  const STATUS_URL = '/api/status';

  const statusBadge = document.getElementById('connection-status');
  const statusText = statusBadge.querySelector('.status-text');

  async function checkApiStatus() {
      try {
          const response = await fetch(STATUS_URL);
          const data = await response.json();
          
          statusBadge.classList.remove('checking');
          if (data.geminiConnected) {
              statusBadge.classList.add('connected');
              statusText.textContent = `Connected (${data.model})`;
          } else {
              statusBadge.classList.add('disconnected');
              statusText.textContent = 'Disconnected (Missing Key)';
          }
      } catch (error) {
          statusBadge.classList.remove('checking');
          statusBadge.classList.add('disconnected');
          statusText.textContent = 'Backend API: Offline';
      }
  }

  async function fetchAgents() {
      try {
          const response = await authFetch('/api/agents');
          if (!response.ok) throw new Error('Failed to fetch agent list');
          const data = await response.json();
          renderAgentCheckboxes(data.agents || []);
      } catch (err) {
          console.error('Failed to fetch agents', err);
          agentCheckboxList.innerHTML = '<small class="error-text">Could not load agent list — the full swarm will run.</small>';
      }
  }

  function renderAgentCheckboxes(agents) {
      agentCheckboxList.innerHTML = '';
      agents.forEach(({ id, displayName }) => {
          const label = document.createElement('label');
          label.className = 'agent-checkbox-item checked';

          const checkbox = document.createElement('input');
          checkbox.type = 'checkbox';
          checkbox.value = id;
          checkbox.checked = true;
          checkbox.addEventListener('change', () => {
              label.classList.toggle('checked', checkbox.checked);
              updateAgentSelectToggleLabel();
              validateAgentSelection();
          });

          label.appendChild(checkbox);
          label.appendChild(document.createTextNode(displayName));
          agentCheckboxList.appendChild(label);
      });
      updateAgentSelectToggleLabel();
      validateAgentSelection();
  }

  function getAgentCheckboxes() {
      return Array.from(agentCheckboxList.querySelectorAll('input[type="checkbox"]'));
  }

  function getSelectedAgentIds() {
      return getAgentCheckboxes().filter(cb => cb.checked).map(cb => cb.value);
  }

  function updateAgentSelectToggleLabel() {
      if (!agentSelectToggle) return;
      const checkboxes = getAgentCheckboxes();
      const allChecked = checkboxes.length > 0 && checkboxes.every(cb => cb.checked);
      agentSelectToggle.textContent = allChecked ? 'Select None' : 'Select All';
  }

  // Omits `agents` entirely when every available agent is selected, so the
  // default request is identical to the pre-agent-selection payload.
  function buildReviewPayload(url, pat) {
      const checkboxes = getAgentCheckboxes();
      const selectedIds = getSelectedAgentIds();
      const isFullSelection = checkboxes.length === 0 || selectedIds.length === checkboxes.length;
      return isFullSelection ? { url, pat } : { url, pat, agents: selectedIds };
  }

  function validateAgentSelection() {
      const checkboxes = getAgentCheckboxes();
      // No checkboxes means the /api/agents fetch failed — fall back to running
      // the full swarm rather than hard-blocking submission.
      const anySelected = checkboxes.length === 0 || getSelectedAgentIds().length > 0;
      if (agentSelectionError) agentSelectionError.classList.toggle('hidden', anySelected);
      if (submitBtn) submitBtn.disabled = !anySelected;
      return anySelected;
  }

  if (agentSelectToggle) {
      agentSelectToggle.addEventListener('click', () => {
          const checkboxes = getAgentCheckboxes();
          const allChecked = checkboxes.length > 0 && checkboxes.every(cb => cb.checked);
          const nextChecked = !allChecked;
          checkboxes.forEach(cb => {
              cb.checked = nextChecked;
              cb.closest('.agent-checkbox-item').classList.toggle('checked', nextChecked);
          });
          updateAgentSelectToggleLabel();
          validateAgentSelection();
      });
  }

  // Check immediately on load
  checkApiStatus();
  fetchHistory();
  fetchAgents();

  if (refreshHistoryBtn) {
      refreshHistoryBtn.addEventListener('click', fetchHistory);
  }

  if (viewMoreHistoryBtn) {
      viewMoreHistoryBtn.addEventListener('click', () => {
          currentHistoryLimit += 10;
          renderHistoryList();
      });
  }

  async function fetchHistory() {
      try {
          const response = await authFetch('/api/review/history');
          const data = await response.json();
          if (data && data.length > 0) {
              fullHistoryData = data;
              historyContainer.classList.remove('hidden');
              renderHistoryList();
              
              // If results container is hidden (first load), optionally load the latest
              if (resultsContainer.classList.contains('hidden')) {
                  loadHistoricalReview(data[0].name);
              }
          } else {
              historyContainer.classList.add('hidden');
          }
      } catch (err) {
          console.error("Failed to fetch history", err);
      }
  }

  function renderHistoryList() {
      historyList.innerHTML = '';
      
      const visibleData = fullHistoryData.slice(0, currentHistoryLimit);
      
      visibleData.forEach(item => {
          const div = document.createElement('div');
          div.className = 'history-item';
          div.dataset.id = item.name;
          
          let displayUrl = item.originalUrl;
          if (!displayUrl) {
              const urlMatch = item.name.match(/review-run_.*_(.*?)\.json/);
              displayUrl = urlMatch ? urlMatch[1] : item.name;
          }
          
          const date = new Date(item.updated).toLocaleString();

          div.innerHTML = `
             <div class="history-item-url" title="${displayUrl}">${displayUrl}</div>
             <div class="history-item-date">${date}</div>
          `;

          div.addEventListener('click', () => {
              document.querySelectorAll('.history-item').forEach(el => el.classList.remove('active'));
              div.classList.add('active');
              loadHistoricalReview(item.name);
          });
          historyList.appendChild(div);
      });

      // Handle View More button visibility
      if (viewMoreHistoryBtn) {
          viewMoreHistoryBtn.classList.remove('hidden');
          if (fullHistoryData.length > currentHistoryLimit) {
              viewMoreHistoryBtn.disabled = false;
              viewMoreHistoryBtn.textContent = 'View More';
          } else {
              viewMoreHistoryBtn.disabled = true;
              viewMoreHistoryBtn.textContent = 'No More Reviews';
          }
      }
  }

  async function loadHistoricalReview(id) {
      try {
          resultsContainer.classList.add('hidden');
          const response = await authFetch(`/api/review/history/${id}`);
          if (!response.ok) throw new Error("Failed to fetch review data");
          const data = await response.json();
          renderReviewData(data);
      } catch (err) {
          console.error(err);
      }
  }

  function renderReviewData(data) {
      resultsContainer.classList.remove('hidden');
      
      const subagentFindings = data.findings.filter(f => f.source === 'subagent');
      const basicFindings = data.findings.filter(f => f.source === 'basic');
      
      renderFindings(subagentFindings, subagentFindingsList, 'Subagent Review');
      renderFindings(basicFindings, basicFindingsList, 'Basic Review');
      
      if (data.metrics) {
          renderMetrics(data.metrics.subagentMetrics, 'subagent');
          renderMetrics(data.metrics.basicMetrics, 'basic');
          renderComparisonTable(data.metrics.subagentMetrics, data.metrics.basicMetrics, subagentFindings, basicFindings);
      } else {
          comparisonTable.classList.add('hidden');
      }
      
      if (data.evaluation) {
          comparisonEvaluationPanel.classList.remove('hidden');
          evaluationText.innerHTML = window.marked && window.DOMPurify ? window.DOMPurify.sanitize(window.marked.parse(data.evaluation)) : escapeHTML(data.evaluation).replace(/\n/g, '<br/>');
      } else {
          comparisonEvaluationPanel.classList.add('hidden');
      }
  }

  form.addEventListener('submit', async (e) => {
      e.preventDefault();

      const url = document.getElementById('pr-url').value;
      const pat = document.getElementById('pat').value;

      if (!url || !pat) return;
      if (!validateAgentSelection()) return;

      // Progress UI elements
      const progressContainer = document.getElementById('progress-container');
      const progressGrid = document.getElementById('progress-grid');
      const warningContainer = document.getElementById('warning-container');
      
      // UI Loading State
      submitBtn.disabled = true;
      btnText.classList.add('hidden');
      spinner.classList.remove('hidden');
      resultsContainer.classList.add('hidden');
      progressContainer.classList.remove('hidden');
      warningContainer.classList.add('hidden');
      warningContainer.innerHTML = '';
      
      subagentFindingsList.innerHTML = '';
      basicFindingsList.innerHTML = '';
      comparisonTableBody.innerHTML = '';
      comparisonTable.classList.add('hidden');
      comparisonEvaluationPanel.classList.add('hidden');
      progressGrid.innerHTML = '';

      // Keep track of active agent tasks to update the UI
      const agentTasks = new Map();

      try {
          const response = await authFetch(API_URL, {
              method: 'POST',
              headers: {
                  'Content-Type': 'application/json',
              },
              body: JSON.stringify(buildReviewPayload(url, pat))
          });

          if (!response.ok) {
              const data = await response.json().catch(() => ({}));
              throw new Error(data.error || 'Failed to fetch review.');
          }

          const reader = response.body.getReader();
          const decoder = new TextDecoder('utf-8');
          let buffer = '';

          while (true) {
              const { value, done } = await reader.read();
              if (done) break;
              
              const result = parseStreamChunk(value, decoder, buffer);
              buffer = result.buffer;

              for (const line of result.lines) {
                  try {
                      const data = JSON.parse(line);
                      
                      if (data.type === 'progress') {
                          renderProgress(data, agentTasks, progressGrid);
                      } else if (data.type === 'warning') {
                          warningContainer.innerHTML = '⚠️ ' + escapeHTML(data.message);
                          warningContainer.classList.remove('hidden');
                      } else if (data.type === 'done') {
                          renderReviewData(data);
                          // Refresh history to show the new run
                          setTimeout(fetchHistory, 1000);
                          break; // Immediately exit the parsing loop. The server closed the socket correctly and reading further risks a trailing HTTP NetworkError.
                      } else if (data.type === 'error') {
                          throw new Error(data.error);
                      }
                  } catch (e) {
                      console.error('Error parsing stream line:', e, line);
                  }
              }
          }

      } catch (error) {
          console.error(error);
          resultsContainer.classList.remove('hidden');
          const errorHtml = `<div class="error-message main-error-message"><strong>Error:</strong> ${error.message}</div>`;
          document.querySelector('.tabs').insertAdjacentHTML('beforebegin', errorHtml);
      } finally {
          // Reset UI
          submitBtn.disabled = !validateAgentSelection();
          btnText.classList.remove('hidden');
          spinner.classList.add('hidden');
          // Keep progress container visible to show what was done
      }
  });

  function renderProgress(data, agentTasks, progressGrid) {
      const { agent, file, status } = data;
      const taskId = `${agent}-${file}`;
      
      if (status === 'skipped') {
          const card = document.createElement('div');
          card.className = 'progress-card skipped';
          const safeTaskId = taskId.replace(/[^a-zA-Z0-9]/g, '-');
          card.id = `task-${safeTaskId}`;
          
          card.innerHTML = `
              <div class="agent-name">🤖 ${agent} Agent</div>
              <div class="file-name" title="${file}">${file}</div>
              <div class="status-indicator">
                  <span class="skip-icon">⊘</span>
                  <span>Not Applicable</span>
              </div>
          `;
          
          progressGrid.prepend(card);
          agentTasks.set(taskId, card);
          return;
      }

      if (status === 'start') {

          // Add to UI
          const card = document.createElement('div');
          card.className = 'progress-card active';
          card.id = `task-${taskId.replace(/[^a-zA-Z0-9]/g, '-')}`;
          
          card.innerHTML = `
              <div class="agent-name">🤖 ${agent} Agent</div>
              <div class="file-name" title="${file}">${file}</div>
              <div class="status-indicator">
                  <div class="pulse-dot"></div>
                  <span>Analyzing...</span>
              </div>
          `;
          
          progressGrid.prepend(card);
          agentTasks.set(taskId, card);
      } else if (status === 'complete') {
          const card = agentTasks.get(taskId);
          if (card) {
              card.classList.remove('active');
              card.classList.add('completed');
              const statusIndicator = card.querySelector('.status-indicator');
              if (statusIndicator) {
                  statusIndicator.innerHTML = `
                      <span class="check-icon">✓</span>
                      <span>Done</span>
                  `;
              }
          }
      }
  }

  function renderFindings(findings, container, reviewType) {
      if (!findings || findings.length === 0) {
          container.innerHTML = `
              <div class="finding" style="text-align: center;">
                  <h3 style="color: var(--success)">✅ No issues found!</h3>
                  <p style="color: var(--text-secondary); margin-top: 10px;">The ${reviewType} approach reviewed the code and did not identify any candidate findings.</p>
              </div>`;
          return;
      }

      const html = findings.map(f => `
          <div class="finding">
              <div class="finding-header">
                  <span class="agent-badge">🤖 ${f.agent} Agent</span>
                  <span class="severity-badge severity-${f.severity ? escapeHTML(f.severity.toLowerCase()) : 'unknown'}">${f.severity ? escapeHTML(f.severity) : 'UNKNOWN'}</span>
              </div>
              <div class="location">📄 ${f.file}${f.line ? ` : L${f.line}` : ''}</div>
              <div class="description">${escapeHTML(f.description)}</div>
          </div>
      `).join('');

      container.innerHTML = html;
  }

  function renderMetrics(metrics, prefix) {
      if (!metrics) return;
      
      const input = document.getElementById(`metric-${prefix}-input`);
      const output = document.getElementById(`metric-${prefix}-output`);
      const calls = document.getElementById(`metric-${prefix}-calls`);

      if (input) input.textContent = metrics.inputTokens || 0;
      if (output) output.textContent = metrics.outputTokens || 0;
      if (calls) calls.textContent = metrics.calls || 0;
  }

  function calculateSeverities(findings) {
      const counts = { CRITICAL: 0, HIGH: 0, MEDIUM: 0, LOW: 0 };
      findings.forEach(f => {
          if (f && f.severity) {
              const sev = f.severity.toUpperCase();
              if (counts[sev] !== undefined) counts[sev]++;
          }
      });
      return counts;
  }

  function renderComparisonTable(subagentMetrics, basicMetrics, subagentFindings, basicFindings) {
      comparisonTable.classList.remove('hidden');
      
      const subCounts = calculateSeverities(subagentFindings);
      const basicCounts = calculateSeverities(basicFindings);

      const formatMetric = (val) => val != null ? val.toLocaleString() : '0';
      
      comparisonTableBody.innerHTML = `
          <tr>
              <td>Input Tokens</td>
              <td>${formatMetric(subagentMetrics?.inputTokens)}</td>
              <td>${formatMetric(basicMetrics?.inputTokens)}</td>
          </tr>
          <tr>
              <td>Output Tokens</td>
              <td>${formatMetric(subagentMetrics?.outputTokens)}</td>
              <td>${formatMetric(basicMetrics?.outputTokens)}</td>
          </tr>
          <tr>
              <td>LLM API Calls</td>
              <td>${formatMetric(subagentMetrics?.calls)}</td>
              <td>${formatMetric(basicMetrics?.calls)}</td>
          </tr>
          <tr>
              <td>Total Findings</td>
              <td>${subagentFindings.length}</td>
              <td>${basicFindings.length}</td>
          </tr>
          <tr>
              <td>Critical Issues</td>
              <td>${subCounts.CRITICAL}</td>
              <td>${basicCounts.CRITICAL}</td>
          </tr>
          <tr>
              <td>High Issues</td>
              <td>${subCounts.HIGH}</td>
              <td>${basicCounts.HIGH}</td>
          </tr>
          <tr>
              <td>Medium Issues</td>
              <td>${subCounts.MEDIUM}</td>
              <td>${basicCounts.MEDIUM}</td>
          </tr>
          <tr>
              <td>Low Issues</td>
              <td>${subCounts.LOW}</td>
              <td>${basicCounts.LOW}</td>
          </tr>
      `;
  }


  // escapeHTML is now imported from utils.js
}

if (typeof document !== 'undefined' && typeof window !== 'undefined') {
    document.addEventListener('DOMContentLoaded', initApp);
}
