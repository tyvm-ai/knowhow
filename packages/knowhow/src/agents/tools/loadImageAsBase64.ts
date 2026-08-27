import fs from "fs";
import path from "path";
import { Tool } from "../../clients/types";

const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

const MIME_TYPES: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  bmp: "image/bmp",
  svg: "image/svg+xml",
  avif: "image/avif",
  ico: "image/x-icon",
};

function detectMimeType(buffer: Buffer, fallback: string): string {
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }
  if (buffer.length >= 4 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) {
    return "image/png";
  }
  if (buffer.length >= 4 && buffer.subarray(0, 4).toString("ascii") === "GIF8") {
    return "image/gif";
  }
  if (
    buffer.length >= 12 &&
    buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
    buffer.subarray(8, 12).toString("ascii") === "WEBP"
  ) {
    return "image/webp";
  }
  return fallback;
}

/** Load a reasonably sized image from the worker filesystem for UI/AI preview. */
export async function loadImageAsBase64(
  filePath: string,
  detail: "auto" | "low" | "high" = "auto"
): Promise<string> {
  const stats = await fs.promises.stat(filePath).catch(() => null);
  if (!stats) throw new Error(`File not found: ${filePath}`);
  if (!stats.isFile()) throw new Error(`Path is not a file: ${filePath}`);
  if (stats.size > MAX_IMAGE_BYTES) {
    throw new Error(`Image is too large to preview (${Math.ceil(stats.size / 1024 / 1024)} MB; maximum 15 MB)`);
  }

  const extension = path.extname(filePath).slice(1).toLowerCase();
  const extensionMimeType = MIME_TYPES[extension];
  if (!extensionMimeType) {
    throw new Error(`Unsupported image format: ${extension || "unknown"}`);
  }

  const image = await fs.promises.readFile(filePath);
  const mimeType = detectMimeType(image, extensionMimeType);
  return JSON.stringify({
    type: "image_url",
    image_url: {
      url: `data:${mimeType};base64,${image.toString("base64")}`,
      detail,
    },
  });
}

export const loadImageAsBase64Definition: Tool = {
  type: "function",
  function: {
    name: "loadImageAsBase64",
    description: "Load an image from the worker filesystem and return it as a base64 data URL for previewing.",
    parameters: {
      type: "object",
      positional: true,
      properties: {
        filePath: { type: "string", description: "Absolute or workspace-relative image path" },
        detail: { type: "string", enum: ["auto", "low", "high"], description: "Image detail hint" },
      },
      required: ["filePath"],
    },
  },
};
