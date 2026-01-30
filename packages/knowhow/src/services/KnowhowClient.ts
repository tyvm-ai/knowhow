import axios from "axios";
import fs from "fs";
import { Message } from "../clients/types";
import path from "path";
import {
  CompletionOptions,
  CompletionResponse,
  EmbeddingOptions,
  EmbeddingResponse,
} from "src/clients";
import { Config } from "../types";

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
  totalCostUsd: number;
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
  threads: any;
  createdAt: string;
  updatedAt: string;
  messageId?: string;
  hasPendingMessages: boolean;
  pendingMessagesCount: number;
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
  headers = {};
  jwtValidated = false;

  constructor(
    private baseUrl = KNOWHOW_API_URL,
    private jwt = loadKnowhowJwt()
  ) {
    this.setJwt(jwt);
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

        console.log(
          `Current user: ${user.email}, \nOrganization: ${currentOrg?.organization?.name} - ${orgId}`
        );
      } catch (error) {
        throw new Error("Invalid JWT. Please login again.");
      }
    }
  }

  async me() {
    if (!this.jwt) {
      throw new Error("No JWT found. Please login first.");
    }

    return axios.get(`${this.baseUrl}/api/users/me`, {
      headers: this.headers,
    });
  }

  async getPresignedUploadUrl(source: Config["embedSources"][0]) {
    await this.checkJwt();
    const id = source.remoteId;
    const presignedUrlResp = await axios.post(
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
    const presignedUrlResp = await axios.post(
      `${this.baseUrl}/api/org-embeddings/${id}/download`,
      {},
      {
        headers: this.headers,
      }
    );

    const presignedUrl = presignedUrlResp.data.downloadUrl;
    return presignedUrl;
  }

  async createChatCompletion(options: CompletionOptions) {
    await this.checkJwt();
    return axios.post<CompletionResponse>(
      `${this.baseUrl}/api/proxy/v1/chat/completions`,
      options,
      {
        headers: this.headers,
      }
    );
  }

  async createEmbedding(options: EmbeddingOptions) {
    await this.checkJwt();
    return axios.post<EmbeddingResponse>(
      `${this.baseUrl}/api/proxy/v1/embeddings`,
      options,
      {
        headers: this.headers,
      }
    );
  }

  async getModels() {
    await this.checkJwt();
    return axios.get(`${this.baseUrl}/api/proxy/v1/models?type=all`, {
      headers: this.headers,
    });
  }

  async createChatTask(request: CreateMessageTaskRequest) {
    await this.checkJwt();
    return axios.post<CreateMessageTaskResponse>(
      `${this.baseUrl}/api/chat/tasks`,
      request,
      {
        headers: this.headers,
      }
    );
  }

  async updateChatTask(taskId: string, updates: UpdateOrgTaskRequest) {
    await this.checkJwt();
    return axios.put<UpdateOrgTaskResponse>(
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
    return axios.get<TaskDetailsResponse>(
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
    return axios.get<PendingMessage[]>(
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
    return axios.post<MarkProcessedResponse>(
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
  async sendMessageToAgent(taskId: string, message: string, role: "user" | "system" = "user") {
    await this.checkJwt();
    return axios.post<SendMessageResponse>(
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
    return axios.post<StatusResponse>(
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
    return axios.post<StatusResponse>(
      `${this.baseUrl}/api/org-agent-tasks/${taskId}/resume`,
      {},
      {
        headers: this.headers,
      }
    );
  }

  /**
   * Kill/cancel a running or paused agent task
   */
  async killAgent(taskId: string) {
    await this.checkJwt();
    return axios.post<StatusResponse>(
      `${this.baseUrl}/api/org-agent-tasks/${taskId}/kill`,
      {},
      {
        headers: this.headers,
      }
    );
  }
}
