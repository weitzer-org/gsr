import { describe, it, expect } from '@jest/globals';
import { parseAgentSelection, resolveAgentSelectionForMode } from '../src/agentSelection';

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

describe('resolveAgentSelectionForMode', () => {
  it('parses selected agents when mode is subagent', () => {
    expect(resolveAgentSelectionForMode('subagent', 'logic,security', availableIds)).toEqual({
      selectedAgents: ['logic', 'security']
    });
  });

  it('runs all agents when mode is subagent and REVIEW_AGENTS is unset', () => {
    expect(resolveAgentSelectionForMode('subagent', undefined, availableIds)).toEqual({ selectedAgents: undefined });
  });

  it('propagates parseAgentSelection errors for unknown ids in subagent mode', () => {
    expect(() => resolveAgentSelectionForMode('subagent', 'not-real', availableIds)).toThrow(/not-real/);
  });

  it('warns and ignores REVIEW_AGENTS when mode is basic', () => {
    const result = resolveAgentSelectionForMode('basic', 'logic', availableIds);
    expect(result.selectedAgents).toBeUndefined();
    expect(result.warning).toMatch(/ignored in mode "basic"/);
  });

  it('does not warn in basic mode when REVIEW_AGENTS is "all" or unset', () => {
    expect(resolveAgentSelectionForMode('basic', 'all', availableIds)).toEqual({});
    expect(resolveAgentSelectionForMode('basic', undefined, availableIds)).toEqual({});
  });
});
