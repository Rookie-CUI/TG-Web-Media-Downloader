<script setup lang="ts">
import type { MediaItem } from '../types';

defineProps<{ item: MediaItem; checked: boolean }>();
defineEmits<{ toggle: [url: string]; download: [item: MediaItem] }>();
</script>

<template>
  <article class="media-row">
    <input type="checkbox" :checked="checked" @change="$emit('toggle', item.url)" />
    <div class="row-copy">
      <strong>{{ item.filename }}</strong>
      <small>{{ item.kind }} · {{ item.size ? (item.size / 1048576).toFixed(1) + ' MB' : '大小未知' }}<template v-if="item.messageId"> · 消息 {{ item.messageId }}</template></small>
    </div>
    <button class="primary" @click="$emit('download', item)">下载</button>
  </article>
</template>
