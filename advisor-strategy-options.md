# Advisor Strategy Application Options for GSR

This document outlines options for applying the "Advisor Strategy" (inspired by Anthropic's approach) to the Gemini Multi-Agent Code Review (GSR) framework.

## Overview of the Advisor Strategy
The Advisor Strategy pairs a smaller, cost-effective model (**Executor**) with a larger, more capable model (**Advisor**). The Executor drives the task and calls the Advisor only when it needs guidance on complex decisions. This inverts the common pattern where a large model orchestrates work and delegates to smaller models.

## Current GSR Architecture
GSR currently uses a traditional multi-agent pattern:
1.  A `Coordinator` reads the git diff and parses it into chunks.
2.  It maps these chunks to multiple specialized sub-agents (`LogicAgent`, `SecurityAgent`, etc.) that run in parallel.
3.  Findings are collected, filtered, and consolidated.

This pattern can lead to high redundancy and noise (multiple agents flagging the same issue).

## Options for GSR

### Option 1: Full Architectural Shift (Executor + Advisor)
Replace the specialized sub-agents and the coordinator pool with a single **General Reviewer Agent** (Executor) running on a fast, cheap model (e.g., **Gemini 1.5 Flash**).
*   **Flow**: The Executor scans the diff and generates findings. When it encounters a complex area (e.g., security-sensitive function, complex state machine), it calls an **Expert Advisor** (e.g., **Gemini 1.5 Pro**) for a verdict or remediation plan.
*   **Pros**: Solves deduplication/noise issues naturally (single source of truth), reduces API calls significantly, simplifies the codebase.

### Option 2: Advisor for Consolidation
Keep the specialized sub-agents, but use the Advisor strategy during the *consolidation* or *deduplication* phase.
*   **Flow**: The sub-agents (Logic, Security, etc.) run on cheaper models. A **Consolidation Agent** (Executor) runs on a cheaper model to merge the results. If it finds conflicting or highly complex overlapping findings, it calls the **Expert Advisor** to resolve them and produce the final high-signal report.
*   **Pros**: Keeps the benefit of specialized prompts while fixing the consolidation/noise problem.

### Option 3: Advisor within Sub-agents
Apply the strategy *inside* each sub-agent.
*   **Flow**: For example, the `SecurityAgent` runs on a cheap model. When it suspects a complex vulnerability but isn't sure, it calls a "Security Advisor" (Expert model) to confirm and provide a detailed plan.
