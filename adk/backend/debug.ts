import { GitHubClient } from './src/github';
import { Orchestrator } from './src/orchestrator';
import * as dotenv from 'dotenv';

dotenv.config({ path: './.env' });

async function test() {
    console.log("Starting debug script...");
    const pat = "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";
    const url = "https://github.com/benw307/logo-maker-weitzer/pull/1";

    const ghClient = new GitHubClient(pat);
    const orchestrator = new Orchestrator(5);

    orchestrator.onProgress = (agentName, file, status) => {
        console.log(`[PROGRESS] ${agentName} | ${file} | ${status}`);
    };

    console.log("Fetching diff...");
    const chunks = await ghClient.getPRDiff(url);
    console.log(`Found ${chunks.length} chunks. Starting review...`);

    const findings = await orchestrator.runReview(chunks);
    console.log(`Review complete! Findings count: ${findings.length}`);
    console.log(JSON.stringify(findings, null, 2));
}

test().catch(e => console.error("FATAL ERROR:", e));
