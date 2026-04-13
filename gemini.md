# Gemini Subagent Reviewer (GSR) - AI Assistant Guide

This document (`gemini.md`) provides essential context, architectural outlines, and coding standards for all AI assistants (like Gemini) working on the GSR project.

## 📌 Project Overview
GSR (Gemini Subagent Reviewer) is an AI-powered code review tool designed to analyze code and provide rich feedback utilizing Gemini subagents.

The project consists of the **GSR ADK Cloud Run Prototype (`/adk`)**:
- A decoupled client/server web application that analyzes live GitHub Pull Requests directly in the browser via an API.
- Designed for deployment on Google Cloud Run.

## 🛠 Tech Stack
- **Languages**: TypeScript (Backend / CLI), JavaScript (Frontend)
- **Runtime**: Node.js
- **Frameworks**: Express.js (ADK Backend & Frontend)
- **Testing Tools**:
  - `jest` & `ts-jest` (Unit/Integration)
  - `supertest` (API backend testing)
  - `@playwright/test` (E2E frontend testing)
- **Key Libraries**: `@google/genai` (Gemini SDK interactions), `@octokit/rest` (GitHub integration), `commander` (CLI).

## 🚀 Architectural & Environmental Context
- **Module Systems**: Be aware of the varying module systems. `adk/frontend` uses `"type": "module"` (ESM), whereas `adk/backend` defaults to CommonJS (`"type": "commonjs"`). Always use the appropriate import/export syntax for the respective directory.
- **Secrets Management**: The project heavily utilizes Google Cloud Secret Manager (especially in the Jetski environment) to fetch sensitive keys (e.g., `GEMINI_API_KEY`). Rely on the established scripts (like `start_sm.sh`) and do not hardcode secrets or assume `.env` files are always present in production.
- **Concurrent Subagents**: Central to the application is running concurrent subagents that analyze code and return streamable or aggregated NDJSON findings. 

## 🧪 Testing & Evaluation
- **General Testing**: See [TESTING.md](TESTING.md) for an overview of unit, integration, and E2E testing in the project.
- **Ablation Testing**: We have implemented an Ablation Testing Framework to evaluate the impact of individual subagents. You can selectively disable agents using environment variables (e.g., `ABLATE_SECURITY=true`) when running the evaluation harness. See [ABLATION.md](tools/eval/ABLATION.md) for detailed instructions.

## 📝 Coding Standards & Best Practices
1. **Strong Typing**: When working in TypeScript directories (`adk/backend`), always define clean, strict types or interfaces for API payloads, tool outputs, and configurations.
2. **Testing Coverage**: When adding new features or endpoints, create or update the corresponding tests. Follow the separation: `supertest` for Express endpoint validation, standard `jest` for utility/logic, and `playwright` for frontend UI verification.
3. **Decoupled Client/Server**: Within `adk/`, keep the frontend and backend strictly separated. Do not bleed server-side logic into the frontend directory.
4. **Prompt Engineering Storage**: Store complex AI prompt definitions, system instructions, and schemas in clearly defined locations (e.g., `system_prompts/` or `prompts/` directories) rather than hardcoding long strings inside the business logic.
5. **UI Aesthetics**: For frontend changes, ensure an aesthetically pleasing, responsive design. Use distinct elements like progress indicators for agent executions and clear visual layouts (e.g., comparison tables for AI analyses).
6. **Error Handling & Streaming**: As responses from the LLM can take time and are often streamed, ensure error boundaries are tight to avoid deadlocks (such as unresolved HTTP streams). Use appropriate events for end-of-stream indicators.
