import * as crypto from 'crypto';
import { YcmdServer, YcmdServerInfo } from './server';

export interface YcmdRequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  headers?: Record<string, string>;
  timeout?: number;
}

export interface YcmdCompletionRequest {
  filepath: string;
  line_num: number;
  column_num: number;
  file_data: Record<string, {
    contents: string;
    filetypes: string[];
  }>;
  force_semantic?: boolean;
}

export interface YcmdCompletionResponse {
  completions: Array<{
    insertion_text: string;
    menu_text?: string;
    extra_menu_info?: string;
    detailed_info?: string;
    kind?: string;
  }>;
  completion_start_column: number;
}

export interface YcmdDiagnostic {
  kind: 'ERROR' | 'WARNING' | 'INFO';
  text: string;
  location: {
    line_num: number;
    column_num: number;
    filepath: string;
  };
  location_extent: {
    start: {
      line_num: number;
      column_num: number;
      filepath: string;
    };
    end: {
      line_num: number;
      column_num: number;
      filepath: string;
    };
  };
  ranges: Array<{
    start: {
      line_num: number;
      column_num: number;
      filepath: string;
    };
    end: {
      line_num: number;
      column_num: number;
      filepath: string;
    };
  }>;
  fixit_available: boolean;
}

export interface YcmdGoToResponse {
  filepath: string;
  line_num: number;
  column_num: number;
  description?: string;
}

/**
 * HTTP client for communicating with ycmd server using HMAC authentication
 */
export class YcmdClient {
  private serverInfo: YcmdServerInfo;
  private baseUrl: string;

  constructor(serverInfo: YcmdServerInfo) {
    this.serverInfo = serverInfo;
    this.baseUrl = `http://${serverInfo.host}:${serverInfo.port}`;
  }

  /**
   * Make an authenticated request to the ycmd server
   */
  async request<T = any>(
    endpoint: string, 
    data?: any, 
    options: YcmdRequestOptions = {}
  ): Promise<T> {
    const url = `${this.baseUrl}${endpoint}`;
    const method = options.method || (data ? 'POST' : 'GET');
    const timeout = options.timeout || 10000;

    // Prepare request body
    const body = data ? JSON.stringify(data) : undefined;
    
    // Generate HMAC signature
    const hmac = this.generateHmac(method, endpoint, body || '');

    // Prepare headers
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'X-Ycm-Hmac': hmac,
      ...options.headers
    };

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), timeout);

      const response = await fetch(url, {
        method,
        headers,
        body,
        signal: controller.signal
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        const errorText = await response.text();
        throw new Error(`ycmd server error (${response.status}): ${errorText}`);
      }

      const result = await response.json();
      return result as T;

    } catch (error) {
      if (error instanceof Error && error.name === 'AbortError') {
        throw new Error(`Request to ycmd server timed out after ${timeout}ms`);
      }
      throw error;
    }
  }

  /**
   * Generate HMAC signature for request authentication using ycmd's nested HMAC algorithm
   * Based on the official ycmd example client implementation
   */
  private generateHmac(method: string, path: string, body: string): string {
    const secret = Buffer.from(this.serverInfo.hmacSecret, 'base64');
    
    // Create individual HMACs for method, path, and body
    const methodHmac = crypto.createHmac('sha256', secret).update(method, 'utf8').digest();
    const pathHmac = crypto.createHmac('sha256', secret).update(path, 'utf8').digest();
    const bodyHmac = crypto.createHmac('sha256', secret).update(body, 'utf8').digest();
    
    // Concatenate the three HMACs
    const joinedHmacInput = Buffer.concat([methodHmac, pathHmac, bodyHmac]);
    
    // Create final HMAC of the concatenated result
    const finalHmac = crypto.createHmac('sha256', secret).update(joinedHmacInput).digest();
    
    // Return base64 encoded result
    return Buffer.from(finalHmac).toString('base64');
  }

  /**
   * Original simple HMAC method for fallback
   */
  private generateSimpleHmac(method: string, path: string, body: string): string {
    const hmac = crypto.createHmac('sha256', Buffer.from(this.serverInfo.hmacSecret, 'base64'));
    const message = `${method}&${path}&${body}`;
    hmac.update(message);
    return Buffer.from(hmac.digest()).toString('base64');
  }

  /**
   * Check if server is ready
   */
  async isReady(): Promise<boolean> {
    try {
      await this.request('/ready');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Check server health
   */
  async isHealthy(): Promise<boolean> {
    try {
      await this.request('/ready');
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Load extra configuration for a project
   */
  async loadExtraConfFile(filepath: string): Promise<boolean> {
    try {
      const response = await this.request<{ found: boolean }>('/load_extra_conf_file', {
        filepath
      });
      return response.found;
    } catch {
      return false;
    }
  }

  /**
   * Get code completions
   */
  async getCompletions(request: YcmdCompletionRequest): Promise<YcmdCompletionResponse> {
    return this.request<YcmdCompletionResponse>('/completions', request);
  }

  /**
   * Get detailed completion information
   */
  async getCompletionDetail(request: YcmdCompletionRequest): Promise<any> {
    return this.request('/detailed_diagnostic', request);
  }

  /**
   * Get diagnostics for a file
   */
  async getDiagnostics(filepath: string, contents: string, filetypes: string[]): Promise<YcmdDiagnostic[]> {
    const response = await this.request<YcmdDiagnostic[]>('/event_notification', {
      event_name: 'FileReadyToParse',
      filepath,
      file_data: {
        [filepath]: {
          contents,
          filetypes
        }
      }
    });

    return response || [];
  }

  /**
   * Go to definition/declaration
   */
  async goToDefinition(
    filepath: string, 
    line: number, 
    column: number, 
    contents: string, 
    filetypes: string[]
  ): Promise<YcmdGoToResponse> {
    return this.request<YcmdGoToResponse>('/goto_definition', {
      filepath,
      line_num: line,
      column_num: column,
      file_data: {
        [filepath]: {
          contents,
          filetypes
        }
      }
    });
  }

  /**
   * Go to declaration
   */
  async goToDeclaration(
    filepath: string, 
    line: number, 
    column: number, 
    contents: string, 
    filetypes: string[]
  ): Promise<YcmdGoToResponse> {
    return this.request<YcmdGoToResponse>('/goto_declaration', {
      filepath,
      line_num: line,
      column_num: column,
      file_data: {
        [filepath]: {
          contents,
          filetypes
        }
      }
    });
  }

  /**
   * Go to references
   */
  async goToReferences(
    filepath: string, 
    line: number, 
    column: number, 
    contents: string, 
    filetypes: string[]
  ): Promise<YcmdGoToResponse[]> {
    return this.request<YcmdGoToResponse[]>('/goto_references', {
      filepath,
      line_num: line,
      column_num: column,
      file_data: {
        [filepath]: {
          contents,
          filetypes
        }
      }
    });
  }

  /**
   * Get signature help
   */
  async getSignatureHelp(
    filepath: string, 
    line: number, 
    column: number, 
    contents: string, 
    filetypes: string[]
  ): Promise<any> {
    return this.request('/signature_help', {
      filepath,
      line_num: line,
      column_num: column,
      file_data: {
        [filepath]: {
          contents,
          filetypes
        }
      }
    });
  }

  /**
   * Get available refactoring commands
   */
  async getRefactorCommands(
    filepath: string, 
    line: number, 
    column: number, 
    contents: string, 
    filetypes: string[]
  ): Promise<any[]> {
    return this.request<any[]>('/refactor', {
      filepath,
      line_num: line,
      column_num: column,
      file_data: {
        [filepath]: {
          contents,
          filetypes
        }
      }
    });
  }

  /**
   * Refactor: Rename symbol
   */
  async refactorRename(
    filepath: string, 
    line: number, 
    column: number, 
    contents: string, 
    filetypes: string[],
    newName: string
  ): Promise<any> {
    return this.request('/run_completer_command', {
      command_arguments: ['RefactorRename', newName],
      filepath,
      line_num: line,
      column_num: column,
      file_data: {
        [filepath]: {
          contents,
          filetypes
        }
      }
    });
  }

  /**
   * Refactor: Extract method
   */
  async refactorExtractMethod(
    filepath: string, 
    line: number, 
    column: number, 
    contents: string, 
    filetypes: string[]
  ): Promise<any> {
    return this.request('/run_completer_command', {
      command_arguments: ['RefactorExtractMethod'],
      filepath,
      line_num: line,
      column_num: column,
      file_data: {
        [filepath]: {
          contents,
          filetypes
        }
      }
    });
  }

  /**
   * Refactor: Organize imports
   */
  async refactorOrganizeImports(
    filepath: string, 
    contents: string, 
    filetypes: string[]
  ): Promise<any> {
    return this.request('/run_completer_command', {
      command_arguments: ['OrganizeImports'],
      filepath,
      file_data: {
        [filepath]: {
          contents,
          filetypes
        }
      }
    });
  }

  /**
   * Refactor: Apply fix-it
   */
  async refactorFixIt(
    filepath: string, 
    line: number, 
    column: number, 
    contents: string, 
    filetypes: string[],
    fixitIndex: number
  ): Promise<any> {
    return this.request('/run_completer_command', {
      command_arguments: ['FixIt'],
      filepath,
      line_num: line,
      column_num: column,
      file_data: {
        [filepath]: {
          contents,
          filetypes
        }
      }
    });
  }

  /**
   * Execute a refactoring command
   */
  async executeRefactor(command: string, args: any): Promise<any> {
    return this.request(`/run_completer_command`, {
      command_arguments: [command, ...Object.values(args)],
      ...args
    });
  }

  /**
   * Notify server of file events
   */
  async notifyFileEvent(
    event: 'BufferVisit' | 'BufferUnload' | 'FileReadyToParse' | 'InsertLeave' | 'CurrentIdentifierFinished',
    filepath: string,
    contents?: string,
    filetypes?: string[]
  ): Promise<void> {
    const eventData: any = {
      event_name: event,
      filepath
    };

    if (contents && filetypes) {
      eventData.file_data = {
        [filepath]: {
          contents,
          filetypes
        }
      };
    }

    await this.request('/event_notification', eventData);
  }

  /**
   * Shutdown the server
   */
  async shutdown(): Promise<void> {
    try {
      await this.request('/shutdown', {}, { method: 'POST' });
    } catch {
      // Server may have already shut down
    }
  }
}

/**
 * Utility function to determine file types from file extension
 */
export function getFileTypes(filepath: string): string[] {
  const ext = filepath.split('.').pop()?.toLowerCase();
  
  const typeMap: Record<string, string[]> = {
    'py': ['python'],
    'js': ['javascript'],
    'ts': ['typescript'],
    'jsx': ['javascript', 'jsx'],
    'tsx': ['typescript', 'tsx'],
    'cpp': ['cpp'],
    'cc': ['cpp'],
    'cxx': ['cpp'],
    'c': ['c'],
    'h': ['c'],
    'hpp': ['cpp'],
    'java': ['java'],
    'cs': ['cs'],
    'go': ['go'],
    'rs': ['rust'],
    'php': ['php'],
    'rb': ['ruby'],
    'swift': ['swift'],
    'kt': ['kotlin'],
    'scala': ['scala'],
    'sh': ['sh'],
    'bash': ['sh'],
    'zsh': ['sh'],
    'fish': ['sh'],
    'vim': ['vim'],
    'lua': ['lua'],
    'r': ['r'],
    'R': ['r'],
    'sql': ['sql'],
    'html': ['html'],
    'xml': ['xml'],
    'css': ['css'],
    'scss': ['scss'],
    'sass': ['sass'],
    'less': ['less'],
    'json': ['json'],
    'yaml': ['yaml'],
    'yml': ['yaml'],
    'toml': ['toml'],
    'ini': ['dosini'],
    'cfg': ['dosini'],
    'conf': ['conf'],
    'md': ['markdown'],
    'markdown': ['markdown'],
    'tex': ['tex'],
    'latex': ['tex']
  };

  return typeMap[ext || ''] || ['text'];
}