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

    it('should correctly parse a unified git diff text', () => {
        const rawDiff = `
diff --git a/src/example.ts b/src/example.ts
index e69de29..d95f3ad 100644
--- a/src/example.ts
+++ b/src/example.ts
@@ -0,0 +1,3 @@
+export function test() {
+  console.log("hello");
+}
diff --git a/test/test.ts b/test/test.ts
index e69de29..c12bb1a 100644
--- a/test/test.ts
+++ b/test/test.ts
@@ -0,0 +1,2 @@
+import { test } from '../src/example';
+test();
`.trim();

        // Access the private method for testing via any cast
        const diffChunks = (client as any).parseDiff(rawDiff);

        expect(diffChunks).toHaveLength(2);
        expect(diffChunks[0].file).toBe('src/example.ts');
        expect(diffChunks[0].content).toContain('export function test()');
        
        expect(diffChunks[1].file).toBe('test/test.ts');
        expect(diffChunks[1].content).toContain('import { test }');
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
            rest: {
                pulls: {
                    get: (jest.fn() as any).mockResolvedValue({ data: mockDiff })
                }
            }
        };

        const chunks = await client.getPRDiff('https://github.com/GoogleCloudPlatform/scion/pull/123');
        
        expect(chunks).toHaveLength(1);
        expect(chunks[0].file).toBe('src/example.ts');
        expect((client as any).octokit.rest.pulls.get).toHaveBeenCalledWith({
            owner: 'GoogleCloudPlatform',
            repo: 'scion',
            pull_number: 123,
            mediaType: { format: 'diff' }
        });
    });

    it('should throw an error if fetching PR diff fails', async () => {
        const originalConsoleError = console.error;
        console.error = jest.fn(); 

        (client as any).octokit = {
            rest: {
                pulls: {
                    get: (jest.fn() as any).mockRejectedValue(new Error('Network error'))
                }
            }
        };

        await expect(client.getPRDiff('https://github.com/GoogleCloudPlatform/scion/pull/123'))
            .rejects.toThrow('Failed to fetch PR diff: Network error');

        console.error = originalConsoleError;
    });

});

