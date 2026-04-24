# Use Node.js 18 as base image
FROM node:18-bullseye

# Install system dependencies (cached layer - rarely changes)
RUN apt-get update && apt-get install -y \
    git \
    curl \
    wget \
    python3 \
    python3-pip \
    build-essential \
    && rm -rf /var/lib/apt/lists/*

# Set working directory for the monorepo root
WORKDIR /app

# Copy root package.json for workspace setup
COPY package.json package-lock.json ./

# Copy package.json files for all relevant workspace packages
# (needed before npm install so workspaces are discovered)
COPY packages/knowhow/package*.json ./packages/knowhow/
COPY packages/knowhow-tunnel/package*.json ./packages/knowhow-tunnel/
COPY packages/knowhow-benchmarks/package*.json ./packages/knowhow-benchmarks/
COPY packages/knowhow-benchmarks/benchmarks/package*.json ./packages/knowhow-benchmarks/benchmarks/

# Install all workspace dependencies
# This hoists shared deps to root node_modules and links @tyvm/knowhow as a workspace symlink
RUN npm install --workspaces --include-workspace-root

# Copy knowhow source and build it from source
# (This allows local changes to @tyvm/knowhow to be reflected in benchmarks)
COPY packages/knowhow/tsconfig.json ./packages/knowhow/
COPY packages/knowhow/src/ ./packages/knowhow/src/

# Build knowhow-tunnel first (required by knowhow)
COPY packages/knowhow-tunnel/tsconfig.json ./packages/knowhow-tunnel/
COPY packages/knowhow-tunnel/src/ ./packages/knowhow-tunnel/src/
RUN cd packages/knowhow-tunnel && npm run build

RUN cd packages/knowhow && npm run compile

# Copy benchmarks source and build it
COPY packages/knowhow-benchmarks/benchmarks/tsconfig.json ./packages/knowhow-benchmarks/benchmarks/
COPY packages/knowhow-benchmarks/benchmarks/src/ ./packages/knowhow-benchmarks/benchmarks/src/

RUN cd packages/knowhow-benchmarks/benchmarks && npx tsc

# Copy scripts needed at runtime
COPY packages/knowhow-benchmarks/benchmarks/scripts/ ./packages/knowhow-benchmarks/benchmarks/scripts/

# Make CLI executable
RUN chmod +x packages/knowhow-benchmarks/benchmarks/dist/cli.js

# Environment variables for AI providers
ENV OPENAI_API_KEY=""
ENV ANTHROPIC_API_KEY=""
ENV GEMINI_API_KEY=""
ENV XAI_API_KEY=""
ENV CONTAINER=true

# Create exercises directory and set working directory
RUN mkdir -p /exercises
WORKDIR /exercises

# Use ENTRYPOINT so docker run arguments are appended as CLI args
ENTRYPOINT ["node", "/app/packages/knowhow-benchmarks/benchmarks/dist/cli.js"]
