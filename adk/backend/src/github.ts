import { Octokit } from '@octokit/rest';
import { DiffChunk } from './types.js';

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
}
