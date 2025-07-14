#!/usr/bin/env node

import { spawn } from 'child_process';
import { join, resolve } from 'path';
import { existsSync } from 'fs';
import { SwaggerMcpGenerator } from './generator';

interface ParsedArgs {
  swaggerUrl: string;
  outputDir: string;
  startStdio: boolean;
}

function parseArgs(args: string[]): ParsedArgs {
  const parsed: ParsedArgs = {
    swaggerUrl: '',
    outputDir: './generated',
    startStdio: false
  };

  // Filter out the --start-stdio flag first
  const filteredArgs = args.filter(arg => {
    if (arg === '--start-stdio') {
      parsed.startStdio = true;
      return false;
    }
    return true;
  });

  // Now parse the remaining arguments in order
  for (let i = 0; i < filteredArgs.length; i++) {
    if (!parsed.swaggerUrl) {
      parsed.swaggerUrl = filteredArgs[i];
    } else {
      // Second non-flag argument is the output directory
      parsed.outputDir = filteredArgs[i];
      break; // Only take the first two non-flag arguments
    }
  }

  return parsed;
}

async function buildAndRunServer(outputDir: string, swaggerUrl: string) {
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

  const serverProcess = spawn('node', [serverPath, swaggerUrl], { 
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
  const args = process.argv.slice(2);
  
  if (args.length === 0) {
    console.error('Usage: npx swagger-mcp-generator <swagger-url> [output-dir] [--start-stdio]');
    console.error('');
    console.error('Environment variables:');
    console.error('  HEADER_AUTHORIZATION=Bearer <token>  - Set Authorization header');
    console.error('  HEADER_<NAME>=<value>               - Set custom header');
    console.error('');
    console.error('Examples:');
    console.error('  npx swagger-mcp-generator https://api.example.com/swagger.json');
    console.error('  npx swagger-mcp-generator https://api.example.com/swagger.json --start-stdio');
    console.error('  npx swagger-mcp-generator https://api.example.com/swagger.json ./my-output --start-stdio');
    console.error('  HEADER_AUTHORIZATION="Bearer abc123" npx swagger-mcp-generator https://api.example.com/swagger.json');
    process.exit(1);
  }

  const { swaggerUrl, outputDir, startStdio } = parseArgs(args);

  try {
    const generator = new SwaggerMcpGenerator(swaggerUrl);
    await generator.loadSwaggerSpec();
    
    const tools = generator.generateTools();
    console.log(`Generated ${tools.length} tools from Swagger spec`);
    
    await generator.saveGeneratedFiles(outputDir);
    
    console.log('');
    if (startStdio) {
      console.log('Generation complete! Starting server...');
      
      // Build and run the server
      await buildAndRunServer(outputDir, swaggerUrl);
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
      console.log(`      "args": ["${outputDir}/dist/mcp-server.js", "${swaggerUrl}"],`);
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