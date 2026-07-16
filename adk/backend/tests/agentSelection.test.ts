import { describe, it, expect } from '@jest/globals';
import { parseAgentSelection } from '../src/agentSelection';

const availableIds = ['logic', 'security', 'architecture'];

describe('parseAgentSelection', () => {
  it('returns undefined for undefined input (run all)', () => {
    expect(parseAgentSelection(undefined, availableIds)).toBeUndefined();
  });

  it('returns undefined for empty string input (run all)', () => {
    expect(parseAgentSelection('', availableIds)).toBeUndefined();
  });

  it('returns undefined for "all" (case-insensitive)', () => {
    expect(parseAgentSelection('All', availableIds)).toBeUndefined();
  });

  it('parses a comma-separated list, trimming and lowercasing', () => {
    expect(parseAgentSelection(' Logic, SECURITY ', availableIds)).toEqual(['logic', 'security']);
  });

  it('dedupes repeated ids', () => {
    expect(parseAgentSelection('logic,logic,security', availableIds)).toEqual(['logic', 'security']);
  });

  it('throws for unknown agent ids', () => {
    expect(() => parseAgentSelection('logic,not-real', availableIds)).toThrow(/not-real/);
  });
});
