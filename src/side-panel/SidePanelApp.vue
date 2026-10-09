<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import MediaRow from '../components/MediaRow.vue';
import { exportMediaManifest } from '../exporter/chat-export';
import { formatError, formatErrorLog } from '../utils/errors';
import { cloneStructuredMessage } from '../utils/structured-clone';
import type { DownloadTask, MediaItem } from '../types';

const activeTab = ref<number | undefined>();
const activeUrl = ref('');
const media = ref<MediaItem[]>([]);
const tasks = ref<DownloadTask[]>([]);
const selected = ref<string[]>([]);
const view = ref<'media' | 'chat' | 'history'>('media');
const message = ref('');
let timer = 0;
let contextInvalid = false;

const isInvalidContext = (error: unknown) => /extension context invalidated|context invalidated|extension context.*invalid/i.test(formatError(error).message);
const stopForInvalidContext = (error: unknown) => {
  if (contextInvalid) return;
  contextInvalid = true;
  window.clearInterval(timer);
  message.value = '扩展已重新加载。请刷新 Telegram 页面后重新打开侧栏。';
  const details = formatError(error);
  console.warn(`[TG Downloader][runtime] Extension context invalidated; stopped Side Panel polling: name=${details.name} message=${details.message} code=${details.code || 'n/a'}`);
};
const runAction = async (name: string, action: () => Promise<void>) => {
  try { await action(); }
  catch (error) {
    if (isInvalidContext(error)) stopForInvalidContext(error);
    else {
      const details = formatError(error);
      message.value = `${name}失败：${details.message}`;
      console.warn(formatErrorLog(`[TG Downloader][runtime] ${name} failed`, error));
    }
  }
};

const load = async () => {
  if (contextInvalid) return;
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    activeTab.value = tab?.id;
    activeUrl.value = tab?.url || '';
    if (!activeUrl.value.startsWith('https://web.telegram.org/')) {
      message.value = '请在 Telegram Web 标签页打开侧栏。';
      media.value = [];
      return;
    }
    message.value = '';
    const state = await chrome.runtime.sendMessage(cloneStructuredMessage({ type: 'GET_STATE', tabId: tab.id }));
    media.value = state?.media ?? [];
    tasks.value = state?.tasks ?? [];
  } catch (error) {
    if (isInvalidContext(error)) stopForInvalidContext(error);
    else {
      const details = formatError(error);
      message.value = `读取任务状态失败：${details.message}`;
      console.warn(formatErrorLog('[TG Downloader][runtime] Side Panel load failed', error));
    }
  }
};

onMounted(() => { void load(); timer = window.setInterval(() => { void load(); }, 1400); });
onUnmounted(() => window.clearInterval(timer));

const selectedItems = computed(() => media.value.filter((item) => selected.value.includes(item.url)));
const toggle = (url: string) => { selected.value = selected.value.includes(url) ? selected.value.filter((item) => item !== url) : [...selected.value, url]; };
const scanChat = async () => {
  await runAction('扫描聊天媒体', async () => {
    if (activeTab.value === undefined) return;
    const result = await chrome.runtime.sendMessage(cloneStructuredMessage({ type: 'SCAN_MEDIA', tabId: activeTab.value }));
    media.value = result?.items ?? media.value;
    view.value = 'chat';
    selected.value = media.value.map((item) => item.url);
  });
};
const download = async (item: MediaItem) => {
  await runAction('提交下载任务', async () => {
    if (activeTab.value !== undefined) await chrome.runtime.sendMessage(cloneStructuredMessage({ type: 'START_DOWNLOAD', tabId: activeTab.value, media: item }));
    view.value = 'history';
  });
};
const batchDownload = async () => {
  for (const item of selectedItems.value) await download(item);
  selected.value = [];
};
const exportList = () => exportMediaManifest(selectedItems.value, activeUrl.value);
const taskAction = async (task: DownloadTask) => {
  await runAction('更新下载任务', async () => {
    const type = task.status === 'paused' ? 'RESUME_TASK' : 'PAUSE_TASK';
    const tabId = task.tabId ?? activeTab.value;
    if (tabId !== undefined) await chrome.runtime.sendMessage(cloneStructuredMessage({ type, tabId, taskId: task.id }));
    await load();
  });
};
const retry = async (task: DownloadTask) => {
  await runAction('重试下载', async () => {
    const state = await chrome.runtime.sendMessage(cloneStructuredMessage({ type: 'GET_STATE', tabId: task.tabId ?? activeTab.value }));
    const item = (state?.media ?? media.value).find((candidate: MediaItem) => candidate.id === task.mediaId);
    if (item) await download(item);
    else message.value = '该媒体已不在当前页面列表中，请在聊天中重新扫描。';
  });
};
const openOptions = () => { void runAction('打开设置', async () => { await chrome.runtime.openOptionsPage(); }); };
</script>

<template>
  <main class="shell side-shell">
    <header><div><strong>Telegram 媒体测试</strong><small>当前会话 · 本地运行</small></div><button class="icon" title="设置" @click="openOptions">⚙</button></header>
    <nav>
      <button :class="{ active: view === 'media' }" @click="view = 'media'">媒体</button>
      <button :class="{ active: view === 'chat' }" @click="scanChat">扫描当前聊天</button>
      <button :class="{ active: view === 'history' }" @click="view = 'history'">任务</button>
    </nav>
    <p v-if="message" class="notice">{{ message }}</p>
    <section v-if="view !== 'history'">
      <div class="toolbar"><span>{{ media.length }} 项 · 仅限当前页面已加载内容</span>
        <div class="actions"><button :disabled="!selected.length" @click="exportList">导出清单</button><button class="primary" :disabled="!selected.length" @click="batchDownload">下载选中 ({{ selected.length }})</button></div>
      </div>
      <div v-if="!media.length && !message" class="empty">滚动或打开当前聊天中的媒体后，点击“扫描当前聊天”。</div>
      <MediaRow v-for="item in media" :key="item.url" :item="item" :checked="selected.includes(item.url)" @toggle="toggle" @download="download" />
    </section>
    <section v-else>
      <div class="toolbar"><span>{{ tasks.length }} 条任务/历史</span><button @click="load">刷新</button></div>
      <div v-if="!tasks.length" class="empty">尚无下载任务。</div>
      <article v-for="task in tasks" :key="task.id" class="task-row">
        <div class="row-copy"><strong>{{ task.filename }}</strong><small>{{ task.status }}<template v-if="task.error"> · {{ task.error }}</template></small><progress max="100" :value="task.progress"></progress></div>
        <span class="percent">{{ task.progress }}%</span>
        <button v-if="['downloading', 'resolving'].includes(task.status)" @click="taskAction(task)">暂停</button>
        <button v-else-if="task.status === 'paused'" @click="taskAction(task)">继续</button>
        <button v-else-if="task.status === 'failed'" @click="retry(task)">重试</button>
      </article>
    </section>
    <footer>批量导出仅扫描 Telegram 当前 DOM 中已加载并可访问的媒体，不读取未加载聊天记录。</footer>
  </main>
</template>
