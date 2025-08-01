import { YcmdClient, getFileTypes } from '../client';
import { ycmdServerManager } from '../serverManager';
import * as fs from 'fs';

export interface YcmdSignatureHelpParams {
  filepath: string;
  line: number;
  column: number;
  contents?: string;
}

export interface SignatureParameter {
  label: string;
  documentation?: string;
}

export interface SignatureInformation {
  label: string;
  documentation?: string;
  parameters?: SignatureParameter[];
}

export interface SignatureHelp {
  signatures: SignatureInformation[];
  activeSignature?: number;
  activeParameter?: number;
}

/**
 * Get function signature hints
 */
export async function ycmdSignatureHelp(params: YcmdSignatureHelpParams): Promise<{
  success: boolean;
  signatureHelp?: SignatureHelp;
  message: string;
}> {
  try {
    // Validate parameters
    if (!params.filepath) {
      return {
        success: false,
        message: 'filepath is required'
      };
    }

    if (typeof params.line !== 'number' || typeof params.column !== 'number') {
      return {
        success: false,
        message: 'line and column must be numbers'
      };
    }

    // Get file contents
    let contents = params.contents;
    if (!contents) {
      try {
        contents = await fs.promises.readFile(params.filepath, 'utf8');
      } catch (error) {
        return {
          success: false,
          message: `Failed to read file: ${(error as Error).message}`
        };
      }
    }

    // Get file types
    const filetypes = getFileTypes(params.filepath);

    // Check if ycmd server is running using server manager
    if (!ycmdServerManager.isRunning()) {
      return {
        success: false,
        message: 'ycmd server is not running. Please start it first.'
      };
    }

    const serverInfo = ycmdServerManager.getServerInfo();
    if (!serverInfo) {
      return {
        success: false,
        message: 'Failed to get server information'
      };
    }

    // Create client
    const client = new YcmdClient(serverInfo);

    // Notify server about file
    try {
      await client.notifyFileEvent('FileReadyToParse', params.filepath, contents, filetypes);
    } catch (error) {
      console.warn('Failed to notify file event:', error);
    }

    // Get signature help
    const response = await client.getSignatureHelp(
      params.filepath,
      params.line,
      params.column,
      contents,
      filetypes
    );

    // Handle different response formats
    let signatureHelp: SignatureHelp;

    if (response && response.signatures) {
      // LSP-style response
      signatureHelp = {
        signatures: response.signatures.map((sig: any) => ({
          label: sig.label,
          documentation: sig.documentation,
          parameters: sig.parameters?.map((param: any) => ({
            label: param.label,
            documentation: param.documentation
          }))
        })),
        activeSignature: response.activeSignature,
        activeParameter: response.activeParameter
      };
    } else if (response && response.detailed_info) {
      // ycmd detailed_info response - convert to signature format
      const detailedInfo = response.detailed_info;
      signatureHelp = {
        signatures: [{
          label: detailedInfo,
          documentation: response.extra_menu_info
        }],
        activeSignature: 0,
        activeParameter: 0
      };
    } else if (response && typeof response === 'string') {
      // Simple string response
      signatureHelp = {
        signatures: [{
          label: response
        }],
        activeSignature: 0,
        activeParameter: 0
      };
    } else {
      return {
        success: true,
        signatureHelp: {
          signatures: []
        },
        message: 'No signature information available at this location'
      };
    }

    const signatureCount = signatureHelp.signatures.length;
    let message = 'No signature information available';
    
    if (signatureCount > 0) {
      message = `Found ${signatureCount} signature${signatureCount === 1 ? '' : 's'}`;
      
      if (signatureHelp.activeSignature !== undefined && signatureCount > 1) {
        message += ` (showing signature ${signatureHelp.activeSignature + 1} of ${signatureCount})`;
      }
      
      if (signatureHelp.activeParameter !== undefined) {
        const activeSignature = signatureHelp.signatures[signatureHelp.activeSignature || 0];
        if (activeSignature?.parameters && activeSignature.parameters.length > 0) {
          message += `, parameter ${signatureHelp.activeParameter + 1} of ${activeSignature.parameters.length}`;
        }
      }
    }

    return {
      success: true,
      signatureHelp,
      message
    };

  } catch (error) {
    return {
      success: false,
      message: `Failed to get signature help: ${(error as Error).message}`
    };
  }
}