# @tyvm/knowhow-module-ast-js

Tree-sitter AST parsing tools for [@tyvm/knowhow](https://www.npmjs.com/package/@tyvm/knowhow).

## Overview

This module provides 5 AST-based code editing tools powered by [tree-sitter](https://tree-sitter.github.io/tree-sitter/):

- **astListPaths** — List all available simple paths in a file (classes, methods, properties, blocks)
- **astEditNode** — Update a node at a specific AST path
- **astAppendNode** — Append a child node to a specific AST path
- **astDeleteNode** — Delete a node at a specific AST path
- **astGetPathForLine** — Find the AST path for a specific line of text

## Supported Languages

- JavaScript
- TypeScript
- Python (partial)
- Java (partial)

## Installation

```bash
npm install @tyvm/knowhow-module-ast-js
```

## Usage

Add the module to your `knowhow.json` configuration:

```json
{
  "modules": [
    "@tyvm/knowhow-module-ast-js"
  ]
}
```

Once loaded, the 5 AST tools will be available to your Knowhow agents.

## Development

```bash
npm run compile   # Compile TypeScript
npm test          # Run tests
```
