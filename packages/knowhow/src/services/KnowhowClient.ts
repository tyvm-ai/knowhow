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
}

export interface UpdateOrgTaskResponse {
  threadCount: Message[][];
  totalCostUsd: number;
  inProgress: boolean;
}

export function loadKnowhowJwt(): string {
  const jwtFile = path.join(process.cwd(), ".knowhow", ".jwt");
  if (!fs.existsSync(jwtFile)) {
    return "";
  }
  return fs.readFileSync(jwtFile, "utf-8").trim();
}

export class KnowhowSimpleClient {
  headers = {};

  constructor(private baseUrl, private jwt = loadKnowhowJwt()) {
    this.setJwt(jwt);
  }

  setJwt(jwt: string) {
    this.jwt = jwt;
    this.headers = {
      Authorization: `Bearer ${this.jwt}`,
    };
  }

  checkJwt() {
    if (!this.jwt) {
      throw new Error("No JWT found. Please login first.");
    }
  }

  me() {
    this.checkJwt();
    return axios.get(`${this.baseUrl}/api/users/me`, {
      headers: this.headers,
    });
  }

  async getPresignedUploadUrl(source: Config["embedSources"][0]) {
    this.checkJwt();
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
    this.checkJwt();
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

  createChatCompletion(options: CompletionOptions) {
    this.checkJwt();
    return axios.post<CompletionResponse>(
      `${this.baseUrl}/api/proxy/v1/chat/completions`,
      options,
      {
        headers: this.headers,
      }
    );
  }

  createEmbedding(options: EmbeddingOptions) {
    this.checkJwt();
    return axios.post<EmbeddingResponse>(
      `${this.baseUrl}/api/proxy/v1/embeddings`,
      options,
      {
        headers: this.headers,
      }
    );
  }

  getModels() {
    this.checkJwt();
    return axios.get(`${this.baseUrl}/api/proxy/v1/models`, {
      headers: this.headers,
    });
  }

  createChatTask(request: CreateMessageTaskRequest) {
    this.checkJwt();
    return axios.post<CreateMessageTaskResponse>(
      `${this.baseUrl}/api/chat/tasks`,
      request,
      {
        headers: this.headers,
      }
    );
  }

  updateChatTask(taskId: string, updates: UpdateOrgTaskRequest) {
    this.checkJwt();
    return axios.put<UpdateOrgTaskResponse>(
      `${this.baseUrl}/api/chat/tasks/${taskId}`,
      updates,
      {
        headers: this.headers,
      }
    );
  }
}
