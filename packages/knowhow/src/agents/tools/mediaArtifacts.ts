import { KnowhowSimpleClient } from "../../services/KnowhowClient";
import http from "../../utils/http";
import { getConfigSync } from "../../config";

/**
 * Worker-side transport for generated media (audio / image / video) going back to the backend over the
 * MCP socket. Small results travel inline as base64; larger ones are uploaded to the org's Files (the
 * worker already has the machine's JWT) and only a reference with a presigned download URL goes back.
 * `unpackArtifact` on the receiving side (KnowhowMcpClient) turns either form back into bytes.
 */
export interface ArtifactRef {
  /** Presigned download URL (short lived). */
  url: string;
  /** Org file id of the uploaded temp copy. */
  fileId?: string;
  mimeType?: string;
  sizeBytes: number;
}

export type PackedArtifact =
  | { base64: string; sizeBytes: number }
  | { ref: ArtifactRef };

/** Largest result (raw bytes) sent inline over the socket. Override with `worker.mediaInlineMaxBytes`. */
export const DEFAULT_INLINE_MAX_BYTES = 2 * 1024 * 1024;
/** Where the worker parks results that are too big to send inline. */
export const WORKER_TMP_FOLDER = "/ai-generated/worker-tmp/";
/** The worker deletes its own temp uploads after this long (the backend persists its own copy). */
export const TMP_ARTIFACT_TTL_MS = 60 * 60 * 1000;

export interface ArtifactUploader {
  upload(
    data: Buffer,
    meta: { fileName: string; folderPath: string; mimeType?: string }
  ): Promise<{ fileId: string; downloadUrl: string }>;
  remove?(fileId: string): Promise<void>;
}

class KnowhowFilesUploader implements ArtifactUploader {
  private client = new KnowhowSimpleClient();

  async upload(
    data: Buffer,
    meta: { fileName: string; folderPath: string; mimeType?: string }
  ) {
    const file = (await this.client.createOrgFile(meta.fileName, meta.folderPath)).data;
    const filePath = `${meta.folderPath}${meta.fileName}`;
    const { fileId, uploadUrl } = await this.client.getOrgFileUploadTarget(
      filePath,
      undefined,
      file
    );
    const put = await fetch(uploadUrl, {
      method: "PUT",
      // Same as fileSync: only Content-Length (a Content-Type the URL was not signed for can be rejected).
      headers: { "Content-Length": String(data.length) },
      body: new Uint8Array(data),
    });
    if (!put.ok) {
      throw new Error(
        `Upload of generated media to org files failed: HTTP ${put.status} ${await put
          .text()
          .catch(() => "")}`
      );
    }
    await this.client.markOrgFileUploadComplete(filePath, fileId);
    const dl = await this.client.getOrgFileDownloadUrlById(fileId);
    return { fileId, downloadUrl: dl };
  }

  async remove(fileId: string) {
    await this.client.deleteOrgFile(fileId);
  }
}

let uploader: ArtifactUploader | undefined;
/** Tests / embedders can swap the uploader. */
export function setArtifactUploader(next: ArtifactUploader | undefined) {
  uploader = next;
}
function getUploader(): ArtifactUploader {
  return (uploader ??= new KnowhowFilesUploader());
}

const pendingCleanup: { fileId: string; at: number }[] = [];

async function cleanupOldUploads(up: ArtifactUploader, now = Date.now()) {
  if (!up.remove) return;
  while (pendingCleanup.length && now - pendingCleanup[0].at > TMP_ARTIFACT_TTL_MS) {
    const { fileId } = pendingCleanup.shift()!;
    await up.remove(fileId).catch(() => undefined);
  }
}

function inlineMaxBytes(): number {
  const configured = getConfigSync()?.worker?.mediaInlineMaxBytes;
  return typeof configured === "number" && configured >= 0
    ? configured
    : DEFAULT_INLINE_MAX_BYTES;
}

export async function packArtifact(
  data: Buffer,
  meta: { fileName: string; mimeType?: string; maxInlineBytes?: number }
): Promise<PackedArtifact> {
  const limit = meta.maxInlineBytes ?? inlineMaxBytes();
  if (data.length <= limit) {
    return { base64: data.toString("base64"), sizeBytes: data.length };
  }
  const up = getUploader();
  const { fileId, downloadUrl } = await up.upload(data, {
    fileName: meta.fileName,
    folderPath: WORKER_TMP_FOLDER,
    mimeType: meta.mimeType,
  });
  pendingCleanup.push({ fileId, at: Date.now() });
  void cleanupOldUploads(up);
  return {
    ref: {
      url: downloadUrl,
      fileId,
      mimeType: meta.mimeType,
      sizeBytes: data.length,
    },
  };
}

/** Receiving side: bytes from a PackedArtifact (inline base64, or fetch the presigned URL). */
export async function unpackArtifact(packed: PackedArtifact): Promise<Buffer> {
  if ("base64" in packed && typeof packed.base64 === "string") {
    return Buffer.from(packed.base64, "base64");
  }
  if ("ref" in packed && packed.ref?.url) {
    const res = await http.get<ArrayBuffer>(packed.ref.url, {
      responseType: "arraybuffer",
      timeout: 0,
    });
    return Buffer.from(res.data);
  }
  throw new Error("Malformed media artifact: neither base64 nor ref.url");
}

export function artifactFileName(prefix: string, ext: string) {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
}
