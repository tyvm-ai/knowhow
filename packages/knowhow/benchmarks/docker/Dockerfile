# Use Node.js 18 as base image
FROM node:18-bullseye

# Install system dependencies
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

# Copy the entire knowhow codebase (not just npm package)
COPY . /app/knowhow

# Install knowhow dependencies
WORKDIR /app/knowhow
RUN npm install

# Build knowhow
RUN npm run compile

# Set up benchmarks
WORKDIR /app/knowhow/benchmarks
RUN npm install
RUN npm run build

# Create exercises directory
RUN mkdir -p /app/exercises

# Environment variables for AI providers
# These will be passed in at runtime via docker run -e
ENV OPENAI_KEY=""
ENV ANTHROPIC_API_KEY=""
ENV GEMINI_API_KEY=""
ENV XAI_API_KEY=""
ENV CONTAINER=true

# Set the working directory for exercises
WORKDIR /app/exercises

# Default command
CMD ["node", "/app/knowhow/benchmarks/dist/cli.js"]