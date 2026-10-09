import { createApp, h, nextTick, reactive } from 'vue';
import AdvancedDownloadDialog from '../components/AdvancedDownloadDialog.vue';
import dialogCss from '../components/advanced-download-dialog.css?inline';
import { formatErrorLog } from '../utils/errors';
import { cloneStructuredMessage } from '../utils/structured-clone';
import type { AdvancedDownloadProgress, AdvancedDownloadSelection } from '../types/advanced-download';
import type { AdvancedHistoryScanRequest, ScannedMediaIdentity } from '../types/scanned-media';

const MARK = '__TG_PERSONAL_MEDIA_V1__';
const HOST_STYLE = `
  position: fixed !important;
  inset: 0 !important;
  top: 0 !important;
  left: 0 !important;
  right: 0 !important;
  bottom: 0 !important;
  width: 100vw !important;
  height: 100vh !important;
  z-index: 2147483646 !important;
  pointer-events: none !important;
  background: transparent !important;
  display: block !important;
  overflow: visible !important;
  transform: none !important;
  opacity: 1 !important;
  border-radius: 0 !important;
  box-shadow: none !important;
`;
const APP_STYLE = 'display:block;width:100%;height:100%;min-height:100vh;position:relative;overflow:visible;pointer-events:none;';

interface OpenDialogMessage {
  chatId: string;
  chatTitle: string;
  mediaList: ScannedMediaIdentity[];
}

interface DialogState extends OpenDialogMessage {
  modelValue: boolean;
  loading: boolean;
  progress: AdvancedDownloadProgress;
  resetToken: number;
}

const state = reactive<DialogState>({
  modelValue: false,
  chatId: '',
  chatTitle: '',
  mediaList: [],
  loading: false,
  progress: { completed: 0, total: 0, successCount: 0, failedCount: 0, status: 'idle' },
  resetToken: 0,
});

let app: ReturnType<typeof createApp> | undefined;
let shadowRoot: ShadowRoot | undefined;
let mountPoint: HTMLElement | undefined;

function reportAdvancedFailure(step: string, error: unknown): void {
  console.error(formatErrorLog('[TG Downloader][advanced] failed', error, { step }));
}

function applyProtocolMessage(data: Record<string, unknown>): void {
  if (data.type === 'OPEN_UNIFIED_CHAT_EXPORT_DIALOG') {
    const context = data.context && typeof data.context === 'object' ? data.context as Record<string, unknown> : undefined;
    state.chatId = String(data.chatId || context?.peerId || '');
    state.chatTitle = String(data.chatTitle || context?.chatTitle || '');
    state.mediaList = Array.isArray(data.mediaList) ? data.mediaList as ScannedMediaIdentity[] : [];
    state.loading = data.mediaListLoading === true;
    state.progress = { completed: 0, total: 0, successCount: 0, failedCount: 0, status: 'idle' };
    state.resetToken += 1;
    state.modelValue = true;
    return;
  }

  if (data.type === 'TG_UPDATE_MEDIA_EXPORT_LIST') {
    const chatId = String(data.chatId || '');
    if (chatId && state.chatId && chatId !== state.chatId) return;
    if (chatId) state.chatId = chatId;
    state.mediaList = Array.isArray(data.mediaList) ? data.mediaList as ScannedMediaIdentity[] : [];
    state.loading = data.mediaListLoading === true;
    return;
  }

  if (data.type === 'TG_PERSONAL_EXPORT_PROGRESS') {
    state.progress = data.progress as AdvancedDownloadProgress;
  }
}

export function dispatchAdvancedDialogMessage(data: Record<string, unknown>): void {
  if (data.mark !== undefined && data.mark !== MARK) return;
  if (!['OPEN_UNIFIED_CHAT_EXPORT_DIALOG', 'TG_UPDATE_MEDIA_EXPORT_LIST', 'TG_PERSONAL_EXPORT_PROGRESS'].includes(String(data.type))) return;
  try {
    if (data.type === 'OPEN_UNIFIED_CHAT_EXPORT_DIALOG') {
      mountDialog();
      applyProtocolMessage(data);
    } else {
      applyProtocolMessage(data);
    }
  } catch (error) {
    reportAdvancedFailure(`message:${String(data.type)}`, error);
  }
}

function mountDialog(): { hostCreated: boolean; appMounted: boolean } {
  let host = document.getElementById('tg-downloader-shadow-host');
  const hostCreated = !host;
  if (!host) {
    host = document.createElement('div');
    host.id = 'tg-downloader-shadow-host';
    host.style.cssText = 'all: initial';
    document.documentElement.append(host);
  }
  host.style.cssText = HOST_STYLE;
  shadowRoot = host.shadowRoot || host.attachShadow({ mode: 'open' });

  if (!shadowRoot.querySelector('style[data-tg-advanced-dialog]')) {
    const style = document.createElement('style');
    style.dataset.tgAdvancedDialog = '1';
    style.textContent = dialogCss;
    shadowRoot.append(style);
  }

  mountPoint = shadowRoot.getElementById('app') as HTMLElement | null || undefined;
  if (!mountPoint) {
    mountPoint = document.createElement('div');
    mountPoint.id = 'app';
    shadowRoot.append(mountPoint);
  }
  mountPoint.style.cssText = APP_STYLE;

  if (app) return { hostCreated, appMounted: false };
  const nextApp = createApp({
    render: () => h(AdvancedDownloadDialog, {
      modelValue: state.modelValue,
      mediaList: state.mediaList,
      chatId: state.chatId,
      chatTitle: state.chatTitle,
      resetToken: state.resetToken,
      loading: state.loading,
      progress: state.progress,
      'onUpdate:modelValue': (value: boolean) => { state.modelValue = value; },
      onStartExport: (options: AdvancedDownloadSelection) => {
        try {
          const message = cloneStructuredMessage({
            mark: MARK,
            type: 'TG_START_CHAT_MEDIA_EXPORT',
            messageId: crypto.randomUUID(),
            chatId: state.chatId,
            options: {
              mediaTypes: [...options.mediaTypes],
              skipDownloaded: options.skipDownloaded,
              selectedKeys: [...options.selectedKeys],
            },
          });
          console.info('[TG Downloader][advanced-submit] event-dispatch', {
            type: message.type, markMatches: message.mark === MARK, selectedCount: options.selectedKeys.length,
            mediaTypes: options.mediaTypes, skipDownloaded: options.skipDownloaded,
          });
          window.postMessage(message, '*');
        } catch (error) {
          console.error(formatErrorLog('[TG Downloader][batch] item-failed', error, { stage: 'event-dispatch' }));
        }
      },
      onRequestFullScan: (request: AdvancedHistoryScanRequest) => {
        try {
          const message = cloneStructuredMessage({
            mark: MARK,
            type: 'TG_LOAD_ALL_MEDIA_REQUEST',
            messageId: crypto.randomUUID(),
            chatId: state.chatId,
            request: {
              selectedKeys: [...request.selectedKeys],
              mediaTypes: [...request.mediaTypes],
              skipDownloaded: request.skipDownloaded,
            },
          });
          state.modelValue = false;
          window.postMessage(message, '*');
        } catch (error) {
          state.modelValue = true;
          console.error(formatErrorLog('[TG Downloader][scan] request failed', error, { stage: 'event-dispatch' }));
        }
      },
    }),
  });
  try {
    nextApp.mount(mountPoint);
    app = nextApp;
    return { hostCreated, appMounted: true };
  } catch (error) {
    try { nextApp.unmount(); } catch { /* preserve original mount error */ }
    mountPoint.replaceChildren();
    app = undefined;
    throw error;
  }
}

async function verifyVisible(): Promise<void> {
  await new Promise<void>((resolve) => window.requestAnimationFrame(() => resolve()));
  const readMetrics = () => {
    if (!shadowRoot) throw new Error('ShadowRoot 尚未创建');
    const overlay = shadowRoot.querySelector('.tg-export-dialog-overlay') as HTMLElement | null;
    if (!overlay) throw new Error('Vue 已挂载，但弹窗根节点 .tg-export-dialog-overlay 不存在');
    const rect = overlay.getBoundingClientRect();
    const style = getComputedStyle(overlay);
    return { overlay, rect, style, metrics: {
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      display: style.display, position: style.position, visibility: style.visibility,
      opacity: style.opacity, animationName: style.animationName,
      pointerEvents: style.pointerEvents, zIndex: style.zIndex,
    } };
  };
  let current = readMetrics();
  if (Number(current.style.opacity) <= 0 && current.style.animationName !== 'none') {
    await new Promise<void>((resolve) => window.setTimeout(resolve, 260));
    current = readMetrics();
  }
  const { overlay, rect, style, metrics } = current;
  console.info('[TG Downloader][advanced] visible', metrics);
  if (!overlay.isConnected || style.display === 'none' || style.position !== 'fixed' || style.visibility === 'hidden' || style.pointerEvents === 'none' || Number(style.opacity) <= 0 || rect.width <= 0 || rect.height <= 0) {
    throw new Error(`弹窗根节点未显示：${JSON.stringify(metrics)}`);
  }
}

export async function openAdvancedDownloadDialog(payload: OpenDialogMessage): Promise<void> {
  console.info('[TG Downloader][advanced] controller dispatch');
  try {
    const mount = mountDialog();
    console.info(`[TG Downloader][advanced] host ${mount.hostCreated ? 'created' : 'reused'}`, {
      hostId: 'tg-downloader-shadow-host',
      shadowRoot: Boolean(shadowRoot),
      mountId: mountPoint?.id || '',
    });
    console.info('[TG Downloader][advanced] vue mounted', { mountedNow: mount.appMounted, appRoot: mountPoint?.id || '' });

    dispatchAdvancedDialogMessage({
      type: 'OPEN_UNIFIED_CHAT_EXPORT_DIALOG',
      chatId: payload.chatId,
      chatTitle: payload.chatTitle,
      context: { peerId: payload.chatId, chatTitle: payload.chatTitle },
      mediaList: [],
      mediaListLoading: true,
      inActiveChat: true,
      mediaGatherScope: 'sidebar-loaded',
    });
    dispatchAdvancedDialogMessage({
      type: 'TG_UPDATE_MEDIA_EXPORT_LIST',
      chatId: payload.chatId,
      mediaList: payload.mediaList,
      mediaListLoading: false,
    });
    await nextTick();
    console.info('[TG Downloader][advanced] show', { chatId: payload.chatId, count: payload.mediaList.length });
    await verifyVisible();
  } catch (error) {
    reportAdvancedFailure('show', error);
    throw error;
  }
}

export function updateAdvancedDownloadProgress(progress: AdvancedDownloadProgress): void {
  if (!shadowRoot) return;
  state.progress = progress;
}

export function updateAdvancedDownloadMediaList(mediaList: ScannedMediaIdentity[]): void {
  if (!shadowRoot) return;
  dispatchAdvancedDialogMessage({ type: 'TG_UPDATE_MEDIA_EXPORT_LIST', chatId: state.chatId, mediaList, mediaListLoading: false });
}

export function setAdvancedDownloadDialogVisible(visible: boolean): void {
  state.modelValue = visible;
}
