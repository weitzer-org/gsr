import { describe, it, expect } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';
import { HELDOUT_DIR, listCases } from '../witness-spike/testbed';
import { CASES_DIR } from '../witness-spike/testbed';
import { validateWitness } from '../witness-spike/pipeline';
import type { WitnessAuthorOutput } from '../../../adk/backend/src/witness/types';

const readJson = (...p: string[]) => JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'witness-spike', ...p), 'utf8'));
const truth: { cases: Record<string, { truth: string; attribution?: string; why: string }> } = readJson('heldout-truth.json');
const inSample: { cases: Record<string, unknown> } = readJson('author-truth.json');
const cases = listCases(HELDOUT_DIR);
const read = (id: string, f: string): WitnessAuthorOutput => JSON.parse(fs.readFileSync(path.join(HELDOUT_DIR, id, f), 'utf8'));

// Offline structure checks only. The reference witnesses are executed by `ts-node witness-spike/testbed.ts --heldout`
// (needs Docker), which is how each label in heldout-truth.json was verified.
describe('held-out witness cases', () => {
  it('has exactly one ground-truth entry per case, with a valid label', () => {
    expect(cases.map((c) => c.id).sort()).toEqual(Object.keys(truth.cases).sort());
    for (const t of Object.values(truth.cases)) {
      expect(['true', 'false', 'opinion']).toContain(t.truth);
      expect(t.why.length).toBeGreaterThan(10);
      if (t.truth === 'true') expect(['regression', 'preexisting']).toContain(t.attribution);
    }
  });

  it('never reuses an in-sample case id, so the two sets cannot be confused', () => {
    const inSampleIds = new Set([...Object.keys(inSample.cases), ...fs.readdirSync(CASES_DIR)]);
    for (const c of cases) expect(inSampleIds.has(c.id)).toBe(false);
  });

  it('covers true ctx/contract bugs, false findings with a trap, opinions and both languages', () => {
    const t = Object.entries(truth.cases);
    expect(t.filter(([, v]) => v.truth === 'true').length).toBeGreaterThanOrEqual(5);
    expect(t.filter(([, v]) => v.truth === 'false').length).toBeGreaterThanOrEqual(5);
    expect(t.some(([, v]) => v.truth === 'opinion')).toBe(true);
    expect(cases.filter((c) => c.alsoCheck?.length).length).toBeGreaterThanOrEqual(3);
    expect(new Set(cases.map((c) => c.language))).toEqual(new Set(['go', 'javascript']));
  });

  it.each(cases.map((c) => [c.id, c] as const))('%s has a head tree and well-formed reference witnesses', (id, c) => {
    expect(fs.existsSync(path.join(HELDOUT_DIR, id, 'head', c.finding.file))).toBe(true);
    for (const f of ['witness.json', ...(c.alsoCheck ?? []).map((a) => a.witnessFile)]) {
      const out = read(id, f);
      if (!out.claim.testable) {
        expect(out.witness).toBeNull();
      } else {
        expect(out.claim.file).toBe(c.finding.file);
        expect(validateWitness(out.claim, out.witness!, path.join(HELDOUT_DIR, id, 'head'))).toBeNull();
      }
    }
  });

  it('every true case has a reference witness whose expected verdict is a proven one', () => {
    for (const c of cases) {
      const t = truth.cases[c.id];
      if (t.truth === 'true') expect(c.expectedVerdict).toBe(t.attribution === 'regression' ? 'proven_regression' : 'proven_preexisting');
      if (t.truth === 'false') expect(c.expectedVerdict).toBe('refuted');
      if (t.truth === 'opinion') expect(c.expectedVerdict).toBe('opinion');
    }
  });

  it('go-median-new-true really has no file on base (exercises the base-null path)', () => {
    expect(fs.existsSync(path.join(HELDOUT_DIR, 'go-median-new-true', 'base', 'stats', 'stats.go'))).toBe(false);
  });
});
