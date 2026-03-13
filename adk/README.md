# Gemini Subagent Reviewer (GSR) - ADK

The ADK is a decoupled backend and frontend architecture for running concurrent LLM code reviews against GitHub Pull Requests. It is designed to be hosted in Google Cloud Run.

## Architecture
The project is split into two standalone Node.js services:
1. **`backend`**: An Express server running on port `8080`. It handles GitHub authentication, diff fetching, and orchestrating the Vertex AI subagents concurrently.
2. **`frontend`**: An Express server running on port `3000`. It serves the Vanilla Web UI that allows developers to request reviews and visualize the results.

---

## Setup & Local Development

### Prerequisites
*   **Git** (command line tool)
*   **Node.js** (v18+)
*   **Gemini API Key** (Set as an environment variable: `export GEMINI_API_KEY="your-key-here"`)
*   *(Optional)* **Gemini Model** (Set as an environment variable: `export GEMINI_MODEL="gemini-2.5-pro"` to override the default model)

### Easy Local Startup (Recommended)
You can use the provided bash script to start both the frontend and backend servers simultaneously.

```bash
cd adk
./start.sh
```

### 1. Run the Backend API (Manual)
The backend requires your Gemini API key to authenticate with the LLMs locally.

```bash
cd backend
npm install
npm run dev
```
*The API will start at `http://localhost:8080`*

### 2. Run the Frontend UI
The frontend is a lightweight Node.js server that serves the user interface.

```bash
cd frontend
npm install
npm start
```
*The UI will start at `http://localhost:3000`*

---

## Usage
1. Open your browser and navigate to `http://localhost:3000`.
2. Find a public GitHub Pull Request URL (e.g., `https://github.com/GoogleCloudPlatform/scion/pull/1`).
3. Generate a GitHub Personal Access Token (PAT) with `repo` read access.
4. Paste the PR URL and your PAT into the form and click **Start Concurrent Review**.
5. The frontend will hit the backend API, the backend will fetch the diff and distribute it to 10 Gemini subagents, and the aggregated results will be streamed back to your browser!
