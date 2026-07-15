# Image for the GSR GitHub Action (see action.yml). Built from this repo's
# own adk/backend + adk/prompts — never from a consumer's checkout, which the
# action only reads via the GitHub API at runtime.
FROM node:20-alpine AS builder

WORKDIR /app

COPY adk/backend/package*.json ./backend/
RUN cd backend && npm ci

COPY adk/backend/tsconfig.json ./backend/
COPY adk/backend/src ./backend/src
RUN cd backend && npx tsc

FROM node:20-alpine

WORKDIR /app

COPY adk/backend/package*.json ./backend/
RUN cd backend && npm ci --omit=dev

COPY --from=builder /app/backend/dist ./backend/dist

# Layout must match Orchestrator's projectRoot resolution for compiled code
# (dist/src -> up 4 levels -> /), which expects prompts at /adk/prompts/*.
COPY adk/prompts/system_prompts/ /adk/prompts/system_prompts/
COPY adk/prompts/basic_prompt/ /adk/prompts/basic_prompt/

ENV NODE_ENV=production

# GitHub Actions always runs container actions with `docker run --workdir
# /github/workspace` (the consumer's checkout), overriding this image's own
# WORKDIR — so the entrypoint path must be absolute, not relative to cwd.
ENTRYPOINT ["node", "/app/backend/dist/src/action-entrypoint.js"]
