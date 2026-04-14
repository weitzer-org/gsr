# Ablation Testing Framework

The Ablation Testing Framework allows you to evaluate the impact of individual subagents in the GSR (Gemini Subagent Reviewer) pipeline by selectively disabling ("ablating") them. This helps quantify the necessity and effectiveness of each agent.

## How it Works

Ablation is driven by environment variables. The `Orchestrator` in `adk/backend/src/orchestrator.ts` checks for environment variables matching the pattern `ABLATE_[AGENT_NAME]` before executing an agent.

If the variable is set to `true`, the agent execution is skipped.

### Supported Agents

The following environment variables can be used to ablate agents:
*   `ABLATE_SECURITY=true` (Skips the Security Agent)
*   `ABLATE_ARCHITECTURE=true` (Skips the Architecture Agent)
*   `ABLATE_LOGIC=true` (Skips the Logic Agent)
*   `ABLATE_PERFORMANCE=true` (Skips the Performance Agent)
*   `ABLATE_TECHDEBT=true` (Skips the Techdebt Agent)
*   `ABLATE_TESTING=true` (Skips the Testing Agent)
*   `ABLATE_CICD=true` (Skips the CI/CD Agent)
*   `ABLATE_DEPENDENCIES=true` (Skips the Dependencies Agent)
*   `ABLATE_PROMPTSECURITY=true` (Skips the Prompt Security Agent)
*   `ABLATE_SECRETS=true` (Skips the Secrets Agent)

## How to Run an Ablation Test

You can run ablation tests using the evaluation harness located in `tools/eval`.

### Prerequisites

Ensure you have the correct environment variables set for authentication and project context:

```bash
export GOOGLE_APPLICATION_CREDENTIALS=/path/to/your/service-account-key.json
export GOOGLE_CLOUD_PROJECT=your-gcp-project-id
export GCS_REVIEW_BUCKET=gsr-review-results-weitzer-org
export GEMINI_SECRET=your-gemini-api-key-secret-name (optional, defaults to gsr-gemini-api-key)
```

### Running the Evaluation

Prefix the evaluation command with the desired ablation environment variables.

**Example: Ablating the Security Agent**

```bash
cd tools/eval
GCS_REVIEW_BUCKET=gsr-review-results-weitzer-org ABLATE_SECURITY=true npm run eval -- --config eval-config-ablation.json
```

This command will:
1.  Start the local backend server with `ABLATE_SECURITY=true`.
2.  Run the evaluation harness against the PRs specified in `eval-config-ablation.json`.
3.  Compare the results against the Production baseline.
4.  Upload the comparison report to GCS.

## Configuration

The list of PRs to evaluate is defined in a JSON configuration file (e.g., `eval-config-ablation.json`).

Example `eval-config-ablation.json`:
```json
[
  "https://github.com/weitzer-org/gemini-cli-fork/pull/3"
]
```

## Interpreting Results

The evaluation harness generates a summary report comparing findings count, token usage, and qualitative quality. A reduction in high-quality findings when an agent is ablated suggests that the agent is necessary and effective.
