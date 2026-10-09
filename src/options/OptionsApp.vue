<script setup lang="ts">
import { onMounted, reactive, ref } from 'vue';
import { defaultSettings, type AppSettings } from '../types';
import { getSettings, saveSettings } from '../storage/local';

const settings = reactive<AppSettings>({ ...defaultSettings });
const saved = ref(false);
onMounted(async () => Object.assign(settings, await getSettings()));
const save = async () => { await saveSettings({ ...settings }); saved.value = true; setTimeout(() => (saved.value = false), 1800); };
</script>

<template>
  <main class="settings-shell"><h1>下载设置</h1><p>仅在本机保存下载设置、任务与历史。</p>
    <label>分片大小（MB） <input v-model.number="settings.chunkSizeMb" type="number" min="1" max="8" /></label>
    <label>失败重试次数 <input v-model.number="settings.maxRetries" type="number" min="0" max="10" /></label>
    <label class="check"><input v-model="settings.captureImages" type="checkbox" /> 捕获当前页面已加载的图片</label>
    <label class="check"><input v-model="settings.captureFiles" type="checkbox" /> 捕获当前页面可见的文件链接</label>
    <button class="primary" @click="save">保存设置</button><span v-if="saved" class="success">已保存</span>
  </main>
</template>
