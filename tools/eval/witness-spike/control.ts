// Control run for the Phase 0 spike: runs every authored, testable witness
// against an arbitrary checkout (e.g. a later commit where the bug may have
// been fixed) and prints the raw outcome. A witness that is valid should pass
// on fixed code; one that still fails there is either a still-live bug or a
// witness that asserts the wrong thing, so every FAIL needs a human look.
//
//   ts-node witness-spike/control.ts <checkout-dir>
// Env as for run.ts: GO_MOD_CACHE, GO_BUILD_CACHE, WITNESS_IMAGE.

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { WitnessAuthorOutput } from '../../../adk/backend/src/witness/types';
import { GO_WITNESS_TEST_NAME } from '../../../adk/backend/src/witness/types';
import { copyWorkspaceWithoutGit, runGoWitness, SandboxConfig } from './sandbox';

async function main() {
  const checkout = process.argv[2];
  if (!checkout) throw new Error('usage: control.ts <checkout-dir>');
  const dir = path.join(__dirname, '..', 'fixtures', 'witness-spike');
  const cfg: SandboxConfig = {
    image: process.env.WITNESS_IMAGE || 'witness-go:1.24',
    goModCacheDir: process.env.GO_MOD_CACHE || execFileSync('go', ['env', 'GOMODCACHE'], { encoding: 'utf8', env: { ...process.env, GOTOOLCHAIN: 'local' } }).trim(),
    goBuildCacheDir: process.env.GO_BUILD_CACHE || '/tmp/gsr-witness-gocache',
    timeoutMs: 180000,
    memory: '2g',
    cpus: '2',
  };
  fs.mkdirSync(cfg.goBuildCacheDir, { recursive: true });
  fs.chmodSync(cfg.goBuildCacheDir, 0o777);

  for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort()) {
    const out: WitnessAuthorOutput = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    if (!out.claim.testable || !out.witness) continue;
    if (!fs.existsSync(path.join(checkout, out.claim.file))) {
      console.log(`${f.padEnd(52)} file absent in checkout`);
      continue;
    }
    const ws = copyWorkspaceWithoutGit(checkout);
    try {
      fs.writeFileSync(path.join(ws, out.witness.path), out.witness.source);
      const r = await runGoWitness(cfg, ws, path.dirname(out.claim.file), GO_WITNESS_TEST_NAME);
      console.log(`${f.padEnd(52)} ${r.result.witnessOutcome}${r.result.buildFailed ? ' (build failed)' : ''}${r.result.timedOut ? ' (timed out)' : ''} ${r.wallMs}ms`);
      if (r.result.witnessOutcome !== 'pass') console.log('    ' + r.result.outputTail.trim().split('\n').slice(-6).join('\n    '));
    } finally {
      fs.rmSync(ws, { recursive: true, force: true });
    }
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
