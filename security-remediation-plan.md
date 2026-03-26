# Security Remediation Plan

This document outlines the step-by-step strategy for removing hardcoded credentials from the repository.

## 1. Immediate Credential Revocation
Any secret that has been committed to the repository is permanently compromised, even if rewritten or deleted in subsequent commits.
- **Action**: Revoke the hardcoded Google Gemini API Key (`AIzaSy...`) via the Google Cloud Console.
- **Action**: Revoke the hardcoded GitHub Personal Access Token (`ghp_...`) via GitHub Developer Settings.

## 2. Eliminate Fallback Patterns
Our test scripts (such as `run_single_pr.js` and `test_caching.js`) use an anti-pattern:
\`\`\`javascript
const pat = process.env.GITHUB_PAT || 'ghp_compromised_token_string';
\`\`\`
- **Action**: Remove the `|| '...'` fallback everywhere.
- **Action**: Implement explicit fail-fast logic. 
  \`\`\`javascript
  const pat = process.env.GITHUB_PAT;
  if (!pat) {
      console.error("FATAL: GITHUB_PAT is missing. Execution halted.");
      process.exit(1);
  }
  \`\`\`

## 3. Leverage Application Default Credentials (ADC)
Scripts currently binding to absolute paths (`/Users/benweitzer/projects/GSR/jetski-sa-key.json`) prevent portability.
- **Action**: Remove the `keyFilename` mapping entirely from GCS Storage instantiations.
- **Action**: Rely on `GOOGLE_APPLICATION_CREDENTIALS` natively supplied by the operating environment or CI/CD platform.

## 4. Environment Injection (dotenv)
- **Action**: Ensure `dotenv` is installed and required as early as possible in local test scripts.
- **Action**: Instruct all developers to create a local `.env` file containing `{GEMINI_API_KEY, GITHUB_PAT, GOOGLE_APPLICATION_CREDENTIALS}`.

## 5. CI/CD Secrets Injection
- **Action**: For Google Cloud Build (`cloudbuild.yaml`) and GitHub Actions, create matching Secret Manager instances.
- **Action**: Update the deployment mapping to inject these managed secrets as environment variables into the container at runtime.
