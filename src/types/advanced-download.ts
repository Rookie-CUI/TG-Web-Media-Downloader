export interface AdvancedDownloadSelection {
  mediaTypes: Array<'image' | 'video' | 'gif'>;
  skipDownloaded: boolean;
  selectedKeys: string[];
}

export interface AdvancedDownloadProgress {
  completed: number;
  total: number;
  successCount?: number;
  failedCount?: number;
  currentFile?: string;
  statusText?: string;
  status: 'idle' | 'scanning' | 'downloading' | 'completed' | 'failed';
  error?: string;
}
