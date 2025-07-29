export class AudioFormat {
  ext: string;
  width: number | null;
  height: number | null;
  tbr: number | null;
  format_id: string;
  url: string;
  vcodec: string;
  http_headers: Record<string, string>;
  protocol: string;
  resolution: string;
  aspect_ratio: number | null;
  audio_ext: string;
  video_ext: string;
  format: string;
}

export interface KeyframeInfo {
  path: string;
  description: string;
  timestamp: number;
  usd_cost: number | null;
}

export interface TranscriptChunk {
  chunkPath: string;
  text: string;
  usd_cost: number | null;
}

export class RequestedDownload {
  ext: string;
  format_id: string;
  url: string;
  vcodec: string;
  http_headers: Record<string, string>;
  protocol: string;
  resolution: string;
  audio_ext: string;
  video_ext: string;
  format: string;
  epoch: number;
  _filename: string;
  __write_download_archive: boolean;
}

export class DownloadInfo {
  id: string;
  title: string;
  timestamp: Date | null;
  description: string | null;
  thumbnail: string | null;
  age_limit: number;
  formats: AudioFormat[];
  subtitles: Record<string, string>;
  _old_archive_ids: string[];
  extractor: string;
  extractor_key: string;
  webpage_url: string;
  original_url: string;
  webpage_url_basename: string;
  webpage_url_domain: string;
  playlist: string | null;
  playlist_index: number | null;
  display_id: string;
  fulltitle: string;
  requested_subtitles: Record<string, string> | null;
  _has_drm: boolean | null;
  requested_downloads: RequestedDownload[];
  ext: string;
  width: number | null;
  height: number | null;
  tbr: number | null;
  format_id: string;
  url: string;
  vcodec: string;
  http_headers: Record<string, string>;
  protocol: string;
  resolution: string;
  aspect_ratio: number | null;
  audio_ext: string;
  video_ext: string;
  format: string;
  epoch: number;
  _type: string;
  _version: {
    version: string;
    current_git_head: string | null;
    release_git_head: string;
    repository: string;
  };
}
