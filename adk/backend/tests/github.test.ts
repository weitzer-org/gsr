import { GitHubClient } from '../src/github';
import { jest } from '@jest/globals';


describe('GitHubClient', () => {
    let client: GitHubClient;

    beforeEach(() => {
        client = new GitHubClient('mock-pat');
    });

    it('should successfully parse a valid PR URL', () => {
        const url = 'https://github.com/GoogleCloudPlatform/scion/pull/123';
        const result = client.parsePRUrl(url);

        expect(result).toEqual({
            owner: 'GoogleCloudPlatform',
            repo: 'scion',
            pull_number: 123
        });
    });

    it('should throw an error for an invalid PR URL', () => {
        const url = 'https://github.com/GoogleCloudPlatform/scion/issues/123';
        expect(() => client.parsePRUrl(url)).toThrow('Invalid GitHub Pull Request URL.');
    });

    it('should fetch and parse PR diff successfully', async () => {
        const mockDiff = `
diff --git a/src/example.ts b/src/example.ts
index e69de29..d95f3ad 100644
--- a/src/example.ts
+++ b/src/example.ts
@@ -0,0 +1,3 @@
+export function test() {
+  console.log("hello");
+}
        `.trim();

        (client as any).octokit = {
            paginate: (jest.fn() as any).mockResolvedValue([{ filename: 'src/example.ts', patch: mockDiff }]),
            rest: {
                pulls: {
                    get: (jest.fn() as any).mockResolvedValue({ data: mockDiff }),
                    listFiles: jest.fn()
                }
            }
        };

        const chunks = await client.getPRDiff('https://github.com/GoogleCloudPlatform/scion/pull/123');
        
        expect(chunks).toHaveLength(1);
        expect(chunks[0].file).toBe('src/example.ts');
    });

    it('should throw an error if fetching PR diff fails', async () => {
        const originalConsoleError = console.error;
        console.error = jest.fn(); 

        (client as any).octokit = {
            paginate: (jest.fn() as any).mockRejectedValue(new Error('Network error')),
            rest: {
                pulls: {
                    get: (jest.fn() as any).mockRejectedValue(new Error('Network error')),
                    listFiles: jest.fn()
                }
            }
        };

        await expect(client.getPRDiff('https://github.com/GoogleCloudPlatform/scion/pull/123'))
            .rejects.toThrow('Failed to fetch PR diff: Network error');

        console.error = originalConsoleError;
    });

});

