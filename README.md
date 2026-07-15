# Gemini Subagent Reviewer (GSR)

Welcome to the GSR project repository! This project implements an advanced multi-agent code review system powered by Gemini.

## 🧠 Multi-Agent Approach

Instead of relying on a single prompt to review code, GSR uses a **swarm of specialized subagents** to analyze pull requests from different perspectives. This approach yields higher quality, more focused findings.

### Specialized Agents
*   **Architecture Agent**: Focuses on system design, separation of concerns, and adherence to design patterns.
*   **Logic Agent**: Looks for bugs, edge cases, and correctness issues in the code.
*   **Security Agent**: Identifies potential security vulnerabilities (e.g., DoS, injection risks).
*   **TechDebt Agent**: Flags anti-patterns, legacy code usage (e.g., `indexOf` vs `includes`), and maintainability issues.
*   **Testing Agent**: Ensures adequate test coverage and identifies missing tests for new logic.

### Orchestration & Deduplication
1.  **Orchestrator**: Splits the incoming PR diff into chunks and distributes them to the subagents in parallel.
2.  **Deduplicator**: After all subagents report their findings, a dedicated `DeduplicatorAgent` (running on `gemini-3.1-pro-preview` with a sequential lock) merges duplicate findings and selects the most actionable suggestions, reducing noise for the developer.

---

## 📊 Evaluation Framework

To ensure our agent prompts are effective and not regressing, we use a custom **Evaluation Harness** located in `tools/eval`.

### How it Works
*   **Ablation Testing**: The harness can run reviews with specific agents disabled to measure their impact.
*   **Comparison (Local vs Production)**: It runs reviews against both the local development server and the deployed production server simultaneously.
*   **Auto-Evaluation**: An independent Gemini instance reviews the findings from both targets and generates a detailed comparison report on accuracy, actionability, and noise.
*   **Persistence**: Results are automatically archived and uploaded to an S3-compatible object storage bucket (Cloudflare R2 in production).

---

## 📁 Project Structure

*   **`adk/`**: The core application.
    *   **`backend/`**: Node.js Express server that handles GitHub API interaction and orchestrates Gemini agents.
    *   **`frontend/`**: Vanilla JS interface to request reviews and view streaming progress.
    *   **`prompts/`**: Contains the system prompts for all agents (including `system_prompts_v2`).
*   **`tools/eval/`**: The evaluation harness used to benchmark performance.

---

## 🚀 Getting Started

Please see the **[ADK README](./adk/README.md)** for detailed instructions on setting up the environment and running the servers locally.

---

## 🤖 GitHub Action

GSR can also run as a **GitHub Action** on your own pull requests — see
**[ACTION.md](./ACTION.md)** for setup and configuration (choose between
`subagent` and `basic` review modes).

