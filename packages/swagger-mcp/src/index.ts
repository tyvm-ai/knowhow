#!/usr/bin/env node

import { Command } from 'commander';
import { spawn } from 'child_process';
import { join, resolve, dirname } from 'path';
import { existsSync } from 'fs';
import { SwaggerMcpGenerator } from './generator';

function generateDomainBasedDir(swaggerSource: string, packageDir: string): string {
  try {
    // Try to parse as URL first
    const url = new URL(swaggerSource);
    const sanitizedDomain = url.hostname.replace(/[^a-zA-Z0-9]/g, '_');
    return join(packageDir, 'generated', sanitizedDomain);
  } catch (error) {
    // If URL parsing fails, it's likely a file path - use generic directory
    console.warn('Using generic "generated" directory for file-based swagger source');
    return join(packageDir, 'generated');
  }
}

async function buildAndRunServer(outputDir: string) {
  console.log('\n🏗️  Building generated server...');
  
  // Resolve the output directory to an absolute path to avoid duplication
  const resolvedOutputDir = resolve(outputDir);
  console.log(`Resolved output directory: ${resolvedOutputDir}`);
  
  // Check if package.json exists
  const packageJsonPath = join(resolvedOutputDir, 'package.json');
  if (!existsSync(packageJsonPath)) {
    throw new Error(`Generated package.json not found at ${packageJsonPath}`);
  }

  // Run npm install
  await new Promise<void>((resolve, reject) => {
    console.log('Installing dependencies...');
    const npmInstall = spawn('npm', ['install'], { 
      cwd: resolvedOutputDir, 
      stdio: 'inherit' 
    });
    
    npmInstall.on('close', (code) => {
      if (code === 0) {
        console.log('✅ Dependencies installed successfully');
        resolve();
      } else {
        reject(new Error(`npm install failed with code ${code}`));
      }
    });
    
    npmInstall.on('error', (error) => {
      reject(new Error(`Failed to start npm install: ${error.message}`));
    });
  });
  
  // Run npm run build
  await new Promise<void>((resolve, reject) => {
    console.log('Building TypeScript...');
    const npmBuild = spawn('npm', ['run', 'build'], { 
      cwd: resolvedOutputDir, 
      stdio: 'inherit' 
    });
    
    npmBuild.on('close', (code) => {
      if (code === 0) {
        console.log('✅ Build completed successfully');
        resolve();
      } else {
        reject(new Error(`npm run build failed with code ${code}`));
      }
    });
    
    npmBuild.on('error', (error) => {
      reject(new Error(`Failed to start npm build: ${error.message}`));
    });
  });
  
  // Run the MCP server
  console.log('\n🚀 Starting MCP server...');
  console.log('Press Ctrl+C to stop the server');
  
  const serverPath = join(resolvedOutputDir, 'dist', 'mcp-server.js');
  console.log(`Looking for server at: ${serverPath}`);
  if (!existsSync(serverPath)) {
    throw new Error(`Built server not found at ${serverPath}`);
  }

  const serverProcess = spawn('node', [serverPath], { 
    cwd: resolvedOutputDir, 
    stdio: 'inherit' 
  });
  
  // Handle process termination
  process.on('SIGINT', () => {
    console.log('\n🛑 Stopping MCP server...');
    serverProcess.kill('SIGINT');
    process.exit(0);
  });
  
  serverProcess.on('close', (code) => {
    console.log(`MCP server exited with code ${code}`);
    process.exit(code || 0);
  });
  
  serverProcess.on('error', (error) => {
    console.error('Failed to start MCP server:', error);
    process.exit(1);
  });

  // Keep the process alive
  return new Promise(() => {});
}

async function main() {
  const program = new Command();
  
  // Get the directory where this package is installed
  const packageDir = dirname(dirname(__filename));

  program
    .name('@tyvm/swagger-mcp')
    .description('Generate MCP servers from Swagger/OpenAPI specifications')
    .version('0.0.8')
    .option('-u, --url <url>', 'Swagger/OpenAPI specification URL (required - used for API client configuration)')
    .option('-f, --file <path>', 'Swagger/OpenAPI specification file path')
    .option('-o, --output <dir>', 'Output directory for generated MCP server')
    .option('--start-stdio', 'Build and start the server after generation')
    .addHelpText('after', `
Environment variables:
  HEADER_AUTHORIZATION=Bearer <token>  - Set Authorization header
  HEADER_<NAME>=<value>               - Set custom header

Examples:
  $ @tyvm/swagger-mcp --url https://api.example.com/swagger.json
  $ @tyvm/swagger-mcp --url https://api.example.com --file ./swagger.json --output ./my-server
  $ @tyvm/swagger-mcp --url https://api.example.com/swagger.json --start-stdio
  $ @tyvm/swagger-mcp --url https://api.example.com --file ./local-swagger.json
  $ HEADER_AUTHORIZATION="Bearer abc123" @tyvm/swagger-mcp --url https://api.example.com/swagger.json`);

  program.parse();

  const options = program.opts();

  // Validate that --url is always required
  if (!options.url) {
    console.error('Error: --url is required (used for API client configuration)');
    program.outputHelp();
    process.exit(1);
  }

  // Determine the swagger source
  const swaggerSource = options.file || options.url;
  
  // Determine output directory
  let outputDir = options.output;
  if (!outputDir) {
    outputDir = generateDomainBasedDir(swaggerSource, packageDir);
    console.log(`Using default output directory: ${outputDir}`);
  }

  try {
    // Pass both the swagger source and the API base URL
    const generator = new SwaggerMcpGenerator(swaggerSource, options.url);
    await generator.loadSwaggerSpec();
    
    const tools = generator.generateTools();
    console.log(`Generated ${tools.length} tools from Swagger spec`);
    
    await generator.saveGeneratedFiles(outputDir);
    
    console.log('');
    if (options.startStdio) {
      console.log('Generation complete! Starting server...');
      
      // Build and run the server
      await buildAndRunServer(outputDir);
    } else {
      console.log('Generation complete!');
    
      // Only show instructions if not starting the server
      console.log('');
      console.log('To use the generated MCP server:');
      console.log(`1. cd ${outputDir}`);
      console.log('2. npm install');
      console.log('3. npm run build');
      console.log('4. Add to your MCP client config:');
      console.log('{');
      console.log('  "servers": {');
      console.log('    "my-api": {');
      console.log('      "command": "node",');
      console.log(`      "args": ["${outputDir}/dist/mcp-server.js"],`);
      console.log('      "env": {');
      console.log('        "HEADER_AUTHORIZATION": "Bearer your-token-here"');
      console.log('      }');
      console.log('    }');
      console.log('  }');
      console.log('}');
    }
    
  } catch (error) {
    console.error('Generation failed:', (error as Error).message);
    if ((error as any).response) {
      console.error('HTTP Status:', (error as any).response.status);
      console.error('HTTP Headers:', (error as any).response.headers);
    }
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}