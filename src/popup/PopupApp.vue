<script setup lang="ts">
import { ref } from 'vue';
import { formatError } from '../utils/errors';

const message = ref('');
const openSidePanel = async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id || !tab.url?.startsWith('https://web.telegram.org/')) {
    message.value = '请先打开 Telegram Web。';
    return;
  }
  try {
    await chrome.sidePanel.open({ tabId: tab.id });
    window.close();
  } catch (error) {
    message.value = `Side Panel 打开失败：${formatError(error).message}`;
  }
};
</script>

<template><main class="shell popup-shell"><strong>Telegram 媒体测试</strong><p>在当前聊天扫描已加载媒体并批量下载。</p><button class="primary" @click="openSidePanel">打开 Side Panel</button><p v-if="message" class="notice">{{ message }}</p></main></template>
