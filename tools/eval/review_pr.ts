import { runReview } from './api-client';
import * as fs from 'fs';

async function main() {
    const prUrl = 'https://github.com/weitzer-org/gsr/pull/24';
    const pat = process.env.GITHUB_PAT || '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';
    
    console.log(`Sending Code Review request for PR: ${prUrl}...`);
    try {
        const result = await runReview('http://localhost:8080', prUrl, pat);
        fs.writeFileSync('pr24_findings.json', JSON.stringify(result, null, 2));
        console.log("Successfully saved to pr24_findings.json");
    } catch(e) {
        console.error("Failed!", e);
    }
}

main();
