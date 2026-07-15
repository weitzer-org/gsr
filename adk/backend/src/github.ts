import { Octokit } from '@octokit/rest';
import { CandidateFinding, DiffChunk } from './types.js';

const SEVERITY_EMOJI: Record<string, string> = {
  CRITICAL: '🔴',
  HIGH: '🟠',
  MEDIUM: '🟡',
  LOW: '🔵'
};

export class GitHubClient {
  private octokit: Octokit;

  constructor(pat: string) {
    this.octokit = new Octokit({ auth: pat });
  }

  /**
   * Parses a GitHub PR URL to extract owner, repo, and pull_number
   */
  public parsePRUrl(url: string): { owner: string, repo: string, pull_number: number } {
    const regex = /github\.com\/([^\/]+)\/([^\/]+)\/pull\/(\d+)/;
    const match = url.match(regex);
    if (!match) {
      throw new Error("Invalid GitHub Pull Request URL.");
    }
    return {
      owner: match[1],
      repo: match[2],
      pull_number: parseInt(match[3], 10)
    };
  }

  /**
   * Fetches the file changes of a Pull Request and maps them into chunks
   */
  public async getPRDiff(url: string): Promise<DiffChunk[]> {
    const { owner, repo, pull_number } = this.parsePRUrl(url);

    try {
      // Use pagination to fetch all files without hitting the 300 file monolithic limit
      const files = await this.octokit.paginate(this.octokit.rest.pulls.listFiles, {
        owner,
        repo,
        pull_number,
        per_page: 100
      });

      const IGNORE_PATTERNS = [
        /package-lock\.json$/i,
        /yarn\.lock$/i,
        /pnpm-lock\.yaml$/i,
        /\.min\.js$/i,
        /\.bundle\.js$/i,
        /\.svg$/i,
        /^dist\//i,
        /^build\//i
      ];

      const chunks: DiffChunk[] = [];
      for (const file of files) {
        // file.patch only exists if the file was modified and the diff is not too large
        if (file.patch) {
          const isIgnored = IGNORE_PATTERNS.some(pattern => pattern.test(file.filename));
          if (!isIgnored) {
            chunks.push({
              file: file.filename,
              content: file.patch
            });
          }
        }
      }
      return chunks;
    } catch (error: any) {
      console.error("Failed to fetch PR diff:", error);
      throw new Error(`Failed to fetch PR diff: ${error.message}`);
    }
  }

  private formatFindingBody(finding: CandidateFinding): string {
    const emoji = SEVERITY_EMOJI[finding.severity] || '';
    let body = `${emoji} **${finding.severity}**${finding.agent ? ` · ${finding.agent}` : ''} — ${finding.summary}\n\n${finding.description}`;
    if (finding.suggestion) {
      body += `\n\n${finding.suggestion}`;
    }
    return body;
  }

  /**
   * Submits findings as a single GitHub PR review with inline comments. The
   * Reviews API rejects the whole batch if any comment's line isn't part of
   * the diff, so on failure we fall back to posting comments one at a time
   * (skipping only the ones GitHub rejects) plus a summary issue comment.
   */
  public async postReviewComments(url: string, findings: CandidateFinding[]): Promise<{ posted: number; skipped: number }> {
    const { owner, repo, pull_number } = this.parsePRUrl(url);
    const summary = findings.length === 0
      ? '**GSR Review** — no issues found.'
      : `**GSR Review** — ${findings.length} finding(s).`;

    if (findings.length === 0) {
      await this.octokit.rest.pulls.createReview({ owner, repo, pull_number, event: 'COMMENT', body: summary });
      return { posted: 0, skipped: 0 };
    }

    const comments = findings.map(f => ({
      path: f.file,
      line: f.line,
      side: 'RIGHT' as const,
      body: this.formatFindingBody(f)
    }));

    try {
      await this.octokit.rest.pulls.createReview({ owner, repo, pull_number, event: 'COMMENT', body: summary, comments });
      return { posted: comments.length, skipped: 0 };
    } catch (error: any) {
      console.warn(`Batched review submission failed (${error.message}); falling back to posting comments individually.`);

      const pr = await this.octokit.rest.pulls.get({ owner, repo, pull_number });
      const commit_id = pr.data.head.sha;

      let posted = 0;
      let skipped = 0;
      for (const comment of comments) {
        try {
          await this.octokit.rest.pulls.createReviewComment({
            owner, repo, pull_number, commit_id,
            path: comment.path,
            line: comment.line,
            side: comment.side,
            body: comment.body
          });
          posted++;
        } catch (commentError: any) {
          console.warn(`Skipping comment on ${comment.path}:${comment.line} (${commentError.message})`);
          skipped++;
        }
      }

      const fallbackSummary = summary + (skipped > 0
        ? `\n\n_(${skipped} finding(s) could not be placed inline on the diff and were omitted; see workflow logs.)_`
        : '');
      await this.octokit.rest.issues.createComment({ owner, repo, issue_number: pull_number, body: fallbackSummary });

      return { posted, skipped };
    }
  }
}
