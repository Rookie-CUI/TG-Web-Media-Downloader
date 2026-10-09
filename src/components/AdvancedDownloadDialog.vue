<script setup lang="ts">
import { computed, ref, watch } from 'vue';
import { LABELS } from '../i18n/labels';
import { formatErrorLog } from '../utils/errors';
import type { AdvancedDownloadProgress, AdvancedDownloadSelection } from '../types/advanced-download';
import type { AdvancedHistoryScanRequest, ScannedMediaIdentity } from '../types/scanned-media';

const props = withDefaults(defineProps<{
  modelValue: boolean;
  mediaList: ScannedMediaIdentity[];
  chatId: string;
  chatTitle: string;
  resetToken: number;
  loading?: boolean;
  progress?: AdvancedDownloadProgress;
}>(), {
  loading: false,
  progress: () => ({ completed: 0, total: 0, status: 'idle' }),
});

const emit = defineEmits<{
  'update:modelValue': [value: boolean];
  startExport: [selection: AdvancedDownloadSelection];
  requestFullScan: [request: AdvancedHistoryScanRequest];
}>();

const activeTab = ref<'history' | 'media'>('media');
const selectedTypes = ref(new Set<'image' | 'video' | 'gif'>(['image', 'video', 'gif']));
const skipDownloaded = ref(false);
const selectedStableKeys = ref(new Set<string>());
const typeDefinitions = [
  { kind: 'image', label: LABELS.image, icon: '🖼', color: '#3390ec' },
  { kind: 'video', label: LABELS.video, icon: '🎬', color: '#ec4899' },
  { kind: 'gif', label: LABELS.gif, icon: '✨', color: '#f59e0b' },
] as const;

const typedItems = computed(() => props.mediaList.filter((item) => selectedTypes.value.has(item.kind)));
const eligibleItems = computed(() => typedItems.value.filter((item) => !skipDownloaded.value || !item.hasDownloaded));
const selectedItems = computed(() => eligibleItems.value.filter((item) => selectedStableKeys.value.has(item.stableKey)));
const counts = computed(() => ({
  image: props.mediaList.filter((item) => item.kind === 'image').length,
  video: props.mediaList.filter((item) => item.kind === 'video').length,
  gif: props.mediaList.filter((item) => item.kind === 'gif').length,
}));
const title = computed(() => props.chatTitle || props.chatId || LABELS.telegram);
const buttonLabel = computed(() => LABELS.downloadCount.replace('{count}', String(selectedItems.value.length)));
const isBusy = computed(() => props.loading || props.progress?.status === 'scanning' || props.progress?.status === 'downloading');

watch(() => props.resetToken, () => {
  activeTab.value = 'media';
  selectedTypes.value = new Set(['image', 'video', 'gif']);
  skipDownloaded.value = false;
  selectedStableKeys.value = new Set(props.mediaList.map((item) => item.stableKey));
}, { immediate: true });

function toggleType(kind: 'image' | 'video' | 'gif'): void {
  const next = new Set(selectedTypes.value);
  if (next.has(kind)) next.delete(kind);
  else next.add(kind);
  selectedTypes.value = next;
}

function toggleItem(item: ScannedMediaIdentity): void {
  if (skipDownloaded.value && item.hasDownloaded) return;
  const next = new Set(selectedStableKeys.value);
  if (next.has(item.stableKey)) next.delete(item.stableKey);
  else next.add(item.stableKey);
  selectedStableKeys.value = next;
}

function selectAll(): void {
  const next = new Set(selectedStableKeys.value);
  for (const item of eligibleItems.value) next.add(item.stableKey);
  selectedStableKeys.value = next;
}

function clearAll(): void {
  const next = new Set(selectedStableKeys.value);
  for (const item of typedItems.value) next.delete(item.stableKey);
  selectedStableKeys.value = next;
}

function close(): void {
  if (isBusy.value) return;
  emit('update:modelValue', false);
}

function requestFullScan(): void {
  if (isBusy.value) return;
  try {
    emit('requestFullScan', {
      selectedKeys: [...selectedStableKeys.value],
      mediaTypes: [...selectedTypes.value],
      skipDownloaded: skipDownloaded.value,
    });
  } catch (error) {
    console.error(formatErrorLog('[TG Downloader][scan] request failed', error, { stage: 'event-dispatch' }));
  }
}

function startDownload(): void {
  if (isBusy.value || !selectedItems.value.length) return;
  const selection: AdvancedDownloadSelection = {
    mediaTypes: [...selectedTypes.value],
    skipDownloaded: skipDownloaded.value,
    selectedKeys: selectedItems.value.map((item) => item.stableKey),
  };
  console.info('[TG Downloader][advanced-submit] click', {
    selectedCount: selection.selectedKeys.length,
    mediaTypes: selection.mediaTypes,
    skipDownloaded: selection.skipDownloaded,
  });
  try {
    emit('startExport', selection);
  } catch (error) {
    console.error(formatErrorLog('[TG Downloader][batch] item-failed', error, { stage: 'event-dispatch' }));
  }
}

function mediaKindLabel(kind: ScannedMediaIdentity['kind']): string {
  return typeDefinitions.find((entry) => entry.kind === kind)?.label || kind;
}

function dateLabel(item: ScannedMediaIdentity): string {
  if (item.monthGroup) return item.monthGroup;
  if (item.dateTimestamp) return new Date(item.dateTimestamp).toLocaleDateString();
  return '日期未知';
}
</script>

<template>
  <div v-if="modelValue" class="tg-export-dialog-overlay tg-cme-export-overlay" @click.self="close">
    <section class="tg-cme-dialog" :class="{ 'is-exporting': isBusy }" role="dialog" aria-modal="true" aria-labelledby="tg-cme-title">
      <header class="tg-cme-header">
        <div class="tg-cme-header-text">
          <h3 id="tg-cme-title">{{ LABELS.dialogTitle }}</h3>
          <p>{{ LABELS.dialogSubtitle }}</p>
        </div>
        <button class="tg-cme-close" type="button" :aria-label="LABELS.close" :disabled="isBusy" @click="close">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M18 6L6 18M6 6l12 12" stroke="currentColor" stroke-width="2" stroke-linecap="round" /></svg>
        </button>
      </header>

      <nav class="tg-cme-tabs" role="tablist">
        <button class="tg-cme-tab" :class="{ active: activeTab === 'history' }" type="button" role="tab" :aria-selected="activeTab === 'history'" @click="activeTab = 'history'">
          <span class="tg-cme-tab-icon" aria-hidden="true">📄</span>
          <span class="tg-cme-tab-text"><strong>{{ LABELS.historyTab }}</strong><small>{{ LABELS.historyHint }}</small></span>
        </button>
        <button class="tg-cme-tab" :class="{ active: activeTab === 'media' }" type="button" role="tab" :aria-selected="activeTab === 'media'" @click="activeTab = 'media'">
          <span class="tg-cme-tab-icon" aria-hidden="true">🖼</span>
          <span class="tg-cme-tab-text"><strong>{{ LABELS.mediaTab }}</strong><small>{{ LABELS.mediaHint }}</small></span>
        </button>
      </nav>

      <div class="tg-cme-body">
        <section class="tg-cme-hero tg-cme-hero-compact">
          <div class="tg-cme-hero-icon" aria-hidden="true">💬</div>
          <div class="tg-cme-hero-info">
            <span class="tg-cme-hero-label">{{ LABELS.chatLabel }}</span>
            <strong class="tg-cme-hero-title">{{ title }}</strong>
            <span class="tg-cme-hero-stats">{{ counts.image }} {{ LABELS.image }} · {{ counts.video }} {{ LABELS.video }} · {{ counts.gif }} {{ LABELS.gif }} · {{ props.mediaList.length }} {{ LABELS.mediaCount }}</span>
          </div>
        </section>

        <div v-if="activeTab === 'history'" class="tg-cme-empty">
          <div class="tg-cme-empty-icon" aria-hidden="true">ℹ️</div>
          <p>{{ LABELS.historyUnavailable }}</p>
        </div>

        <template v-else>
          <div class="tg-cme-selection-head">
            <strong>已选择 {{ selectedItems.length }} / {{ typedItems.length }}</strong>
            <div class="tg-cme-selection-actions">
              <button class="tg-cme-text-btn" type="button" :disabled="isBusy || !eligibleItems.length" @click="selectAll">全选</button>
              <button class="tg-cme-text-btn" type="button" :disabled="isBusy || !selectedItems.length" @click="clearAll">取消全选</button>
              <button class="tg-cme-text-btn" type="button" :disabled="isBusy" @click="requestFullScan">加载完整历史媒体</button>
            </div>
          </div>

          <section class="tg-cme-section">
            <h4 class="tg-cme-section-title">媒体类型</h4>
            <div class="tg-cme-type-grid">
              <button v-for="definition in typeDefinitions" :key="definition.kind" class="tg-cme-type-card" :class="{ active: selectedTypes.has(definition.kind), disabled: counts[definition.kind] === 0 }" :style="{ '--accent': definition.color }" type="button" :aria-pressed="selectedTypes.has(definition.kind)" :disabled="counts[definition.kind] === 0 || isBusy" @click="toggleType(definition.kind)">
                <span class="tg-cme-type-icon" aria-hidden="true">{{ definition.icon }}</span>
                <span class="tg-cme-type-name">{{ definition.label }}</span>
                <span class="tg-cme-type-count">{{ counts[definition.kind] }}</span>
              </button>
            </div>
          </section>

          <section class="tg-cme-section tg-cme-toggles">
            <label class="tg-cme-toggle-row">
              <input v-model="skipDownloaded" type="checkbox" :disabled="isBusy">
              <span class="tg-cme-toggle-label"><strong>{{ LABELS.skipDownloaded }}</strong><small>{{ LABELS.skipDownloadedHint }}</small></span>
              <span class="tg-cme-toggle-track"><span class="tg-cme-toggle-thumb" /></span>
            </label>
          </section>

          <div v-if="progress?.status === 'scanning'" class="tg-cme-scanning" role="status">
            <div class="tg-cme-wait-panel"><span class="tg-cme-spinner" /><p class="tg-cme-progress-status">{{ progress.statusText || LABELS.scanning }}</p></div>
          </div>
          <p v-else-if="progress?.statusText" class="tg-cme-scan-result" role="status">{{ progress.statusText }}</p>

          <section class="tg-cme-media-list" aria-label="媒体列表">
            <article v-for="item in typedItems" :key="item.stableKey" class="tg-cme-media-row" :class="{ 'is-downloaded': item.hasDownloaded && skipDownloaded }">
              <input class="tg-cme-media-check" type="checkbox" :checked="selectedStableKeys.has(item.stableKey) && !(skipDownloaded && item.hasDownloaded)" :disabled="isBusy || (skipDownloaded && Boolean(item.hasDownloaded))" :aria-label="`选择 ${item.messageId}`" @change="toggleItem(item)">
              <div class="tg-cme-media-thumb">
                <img v-if="item.thumbnail" :src="item.thumbnail" alt="" @error="($event.target as HTMLImageElement).style.display = 'none'">
                <span v-else aria-hidden="true">{{ item.kind === 'image' ? '🖼' : '🎬' }}</span>
              </div>
              <div class="tg-cme-media-meta">
                <div class="tg-cme-media-primary"><strong>{{ mediaKindLabel(item.kind) }}</strong><span v-if="item.duration">{{ item.duration }}</span><span v-if="item.hasDownloaded" class="tg-cme-downloaded-badge">已下载</span></div>
                <div class="tg-cme-media-secondary"><span>{{ dateLabel(item) }}</span><span>消息 {{ item.messageId }}</span></div>
                <code>{{ item.stableKey }}</code>
              </div>
            </article>
            <div v-if="!typedItems.length" class="tg-cme-empty"><p>{{ LABELS.noMedia }}</p></div>
          </section>

          <section v-if="progress?.status === 'downloading' || progress?.status === 'completed' || progress?.status === 'failed'" class="tg-cme-progress-view" role="status">
            <div class="tg-cme-progress-status">{{ progress.error || progress.statusText || (progress.status === 'completed' ? LABELS.completed : LABELS.downloading) }}</div>
            <div v-if="progress.successCount !== undefined || progress.failedCount !== undefined" class="tg-cme-progress-status">
              {{ LABELS.batchSuccess }} {{ progress.successCount || 0 }} · {{ LABELS.batchFailed }} {{ progress.failedCount || 0 }}
            </div>
            <div v-if="progress.status !== 'failed'" class="tg-cme-progress-card">
              <div class="tg-cme-progress-card-head"><span class="tg-cme-item-name">{{ progress.currentFile || LABELS.downloading }}</span><span class="tg-cme-pct">{{ progress.completed }}/{{ progress.total }}</span></div>
              <div class="tg-cme-bar"><div class="tg-cme-bar-fill" :style="{ transform: `scaleX(${progress.total ? progress.completed / progress.total : 0})` }" /></div>
            </div>
          </section>
        </template>
      </div>

      <footer class="tg-cme-footer">
        <button class="tg-cme-btn tg-cme-btn-ghost" type="button" :disabled="isBusy" @click="close">{{ LABELS.cancel }}</button>
        <button v-if="activeTab === 'media'" class="tg-cme-btn tg-cme-btn-primary" type="button" :disabled="isBusy || !selectedItems.length" @click="startDownload">{{ buttonLabel }}</button>
      </footer>
    </section>
  </div>
</template>
