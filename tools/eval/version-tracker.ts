import { execSync } from 'child_process';

/**
 * Gets the current Git commit hash
 */
export function getLocalGitHash(): string {
  try {
    return execSync('git rev-parse HEAD', { encoding: 'utf-8' }).trim();
  } catch (err) {
    console.warn('Unable to determine local Git hash.', err);
    return 'unknown';
  }
}

/**
 * Gets a clean metadata object for the current run
 */
export function buildRunMetadata(productionUrl: string) {
  return {
    run_date: new Date().toISOString(),
    environments: {
      local: {
        commit: getLocalGitHash(),
        timestamp: new Date().toISOString()
      },
      production: {
        url: productionUrl,
        timestamp: new Date().toISOString()
        // Commit for production would ideally be fetched from a /api/version endpoint.
      }
    }
  };
}
