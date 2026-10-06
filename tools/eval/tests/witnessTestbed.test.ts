import { describe, it, expect } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';
import { CASES_DIR, listCases } from '../witness-spike/testbed';
import { validateWitness } from '../witness-spike/pipeline';
import type { WitnessAuthorOutput } from '../../../adk/backend/src/witness/types';

const VERDICTS = ['proven_regression', 'proven_preexisting', 'refuted', 'hypothesis', 'opinion'];
const read = (...p: string[]): WitnessAuthorOutput => JSON.parse(fs.readFileSync(path.join(CASES_DIR, ...p), 'utf8'));

// Offline structure checks only (no Docker, no model). The cases are executed
// by `ts-node witness-spike/testbed.ts`, or by this file's e2e block below when
// WITNESS_E2E=1.
describe('witness testbed cases', () => {
  const cases = listCases();

  it('covers every verdict and both languages', () => {
    expect(new Set(cases.map((c) => c.expectedVerdict))).toEqual(new Set(VERDICTS));
    expect(new Set(cases.map((c) => c.language))).toEqual(new Set(['go', 'javascript']));
  });

  it('keeps directory name and case id in sync', () => {
    for (const id of fs.readdirSync(CASES_DIR, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => e.name)) {
      expect(JSON.parse(fs.readFileSync(path.join(CASES_DIR, id, 'case.json'), 'utf8')).id).toBe(id);
    }
  });

  it.each(cases.map((c) => [c.id, c] as const))('%s has head files and a well-formed reference witness', (id, c) => {
    const dir = path.join(CASES_DIR, id);
    expect(VERDICTS).toContain(c.expectedVerdict);
    expect(fs.existsSync(path.join(dir, 'head'))).toBe(true);
    expect(fs.existsSync(path.join(dir, 'head', c.finding.file))).toBe(true);

    const files = ['witness.json', ...(c.alsoCheck ?? []).map((a) => a.witnessFile)];
    for (const f of files) {
      const out = read(id, f);
      if (!out.claim.testable) {
        expect(out.witness).toBeNull();
        expect(out.claim.notTestableKind).toBeDefined();
      } else {
        expect(out.witness).not.toBeNull();
        expect(out.claim.file).toBe(c.finding.file);
        expect(validateWitness(out.claim, out.witness!, path.join(dir, 'head'))).toBeNull();
      }
    }
  });

  it('go-new-code really has no file on base (exercises the base-null path)', () => {
    const c = cases.find((x) => x.id === 'go-new-code')!;
    expect(fs.existsSync(path.join(CASES_DIR, c.id, 'base', c.finding.file))).toBe(false);
  });

  it('validateWitness rejects a claim/witness language mismatch (keeps Go witnesses out of the unsandboxed Jest path)', () => {
    const c = cases.find((x) => x.id === 'go-regression')!;
    const out = read(c.id, 'witness.json');
    const mislabelled = { ...out.claim, language: 'javascript' as const };
    expect(validateWitness(mislabelled, out.witness!, path.join(CASES_DIR, c.id, 'head'))).toMatch(/does not match/);
  });

  it('validateWitness accepts a root-level file without a "./" prefix and rejects a missing directory', () => {
    const tmp = fs.mkdtempSync(path.join(require('os').tmpdir(), 'gsr-val-'));
    try {
      fs.writeFileSync(path.join(tmp, 'main.go'), 'package main');
      const source = 'package main\n\nimport "testing"\n\nfunc TestGSRWitness(t *testing.T) {}\n';
      const claim = { testable: true, language: 'go' as const, file: 'main.go', symbol: 'f', input: '', expected: '', actual: '' };
      const w = (p: string) => ({ path: p, language: 'go' as const, framework: 'go-test' as const, source });
      expect(validateWitness(claim, w('zz_gsr_witness_test.go'), tmp)).toBeNull();
      expect(validateWitness({ ...claim, file: 'nope/x.go' }, w('nope/zz_gsr_witness_test.go'), tmp)).toMatch(/does not exist/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
