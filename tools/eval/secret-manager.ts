import { SecretManagerServiceClient } from '@google-cloud/secret-manager';

const client = new SecretManagerServiceClient();

/**
 * Fetches a secret from Google Cloud Secret Manager.
 * @param secretName Name of the secret (e.g., 'gsr-github-pat')
 * @returns The secret value as a string.
 */
export async function getSecret(secretName: string): Promise<string> {
  try {
    const projectId = await client.getProjectId();
    const name = `projects/${projectId}/secrets/${secretName}/versions/latest`;
    const [version] = await client.accessSecretVersion({ name });

    const payload = version.payload?.data?.toString();
    if (!payload) {
      throw new Error(`Data for secret ${secretName} is empty.`);
    }

    return payload;
  } catch (error) {
    console.error(`Failed to fetch secret ${secretName} from Secret Manager.`, error);
    throw error;
  }
}
