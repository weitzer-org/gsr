import { Octokit } from '@octokit/rest';
import { ReviewFinding } from './api-client';

export async function fetchBotComments(prUrl: string, pat: string): Promise<{ gcaFindings: ReviewFinding[], codeRabbitFindings: ReviewFinding[] }> {
  const octokit = new Octokit({ auth: pat });
  
  const regex = /github\.com\/([^\/]+)\/([^\/]+)\/pull\/(\d+)/;
  const match = prUrl.match(regex);
  if (!match) {
    throw new Error("Invalid GitHub Pull Request URL.");
  }
  const owner = match[1];
  const repo = match[2];
  const pull_number = parseInt(match[3], 10);

  const comments = await octokit.paginate(octokit.rest.pulls.listReviewComments, {
    owner,
    repo,
    pull_number,
    per_page: 100
  });

  const gcaFindings: ReviewFinding[] = [];
  const codeRabbitFindings: ReviewFinding[] = [];

  for (const comment of comments) {
    const login = comment.user?.login || '';
    
    // Check if it's GCA or Code Rabbit
    const isGCA = login.includes('gemini-code-assist');
    const isCodeRabbit = login.includes('coderabbit');
    
    if (isGCA || isCodeRabbit) {
      const sourceName = isGCA ? 'GCA' : 'CodeRabbit';
      
      const finding: ReviewFinding = {
        fileName: comment.path,
        lineNumber: comment.line || comment.original_line || 1,
        issueDescription: comment.body,
        suggestion: '', // Typically interleaved in the body for external bots
        severity: 'UNKNOWN',
        source: sourceName
      };

      if (isGCA) {
        gcaFindings.push(finding);
      } else {
        codeRabbitFindings.push(finding);
      }
    }
  }

  return { gcaFindings, codeRabbitFindings };
}
