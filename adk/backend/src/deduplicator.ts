import { GoogleGenAI, Type } from '@google/genai';
import { CandidateFinding } from './types.js';
import { trackGeminiCall } from './usage.js';

// Two findings can only be duplicates when they are in the same file and
// this close together. Shared by the prompt and the code checks around it.
export const MERGE_LINE_WINDOW = 10;

const SEVERITY_RANK: Record<string, number> = { LOW: 1, MEDIUM: 2, HIGH: 3, CRITICAL: 4 };

function lineOf(f: CandidateFinding): number {
  const n = Number(f.line);
  return Number.isFinite(n) ? n : 0;
}

// clusterByProximity returns, for each finding, the id of its cluster: a
// maximal run of findings in one file where each is within MERGE_LINE_WINDOW
// lines of the next. A cluster of one cannot contain a duplicate.
export function clusterByProximity(findings: CandidateFinding[]): number[] {
  const order = findings.map((_, i) => i).sort((a, b) => {
    const fa = String(findings[a].file), fb = String(findings[b].file);
    if (fa !== fb) return fa < fb ? -1 : 1;
    return lineOf(findings[a]) - lineOf(findings[b]) || a - b;
  });
  const clusterOf = new Array<number>(findings.length);
  let cluster = -1;
  let prev: number | undefined;
  for (const i of order) {
    const sameRun = prev !== undefined
      && String(findings[prev].file) === String(findings[i].file)
      && lineOf(findings[i]) - lineOf(findings[prev]) <= MERGE_LINE_WINDOW;
    if (!sameRun) cluster++;
    clusterOf[i] = cluster;
    prev = i;
  }
  return clusterOf;
}

// normalizeGroups turns the model's untrusted answer into merge groups that
// are safe to apply. An index is honoured once (first appearance), only if it
// was actually sent, and a group is split wherever it spans two proximity
// clusters — so the model can neither drop a finding nor merge two findings
// that are far apart or in different files. Anything it left out simply stays
// unmerged. Returns only groups of two or more, each sorted ascending.
export function normalizeGroups(raw: unknown, candidates: Set<number>, clusterOf: number[]): number[][] {
  if (!Array.isArray(raw)) return [];
  const seen = new Set<number>();
  const groups: number[][] = [];
  for (const entry of raw) {
    const indices = Array.isArray(entry) ? entry : (entry as any)?.indices;
    if (!Array.isArray(indices)) continue;
    const byCluster = new Map<number, number[]>();
    for (const idx of indices) {
      if (!Number.isInteger(idx) || !candidates.has(idx) || seen.has(idx)) continue;
      seen.add(idx);
      const c = clusterOf[idx];
      if (!byCluster.has(c)) byCluster.set(c, []);
      byCluster.get(c)!.push(idx);
    }
    for (const g of byCluster.values()) {
      if (g.length > 1) groups.push(g.sort((a, b) => a - b));
    }
  }
  return groups;
}

// mergeGroup collapses findings the model judged to be one issue. The
// highest-severity member (earliest on a tie) supplies the text and location;
// the agent names are joined ("Performance, Security") and a suggestion is
// borrowed from another member if the primary has none.
export function mergeGroup(group: CandidateFinding[]): CandidateFinding {
  const rank = (f: CandidateFinding) => SEVERITY_RANK[String(f.severity || '').toUpperCase()] || 0;
  const primary = group.reduce((best, f) => (rank(f) > rank(best) ? f : best), group[0]);
  const agents: string[] = [];
  for (const f of group) {
    for (const name of String(f.agent || '').split(',').map(s => s.trim()).filter(Boolean)) {
      if (!agents.includes(name)) agents.push(name);
    }
  }
  return {
    ...primary,
    agent: agents.length > 0 ? agents.join(', ') : primary.agent,
    suggestion: primary.suggestion || group.find(f => f.suggestion)?.suggestion,
  };
}

export class DeduplicatorAgent {
  private ai: GoogleGenAI;

  constructor() {
    this.ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
  }

  async deduplicate(findings: CandidateFinding[]): Promise<CandidateFinding[]> {
    if (!findings || findings.length === 0) return [];

    // Fallback if deduplicator is disabled via config
    if (process.env.USE_DEDUPLICATOR === 'false') {
       return findings;
    }

    // Only findings that sit near another finding can be duplicates at all
    // (the merge rule below is "same file, within MERGE_LINE_WINDOW lines"),
    // so that proximity check is done here in code, not by the model. When
    // nothing clusters there is nothing to merge and no call is made.
    const clusterOf = clusterByProximity(findings);
    const clusterSizes = new Map<number, number>();
    for (const c of clusterOf) clusterSizes.set(c, (clusterSizes.get(c) || 0) + 1);
    const candidateIndices = findings.map((_, i) => i).filter(i => (clusterSizes.get(clusterOf[i]) || 0) > 1);
    if (candidateIndices.length === 0) {
      console.log(`[Deduplicator] No findings within ${MERGE_LINE_WINDOW} lines of each other in the same file; skipping the merge call.`);
      return findings;
    }

    try {
      console.log(`[Deduplicator] Starting deduplication of ${candidateIndices.length} clustered findings (of ${findings.length} total)...`);
      // The model only decides WHICH findings describe the same root cause
      // and answers with index groups. It never rewrites a finding: the merge
      // itself happens in mergeGroup below. Re-emitting every description and
      // suggestion was most of this call's output tokens and latency, and it
      // let the model silently drop findings (deduplicator-duplication-bug.md
      // "collapse") — with indices, every input finding provably survives.
      const systemInstruction = `You are an expert Code Review Deduplicator agent.
You will be provided with a JSON array of code review findings, each with an "index". They were generated by various specialist subagents, so some of them highlight the exact same issue from slightly different angles.

Your job is to decide which findings are duplicates of each other. Do NOT rewrite, summarize or return the findings themselves.

Rules:
1. Two findings belong in the same group ONLY if they are in the SAME file, on the SAME or NEARBY lines (within ${MERGE_LINE_WINDOW} lines), AND they describe the same root cause or issue.
2. Findings that are merely close together but describe different problems must stay in separate groups.
3. Return every index exactly once. A finding with no duplicate is a group of one.

Output a JSON array of groups, each of the form {"indices": [..]}.`;

      const payload = candidateIndices.map(i => ({
        index: i,
        file: findings[i].file,
        line: findings[i].line,
        severity: findings[i].severity,
        agent: findings[i].agent,
        summary: findings[i].summary,
        description: findings[i].description,
      }));

      const startTime = Date.now();
      console.log(`[Deduplicator] Sending request to Gemini...`);
      
      const deduplicatorModel = process.env.DEDUPLICATOR_MODEL || 'gemini-3.1-pro-preview';
      const request = trackGeminiCall(
        { callType: 'deduplicate', model: deduplicatorModel },
        () => this.ai.models.generateContent({
        model: deduplicatorModel,
        contents: JSON.stringify(payload),
        config: {
          systemInstruction,
          // Without an explicit cap, this model can pathologically hang past
          // Node's 5-minute headers timeout with ZERO response when the
          // input findings are highly repetitive/near-duplicate (e.g. the
          // same pattern flagged at several similar call sites) — confirmed
          // via a standalone repro outside the app. Root cause isn't excess
          // latency from thinking itself: an 8192 cap still hung; 4096 and
          // below reliably completed in ~12-17s on the same repetitive
          // input. This model rejects thinkingBudget: 0 (requires "thinking
          // mode"), so 4096 is the smallest well-tested safe floor, with
          // ~1.8x headroom above the ~2200 thinking tokens a healthy
          // 12-finding merge used natively.
          thinkingConfig: { thinkingBudget: 4096 },
          responseMimeType: 'application/json',
          responseSchema: {
            type: Type.ARRAY,
            description: "Groups of finding indices that describe the same issue. Every input index appears in exactly one group.",
            items: {
              type: Type.OBJECT,
              properties: {
                indices: { type: Type.ARRAY, items: { type: Type.INTEGER } }
              },
              required: ["indices"]
            }
          }
        }
        })
      );

      // Node's setTimeout treats NaN, <=0, and anything above the 32-bit
      // signed int max (2147483647) identically: it clamps to ~1ms and
      // fires almost immediately (verified empirically — see the PR
      // description) — so every dedup call would "time out" instantly
      // under any of those GEMINI_TIMEOUT_MS values. Fall back to the
      // existing 300000 default (matches agent.ts's own guard).
      const rawTimeoutMs = parseInt(process.env.GEMINI_TIMEOUT_MS || '300000', 10);
      const timeoutMs = Number.isNaN(rawTimeoutMs) || rawTimeoutMs <= 0 || rawTimeoutMs > 2147483647 ? 300000 : rawTimeoutMs;
      console.log(`[Deduplicator] Timeout set to ${timeoutMs}ms`);
      
      let timeoutId: NodeJS.Timeout | undefined;
      const timeoutPromise = new Promise<any>((_, reject) => {
          timeoutId = setTimeout(() => reject(new Error(`ETIMEDOUT: Deduplicator fetch exceeded ${timeoutMs}ms.`)), timeoutMs);
      });

      const response = await Promise.race([request, timeoutPromise]).finally(() => clearTimeout(timeoutId));
      
      const duration = Date.now() - startTime;
      console.log(`[Deduplicator] Response received in ${duration}ms`);
      
      if (response.usageMetadata) {
         console.log(`[Deduplicator] Tokens used - Prompt: ${response.usageMetadata.promptTokenCount}, Candidates: ${response.usageMetadata.candidatesTokenCount}`);
      }

      if (response.text) {
        const groups = normalizeGroups(JSON.parse(response.text), new Set(candidateIndices), clusterOf);
        const groupOf = new Map<number, number[]>();
        for (const g of groups) for (const i of g) groupOf.set(i, g);

        // Emit in the original order, each group at its first member's position.
        const mergedFindings: CandidateFinding[] = [];
        findings.forEach((f, i) => {
          const g = groupOf.get(i);
          if (!g) mergedFindings.push(f);
          else if (g[0] === i) mergedFindings.push(mergeGroup(g.map(j => findings[j])));
        });
        console.log(`[Deduplicator] Successfully deduplicated ${findings.length} findings into ${mergedFindings.length}.`);
        return mergedFindings;
      }

      console.warn(`[Deduplicator] Empty response. Returning raw findings.`);
      return findings;

    } catch (e) {
      console.error("[Deduplicator] Failed to deduplicate findings:", e);
      return findings;
    }
  }
}
