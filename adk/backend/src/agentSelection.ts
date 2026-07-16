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
