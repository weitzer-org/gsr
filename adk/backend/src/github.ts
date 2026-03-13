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
   * Fetches the raw diff of a Pull Request and parses it into chunks
   */
  public async getPRDiff(url: string): Promise<DiffChunk[]> {
    const { owner, repo, pull_number } = this.parsePRUrl(url);

    try {
      const response = await this.octokit.rest.pulls.get({
        owner,
        repo,
        pull_number,
        mediaType: {
          format: "diff",
        },
      });

      const rawDiff = response.data as unknown as string;
      return this.parseDiff(rawDiff);
    } catch (error: any) {
      console.error("Failed to fetch PR diff:", error);
      throw new Error(`Failed to fetch PR diff: ${error.message}`);
    }
  }

  /**
   * Parses a raw unified git diff into an array of file-specific DiffChunks
   */
  private parseDiff(rawDiff: string): DiffChunk[] {
    const chunks: DiffChunk[] = [];
    const files = rawDiff.split(/^diff --git a\/(.+?) b\/(.+?)$/m);
    
    // The split returns: [ preamble, filename_a, filename_b, file_diff_content, ... ]
    for (let i = 1; i < files.length; i += 3) {
      const filename = files[i];
      const content = files[i + 2]?.trim();
      if (filename && content) {
        chunks.push({
          file: filename,
          content: content
        });
      }
    }
    return chunks;
  }
}
