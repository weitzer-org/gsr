// Usage dashboard — fetches GET /api/usage/summary and renders totals, a
// per-bucket time series, and a dimension breakdown (with an optional
// second-dimension intersection).
import { authFetch, wireLogoutLink, escapeHTML } from './utils.js';

const DIMENSION_LABELS = {
    byModel: 'Model',
    byRepository: 'Consuming project',
    byWorkload: 'Workload',
};

// Each intersection key's two parent single-dimension keys — used both to
// label the two breakdown-table columns and to decide which "intersect
// with" options make sense for the currently selected "by" dimension (a
// dimension never intersects with itself).
const INTERSECT_PARENTS = {
    byModelRepository: ['byModel', 'byRepository'],
    byModelWorkload: ['byModel', 'byWorkload'],
    byRepositoryWorkload: ['byRepository', 'byWorkload'],
};

function formatNumber(n) {
    return (n || 0).toLocaleString();
}

function formatUsd(n) {
    return `$${(n || 0).toFixed(4)}`;
}

function isoDate(d) {
    return d.toISOString().slice(0, 10);
}

export function initUsage() {
    wireLogoutLink();

    const fromInput = document.getElementById('usage-from');
    const toInput = document.getElementById('usage-to');
    const granularitySelect = document.getElementById('usage-granularity');
    const sourceSelect = document.getElementById('usage-source');
    const statusNotice = document.getElementById('usage-status-notice');
    const rangeBadge = document.getElementById('usage-range-badge');
    const breakdownBySelect = document.getElementById('usage-breakdown-by');
    const breakdownIntersectSelect = document.getElementById('usage-breakdown-intersect');
    const breakdownBody = document.getElementById('usage-breakdown-body');
    const breakdownCol1 = document.getElementById('usage-breakdown-col-1');
    const breakdownCol2 = document.getElementById('usage-breakdown-col-2');
    const timeseriesMetricSelect = document.getElementById('usage-timeseries-metric');
    const timeseriesContainer = document.getElementById('usage-timeseries');
    const quickRangeBtns = Array.from(document.querySelectorAll('.quick-range-btn'));

    let latestSummary = null;
    // Guards against an older, slower request (e.g. a wide date range with
    // no cached rollups yet, which can take several seconds) resolving
    // after a newer one and overwriting its result with stale data.
    let requestToken = 0;

    function applyQuickRange(range) {
        const today = new Date();
        let from = new Date(today);
        if (range === 'week') {
            const dayIndex = (today.getUTCDay() + 6) % 7; // Monday = 0
            from = new Date(today.getTime() - dayIndex * 86400000);
        } else if (range === 'month') {
            from = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), 1));
        } else if (range === '90d') {
            from = new Date(today.getTime() - 89 * 86400000);
        }
        fromInput.value = isoDate(from);
        toInput.value = isoDate(today);
    }

    function updateBreakdownIntersectOptions() {
        const by = breakdownBySelect.value;
        Array.from(breakdownIntersectSelect.options).forEach(opt => {
            if (!opt.value) return;
            opt.disabled = !INTERSECT_PARENTS[opt.value].includes(by);
        });
        const selected = breakdownIntersectSelect.options[breakdownIntersectSelect.selectedIndex];
        if (selected && selected.disabled) {
            breakdownIntersectSelect.value = '';
        }
    }

    function renderBreakdown() {
        if (!latestSummary) return;
        const by = breakdownBySelect.value;
        const intersect = breakdownIntersectSelect.value;
        const key = intersect || by;
        const map = (latestSummary.total && latestSummary.total[key]) || {};

        if (intersect) {
            // The composite key's column order is fixed by how the backend
            // built it (e.g. byModelRepository is always "model|repository")
            // — it does NOT follow whichever single dimension "by" happens
            // to be selected, so the headers must come from
            // INTERSECT_PARENTS, not from `by`.
            const [dimA, dimB] = INTERSECT_PARENTS[intersect];
            breakdownCol1.textContent = DIMENSION_LABELS[dimA] || dimA;
            breakdownCol2.textContent = DIMENSION_LABELS[dimB] || dimB;
        } else {
            breakdownCol1.textContent = DIMENSION_LABELS[by] || by;
            breakdownCol2.textContent = '';
        }

        const rows = Object.entries(map).sort((a, b) => b[1].costUsd - a[1].costUsd);
        breakdownBody.innerHTML = '';
        if (rows.length === 0) {
            breakdownBody.innerHTML = '<tr><td colspan="7">No data for this range.</td></tr>';
            return;
        }
        const fragment = document.createDocumentFragment();
        for (const [rowKey, bucket] of rows) {
            const parts = intersect ? rowKey.split('|') : [rowKey, ''];
            const tr = document.createElement('tr');
            tr.innerHTML = `
                <td>${escapeHTML(parts[0])}</td>
                <td>${escapeHTML(parts[1] || '')}</td>
                <td>${formatNumber(bucket.calls)}</td>
                <td>${formatNumber(bucket.inputTokens)}</td>
                <td>${formatNumber(bucket.outputTokens)}</td>
                <td>${formatNumber(bucket.thinkingTokens)}</td>
                <td>${formatUsd(bucket.costUsd)}</td>
            `;
            fragment.appendChild(tr);
        }
        breakdownBody.appendChild(fragment);
    }

    function renderTimeseries() {
        if (!latestSummary) return;
        const metric = timeseriesMetricSelect.value;
        const buckets = [...(latestSummary.buckets || [])].sort((a, b) => (a.date < b.date ? -1 : 1));
        timeseriesContainer.innerHTML = '';
        if (buckets.length === 0) {
            timeseriesContainer.innerHTML = '<p>No data for this range.</p>';
            return;
        }
        // Scale to the actual dataset max, not a hardcoded floor of 1 — for
        // a cost metric (typically well under $1/day) a floor of 1 would
        // squash every bar down to a near-invisible sliver relative to that
        // floor instead of the real relative variation between days.
        const datasetMax = Math.max(...buckets.map(b => b[metric] || 0));
        const max = datasetMax > 0 ? datasetMax : 1;
        for (const bucket of buckets) {
            const value = bucket[metric] || 0;
            const pct = Math.max(2, Math.round((value / max) * 100));
            const displayValue = metric === 'totalCostUsd' ? formatUsd(value) : formatNumber(value);
            const row = document.createElement('div');
            row.className = 'usage-bar-row';
            row.innerHTML = `
                <span class="usage-bar-label">${escapeHTML(bucket.date)}</span>
                <div class="usage-bar-track"><div class="usage-bar-fill" style="width: ${pct}%"></div></div>
                <span class="usage-bar-value">${displayValue}</span>
            `;
            timeseriesContainer.appendChild(row);
        }
    }

    function renderAll() {
        if (!latestSummary) return;
        rangeBadge.textContent = `${fromInput.value} to ${toInput.value}`;
        const total = latestSummary.total || {};
        document.getElementById('usage-total-input').textContent = formatNumber(total.totalInputTokens);
        document.getElementById('usage-total-output').textContent = formatNumber(total.totalOutputTokens);
        document.getElementById('usage-total-thinking').textContent = formatNumber(total.totalThinkingTokens);
        document.getElementById('usage-total-cost').textContent = formatUsd(total.totalCostUsd);
        document.getElementById('usage-total-calls').textContent = formatNumber(total.totalCalls);
        updateBreakdownIntersectOptions();
        renderBreakdown();
        renderTimeseries();
    }

    async function fetchSummary() {
        const from = fromInput.value;
        const to = toInput.value;
        if (!from || !to) return;

        const token = ++requestToken;
        statusNotice.textContent = 'Loading…';
        statusNotice.classList.remove('hidden', 'error', 'success');
        statusNotice.classList.add('info');

        try {
            const params = new URLSearchParams({
                from, to,
                granularity: granularitySelect.value,
                source: sourceSelect.value,
            });
            const res = await authFetch(`/api/usage/summary?${params.toString()}`);
            if (token !== requestToken) return; // a newer request already superseded this one
            if (!res.ok) {
                const data = await res.json().catch(() => ({}));
                throw new Error(data.error || `Request failed (${res.status})`);
            }
            const summary = await res.json();
            if (token !== requestToken) return; // superseded again — decoding is also async
            latestSummary = summary;
            renderAll();
            statusNotice.classList.add('hidden');
        } catch (e) {
            if (token !== requestToken) return;
            statusNotice.textContent = 'Error: ' + e.message;
            statusNotice.classList.remove('hidden', 'info', 'success');
            statusNotice.classList.add('error');
        }
    }

    quickRangeBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            quickRangeBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            applyQuickRange(btn.dataset.range);
            fetchSummary();
        });
    });

    [fromInput, toInput, granularitySelect, sourceSelect].forEach(el => {
        el.addEventListener('change', () => {
            quickRangeBtns.forEach(b => b.classList.remove('active'));
            fetchSummary();
        });
    });

    breakdownBySelect.addEventListener('change', () => {
        updateBreakdownIntersectOptions();
        renderBreakdown();
    });
    breakdownIntersectSelect.addEventListener('change', renderBreakdown);
    timeseriesMetricSelect.addEventListener('change', renderTimeseries);

    applyQuickRange('today');
    fetchSummary();
}

if (typeof document !== 'undefined' && typeof window !== 'undefined') {
    document.addEventListener('DOMContentLoaded', initUsage);
}
