export interface DownloadInfo {
  id: string;
  ext: string;
  title?: string;
  description?: string;
  duration?: number;
  [key: string]: any;
}

export interface KeyframeInfo {
  path: string;
  description: string;
  timestamp: number;
  usd_cost?: number;
}

export interface TranscriptChunk {
  chunkPath: string;
  text: string;
  usd_cost: number;
}

/**
 * Interface for media processing operations (chunking, transcription, keyframe extraction).
 * Implemented by MediaProcessorService in @tyvm/knowhow core, but defined here
 * so the downloader module can depend on it without a hard circular dependency.
 */
export interface IMediaProcessor {
  chunk(
    filePath: string,
    outputDir: string,
    chunkLengthSeconds?: number,
    reuseExistingChunks?: boolean
  ): Promise<string[]>;

  transcribeChunks(
    files: string[],
    outputPath: string,
    reusePreviousTranscript?: boolean
  ): Promise<string[]>;

  processAudio(
    filePath: string,
    reusePreviousTranscript?: boolean,
    chunkTime?: number
  ): Promise<string[]>;

  extractKeyframes(
    filePath: string,
    outputPath: string,
    reusePreviousKeyframes?: boolean,
    interval?: number
  ): Promise<KeyframeInfo[]>;

  streamKeyFrameExtraction(
    filePath: string,
    videoJsonPath: string,
    reusePreviousKeyframes?: boolean,
    interval?: number
  ): AsyncGenerator<KeyframeInfo>;
}
