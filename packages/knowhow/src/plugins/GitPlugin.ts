import { PluginBase, PluginMeta } from './PluginBase';
import { PluginContext } from './types';
import { MinimalEmbedding } from '../types';
import { EventService } from '../services/EventService';
import { execSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

export class GitPlugin extends PluginBase {
  readonly meta: PluginMeta = {
    key: 'git',
    name: 'Git Plugin',
    description: 'Git tracking for agent modifications',
  };

  private knowhowGitPath: string;
  private projectHasGit: boolean = false;
  private currentBranch: string = 'main';
  private eventService: EventService;

  constructor(context: PluginContext = {}) {
    super(context);
    this.knowhowGitPath = path.join(process.cwd(), '.knowhow', '.git');
    this.eventService = context.Events || new EventService();
    this.setupEventListeners();
  }

  async call(input: string): Promise<string> {
    // Git plugin doesn't have a call interface - return status info
    return `Git Plugin Status: Branch=${this.currentBranch}, Knowhow Git=${fs.existsSync(this.knowhowGitPath) ? 'initialized' : 'not initialized'}`;
  }

  async embed(input: string): Promise<MinimalEmbedding[]> {
    // Git plugin doesn't provide embeddings
    return [];
  }

  customEnableCheck(): boolean {
    // Check if project has a .git folder
    const projectGitPath = path.join(process.cwd(), '.git');
    this.projectHasGit = fs.existsSync(projectGitPath);
    
    if (this.projectHasGit) {
      this.initializeKnowhowRepo();
      return true;
    }
    
    return false;
  }

  private initializeKnowhowRepo(): void {
    try {
      const knowhowDir = path.join(process.cwd(), '.knowhow');
      
      // Create .knowhow directory if it doesn't exist
      if (!fs.existsSync(knowhowDir)) {
        fs.mkdirSync(knowhowDir, { recursive: true });
      }

      // Initialize git repo in .knowhow if not already initialized
      if (!fs.existsSync(this.knowhowGitPath)) {
        execSync('git init', { cwd: knowhowDir, stdio: 'pipe' });
        
        // Create initial commit
        const gitignorePath = path.join(knowhowDir, '.gitignore');
        fs.writeFileSync(gitignorePath, '# Knowhow agent tracking repository\n');
        
        execSync('git add .gitignore', { cwd: knowhowDir, stdio: 'pipe' });
        execSync('git commit -m "Initial commit for agent tracking"', { cwd: knowhowDir, stdio: 'pipe' });
      }
    } catch (error) {
      console.error('Failed to initialize .knowhow git repository:', error);
    }
  }

  private setupEventListeners(): void {
    // Listen for file:post-edit events to auto-commit
    this.eventService.on('file:post-edit', async (data: any) => {
      if (this.isEnabled()) {
        await this.autoCommit(data);
      }
    });

    // Listen for agent newTask events to create new branches
    this.eventService.on('agent:newTask', async (data: any) => {
      if (this.isEnabled()) {
        await this.handleNewTask(data);
      }
    });
  }

  async setBranch(branchName: string): Promise<void> {
    if (!this.isEnabled()) return;

    try {
      const knowhowDir = path.dirname(this.knowhowGitPath);
      
      // Check if branch exists
      try {
        execSync(`git rev-parse --verify ${branchName}`, { cwd: knowhowDir, stdio: 'pipe' });
        // Branch exists, switch to it
        execSync(`git checkout ${branchName}`, { cwd: knowhowDir, stdio: 'pipe' });
      } catch {
        // Branch doesn't exist, create and switch to it
        execSync(`git checkout -b ${branchName}`, { cwd: knowhowDir, stdio: 'pipe' });
      }
      
      this.currentBranch = branchName;
    } catch (error) {
      console.error(`Failed to set branch ${branchName}:`, error);
    }
  }

  async createBranch(branchName: string): Promise<void> {
    if (!this.isEnabled()) return;

    try {
      const knowhowDir = path.dirname(this.knowhowGitPath);
      execSync(`git checkout -b ${branchName}`, { cwd: knowhowDir, stdio: 'pipe' });
      this.currentBranch = branchName;
    } catch (error) {
      console.error(`Failed to create branch ${branchName}:`, error);
    }
  }

  async commit(message: string, files?: string[]): Promise<void> {
    if (!this.isEnabled()) return;

    try {
      const knowhowDir = path.dirname(this.knowhowGitPath);
      
      // Emit pre-commit event and collect results
      const preCommitResults = await this.eventService.emitBlocking('git:pre-commit', {
        branch: this.currentBranch,
        message,
        files
      });

      let enhancedMessage = message;
      
      // Append pre-commit event results to message
      if (preCommitResults && preCommitResults.length > 0) {
        const resultMessages = preCommitResults
          .filter(result => result && typeof result === 'string')
          .join('\n');
        
        if (resultMessages) {
          enhancedMessage += '\n\n' + resultMessages;
        }
      }

      // Add files (or all if none specified)
      if (files && files.length > 0) {
        for (const file of files) {
          try {
            execSync(`git add "${file}"`, { cwd: knowhowDir, stdio: 'pipe' });
          } catch (error) {
            console.warn(`Failed to add file ${file}:`, error);
          }
        }
      } else {
        execSync('git add .', { cwd: knowhowDir, stdio: 'pipe' });
      }

      // Commit with enhanced message
      execSync(`git commit -m "${enhancedMessage.replace(/"/g, '\\"')}"`, { 
        cwd: knowhowDir, 
        stdio: 'pipe' 
      });

      // Emit post-commit event
      await this.eventService.emitBlocking('git:post-commit', {
        branch: this.currentBranch,
        message: enhancedMessage,
        files
      });

    } catch (error) {
      console.error('Failed to commit:', error);
    }
  }

  private async autoCommit(fileData: any): Promise<void> {
    if (!this.isEnabled()) return;

    try {
      const filePath = fileData.filePath || fileData.file || 'unknown';
      const operation = fileData.operation || 'edit';
      
      // Copy the file to .knowhow directory for tracking
      const knowhowDir = path.dirname(this.knowhowGitPath);
      const fileName = path.basename(filePath);
      const destPath = path.join(knowhowDir, fileName);
      
      // Copy file if it exists
      if (fs.existsSync(filePath)) {
        fs.copyFileSync(filePath, destPath);
      } else {
        // Create a record of the file operation
        const record = `File: ${filePath}\nOperation: ${operation}\nTimestamp: ${new Date().toISOString()}\n`;
        fs.writeFileSync(destPath.replace(path.extname(destPath), '.log'), record);
      }
      
      const commitMessage = `Auto-commit: ${operation} ${filePath}`;
      await this.commit(commitMessage);
    } catch (error) {
      console.error('Failed to auto-commit:', error);
      // Don't throw - auto-commit failures shouldn't break the workflow
    }
  }

  private async handleNewTask(taskData: any): Promise<void> {
    if (!this.isEnabled()) return;

    try {
      // Generate a branch name based on task or timestamp
      const taskId = taskData.taskId || taskData.id || Date.now().toString();
      const branchName = `task-${taskId}`;
      
      await this.createBranch(branchName);
    } catch (error) {
      console.error('Failed to handle new task:', error);
    }
  }

  // Override the process method to handle git-specific operations
  async process(input: string): Promise<string> {
    // This plugin is primarily event-driven, but can handle direct commands
    const lines = input.trim().split('\n');
    const results: string[] = [];

    for (const line of lines) {
      const trimmedLine = line.trim();
      
      if (trimmedLine.startsWith('setBranch:')) {
        const branchName = trimmedLine.substring('setBranch:'.length).trim();
        await this.setBranch(branchName);
        results.push(`Switched to branch: ${branchName}`);
      } else if (trimmedLine.startsWith('createBranch:')) {
        const branchName = trimmedLine.substring('createBranch:'.length).trim();
        await this.createBranch(branchName);
        results.push(`Created branch: ${branchName}`);
      } else if (trimmedLine.startsWith('commit:')) {
        const message = trimmedLine.substring('commit:'.length).trim();
        await this.commit(message);
        results.push(`Committed with message: ${message}`);
      } else {
        results.push(`Unknown git command: ${trimmedLine}`);
      }
    }

    return results.join('\n');
  }
}