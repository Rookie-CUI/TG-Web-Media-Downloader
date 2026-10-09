import { classifyMessage, detectTelegramVersion, getMessageId, messageSelector } from './adapter';
import pageCss from './page-enhancement.css?inline';
import { resolveAndDownloadMedia, resolveSidebarAndDownloadMedia } from './download-flow';
import { LABELS } from '../i18n/labels';
import { getMessageActionHost, hasDirectMessageActions } from './message-action-host';
import { formatError, formatErrorLog } from '../utils/errors';
import type { MediaItem } from '../types';

type Options = {
  openChannelMedia: () => Promise<MediaItem[]>;
  resolve: (messageId: string, force: boolean, preferredUrl?: string) => Promise<MediaItem[]>;
  resolveSidebar: (messageId: string, preferredUrl?: string, onResolvedBeforeViewerClose?: (item: MediaItem) => Promise<void> | void) => Promise<MediaItem[]>;
  startBatch: (month?: Element) => Promise<void> | void;
  download: (item: MediaItem) => Promise<void> | void;
};

const DOWNLOAD_CLASS = 'media-download';
const TEXT = { download: LABELS.download, image: LABELS.downloadImage, video: LABELS.downloadVideo, force: LABELS.forceDownload, month: LABELS.downloadMonth };

function addText(button: HTMLButtonElement, text: string, key: string): void {
  button.innerText = text;
  button.dataset.text = button.innerText;
  button.dataset.i18nKey = key;
}

function stopTelegramClick(event: Event): void {
  event.stopPropagation();
  event.preventDefault();
}

function currentMessageType(message: Element): 'image' | 'video' | 'gif' | null {
  const type = classifyMessage(message);
  return type === 'image' || type === 'gif' || type === 'video' ? type : null;
}

function currentMediaUrl(container: Element): string | undefined {
  const node = container.querySelector('video, img, source') as HTMLMediaElement | HTMLImageElement | null;
  return node?.currentSrc || node?.getAttribute('src') || undefined;
}

function mediaUrlType(value: string): string {
  if (value.startsWith('blob:')) return 'blob';
  if (value.includes('/progressive/')) return 'progressive';
  if (value.includes('/stream/')) return 'stream';
  return 'http';
}

export class TelegramPageEnhancer {
  private items = new Map<string, MediaItem>();

  constructor(private readonly options: Options) {}

  update(items: MediaItem[]): void {
    this.ensurePageStyles();
    for (const item of items) this.items.set(item.url, item);
    this.items = new Map([...this.items.entries()].slice(-500));
    this.installChatHeaderEntry();
    this.installMessageButtons();
    this.installSidebarButtons();
  }

  private ensurePageStyles(): void {
    if (document.getElementById('tg-downloader-styles')) return;
    const style = document.createElement('style');
    style.id = 'tg-downloader-styles';
    style.textContent = pageCss;
    (document.head || document.documentElement).append(style);
  }

  private installChatHeaderEntry(): void {
    const version = detectTelegramVersion();
    const headers = version === 'A' ? Array.from(document.querySelectorAll('.MiddleHeader')) :
      version === 'K' ? [document.querySelector('#column-center .topbar, #column-center .sidebar-header.topbar')].filter(Boolean) as Element[] : [];
    for (const header of headers) {
      const target = version === 'A' ? header.querySelector('.HeaderActions') : (() => {
        const chatInfo = header.querySelector('.chat-info') || document.querySelector('#column-center .chat-info');
        const container = chatInfo?.closest('.chat-info-container');
        return container?.querySelector(':scope > .chat-utils, :scope > .chat-aux') || header.querySelector('.chat-utils, .chat-aux');
      })();
      if (!target || target.querySelector(':scope > .tg-chat-media-export-button-wrapper')) continue;
      const wrapper = document.createElement('div');
      wrapper.className = 'tg-chat-media-export-button-wrapper';
      const button = document.createElement('button');
      button.className = 'tg-chat-media-export-button';
      button.type = 'button';
      button.title = LABELS.openMedia;
      button.setAttribute('aria-label', button.title);
      button.innerHTML = '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M12 16L12 8M12 16L9 13M12 16L15 13" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/><path d="M4 20H20" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><rect x="3" y="3" width="18" height="14" rx="2" stroke="currentColor" stroke-width="2"/></svg>';
      button.addEventListener('click', async (event) => {
        stopTelegramClick(event);
        if (button.dataset.tgExportOpening === '1') return;
        button.dataset.tgExportOpening = '1';
        button.setAttribute('aria-busy', 'true');
        console.info('[TG Downloader][channel-info] header click');
        try { await this.options.openChannelMedia(); }
        catch (error) {
          console.error(formatErrorLog('[TG Downloader][channel-info] open failed', error));
        }
        finally { delete button.dataset.tgExportOpening; button.removeAttribute('aria-busy'); }
      });
      wrapper.append(button);
      target.insertBefore(wrapper, target.firstChild);
    }
  }

  private installMessageButtons(): void {
    const version = detectTelegramVersion();
    for (const message of Array.from(document.querySelectorAll(messageSelector()))) {
      const kind = currentMessageType(message);
      const messageId = getMessageId(message);
      if (!kind || !messageId) continue;
      const wrapper = getMessageActionHost(message, version);
      if (!wrapper) continue;
      // The original Pa()/Go()/Ft() path appends to the complete message content wrapper.
      const container = wrapper;
      if (hasDirectMessageActions(container)) continue;
      const known = [...this.items.values()].filter((item) => item.messageId === messageId && (item.kind === 'image' || item.kind === 'video' || item.kind === 'gif'));
      const mediaCount = container.querySelectorAll('video.full-media, img.full-media, video.media-video, .media-video video, img.media-photo, .media-photo img').length;
      const force = known.length > 1 || mediaCount > 1 || ((kind === 'video' || kind === 'gif') && !container.querySelector('video.full-media, video.media-video, .media-video video'));
      if (version === 'K') this.createKMessageButton(container, messageId, kind, force);
      else this.createAMessageButton(container, messageId, kind, force);
    }
  }

  private createAMessageButton(container: Element, messageId: string, kind: 'image' | 'video' | 'gif', force: boolean): void {
    const action = document.createElement('div');
    action.dataset.tgMediaActions = '1';
    Object.assign(action.style, { display: 'flex', justifyContent: 'space-between' });
    const button = document.createElement('button');
    button.className = DOWNLOAD_CLASS;
    button.type = 'button';
    Object.assign(button.style, { color: '#fff', backgroundColor: force ? '#ff6b6b' : '#1677ff', width: '50%', borderRadius: '5px', border: 'none', margin: '2px auto', cursor: 'pointer' });
    addText(button, force ? TEXT.force : TEXT.download, force ? 'download.buttons.forceDownload' : 'download.buttons.download');
    this.addAlbumCheckboxes(container, '.album-item-select-wrapper');
    button.addEventListener('click', (event) => {
      stopTelegramClick(event);
      void this.downloadMessage(messageId, force, container).catch((error) => console.error(formatErrorLog('[TG Downloader][download] unhandled click rejection', error, { messageId })));
    });
    action.append(button);
    container.append(action);
  }

  private createKMessageButton(container: Element, messageId: string, kind: 'image' | 'video' | 'gif', force: boolean): void {
    const card = document.createElement('div');
    card.className = 'tg-k-download-actions';
    Object.assign(card.style, { maxWidth: '300px', display: 'flex', flexDirection: 'column', justifyContent: 'center', alignItems: 'center', gap: '16px', padding: '24px 20px', backgroundColor: 'rgba(255, 255, 255, .98)', borderRadius: '20px', backdropFilter: 'blur(20px) saturate(180%)', margin: '16px auto', transition: 'all .4s cubic-bezier(.4,0,.2,1)', boxShadow: '0 10px 40px rgba(0,0,0,.1),0 2px 8px rgba(0,0,0,.06)', border: '1px solid rgba(255,255,255,.8)', position: 'relative', overflow: 'hidden' });
    const button = document.createElement('button');
    button.className = DOWNLOAD_CLASS;
    button.type = 'button';
    Object.assign(button.style, { color: '#fff', background: force ? 'linear-gradient(135deg,#ff6b6b,#ee5a24)' : 'linear-gradient(135deg,#667eea,#764ba2)', minWidth: '140px', height: '44px', borderRadius: '12px', border: 'none', padding: '0 20px', fontSize: '13px', fontWeight: '600', cursor: 'pointer', textTransform: 'uppercase', letterSpacing: '.5px' });
    addText(button, force ? TEXT.force : kind === 'image' ? TEXT.image : TEXT.video, force ? 'download.buttons.forceDownload' : kind === 'image' ? 'download.buttons.downloadImage' : 'download.buttons.downloadVideo');
    this.addAlbumCheckboxes(container, '.album-item');
    button.addEventListener('click', (event) => {
      stopTelegramClick(event);
      void this.downloadMessage(messageId, force, container).catch((error) => console.error(formatErrorLog('[TG Downloader][download] unhandled click rejection', error, { messageId })));
    });
    card.append(button);
    container.append(card);
  }

  private addAlbumCheckboxes(container: Element, selector: string): void {
    container.querySelectorAll(selector).forEach((group) => {
      const media = group.querySelector('video.full-media, img.full-media, video.media-video, .media-video video, img.media-photo, .media-photo img');
      if (!media || group.querySelector('input.download-item')) return;
      const input = document.createElement('input');
      input.type = 'checkbox';
      input.className = 'download-item';
      input.name = 'downloadItem';
      input.checked = true;
      input.dataset.mediaUrl = (media as HTMLMediaElement).currentSrc || media.getAttribute('src') || '';
      group.classList.add('download-checkbox-group');
      group.append(input);
    });
  }

  private async downloadMessage(messageId: string, force: boolean, container: Element, sidebar = false): Promise<void> {
    const button = container.querySelector<HTMLButtonElement>(':scope > .media-download, :scope > .tg-k-download-actions .media-download, :scope > [data-tg-media-actions="1"] .media-download');
    if (button?.dataset.tgDownloadActive === '1') return;
    if (button) { button.dataset.tgDownloadActive = '1'; button.disabled = true; }
    try {
      if (sidebar) console.info('[TG Downloader][media-item] click', { messageId });
      console.info(force ? '[TG Downloader][force] click' : '[TG Downloader][download] click', { messageId });
      const checkboxes = Array.from(container.querySelectorAll<HTMLInputElement>('.download-item'));
      const chosenUrls = checkboxes.length ? new Set(checkboxes.filter((input) => input.checked).map((input) => input.dataset.mediaUrl || '')) : undefined;
      const chosen = sidebar
        ? await resolveSidebarAndDownloadMedia(this.options.resolveSidebar, this.options.download, messageId, currentMediaUrl(container))
        : await resolveAndDownloadMedia(this.options.resolve, this.options.download, messageId, force, undefined,
          chosenUrls ? (items) => items.filter((item) => chosenUrls.has(item.url) || chosenUrls.has((item as MediaItem & { sourceUrl?: string }).sourceUrl || '')) : undefined);
      if (sidebar) console.info('[TG Downloader][media-item] MediaItem', chosen.map((item) => ({
        messageId: item.messageId, kind: item.kind, urlType: mediaUrlType(item.url),
        objectUrlKind: item.objectUrlKind || 'n/a', mime: item.mimeType, size: item.size,
      })));
      const loggedItems = sidebar ? chosen.map((item) => ({
        messageId: item.messageId, kind: item.kind, urlType: mediaUrlType(item.url),
        objectUrlKind: item.objectUrlKind || 'n/a', mime: item.mimeType, size: item.size,
        nativeDownloadStarted: item.nativeDownloadStarted === true,
      })) : chosen;
      console.info(force ? '[TG Downloader][force] items' : '[TG Downloader][download] items', loggedItems);
    } catch (error) {
      const details = formatError(error);
      if (sidebar && /NO_MEDIA_URL/.test(details.message)) console.error(`[TG Downloader][media-item] NO_MEDIA_URL messageId=${messageId} stage=sidebar-resolve`);
      console.error(formatErrorLog(force ? '[TG Downloader][force] failed' : '[TG Downloader][download] failed', error, {
        messageId, stage: sidebar ? 'sidebar-resolve-or-download' : 'message-resolve-or-download',
      }));
      if (button) {
        button.textContent = LABELS.downloadFailed;
        button.dataset.tgDownloadFailed = '1';
        window.setTimeout(() => {
          delete button.dataset.tgDownloadFailed;
          button.textContent = button.dataset.text || LABELS.download;
        }, 2400);
      }
    } finally {
      if (button) { delete button.dataset.tgDownloadActive; button.disabled = false; }
    }
  }

  private installSidebarButtons(): void {
    if (detectTelegramVersion() === 'K') this.installKSidebarButtons();
    if (detectTelegramVersion() === 'A') this.installASidebarButtons();
  }

  private installKSidebarButtons(): void {
    const mediaPanel = document.querySelector('#column-right .search-super-container-media.active');
    const root = document.querySelector('#column-right .search-super');
    if (!mediaPanel || !root) return;
    this.addAllMediaButton(root, 'K');
    mediaPanel.querySelectorAll('.search-super-month').forEach((month) => {
      const label = month.querySelector('.search-super-month-name');
      if (!label || label.querySelector('.download-selected-month_items')) return;
      const button = document.createElement('button');
      button.className = 'download-selected-month_items downloader-click-single-btn media-download';
      addText(button, TEXT.month, 'download.buttons.downloadMonth');
      (label as HTMLElement).style.display = 'flex';
      label.append(button);
      button.addEventListener('click', async (event) => {
        stopTelegramClick(event);
        if (button.dataset.tgDownloadActive === '1') return;
        button.dataset.tgDownloadActive = '1';
        button.disabled = true;
        try { await this.options.startBatch(month); }
        catch (error) { console.error(formatErrorLog('[TG Downloader][batch] month click failed', error)); }
        finally { delete button.dataset.tgDownloadActive; button.disabled = false; }
      });
    });
    mediaPanel.querySelectorAll('.media-container[data-mid]').forEach((container) => {
      if (container.querySelector('.download-selected-item')) return;
      const button = document.createElement('button');
      button.className = 'download-selected-item downloader-click-single-btn media-download';
      addText(button, TEXT.download, 'download.buttons.download');
      container.append(button);
      button.addEventListener('click', (event) => {
        stopTelegramClick(event);
        const mid = container.getAttribute('data-mid') || '';
        void this.downloadMessage(mid, true, container, true).catch((error) => console.error(formatErrorLog('[TG Downloader][media-item] unhandled click rejection', error, { messageId: mid })));
      });
    });
  }

  private installASidebarButtons(): void {
    const root = document.querySelector('#RightColumn');
    if (!root) return;
    const activeTab = root.querySelector('#RightColumn .RightHeader .title, [role="tab"][aria-selected="true"], .shared-media .TabList .Tab--active .Tab_inner, .shared-media-tabs .TabList [aria-hidden="true"]');
    const activeName = activeTab?.textContent?.trim() || '';
    if (activeName && !/(^|\b)(media|shared media|媒体|媒體)(\b|$)/i.test(activeName)) return;
    const entries = Array.from(root.querySelectorAll('.Media.scroll-item, [id^="shared-mediamessage-"]'));
    if (!entries.length) return;
    this.addAllMediaButton(root, 'A');
    for (const entry of entries) {
      if (entry.querySelector('.download-selected-item')) continue;
      const button = document.createElement('button');
      button.className = 'download-selected-item downloader-click-single-btn media-download';
      addText(button, TEXT.download, 'download.buttons.download');
      if (getComputedStyle(entry).position === 'static') (entry as HTMLElement).style.position = 'relative';
      entry.append(button);
      button.addEventListener('click', (event) => {
        stopTelegramClick(event);
        const mid = entry.getAttribute('data-message-id') || entry.getAttribute('id')?.replace(/^shared-mediamessage-?/, '') || '';
        void this.downloadMessage(mid, true, entry, true).catch((error) => console.error(formatErrorLog('[TG Downloader][media-item] unhandled click rejection', error, { messageId: mid })));
      });
    }
  }

  private addAllMediaButton(root: Element, version: 'A' | 'K'): void {
    const existing = root.querySelector('.download-click-div.tgMedia .download-all-media');
    if (existing) {
      this.bindAllMediaButton(existing as HTMLButtonElement);
      return;
    }
    const control = document.createElement('div');
    control.className = version === 'A' ? 'download-click-div tg-downloader-sidebar-controls tgMedia' : 'download-click-div tgMedia';
    Object.assign(control.style, { top: version === 'A' ? '0' : '80px', margin: version === 'A' ? '8px 12px' : '0', zIndex: '10', position: version === 'A' ? 'sticky' : 'relative', display: 'flex', flexDirection: 'row', alignItems: 'center', gap: '10px' });
    const button = document.createElement('button');
    button.className = 'download-all-media downloader-click-single-btn media-download';
    button.type = 'button';
    button.textContent = LABELS.advancedDownload;
    const progress = document.createElement('div');
    progress.id = 'tg-all-media-download';
    progress.className = 'downloadProgress';
    const label = document.createElement('span');
    label.textContent = LABELS.progress;
    const value = document.createElement('span');
    value.className = 'media-download';
    value.textContent = '—';
    progress.append(label, value);
    control.append(button, progress);
    root.prepend(control);
    this.bindAllMediaButton(button);
  }

  private bindAllMediaButton(button: HTMLButtonElement): void {
    if (button.dataset.tgLocalExportBound === '1') return;
    button.dataset.tgLocalExportBound = '1';
    button.addEventListener('click', async (event) => {
      stopTelegramClick(event);
      if (button.dataset.tgDownloadActive === '1') return;
      button.dataset.tgDownloadActive = '1';
      button.disabled = true;
      const host = document.getElementById('tg-downloader-shadow-host');
      const shadowRoot = host?.shadowRoot;
      console.info('[TG Downloader][advanced] click', {
        hostExists: Boolean(host),
        shadowRoot: Boolean(shadowRoot),
        appExists: Boolean(shadowRoot?.getElementById('app')),
        dialogExists: Boolean(shadowRoot?.querySelector('.tg-export-dialog-overlay')),
      });
      try {
        await this.options.startBatch();
      } catch (error) {
        console.error(formatErrorLog('[TG Downloader][advanced] failed', error));
        button.textContent = LABELS.openFailed;
        window.setTimeout(() => { button.textContent = LABELS.advancedDownload; }, 2400);
      } finally {
        delete button.dataset.tgDownloadActive;
        button.disabled = false;
      }
    });
  }

  setBatchProgress(message: string): void {
    const label = document.querySelector('#tg-all-media-download .media-download');
    if (label) label.textContent = message;
  }
}
