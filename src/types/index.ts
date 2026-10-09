export type MediaKind = 'video' | 'image' | 'gif' | 'file' | 'audio';
export type ObjectUrlKind = 'blob' | 'media-source' | 'unknown';
export type TaskStatus = 'pending' | 'resolving' | 'downloading' | 'paused' | 'completed' | 'failed';

export interface MediaItem {
  id: string;
  url: string;
  filename: string;
  mimeType: string;
  size: number;
  kind: MediaKind;
  messageId: string;
  peerId: string;
  fileId: string;
  source: 'dom' | 'fetch' | 'blob';
  capturedAt: number;
  monthGroup?: string;
  dateTimestamp?: number;
  hasDownloaded?: boolean;
  /** Transient lease details used only while a K Viewer Blob download is active. */
  blobLeaseId?: string;
  objectUrlKind?: ObjectUrlKind;
  /** A K Viewer native quality-download action was already triggered; never send this item to Downloader. */
  nativeDownloadStarted?: boolean;
  /** A K Viewer HTTP source passed the MAIN-world page probe and must keep page-context transport. */
  requiresPageTransport?: boolean;
  /** Only the K Channel Info single-video action opts into container validation and bounded HTTP ranges. */
  kSingleVideo?: {
    viewerOpenMs: number;
    candidateDiscoveryMs: number;
    probeMs: number;
    resolvedAt: number;
  };
}

export interface DownloadTask {
  id: string;
  tabId?: number;
  mediaId: string;
  url: string;
  filename: string;
  size: number;
  bytesDownloaded: number;
  progress: number;
  status: TaskStatus;
  error: string;
  createdAt: number;
  updatedAt: number;
}

export interface AppSettings {
  chunkSizeMb: number;
  maxRetries: number;
  captureImages: boolean;
  captureFiles: boolean;
}

export const defaultSettings: AppSettings = {
  chunkSizeMb: 2,
  maxRetries: 3,
  captureImages: true,
  captureFiles: true,
};
