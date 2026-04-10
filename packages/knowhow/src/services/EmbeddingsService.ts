type DownloaderFn = (
  remote: string,
  filePath: string,
  destinationPath: string
) => Promise<void>;

type UploaderFn = (
  localPath: string,
  remote: string,
  remoteKey: string
) => Promise<void>;

export interface EmbeddingsResolver {
  download: DownloaderFn;
  upload?: UploaderFn;
}

/**
 * EmbeddingsService manages pluggable resolvers for remote embedding sources.
 * Modules can register a resolver for a given remoteType (e.g. "github", "s3")
 * via registerResolver(), and the core upload()/download() functions delegate to it.
 */
export class EmbeddingsService {
  private resolvers = new Map<string, EmbeddingsResolver>();

  registerResolver(remoteType: string, resolver: EmbeddingsResolver): void {
    this.resolvers.set(remoteType, resolver);
  }

  hasResolver(remoteType: string): boolean {
    return this.resolvers.has(remoteType);
  }

  async download(
    remoteType: string,
    remote: string,
    filePath: string,
    destinationPath: string
  ): Promise<void> {
    const resolver = this.resolvers.get(remoteType);
    if (!resolver) {
      throw new Error(
        `No resolver registered for remoteType: "${remoteType}". ` +
          `Install and configure the appropriate knowhow module (e.g. @tyvm/knowhow-module-github).`
      );
    }
    await resolver.download(remote, filePath, destinationPath);
  }

  async upload(
    remoteType: string,
    localPath: string,
    remote: string,
    remoteKey: string
  ): Promise<void> {
    const resolver = this.resolvers.get(remoteType);
    if (!resolver) {
      throw new Error(
        `No resolver registered for remoteType: "${remoteType}". ` +
          `Install and configure the appropriate knowhow module (e.g. @tyvm/knowhow-module-s3).`
      );
    }
    if (!resolver.upload) {
      throw new Error(
        `Resolver for remoteType: "${remoteType}" does not support uploads.`
      );
    }
    await resolver.upload(localPath, remote, remoteKey);
  }
}
