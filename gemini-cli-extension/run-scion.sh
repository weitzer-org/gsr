#!/bin/bash

# Ensure scion is installed
if ! command -v scion &> /dev/null; then
    echo "Error: The 'scion' CLI could not be found."
    echo "Please install it via: go install github.com/GoogleCloudPlatform/scion/cmd/scion@latest"
    exit 1
fi

echo "Starting Gemini Subagent Reviewer (GSR) via Scion..."
DIFF=$(git diff -U5 HEAD)

if [ -z "$DIFF" ]; then
    echo "No local changes found to review."
    exit 0
fi

echo "Initializing Scion grove..."
scion init >/dev/null 2>&1

PROMPT_MSG="Please review the following code diff for your specific domain and report any candidate findings:\n\n\`\`\`diff\n$DIFF\n\`\`\`"

echo "Batch 1/4: Logic, Security, Secrets..."
scion start gsr-logic "$PROMPT_MSG" --system-prompt system_prompts/logic.md --template gemini &
scion start gsr-security "$PROMPT_MSG" --system-prompt system_prompts/security.md --template gemini &
scion start gsr-secrets "$PROMPT_MSG" --system-prompt system_prompts/secrets.md --template gemini &
wait

echo "Batch 2/4: Dependencies, Performance, Testing..."
scion start gsr-dependencies "$PROMPT_MSG" --system-prompt system_prompts/dependencies.md --template gemini &
scion start gsr-performance "$PROMPT_MSG" --system-prompt system_prompts/performance.md --template gemini &
scion start gsr-testing "$PROMPT_MSG" --system-prompt system_prompts/testing.md --template gemini &
wait

echo "Batch 3/4: Architecture, CI/CD, Tech Debt..."
scion start gsr-architecture "$PROMPT_MSG" --system-prompt system_prompts/architecture.md --template gemini &
scion start gsr-cicd "$PROMPT_MSG" --system-prompt system_prompts/cicd.md --template gemini &
scion start gsr-techdebt "$PROMPT_MSG" --system-prompt system_prompts/techdebt.md --template gemini &
wait

echo "Batch 4/4: Prompt Security..."
scion start gsr-promptsecurity "$PROMPT_MSG" --system-prompt system_prompts/promptsecurity.md --template gemini &
wait

echo "--------------------------------------------------------"
echo "✅ All GSR Subagents have finished their concurrent execution!"
echo "--------------------------------------------------------"
echo ""
echo "=== AGGREGATED CODE REVIEW RESULTS ==="
# Dump the logs of all the agents directly to the console so the Gemini CLI can read them and present them to the user
scion logs --all
