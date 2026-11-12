import { describe, it, expect } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';
import { DISCOVERY_RESPONSE_SCHEMA } from '../src/agent';

// tools/eval/probe-models.ts probes models with a serialized copy of this schema (tools/eval is installed
// on its own in CI and cannot import the backend). If the production schema changes, regenerate the fixture:
//   cd adk/backend && npx ts-node -T -e 'import {DISCOVERY_RESPONSE_SCHEMA} from "./src/agent"; require("fs").writeFileSync("../../tools/eval/fixtures/discovery-schema.json", JSON.stringify(DISCOVERY_RESPONSE_SCHEMA,null,2)+"\n")'
describe('probe fixture', () => {
  it('tools/eval/fixtures/discovery-schema.json equals the production discovery schema', () => {
    const fixture = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), '..', '..', 'tools', 'eval', 'fixtures', 'discovery-schema.json'), 'utf8'));
    expect(fixture).toEqual(JSON.parse(JSON.stringify(DISCOVERY_RESPONSE_SCHEMA)));
  });
});
