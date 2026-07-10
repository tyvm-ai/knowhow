import { createHash } from "crypto";
import http from "../utils/http";
import fs from "fs";
import { Message } from "../clients/types";
import path from "path";
import {
  CompletionOptions,
  CompletionResponse,
  EmbeddingOptions,
  EmbeddingResponse,
  AudioTranscriptionOptions,
  AudioTranscriptionResponse,
  AudioGenerationOptions,
  AudioGenerationResponse,
  ImageGenerationOptions,
  ImageGenerationResponse,
  VideoGenerationOptions,
  VideoGenerationResponse,
  VideoStatusOptions,
  VideoStatusResponse,
  FileUploadOptions,
  FileUploadResponse,
  FileDownloadOptions,
  FileDownloadResponse,
} from "../clients";
import { Config } from "../types";

// Remote sync placeholder interfaces
export interface CreateSessionPlaceholderRequest {
  title?: string;
  workerId?: string;
  metadata?: Record<string, any>;
}

export interface CreateSessionPlaceholderResponse {
  sessionId: string;
  orgId: string;
}

export interface CreateMessagePlaceholderRequest {
  content: string;
  agentName?: string;
  modelName?: string;
  metadata?: Record<string, any>;
}

export interface CreateMessagePlaceholderResponse {
  messageId: string;
  taskId?: string;
}

// Chat Task interfaces
export interface CreateMessageTaskRequest {
  messageId: string;
  prompt: string;
}

export interface CreateMessageTaskResponse {
  id: string;
}

export interface UpdateOrgTaskRequest {
  threads: Message[][];
  totalUsdCost: number;
  inProgress: boolean;
  result?: string;
}

export interface UpdateOrgTaskResponse {
  threadCount: Message[][];
  totalCostUsd: number;
  inProgress: boolean;
}

// Agent task synchronization interfaces
export interface TaskDetailsResponse {
  taskId: string;
  inProgress: boolean;
  status: "running" | "paused" | "killed" | "completed";
  totalUsdCost: number;
  threads: any[][];
  createdAt: string;
  updatedAt: string;
  messageId?: string;
  hasPendingMessages: boolean;
  pendingMessagesCount: number;
  result?: string;
}

export interface PendingMessage {
  id: string;
  message: string;
  role: string;
  createdAt: Date;
  processedAt: Date | null;
}

export interface SendMessageRequest {
  message: string;
  role?: "user" | "system";
}

export interface SendMessageResponse {
  id: string;
  message: string;
}

export interface StatusResponse {
  status: string;
}

export interface MarkProcessedResponse {
  processedCount: number;
}

export interface GitCredentialResponse {
  protocol: string;
  host: string;
  username: string;
  password: string;
  expiresAt: string | null;
}

export function loadKnowhowJwt(): string {
  const jwtFile = path.join(process.cwd(), ".knowhow", ".jwt");
  if (!fs.existsSync(jwtFile)) {
    return "";
  }
  const jwt = fs.readFileSync(jwtFile, "utf-8").trim();

  return jwt;
}

export const KNOWHOW_API_URL =
  process.env.KNOWHOW_API_URL || "https://api.knowhow.tyvm.ai";

export class KnowhowSimpleClient {
  headers: Record<string, string> = {};
  jwtValidated = false;

  constructor(
    private baseUrl = KNOWHOW_API_URL,
    private jwt = loadKnowhowJwt()
  ) {
    this.setJwt(jwt);
  }

  /**
   * Reload the JWT from disk (useful after login refreshes the token).
   */
  refreshJwt() {
    const freshJwt = loadKnowhowJwt();
    if (freshJwt) {
      this.setJwt(freshJwt);
      this.jwtValidated = false;
    }
  }

  setJwt(jwt: string) {
    this.jwt = jwt;
    this.headers = {
      Authorization: `Bearer ${this.jwt}`,
    };
  }

  async checkJwt() {
    if (!this.jwt) {
      throw new Error("No JWT found. Please login first.");
    }

    if (!this.jwtValidated) {
      try {
        this.jwtValidated = true;
        const response = await this.me();
        const user = response.data.user;
        const orgs = user.orgs;
        const orgId = response.data.orgId;
        const currentOrg = orgs.find((org) => {
          return org.organizationId === orgId;
        });
      } catch (error) {
        throw new Error("Invalid JWT. Please login again.");
      }
    }
  }

  async me() {
    if (!this.jwt) {
      throw new Error("No JWT found. Please login first.");
    }

    return http.get(`${this.baseUrl}/api/users/me`, {
      headers: this.headers,
    });
  }

  async getPresignedUploadUrl(source: Config["embedSources"][0]) {
    await this.checkJwt();
    const id = source.remoteId;
    const presignedUrlResp = await http.post(
      `${this.baseUrl}/api/org-embeddings/${id}/upload`,
      {},
      {
        headers: this.headers,
      }
    );

    console.log(presignedUrlResp.data);

    const presignedUrl = presignedUrlResp.data.uploadUrl;
    return presignedUrl;
  }

  async getPresignedDownloadUrl(source: Config["embedSources"][0]) {
    await this.checkJwt();
    const id = source.remoteId;
    const presignedUrlResp = await http.post(
      `${this.baseUrl}/api/org-embeddings/${id}/download`,
      {},
      {
        headers: this.headers,
      }
    );

    const presignedUrl = presignedUrlResp.data.downloadUrl;
    return presignedUrl;
  }

  async getOrgEmbedding(id: string) {
    await this.checkJwt();
    const resp = await http.get(
      `${this.baseUrl}/api/org-embeddings/${id}`,
      {
        headers: this.headers,
      }
    );
    return resp.data as { id: string; modelName: string; name: string; [key: string]: unknown };
  }

  async updateEmbeddingMetadata(
    id: string,
    data: {
      inputGlob?: string;
      outputPath?: string;
      chunkSize?: number;
      remoteType?: string;
    }
  ) {
    await this.checkJwt();
    return http.put(`${this.baseUrl}/api/org-embeddings/${id}`, data, {
      headers: this.headers,
    });
  }

  async createChatCompletion(options: CompletionOptions) {
    await this.checkJwt();
    return http.post<CompletionResponse>(
      `${this.baseUrl}/api/proxy/v1/chat/completions`,
      options,
      {
        headers: this.headers,
      }
    );
  }

  async createEmbedding(options: EmbeddingOptions) {
    await this.checkJwt();
    return http.post<EmbeddingResponse>(
      `${this.baseUrl}/api/proxy/v1/embeddings`,
      options,
      {
        headers: this.headers,
      }
    );
  }

  async getModels(type = "all") {
    await this.checkJwt();
    return http.get(`${this.baseUrl}/api/proxy/v1/models?type=${type}`, {
      headers: this.headers,
    });
  }

  async createAudioTranscription(options: AudioTranscriptionOptions) {
    await this.checkJwt();
    const formData = new FormData();
    // options.file can be a Buffer, ReadStream, Blob, or File
    if (Buffer.isBuffer(options.file)) {
      formData.append(
        "file",
        new Blob([new Uint8Array(options.file)]),
        options.fileName || "audio.mp3"
      );
    } else {
      formData.append("file", options.file);
    }
    if (options.model) formData.append("model", options.model);
    if (options.language) formData.append("language", options.language);
    if (options.prompt) formData.append("prompt", options.prompt);
    if (options.response_format)
      formData.append("response_format", options.response_format);
    if (options.temperature != null)
      formData.append("temperature", String(options.temperature));

    return http.post<AudioTranscriptionResponse>(
      `${this.baseUrl}/api/proxy/v1/audio/transcriptions`,
      formData,
      { headers: { ...this.headers } }
    );
  }

  async createAudioGeneration(options: AudioGenerationOptions) {
    await this.checkJwt();
    return http.post<AudioGenerationResponse>(
      `${this.baseUrl}/api/proxy/v1/audio/generations`,
      options,
      { headers: this.headers }
    );
  }

  async createImageGeneration(options: ImageGenerationOptions) {
    await this.checkJwt();
    return http.post<ImageGenerationResponse>(
      `${this.baseUrl}/api/proxy/v1/images/generations`,
      options,
      { headers: this.headers }
    );
  }

  async createVideoGeneration(options: VideoGenerationOptions) {
    await this.checkJwt();
    return http.post<VideoGenerationResponse>(
      `${this.baseUrl}/api/proxy/v1/videos/generations`,
      options,
      { headers: this.headers }
    );
  }

  async getVideoStatus(options: VideoStatusOptions) {
    await this.checkJwt();
    const { jobId, ...rest } = options;
    return http.get<VideoStatusResponse>(
      `${this.baseUrl}/api/proxy/v1/videos/${jobId}/status`,
      { headers: this.headers, params: rest }
    );
  }

  async downloadVideo(options: FileDownloadOptions) {
    await this.checkJwt();
    const { fileId } = options;
    return http.get<ArrayBuffer>(
      `${this.baseUrl}/api/proxy/v1/videos/${fileId}/content`,
      { headers: this.headers, responseType: "arraybuffer" }
    );
  }

  async uploadFile(options: FileUploadOptions) {
    await this.checkJwt();
    // Send as JSON with base64-encoded data
    const body = {
      data: options.data.toString("base64"),
      mimeType: options.mimeType,
      fileName: options.fileName,
      displayName: options.displayName,
    };
    return http.post<FileUploadResponse>(
      `${this.baseUrl}/api/proxy/v1/files`,
      body,
      { headers: this.headers }
    );
  }

  async downloadFile(options: FileDownloadOptions) {
    await this.checkJwt();
    const { fileId } = options;
    return http.get<ArrayBuffer>(
      `${this.baseUrl}/api/proxy/v1/files/${fileId}/content`,
      { headers: this.headers, responseType: "arraybuffer" }
    );
  }

  async createChatTask(request: CreateMessageTaskRequest) {
    await this.checkJwt();
    return http.post<CreateMessageTaskResponse>(
      `${this.baseUrl}/api/chat/tasks`,
      request,
      {
        headers: this.headers,
      }
    );
  }

  async updateChatTask(taskId: string, updates: UpdateOrgTaskRequest) {
    await this.checkJwt();
    return http.put<UpdateOrgTaskResponse>(
      `${this.baseUrl}/api/chat/tasks/${taskId}`,
      updates,
      {
        headers: this.headers,
      }
    );
  }

  // ============================================
  // Agent Task Synchronization Methods
  // ============================================

  /**
   * Get task details including status, threads, and pending message info
   */
  async getTaskDetails(taskId: string) {
    await this.checkJwt();
    return http.get<TaskDetailsResponse>(
      `${this.baseUrl}/api/org-agent-tasks/${taskId}`,
      {
        headers: this.headers,
      }
    );
  }

  /**
   * Get pending messages for an agent task
   */
  async getPendingMessages(taskId: string) {
    await this.checkJwt();
    return http.get<PendingMessage[]>(
      `${this.baseUrl}/api/org-agent-tasks/${taskId}/pending-messages`,
      {
        headers: this.headers,
      }
    );
  }

  /**
   * Mark pending messages as processed
   */
  async markMessagesAsProcessed(taskId: string, messageIds: string[]) {
    await this.checkJwt();
    return http.post<MarkProcessedResponse>(
      `${this.baseUrl}/api/org-agent-tasks/${taskId}/pending-messages/mark-processed`,
      { messageIds },
      {
        headers: this.headers,
      }
    );
  }

  /**
   * Send a message to a running agent task
   */
  async sendMessageToAgent(
    taskId: string,
    message: string,
    role: "user" | "system" = "user"
  ) {
    await this.checkJwt();
    return http.post<SendMessageResponse>(
      `${this.baseUrl}/api/org-agent-tasks/${taskId}/messages`,
      { message, role },
      {
        headers: this.headers,
      }
    );
  }

  /**
   * Pause a running agent task
   */
  async pauseAgent(taskId: string) {
    await this.checkJwt();
    return http.post<StatusResponse>(
      `${this.baseUrl}/api/org-agent-tasks/${taskId}/pause`,
      {},
      {
        headers: this.headers,
      }
    );
  }

  /**
   * Resume a paused agent task
   */
  async resumeAgent(taskId: string) {
    await this.checkJwt();
    return http.post<StatusResponse>(
      `${this.baseUrl}/api/org-agent-tasks/${taskId}/resume`,
      {},
      {
        headers: this.headers,
      }
    );
  }

  /**
   * Get threads from a task by task ID
   */
  async getTaskThreads(taskId: string): Promise<any[][]> {
    const response = await this.getTaskDetails(taskId);
    return response.data.threads || [];
  }

  /**
   * Kill/cancel a running or paused agent task
   */
  async killAgent(taskId: string) {
    await this.checkJwt();
    return http.post<StatusResponse>(
      `${this.baseUrl}/api/org-agent-tasks/${taskId}/kill`,
      {},
      {
        headers: this.headers,
      }
    );
  }

  // ============================================
  // File Sync Methods
  // Uses existing org-files endpoints: list, text GET/PUT, and create
  // ============================================

  /**
   * List all org files for the current user's org
   */
  async listOrgFiles() {
    await this.checkJwt();
    return http.get<
      { id: string; fileName: string; folderPath: string; name: string }[]
    >(`${this.baseUrl}/api/org-files`, { headers: this.headers });
  }

  /**
   * Create a new org file record
   */
  async createOrgFile(fileName: string, folderPath: string) {
    await this.checkJwt();
    return http.post<{
      id: string;
      fileName: string;
      folderPath: string;
      name: string;
    }>(
      `${this.baseUrl}/api/org-files`,
      { fileName, folderPath, name: fileName },
      { headers: this.headers }
    );
  }

  /**
   * Get text content of an org file by id (returns streaming JSON array of strings)
   */
  async getOrgFileText(fileId: string) {
    await this.checkJwt();
    return http.get<string>(`${this.baseUrl}/api/org-files/${fileId}/text`, {
      headers: this.headers,
      params: { reading: "true" },
    });
  }

  /**
   * Update text content of an org file by id
   */
  async updateOrgFileText(fileId: string, text: string) {
    await this.checkJwt();
    return http.put(
      `${this.baseUrl}/api/org-files/${fileId}/text`,
      { text },
      { headers: this.headers }
    );
  }

  /**
   * Find an org file by its full remote path (e.g. /test.md or /docs/readme.md)
   * Returns null if not found
   */
  async findOrgFileByPath(
    remotePath: string
  ): Promise<{ id: string; fileName: string; folderPath: string } | null> {
    const lastSlash = remotePath.lastIndexOf("/");
    const rawFolder =
      lastSlash >= 0 ? remotePath.substring(0, lastSlash + 1) : "/";
    // Normalize: "/" and "" both mean root
    const folderPath = rawFolder === "/" ? rawFolder : rawFolder;
    const fileName =
      lastSlash >= 0 ? remotePath.substring(lastSlash + 1) : remotePath;

    const response = await this.listOrgFiles();
    const files = response.data;
    // DB may store root as "" or "/" - match both
    const isRoot = folderPath === "/" || folderPath === "";
    return (
      files.find(
        (f) =>
          f.fileName === fileName &&
          (f.folderPath === folderPath ||
            (isRoot && (f.folderPath === "/" || f.folderPath === "")))
      ) || null
    );
  }

  /**
   * Find or create an org file by path, returns the file record
   */
  async findOrCreateOrgFileByPath(
    remotePath: string
  ): Promise<{ id: string; fileName: string; folderPath: string }> {
    const existing = await this.findOrgFileByPath(remotePath);
    if (existing) return existing;

    const lastSlash = remotePath.lastIndexOf("/");
    const folderPath =
      lastSlash >= 0 ? remotePath.substring(0, lastSlash + 1) || "/" : "/";
    const fileName =
      lastSlash >= 0 ? remotePath.substring(lastSlash + 1) : remotePath;

    const response = await this.createOrgFile(fileName, folderPath);
    return response.data;
  }

  /**
   * Get presigned S3 URL for downloading a file from Knowhow FS.
   * First finds or creates the file by path, then gets its download URL.
   */
  async getOrgFilePresignedDownloadUrl(
    filePath: string
  ): Promise<{ downloadUrl: string; checksumSHA256: string | null }> {
    await this.checkJwt();

    // Find the file by path
    const file = await this.findOrgFileByPath(filePath);
    if (!file) {
      throw new Error(`File not found: ${filePath}`);
    }

    // Get download URL using the file ID
    const response = await http.post<{ downloadUrl: string; checksumSHA256: string | null }>(
      `${this.baseUrl}/api/org-files/download/${file.id}`,
      {},
      { headers: this.headers }
    );
    return {
      downloadUrl: response.data.downloadUrl,
      checksumSHA256: response.data.checksumSHA256 ?? null,
    };
  }

  /**
   * Notify the backend that a file upload is complete, updating its updatedAt timestamp.
   */
  async markOrgFileUploadComplete(filePath: string): Promise<void> {
    await this.checkJwt();

    const file = await this.findOrgFileByPath(filePath);
    if (!file) {
      throw new Error(`File not found: ${filePath}`);
    }

    await http.post(
      `${this.baseUrl}/api/org-files/upload/${file.id}/complete`,
      {},
      { headers: this.headers }
    );
  }

  /**
   * Get presigned S3 URL for uploading a file to Knowhow FS.
   * First finds or creates the file by path, then gets its upload URL.
   * Computes SHA256 hash of the file content and stores it as S3 metadata
   * so any client can determine if they already have this version without downloading.
   */
  async getOrgFilePresignedUploadUrl(filePath: string, localFilePath?: string): Promise<string> {
    await this.checkJwt();

    // Find or create the file by path
    const file = await this.findOrCreateOrgFileByPath(filePath);

    // Extract just the filename from the path
    const lastSlash = filePath.lastIndexOf("/");
    const fileName =
      lastSlash >= 0 ? filePath.substring(lastSlash + 1) : filePath;

    // Compute SHA256 hash if we have the local file path, so S3 stores it as metadata
    let sha256Hash: string | undefined;
    if (localFilePath) {
      const fileContent = fs.readFileSync(localFilePath);
      sha256Hash = createHash("sha256").update(fileContent).digest("base64");
    }

    // Get upload URL using the file ID
    const response = await http.post<{ uploadUrl: string }>(
      `${this.baseUrl}/api/org-files/upload/${file.id}`,
      { fileName, sha256Hash },
      { headers: this.headers }
    );
    return response.data.uploadUrl;
  }

  /**
   * Get git credentials for a repository via the Knowhow API.
   * Returns credentials in the GitCredentialResponse format.
   */
  async getGitCredential(repo: string): Promise<GitCredentialResponse> {
    await this.checkJwt();
    const response = await http.post<GitCredentialResponse>(
      `${this.baseUrl}/api/github/git-credential`,
      { repo },
      { headers: this.headers }
    );
    return response.data;
  }

  // ============================================
  // Cloud Worker Methods
  // ============================================

  /**
   * List all cloud workers for the current user's org
   */
  async listCloudWorkers() {
    await this.checkJwt();
    return http.get<
      { id: string; name: string; status: string; workerConfigJson?: Record<string, unknown> }[]
    >(`${this.baseUrl}/api/cloud-workers`, { headers: this.headers });
  }

  /**
   * Create a new cloud worker
   */
  async createCloudWorker(data: {
    name: string;
    workerConfigJson?: Record<string, unknown>;
  }) {
    await this.checkJwt();
    return http.post<{ id: string; name: string; status: string; workerConfigJson?: Record<string, unknown> }>(
      `${this.baseUrl}/api/cloud-workers`,
      data,
      { headers: this.headers }
    );
  }

  /**
   * Get a single cloud worker by ID
   */
  async getCloudWorker(id: string) {
    await this.checkJwt();
    return http.get<{ id: string; name: string; status: string; workerConfigJson?: Record<string, unknown> }>(
      `${this.baseUrl}/api/cloud-workers/${id}`,
      { headers: this.headers }
    );
  }

  /**
   * Update an existing cloud worker
   */
  async updateCloudWorker(
    id: string,
    data: { workerConfigJson?: Record<string, unknown> }
  ) {
    await this.checkJwt();
    return http.put<{ id: string; name: string; status: string; workerConfigJson?: Record<string, unknown> }>(
      `${this.baseUrl}/api/cloud-workers/${id}`,
      data,
      { headers: this.headers }
    );
  }

  // ============================================
  // Remote Sync Placeholder Methods
  // ============================================

  /**
   * Create a bare session stub without triggering AI inference.
   * Used by the CLI remote sync feature to establish a remote session.
   */
  async createSessionPlaceholder(
    request: CreateSessionPlaceholderRequest = {}
  ): Promise<CreateSessionPlaceholderResponse> {
    await this.checkJwt();
    const response = await http.post<CreateSessionPlaceholderResponse>(
      `${this.baseUrl}/api/chat/sessions/placeholder`,
      request,
      { headers: this.headers }
    );
    return response.data;
  }

  /**
   * Create a message placeholder in a session without triggering AI inference.
   * Used by the CLI remote sync feature to register a message before syncing threads.
   */
  async createMessagePlaceholder(
    sessionId: string,
    request: CreateMessagePlaceholderRequest
  ): Promise<CreateMessagePlaceholderResponse> {
    await this.checkJwt();
    const response = await http.post<CreateMessagePlaceholderResponse>(
      `${this.baseUrl}/api/chat/sessions/${sessionId}/messages/placeholder`,
      request,
      { headers: this.headers }
    );
    return response.data;
  }
}
