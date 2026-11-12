import { jest } from '@jest/globals';
import { GeminiAgent } from '../src/agent';
import { StageCollector } from '../src/stageMetrics';
import { setUsageSink, resetUsageSink } from '../src/usage';

// The real usage.ts runs here (see agent.test.ts for why mocking it is unreliable);
// its sink is redirected so nothing touches object storage.
const CHUNKS = [{ file: 'a.ts', content: '@@ -1,1 +1,2 @@\n+const x = 1;' }];

function fakeAi(calls: any[], extra: Record<string, unknown> = {}) {
  const generateContent = jest.fn<any>().mockImplementation(async (args: any) => {
    calls.push(args);
    const isDiscovery = args.config.responseSchema?.type === 'OBJECT';
    return {
      modelVersion: args.model,
      text: isDiscovery
        ? JSON.stringify({ filesAnalyzed: ['a.ts'], issues: [{ file: 'a.ts', line: 1, severity: 'HIGH', summary: 's' }] })
        : JSON.stringify([{ file: 'a.ts', line: 1, severity: 'HIGH', summary: 's', description: 'd', suggestion: 'x' }]),
      usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5 },
      candidates: [{ finishReason: 'STOP' }],
      ...extra,
    };
  });
  return { models: { generateContent } } as any;
}

describe('GeminiAgent model / cap / thinking routing', () => {
  let originalEnv: NodeJS.ProcessEnv;
  const clear = () => {
    for (const k of ['GEMINI_MODEL', 'DISCOVERY_MODEL', 'REMEDIATION_MODEL', 'BASIC_MODEL', 'GEMINI_MAX_OUTPUT_TOKENS', 'GEMINI_THINKING_LEVEL', 'USE_TRIAGE_AGENT']) delete process.env[k];
  };

  beforeEach(() => {
    originalEnv = { ...process.env };
    clear();
    process.env.GEMINI_API_KEY = 'test-key';
    process.env.USE_CONTEXT_CACHING = 'false';
    setUsageSink(() => {});
  });
  afterEach(() => {
    process.env = originalEnv;
    resetUsageSink();
  });

  it('with nothing set: both passes use the default model and send no output cap or thinking config', async () => {
    const calls: any[] = [];
    const agent = new GeminiAgent('Logic', 'p');
    agent['ai'] = fakeAi(calls);
    await agent.analyze(CHUNKS);
    expect(calls.map(c => c.model)).toEqual(['gemini-3.1-pro-preview', 'gemini-3.1-pro-preview']);
    for (const c of calls) {
      expect('maxOutputTokens' in c.config).toBe(false);
      expect('thinkingConfig' in c.config).toBe(false);
    }
  });

  it('GEMINI_MODEL alone moves both swarm passes (the pre-existing behaviour)', async () => {
    process.env.GEMINI_MODEL = 'gemini-3.8-flash';
    const calls: any[] = [];
    const agent = new GeminiAgent('Logic', 'p');
    agent['ai'] = fakeAi(calls);
    await agent.analyze(CHUNKS);
    expect(calls.map(c => c.model)).toEqual(['gemini-3.8-flash', 'gemini-3.8-flash']);
  });

  it('DISCOVERY_MODEL and REMEDIATION_MODEL route the two passes independently; the other pass keeps GEMINI_MODEL', async () => {
    process.env.GEMINI_MODEL = 'gemini-3.8-flash';
    process.env.DISCOVERY_MODEL = 'gemini-4-argon';
    const calls: any[] = [];
    const agent = new GeminiAgent('Logic', 'p');
    agent['ai'] = fakeAi(calls);
    await agent.analyze(CHUNKS);
    expect(calls.map(c => c.model)).toEqual(['gemini-4-argon', 'gemini-3.8-flash']);

    process.env.REMEDIATION_MODEL = 'gemini-3.1-pro-preview';
    calls.length = 0;
    await agent.analyze(CHUNKS);
    expect(calls.map(c => c.model)).toEqual(['gemini-4-argon', 'gemini-3.1-pro-preview']);
  });

  it('a basic-role agent uses BASIC_MODEL for both of its passes and ignores the swarm stage variables', async () => {
    process.env.GEMINI_MODEL = 'gemini-3.8-flash';
    process.env.DISCOVERY_MODEL = 'gemini-4-argon';
    process.env.BASIC_MODEL = 'gemini-3.1-pro-preview';
    const calls: any[] = [];
    const agent = new GeminiAgent('Basic', 'p', 'basic');
    agent['ai'] = fakeAi(calls);
    await agent.analyze(CHUNKS);
    expect(calls.map(c => c.model)).toEqual(['gemini-3.1-pro-preview', 'gemini-3.1-pro-preview']);
  });

  it('the legacy per-file path (USE_TRIAGE_AGENT=false) uses BASIC_MODEL', async () => {
    process.env.USE_TRIAGE_AGENT = 'false';
    process.env.BASIC_MODEL = 'gemini-3.8-flash';
    const calls: any[] = [];
    const agent = new GeminiAgent('Logic', 'p');
    agent['ai'] = {
      models: { generateContent: jest.fn<any>().mockImplementation(async (a: any) => { calls.push(a); return { text: '[]' }; }) },
    } as any;
    await agent.analyze(CHUNKS);
    expect(calls).toHaveLength(1);
    expect(calls[0].model).toBe('gemini-3.8-flash');
  });

  it('GEMINI_MAX_OUTPUT_TOKENS and GEMINI_THINKING_LEVEL reach discovery and remediation', async () => {
    process.env.GEMINI_MAX_OUTPUT_TOKENS = '12000';
    process.env.GEMINI_THINKING_LEVEL = 'LOW';
    const calls: any[] = [];
    const agent = new GeminiAgent('Logic', 'p');
    agent['ai'] = fakeAi(calls);
    await agent.analyze(CHUNKS);
    expect(calls).toHaveLength(2);
    for (const c of calls) {
      expect(c.config.maxOutputTokens).toBe(12000);
      expect(c.config.thinkingConfig).toEqual({ thinkingLevel: 'LOW' });
      // The knobs must not displace the schema / mime type.
      expect(c.config.responseMimeType).toBe('application/json');
      expect(c.config.responseSchema).toBeDefined();
    }
  });

  it('feeds the per-stage collector: served model, finish reason, and a served-model mismatch', async () => {
    process.env.DISCOVERY_MODEL = 'gemini-3.5-flash';
    const calls: any[] = [];
    const ai = fakeAi(calls);
    const orig = ai.models.generateContent;
    ai.models.generateContent = jest.fn<any>().mockImplementation(async (a: any) => {
      const r = await orig(a);
      return a.model === 'gemini-3.5-flash' ? { ...r, modelVersion: 'gemini-3.6-flash' } : r;
    });
    const agent = new GeminiAgent('Logic', 'p');
    agent['ai'] = ai;
    agent.stats = new StageCollector();
    await agent.analyze(CHUNKS);
    const s = agent.stats.summary();
    expect(s.discovery.servedModels).toEqual({ 'gemini-3.6-flash': 1 });
    expect(s.discovery.servedModelMismatches).toBe(1);
    expect(s.remediation.servedModelMismatches).toBe(0);
    expect(s.remediation.finishReasons).toEqual({ STOP: 1 });
  });

  it('records a client-side timeout against the stage', async () => {
    process.env.GEMINI_TIMEOUT_MS = '20';
    const agent = new GeminiAgent('Logic', 'p');
    agent['ai'] = { models: { generateContent: jest.fn<any>().mockImplementation(() => new Promise(() => {})) } } as any;
    agent.stats = new StageCollector();
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const result = await agent.analyze(CHUNKS);
    errSpy.mockRestore();
    expect(result.findings).toEqual([]);
    expect(agent.stats.summary().discovery.timeouts).toBe(1);
  });
});
