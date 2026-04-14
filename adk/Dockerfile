# Stage 1: Build backend
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files and install all dependencies (including devDependencies for tsc)
COPY adk/backend/package*.json ./backend/
RUN cd backend && npm ci

# Copy backend source and compile TS
COPY adk/backend/tsconfig.json ./backend/
COPY adk/backend/src ./backend/src
RUN cd backend && npx tsc

# Stage 2: Production image
FROM node:20-alpine

WORKDIR /app

# Install only production dependencies
COPY adk/backend/package*.json ./backend/
RUN cd backend && npm ci --omit=dev

# Copy built backend files from builder
COPY --from=builder /app/backend/dist ./backend/dist

# Copy frontend directory directly (statically served by backend)
COPY adk/frontend/ ./frontend/

# Copy system prompts for orchestrator
COPY adk/prompts/system_prompts/ /adk/prompts/system_prompts/
COPY adk/prompts/system_prompts_v2/ /adk/prompts/system_prompts_v2/
COPY adk/prompts/basic_prompt/ /adk/prompts/basic_prompt/

# Set working directory to backend so process.cwd() points to /app/backend
WORKDIR /app/backend

# Setup environment variables
ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

CMD ["node", "dist/src/index.js"]
