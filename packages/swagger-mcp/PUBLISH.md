# Publishing to NPM

To publish this package as an NPX command:

## 1. Update package.json

Make sure the package name is unique and follows NPM naming conventions:

```json
{
  "name": "swagger-mcp-generator",
  "version": "1.0.0",
  "description": "Generate MCP servers from Swagger/OpenAPI specifications",
  "main": "dist/index.js",
  "bin": {
    "swagger-mcp-generator": "./dist/index.js"
  }
}
```

## 2. Build the package

```bash
npm run build
```

## 3. Login to NPM

```bash
npm login
```

## 4. Publish

```bash
npm publish
```

## 5. Test the published package

```bash
npx swagger-mcp-generator https://api.example.com/swagger.json
```

## Version Updates

For updates, increment the version in package.json and republish:

```bash
npm version patch  # or minor, major
npm publish
```

## Local Testing

Before publishing, test locally:

```bash
npm link
swagger-mcp-generator https://api.example.com/swagger.json
```