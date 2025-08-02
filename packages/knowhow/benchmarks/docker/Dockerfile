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

# Set working directory
WORKDIR /app

# Copy package files for dependency caching
COPY package*.json ./
# Install main dependencies (cached until package.json changes)
RUN npm install

# Copy build configuration (cached until config changes)
COPY tsconfig.json ./

# Copy source code (this layer will be invalidated on source changes)
COPY src/ ./src/

# Build the main project (will rebuild when source changes)
RUN npm run compile

COPY . .

# Now set up benchmarks in a subdirectory
WORKDIR /app/benchmarks

# Copy benchmarks package.json for dependency caching
COPY benchmarks/package*.json ./

# Create a symlink to make @tyvm/knowhow available
RUN mkdir -p node_modules/@tyvm && \
    ln -sf /app/dist node_modules/@tyvm/knowhow

# Install benchmarks dependencies (cached until benchmarks package.json changes)
RUN npm install

# Copy benchmarks source and build configuration
COPY benchmarks/src/ ./src/
COPY benchmarks/tsconfig.json ./

# Build benchmarks (will rebuild when benchmarks source changes)
RUN npm run build

# Make CLI executable
RUN chmod +x dist/cli.js

# Environment variables for AI providers
ENV OPENAI_API_KEY=""
ENV ANTHROPIC_API_KEY=""
ENV GEMINI_API_KEY=""
ENV XAI_API_KEY=""
ENV CONTAINER=true

# Create exercises directory and set working directory
RUN mkdir -p /app/exercises
WORKDIR /app/exercises

# Default command
CMD ["node", "/app/benchmarks/dist/cli.js"]
