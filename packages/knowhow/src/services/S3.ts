import * as fs from "fs";
import { createWriteStream, createReadStream } from "fs";
import { pipeline, Readable } from "stream";
import * as util from "util";

const pipelineAsync = util.promisify(pipeline);

export class S3Service {
  async uploadToPresignedUrl(
    presignedUrl: string,
    filePath: string
  ): Promise<void> {
    try {
      const fileContent = fs.readFileSync(filePath);
      const fileStats = await fs.promises.stat(filePath);

      const response = await fetch(presignedUrl, {
        method: "PUT",
        headers: {
          "Content-Length": String(fileStats.size),
        },
        body: fileContent,
        // @ts-ignore
        duplex: "half",
      });

      if (!response.ok) {
        const text = await response.text();
        throw new Error(`Upload failed with status code: ${response.status} - ${text}`);
      }

      console.log("File uploaded successfully to pre-signed URL");
    } catch (error) {
      console.error("Error uploading file to pre-signed URL:", error);
      throw error;
    }
  }

  async downloadFromPresignedUrl(
    presignedUrl: string,
    destinationPath: string
  ): Promise<void> {
    try {
      const response = await fetch(presignedUrl);

      if (!response.ok) {
        throw new Error(`Download failed with status code: ${response.status}`);
      }

      const fileStream = createWriteStream(destinationPath);
      await pipelineAsync(Readable.from(response.body as any), fileStream);

      console.log(
        `File downloaded successfully from pre-signed URL to ${destinationPath}`
      );
    } catch (error) {
      console.error("Error downloading file from pre-signed URL:", error);
      throw error;
    }
  }
}
