import { KnowhowModule } from "@tyvm/knowhow";
import {
  S3Client,
  HeadBucketCommand,
  CreateBucketCommand,
  GetObjectCommand,
  PutObjectCommand,
} from "@aws-sdk/client-s3";
import * as fs from "fs";
import { createWriteStream, createReadStream } from "fs";
import { pipeline } from "stream";
import * as util from "util";

const pipelineAsync = util.promisify(pipeline);

async function s3Upload(
  localPath: string,
  bucketName: string,
  key: string
): Promise<void> {
  const s3 = new S3Client();
  const fileContent = await fs.promises.readFile(localPath);

  // create bucket if it doesn't exist
  try {
    await s3.send(new HeadBucketCommand({ Bucket: bucketName }));
  } catch (error) {
    const statusCode = (error as any).$metadata?.httpStatusCode;
    if (statusCode === 404) {
      await s3.send(new CreateBucketCommand({ Bucket: bucketName }));
      console.log(`Bucket ${bucketName} created successfully`);
    } else {
      throw error;
    }
  }

  await s3.send(
    new PutObjectCommand({ Bucket: bucketName, Key: key, Body: fileContent })
  );
  console.log(`File uploaded successfully to ${bucketName}/${key}`);
}

async function s3Download(
  bucketName: string,
  key: string,
  destinationPath: string
): Promise<void> {
  const s3 = new S3Client();
  const { Body } = await s3.send(
    new GetObjectCommand({ Bucket: bucketName, Key: key })
  );
  const fileStream = createWriteStream(destinationPath);
  await pipelineAsync(Body as NodeJS.ReadableStream, fileStream);
  console.log(
    `File downloaded successfully from ${bucketName}/${key} to ${destinationPath}`
  );
}

const module: KnowhowModule = {
  async init({ context }) {
    if (context?.Embeddings) {
      context.Embeddings.registerResolver("s3", {
        download: (remote, filePath, destinationPath) =>
          s3Download(remote, filePath, destinationPath),
        upload: (localPath, remote, remoteKey) =>
          s3Upload(localPath, remote, remoteKey),
      });
    }
  },
  tools: [],
  agents: [],
  plugins: [],
  clients: [],
  commands: [],
};

export default module;
