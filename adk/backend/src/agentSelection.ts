// Parses the GitHub Action's "agents" input (comma-separated agent IDs, or "all")
// into the selection array Orchestrator's constructor expects, or undefined for "run everything".
export function parseAgentSelection(raw: string | undefined, availableIds: string[]): string[] | undefined {
  const trimmed = (raw || '').trim();
  if (!trimmed || trimmed.toLowerCase() === 'all') {
    return undefined;
  }

  const requested = Array.from(new Set(trimmed.split(',').map(id => id.trim().toLowerCase()).filter(Boolean)));
  if (requested.length === 0) {
    return undefined;
  }

  const available = new Set(availableIds);
  const unknown = requested.filter(id => !available.has(id));
  if (unknown.length > 0) {
    throw new Error(`Unknown agent id(s) in "agents" input: ${unknown.join(', ')}. Available: ${availableIds.join(', ')}.`);
  }

  return requested;
}

export interface AgentSelectionForMode {
  selectedAgents?: string[];
  warning?: string;
}

// Only "subagent" mode has a selectable agent set — "basic" mode always runs its
// single fixed prompt, so a supplied "agents" input there is a no-op worth warning about.
export function resolveAgentSelectionForMode(mode: string, reviewAgentsEnv: string | undefined, availableIds: string[]): AgentSelectionForMode {
  if (mode !== 'subagent') {
    const trimmed = (reviewAgentsEnv || '').trim();
    if (trimmed && trimmed.toLowerCase() !== 'all') {
      return { warning: `[GSR Action] "agents" input is ignored in mode "${mode}" (basic mode uses a single fixed prompt).` };
    }
    return {};
  }

  return { selectedAgents: parseAgentSelection(reviewAgentsEnv, availableIds) };
}
