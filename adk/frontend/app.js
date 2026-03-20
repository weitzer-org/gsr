import { escapeHTML, parseStreamChunk } from './utils.js';

document.addEventListener('DOMContentLoaded', () => {

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

  // Tab Setup
  tabs.forEach(tab => {
      tab.addEventListener('click', () => {
          tabs.forEach(t => t.classList.remove('active'));
          tabContents.forEach(c => c.classList.remove('active'));
          
          tab.classList.add('active');
          document.getElementById(tab.dataset.tab).classList.add('active');
      });
  });

  // Hardcoded for local prototype. In production, this would be relative.
  const API_URL = 'http://localhost:8080/api/review';
  const STATUS_URL = 'http://localhost:8080/api/status';

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

  // Check immediately on load
  checkApiStatus();

  form.addEventListener('submit', async (e) => {
      e.preventDefault();

      const url = document.getElementById('pr-url').value;
      const pat = document.getElementById('pat').value;

      if (!url || !pat) return;

      // Progress UI elements
      const progressContainer = document.getElementById('progress-container');
      const progressGrid = document.getElementById('progress-grid');
      
      // UI Loading State
      submitBtn.disabled = true;
      btnText.classList.add('hidden');
      spinner.classList.remove('hidden');
      resultsContainer.classList.add('hidden');
      progressContainer.classList.remove('hidden');
      
      subagentFindingsList.innerHTML = '';
      basicFindingsList.innerHTML = '';
      comparisonTableBody.innerHTML = '';
      comparisonTable.classList.add('hidden');
      comparisonEvaluationPanel.classList.add('hidden');
      progressGrid.innerHTML = '';

      // Keep track of active agent tasks to update the UI
      const agentTasks = new Map();

      try {
          const response = await fetch(API_URL, {
              method: 'POST',
              headers: {
                  'Content-Type': 'application/json',
              },
              body: JSON.stringify({ url, pat })
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
                      } else if (data.type === 'done') {
                          resultsContainer.classList.remove('hidden');
                          
                          // Split findings by source
                          const subagentFindings = data.findings.filter(f => f.source === 'subagent');
                          const basicFindings = data.findings.filter(f => f.source === 'basic');
                          
                          renderFindings(subagentFindings, subagentFindingsList, 'Subagent Review');
                          renderFindings(basicFindings, basicFindingsList, 'Basic Review');
                          
                          if (data.metrics) {
                              renderMetrics(data.metrics.subagentMetrics, 'subagent');
                              renderMetrics(data.metrics.basicMetrics, 'basic');
                              renderComparisonTable(data.metrics.subagentMetrics, data.metrics.basicMetrics, subagentFindings, basicFindings);
                          }
                          
                          if (data.evaluation) {
                              comparisonEvaluationPanel.classList.remove('hidden');
                              evaluationText.innerHTML = escapeHTML(data.evaluation).replace(/\n/g, '<br/>');
                          }

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
          subagentFindingsList.innerHTML = `<div class="error-message"><strong>Error:</strong> ${error.message}</div>`;
      } finally {
          // Reset UI
          submitBtn.disabled = false;
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
                  <span class="severity-badge severity-${f.severity}">${f.severity}</span>
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

  function countSeverity(findings, level) {
      return findings.filter(f => f.severity.toUpperCase() === level.toUpperCase()).length;
  }

  function renderComparisonTable(subagentMetrics, basicMetrics, subagentFindings, basicFindings) {
      comparisonTable.classList.remove('hidden');
      
      comparisonTableBody.innerHTML = `
          <tr>
              <td>Input Tokens</td>
              <td>${subagentMetrics.inputTokens.toLocaleString()}</td>
              <td>${basicMetrics.inputTokens.toLocaleString()}</td>
          </tr>
          <tr>
              <td>Output Tokens</td>
              <td>${subagentMetrics.outputTokens.toLocaleString()}</td>
              <td>${basicMetrics.outputTokens.toLocaleString()}</td>
          </tr>
          <tr>
              <td>LLM API Calls</td>
              <td>${subagentMetrics.calls}</td>
              <td>${basicMetrics.calls}</td>
          </tr>
          <tr>
              <td>Total Findings</td>
              <td>${subagentFindings.length}</td>
              <td>${basicFindings.length}</td>
          </tr>
          <tr>
              <td>Critical Issues</td>
              <td>${countSeverity(subagentFindings, 'CRITICAL')}</td>
              <td>${countSeverity(basicFindings, 'CRITICAL')}</td>
          </tr>
          <tr>
              <td>High Issues</td>
              <td>${countSeverity(subagentFindings, 'HIGH')}</td>
              <td>${countSeverity(basicFindings, 'HIGH')}</td>
          </tr>
          <tr>
              <td>Medium Issues</td>
              <td>${countSeverity(subagentFindings, 'MEDIUM')}</td>
              <td>${countSeverity(basicFindings, 'MEDIUM')}</td>
          </tr>
          <tr>
              <td>Low Issues</td>
              <td>${countSeverity(subagentFindings, 'LOW')}</td>
              <td>${countSeverity(basicFindings, 'LOW')}</td>
          </tr>
      `;
  }


  // escapeHTML is now imported from utils.js
});
