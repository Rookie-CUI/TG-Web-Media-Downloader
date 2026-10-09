import type { MediaKind } from './index';

/** Stable sidebar identity captured during scanning; intentionally has no download URL. */
export interface ScannedMediaIdentity {
  stableKey: string;
  version: 'A' | 'K';
  messageId: string;
  peerId: string;
  kind: Extract<MediaKind, 'image' | 'video' | 'gif'>;
  monthGroup: string;
  dateTimestamp?: number;
  duration: string;
  thumbnail: string;
  sidebarKey: string;
  mediaIndex: number;
  hasDownloaded?: boolean;
}

export interface AdvancedHistoryScanRequest {
  selectedKeys: string[];
  mediaTypes: Array<'image' | 'video' | 'gif'>;
  skipDownloaded: boolean;
}
