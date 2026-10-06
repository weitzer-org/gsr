// Runs every case in fixtures/witness-testbed/cases through the real
// witness pipeline (validate, sandbox run x2 on head, run on base, decide) and
// checks the verdict against the case's expectedVerdict. The cases are tiny
// synthetic projects, so this runs offline in seconds and needs no model.
//
//   ts-node witness-spike/testbed.ts [--only <case-id>] [--list]
//
// Go cases need Docker and the witness-go image (see run-probe.sh / the spike
// report); Jest cases run unsandboxed with tools/eval's own jest and are
// trusted fixtures only. Exits 1 on any mismatch.

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { WitnessAuthorOutput, WitnessVerdict } from '../../../adk/backend/src/witness/types';
import { evaluateWitness } from './pipeline';
import { SandboxConfig } from './sandbox';

export const CASES_DIR = path.join(__dirname, '..', 'fixtures', 'witness-testbed', 'cases');

export interface AlsoCheck { witnessFile: string; expectedVerdict: WitnessVerdict; knownFalseProof?: boolean }
export interface TestbedCase {
  id: string;
  language: 'go' | 'javascript';
  finding: { file: string; line: number; severity: string; summary: string };
  expectedVerdict: WitnessVerdict;
  notes: string;
  timeoutMs?: number;
  alsoCheck?: AlsoCheck[];
}

export function listCases(): TestbedCase[] {
  return fs.readdirSync(CASES_DIR).sort().map((id) => JSON.parse(fs.readFileSync(path.join(CASES_DIR, id, 'case.json'), 'utf8')));
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--list')) {
    for (const c of listCases()) console.log(`${c.id.padEnd(30)} ${c.language.padEnd(11)} expects ${c.expectedVerdict}`);
    return;
  }
  const only = args.includes('--only') ? args[args.indexOf('--only') + 1] : undefined;

  const baseCfg: SandboxConfig = {
    image: process.env.WITNESS_IMAGE || 'witness-go:1.24',
    goModCacheDir: process.env.GO_MOD_CACHE || execFileSync('go', ['env', 'GOMODCACHE'], { encoding: 'utf8', env: { ...process.env, GOTOOLCHAIN: 'local' } }).trim(),
    goBuildCacheDir: process.env.GO_BUILD_CACHE || '/tmp/gsr-witness-gocache',
    timeoutMs: 120000,
    memory: '2g',
    cpus: '2',
  };
  fs.mkdirSync(baseCfg.goBuildCacheDir, { recursive: true });
  fs.chmodSync(baseCfg.goBuildCacheDir, 0o777);
  const jest = { jestBin: path.join(__dirname, '..', 'node_modules', '.bin', 'jest') };

  let failures = 0;
  for (const c of listCases().filter((x) => !only || x.id === only)) {
    const dir = path.join(CASES_DIR, c.id);
    const head = path.join(dir, 'head');
    const base = fs.existsSync(path.join(dir, 'base')) ? path.join(dir, 'base') : null;
    const cfg = { ...baseCfg, timeoutMs: c.timeoutMs ?? baseCfg.timeoutMs };
    const checks: { file: string; expected: WitnessVerdict; known?: boolean }[] = [
      { file: 'witness.json', expected: c.expectedVerdict },
      ...(c.alsoCheck ?? []).map((a) => ({ file: a.witnessFile, expected: a.expectedVerdict, known: a.knownFalseProof })),
    ];
    for (const chk of checks) {
      const out: WitnessAuthorOutput = JSON.parse(fs.readFileSync(path.join(dir, chk.file), 'utf8'));
      const started = Date.now();
      const ev = await evaluateWitness(cfg, head, base, out, jest);
      const ok = ev.verdict === chk.expected;
      if (!ok) failures++;
      console.log(`${ok ? 'ok  ' : 'FAIL'} ${c.id.padEnd(28)} ${chk.file.padEnd(20)} got ${ev.verdict.padEnd(18)} want ${chk.expected}${chk.known ? '  (known false proof)' : ''}  ${Date.now() - started}ms${ev.note ? '  ' + ev.note : ''}`);
      if (!ok && ev.runs) console.log('     head tail: ' + ev.runs.head1.outputTail.trim().split('\n').slice(-4).join(' | '));
    }
  }
  if (failures) {
    console.error(`\n${failures} case(s) did not match their expected verdict`);
    process.exit(1);
  }
}

if (require.main === module) main().catch((e) => { console.error(e); process.exit(1); });
