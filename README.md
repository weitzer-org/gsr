# Gemini Subagent Reviewer (GSR)

Welcome to the GSR project repository! This project exists in two distinct architectures:

1. **[GSR Local CLI Extension](./gemini-cli-extension/README.md)**
   *   A local developer tool that plugs into the `gemini` CLI.
   *   Analyzes local, uncommitted `git diffs`.
   *   Supports simple Node.js execution OR fully isolated `scion` agents.

2. **[GSR ADK Cloud Run Prototype](./adk/README.md)**
   *   A decoupled client/server web application designed to be deployed.
   *   Analyzes live GitHub Pull Requests directly in the browser via an API.
   *   Built with Express.js Node servers.

Please see the respective subdirectories for setup and usage instructions.
