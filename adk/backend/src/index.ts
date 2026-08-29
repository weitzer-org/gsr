import * as dotenv from 'dotenv';
import * as path from 'path';

const currentDir = typeof __dirname !== 'undefined' ? __dirname : undefined;
if (currentDir) {
    const isCompiled = currentDir.includes(path.join('dist', 'src'));
    const envPath = isCompiled
        ? path.resolve(currentDir, '../../.env')
        : path.resolve(currentDir, '../.env');
    dotenv.config({ path: envPath });
} else {
    dotenv.config();
}

import { app } from './app';
import { assertProductionAuthConfigured } from './auth';
import { assertProductionUsageIngestConfigured } from './usageIngestAuth';
import { assertProductionFeedbackAuthConfigured } from './feedbackAuth';

assertProductionAuthConfigured();
assertProductionUsageIngestConfigured();
assertProductionFeedbackAuthConfigured();

const PORT = process.env.PORT || 8080;

const server = app.listen(PORT as number, '0.0.0.0', () => {
  console.log(`GSR ADK Backend listening on IPv4 0.0.0.0 port ${PORT}`);
});

// Node's default requestTimeout (5 min) is the same magnitude as the
// deduplicator's own internal Gemini timeout (GEMINI_TIMEOUT_MS), plus
// subagent review time is added on top — so a slow-but-recovering request
// could get killed by Node itself before deduplicator.ts's graceful
// un-deduped fallback ever reaches the client. Give the whole request
// comfortable headroom beyond the deduplicator's own ceiling.
const geminiTimeoutMs = parseInt(process.env.GEMINI_TIMEOUT_MS || '300000', 10);
server.requestTimeout = geminiTimeoutMs + 180000;
