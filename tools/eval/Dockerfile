FROM node:20-alpine AS builder

WORKDIR /app

# Copy package manifests first to leverage Docker layer caching
COPY package*.json ./
COPY tools/eval/package*.json ./tools/eval/
COPY adk/backend/package*.json ./adk/backend/

# Install tools/eval dependencies
RUN cd tools/eval && npm install

# Copy the entire workspace to ensure relative ../../adk imports satisfy TypeScript
COPY . ./

# Install tools/eval dependencies and build
RUN cd tools/eval && npm install
RUN cd tools/eval && npx tsc

# Stage 2: Production
FROM node:20-alpine

WORKDIR /app/tools/eval

# Copy package and install production dependencies
COPY --from=builder /app/tools/eval/package*.json ./
RUN npm install --omit=dev

# Copy compiled files and any necessary static assets
COPY --from=builder /app/tools/eval/dist ./dist
COPY --from=builder /app/tools/eval/config.json* ./

ENV NODE_ENV=production
ENV PORT=8080

EXPOSE 8080

CMD ["node", "dist/tools/eval/server.js"]
