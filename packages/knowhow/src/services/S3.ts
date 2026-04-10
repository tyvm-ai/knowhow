import {
  S3Client,
  HeadBucketCommand,
  CreateBucketCommand,
  GetObjectCommand,
  PutObjectCommand,
  GetObjectCommandInput,
  PutObjectCommandInput,
} from "@aws-sdk/client-s3";

import * as fs from "fs";
const fsPromises = fs.promises;
import { createWriteStream } from "fs";
import * as path from "path";
import { pipeline, Readable } from "stream";
import * as util from "util";

import { createReadStream } from "fs";
const pipelineAsync = util.promisify(pipeline);

export class S3Service {
  private s3: S3Client;

  constructor() {
    this.s3 = new S3Client();
  }

  async uploadFile(
    filePath: string,
    bucketName: string,
    key: string
  ): Promise<void> {
    const fileContent = await fsPromises.readFile(filePath);

    const params = {
      Bucket: bucketName,
      Key: key,
      Body: fileContent,
    };

    // create bucket if it doesn't exist
    try {
      await this.s3.send(new HeadBucketCommand({ Bucket: bucketName }));
    } catch (error) {
      const statusCode = error.$metadata.httpStatusCode;
      if (statusCode === 404) {
        await this.s3.send(new CreateBucketCommand({ Bucket: bucketName }));
        console.log(`Bucket ${bucketName} created successfully`);
      } else {
        throw error;
      }
    }

    await this.s3.send(new PutObjectCommand(params));
    console.log(`File uploaded successfully to ${bucketName}/${key}`);
  }

  async downloadFile(
    bucketName: string,
    key: string,
    destinationPath: string
  ): Promise<void> {
    const params = {
      Bucket: bucketName,
      Key: key,
    };
    const { Body } = await this.s3.send(new GetObjectCommand(params));
    const fileStream = createWriteStream(destinationPath);

    await pipelineAsync(Body as NodeJS.ReadableStream, fileStream);

    console.log(
      `File downloaded successfully from ${bucketName}/${key} to ${destinationPath}`
    );
  }

  async uploadToPresignedUrl(
    presignedUrl: string,
    filePath: string
  ): Promise<void> {
    try {
      const fileStream = createReadStream(filePath);
      const fileStats = await fsPromises.stat(filePath);

      const response = await fetch(presignedUrl, {
        method: "PUT",
        headers: { "Content-Length": String(fileStats.size) },
        body: fileStream as any,
        // @ts-ignore - Node 18+ supports ReadableStream body with duplex
        duplex: "half",
      });

      if (!response.ok) {
        throw new Error(`Upload failed with status code: ${response.status}`);
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
