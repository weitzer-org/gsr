import { describe, it, expect } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';
import { loadSeededFixture, scoreSeeded } from '../groundtruth';
import { scoreFixtureEntries, Fixture } from '../fixture-regression';
import { ReviewFinding } from '../api-client';

const f = (fileName: string, lineNumber: number, severity = 'HIGH', source = 'basic'): ReviewFinding =>
  ({ fileName, lineNumber, severity, source, issueDescription: 'x', suggestion: '' });

describe('seeded-bug fixture', () => {
  const fx = loadSeededFixture();
  const config = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'config.json'), 'utf8'));

  it('covers exactly the 10 gemini-cli-fork PRs in config.json, one bug each, with line ranges', () => {
    const forkPrs = config.sample_prs.filter((u: string) => u.includes('gemini-cli-fork'));
    expect(forkPrs).toHaveLength(10);
    expect(fx.entries.map(e => e.prUrl).sort()).toEqual([...forkPrs].sort());
    for (const e of fx.entries) {
      expect(e.locations.length).toBeGreaterThan(0);
      expect(e.summary.length).toBeGreaterThan(20);
    }
  });
});

describe('scoreSeeded', () => {
  const fx = loadSeededFixture();
  const pr3 = fx.entries.find(e => e.id === 'cli-input-loop-bug')!;
  const loc = pr3.locations[0];

  it('catches a bug when a finding of the scored source lands within the tolerance of a location', () => {
    const near = f(loc.file, loc.lineEnd + fx.lineTolerance);
    const far = f(loc.file, loc.lineEnd + fx.lineTolerance + 1);
    expect(scoreSeeded(fx, { [pr3.prUrl]: [near] }, 'any')[0].caught).toBe(true);
    expect(scoreSeeded(fx, { [pr3.prUrl]: [far] }, 'any')[0].caught).toBe(false);
  });

  it('matches paths that differ only by a prefix and requires the same file', () => {
    expect(scoreSeeded(fx, { [pr3.prUrl]: [f('/' + loc.file, loc.lineStart)] }, 'any')[0].caught).toBe(true);
    expect(scoreSeeded(fx, { [pr3.prUrl]: [f('packages/cli/src/other.ts', loc.lineStart)] }, 'any')[0].caught).toBe(false);
  });

  it('scopes by source: a swarm hit does not count for basic', () => {
    const hit = f(loc.file, loc.lineStart, 'HIGH', 'subagent');
    expect(scoreSeeded(fx, { [pr3.prUrl]: [hit] }, 'basic')[0].caught).toBe(false);
    expect(scoreSeeded(fx, { [pr3.prUrl]: [hit] }, 'subagent')[0].caught).toBe(true);
  });

  it('counts HIGH/CRITICAL findings outside every expected window as unmatched; MEDIUM and in-window ones are not', () => {
    const s = scoreSeeded(fx, { [pr3.prUrl]: [
      f(loc.file, loc.lineStart),                       // the bug
      f(loc.file, 9000, 'HIGH'),                        // elsewhere, HIGH
      f(loc.file, 9001, 'CRITICAL'),                    // elsewhere, CRITICAL
      f(loc.file, 9002, 'MEDIUM'),                      // elsewhere but not high
    ] }, 'any')[0];
    expect(s.findings).toBe(4);
    expect(s.highUnmatched).toBe(2);
  });

  it('omits a PR with no usable run instead of scoring it as a miss', () => {
    expect(scoreSeeded(fx, { [pr3.prUrl]: undefined }, 'any')).toEqual([]);
  });

  it('an empty review of a PR is a real miss (the run succeeded and found nothing)', () => {
    const s = scoreSeeded(fx, { [pr3.prUrl]: [] }, 'any');
    expect(s).toHaveLength(1);
    expect(s[0].caught).toBe(false);
  });
});

describe('scoreFixtureEntries (the job_tracker audit fixture, same rules as fixture-regression)', () => {
  const fx: Fixture = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'fixtures', 'job_tracker_regressions.json'), 'utf8'));
  const mc = fx.entries.must_catch[0];

  it('a must_catch passes when a basic finding lands near the line and fails when only a subagent finding does', () => {
    const basic = scoreFixtureEntries(fx, { [mc.prUrl]: [f(mc.file, mc.line, 'HIGH', 'basic')] });
    expect(basic.find(r => r.id === mc.id)!.pass).toBe(true);
    const swarm = scoreFixtureEntries(fx, { [mc.prUrl]: [f(mc.file, mc.line, 'HIGH', 'subagent')] });
    expect(swarm.find(r => r.id === mc.id)!.pass).toBe(false);
  });

  it('a PR that failed to review fails every entry for it (never a false green)', () => {
    const all = scoreFixtureEntries(fx, {}, { [mc.prUrl]: 'timeout' });
    const forPr = all.filter(r => r.prUrl === mc.prUrl);
    expect(forPr.length).toBeGreaterThan(0);
    expect(forPr.every(r => !r.pass && /cannot verify/.test(r.detail))).toBe(true);
  });

  it('must_not_flag_high fails on a HIGH finding at the line and passes when capped to MEDIUM', () => {
    const nf = fx.entries.must_not_flag_high[0];
    expect(scoreFixtureEntries(fx, { [nf.prUrl]: [f(nf.file, nf.line, 'HIGH')] }).find(r => r.id === nf.id)!.pass).toBe(false);
    expect(scoreFixtureEntries(fx, { [nf.prUrl]: [f(nf.file, nf.line, 'MEDIUM')] }).find(r => r.id === nf.id)!.pass).toBe(true);
  });
});
