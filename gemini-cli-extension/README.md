# Gemini Subagent Reviewer (GSR)

GSR is a concurrent, multi-agent code orchestration tool built as a Gemini CLI Extension. It leverages the **Scion Multi-Agent Testbed** to spin up 10 isolated, specialized LLM subagents in the background that concurrently analyze your local `git diff`.

## Subagents
The 10 specialized subagents are:
1. ✅ **Logic & Coding Standards**
2. 🔒 **Security Vulnerability Scanner**
3. 🔑 **Secret & Credential Scanner**
4. 📦 **Dependency & Supply Chain Risks**
5. ⚡ **Performance & Complexity**
6. 🧪 **Test Coverage & Quality**
7. 🏛️ **Architecture & Anti-Patterns**
8. 🚀 **CI/CD Configuration**
9. 🧹 **Deprecation & Tech Debt**
10. 🤖 **AI & Prompt Security**

All prompts for these subagents are completely transparent and fully customizable. You can find their instructions in `system_prompts/*.md`.

## Prerequisites

To make setup as easy as possible, GSR offers two different execution backends:

### 1. The Simple Setup (Node.js Wrapper)
This is the default backend. It runs the review natively using Node.js without any complex external dependencies.
1. **Gemini CLI:** The core tool execution harness.
2. **Node.js (v18+):** Required to run the local wrapper.

### 2. The Advanced Setup (Scion Orchestrator)
This backend uses the experimental Scion multi-agent testbed to run agents in fully isolated background `tmux` sessions.
1. **Go:** Required to install Scion.
2. **Scion:** Install via `go install github.com/GoogleCloudPlatform/scion/cmd/scion@latest` (Ensure `$GOPATH/bin` is in your `$PATH`).

## Setup

1. **Clone this repository & Install Dependencies:**
   ```bash
   git clone <GSR_REPO_URL>
   cd GSR
   npm install
   ```

2. **Link the Extension to Gemini CLI:**
   You must register this directory as a local extension so that the Gemini CLI can understand the new commands.
   ```bash
   gemini extensions link .
   ```

## Usage

You have two commands available to you, depending on which backend you want to use. You MUST run them with `--sandbox --yolo` to allow the LLM permission to execute local shell scripts autonomously.

### Option 1: The Node.js Wrapper (Default)
To initiate a concurrent code review using the built-in Node.js promise pool:
```bash
gemini gsr --sandbox --yolo
```
The Coordinator will chunk your `git diff` and invoke the `@google/genai` API for each enabled agent in `gemini-review.yaml`, aggregating the final output in your terminal.

### Option 2: The Scion Orchestrator
To initiate the review using isolated background container instances:
```bash
gemini gsr-scion --sandbox --yolo
```

#### Scion: What happens under the hood?
When you run the command, the `run-scion.sh` script executes. It reads your `git diff` and launches the 10 subagents in concurrent batches. The Gemini CLI will wait for all agents to finish their review and will directly print the aggregated code review back to your console!

#### Scion: Advanced Debugging
Because the Scion backend runs agents in detached background terminals, you can interact with them mid-review:

*   **View all concurrent agent states:**
    ```bash
    scion list
    ```
*   **Attach to a specific agent's terminal interactive session:**
    ```bash
    scion attach gsr-security
    ```
