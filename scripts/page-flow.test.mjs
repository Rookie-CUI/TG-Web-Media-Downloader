import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { fileURLToPath } from 'node:url';

const read = (path) => readFile(fileURLToPath(new URL(path, import.meta.url)), 'utf8');

async function loadFlow() {
  const source = await read('../src/telegram/download-flow.ts');
  const compiled = ts.transpile(source, { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 });
  const exports = {};
  const context = vm.createContext({ module: { exports }, exports, require() { throw new Error('Unexpected import'); } });
  vm.runInContext(`(function(exports, require, module) { ${compiled}\n})(exports, require, module);`, context);
  return context.module.exports;
}

async function loadStandaloneTypeScript(path) {
  const source = await read(path);
  const compiled = ts.transpile(source, { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 });
  const exports = {};
  const context = vm.createContext({ module: { exports }, exports, URL });
  vm.runInContext(`(function(exports, module) { ${compiled}\n})(exports, module);`, context);
  return context.module.exports;
}

const item = (url, messageId = 'mid-1') => ({
  id: `${messageId}:${url}`, url, filename: 'media.bin', mimeType: 'application/octet-stream', size: 1,
  kind: 'video', messageId, peerId: 'peer-1', fileId: '', source: 'dom', capturedAt: 1,
});

test('页面解析层不导入 Downloader，content 仅有一个 Downloader.start 出口', async () => {
  const resolver = await read('../src/telegram/original-media-resolver.ts');
  const content = await read('../src/content/index.ts');
  // Container inspection is pure validation; only the task-running Downloader is forbidden here.
  assert.doesNotMatch(resolver, /from ['"]\.\.\/downloader(?:\/downloader)?['"]/);
  assert.doesNotMatch(resolver, /\.start\s*\(/);
  assert.equal((content.match(/downloader\.start\s*\(/g) || []).length, 1);
  assert.match(content, /async function downloadItem\(item: MediaItem\)/);
  assert.doesNotMatch(content, /installShadowApp|TGDownloaderShadowDOM\.show/);
});

test('普通 Download 解析一个 MediaItem 后只提交一次', async () => {
  const { resolveAndDownloadMedia } = await loadFlow();
  const calls = [];
  const downloaded = await resolveAndDownloadMedia(async () => [item('https://cdn.telegram.org/a')], async (media) => calls.push(media), 'mid-1', false);
  assert.equal(downloaded.length, 1);
  assert.equal(calls.length, 1);
});

test('FORCE 结果重复时按 messageId 与 URL 去重后提交', async () => {
  const { resolveAndDownloadMedia } = await loadFlow();
  const calls = [];
  const media = item('blob:https://web.telegram.org/video');
  await resolveAndDownloadMedia(async (_mid, force) => { assert.equal(force, true); return [media, { ...media }]; }, async (entry) => calls.push(entry), 'mid-1', true);
  assert.equal(calls.length, 1);
});

test('K Media 扫描按 data-mid、peer 和 media 节点字段解析，并含原版容器 selector', async () => {
  const source = await read('../src/telegram/original-media-resolver.ts');
  assert.match(source, /\.search-super-container-media\.active \.media-container\[data-mid\]/);
  assert.match(source, /getAttribute\('data-mid'\)/);
  assert.match(source, /getAttribute\('data-peer-id'\)/);
  assert.match(source, /img\.media-photo|video\.media-video/);
  assert.match(source, /closest\('\.search-super-month'\)/);
});

test('批量任务跳过重复 messageId/url，但保留同消息不同媒体地址', async () => {
  const { downloadBatchMedia } = await loadFlow();
  const downloads = [];
  const media = [item('https://cdn.telegram.org/a'), item('https://cdn.telegram.org/a'), item('https://cdn.telegram.org/b')];
  const result = await downloadBatchMedia(media, async (mid, url) => [item(url, mid)], async (entry) => downloads.push(entry));
  assert.equal(result.success, 2);
  assert.equal(result.failed, 0);
  assert.deepEqual(downloads.map((entry) => entry.url), ['https://cdn.telegram.org/a', 'https://cdn.telegram.org/b']);
});

test('Channel Info 和原版 Media 增强 selectors、入口和进度标记均存在', async () => {
  const resolver = await read('../src/telegram/original-media-resolver.ts');
  const enhancer = await read('../src/telegram/page-enhancer.ts');
  assert.match(resolver, /\[TG Downloader\]\[channel-info\]/);
  assert.match(resolver, /\[TG Downloader\]\[media-tab\]/);
  assert.match(resolver, /#column-right \.search-super/);
  assert.match(resolver, /search-super-tabs\.menu-horizontal-div/);
  assert.match(resolver, /pointerdown/);
  assert.match(enhancer, /download-all-media/);
  assert.match(enhancer, /download-selected-item/);
  assert.match(enhancer, /tg-all-media-download/);
});

test('扩展 context 失效会停掉 timer/observer 并提示刷新页面', async () => {
  const content = await read('../src/content/index.ts');
  assert.match(content, /Extension context invalidated\. Refresh Telegram page\./);
  assert.match(content, /toolbarObserver\?\.disconnect\(\)/);
  assert.match(content, /sidebarObserver\?\.disconnect\(\)/);
  assert.match(content, /window\.clearInterval\(observerTimer\)/);
});

test('消息下载 action host 是完整 bubble wrapper，而不是 attachment/media-container', async () => {
  const { getMessageActionHost } = await loadStandaloneTypeScript('../src/telegram/message-action-host.ts');
  const attachment = { name: 'attachment' };
  const wrapper = { querySelector(selector) { return selector === '.attachment.media-container' ? attachment : null; } };
  const message = { querySelector(selector) { return selector === '.bubble-content-wrapper' ? wrapper : null; } };
  const host = getMessageActionHost(message, 'K');
  assert.equal(host, wrapper);
  assert.notEqual(host, attachment);
  const enhancer = await read('../src/telegram/page-enhancer.ts');
  assert.match(enhancer, /const container = wrapper/);
  assert.doesNotMatch(enhancer, /wrapper\.querySelector\('\.attachment\.media-container/);
});

test('同一消息已存在直接子级下载区时禁止重复注入', async () => {
  const { hasDirectMessageActions } = await loadStandaloneTypeScript('../src/telegram/message-action-host.ts');
  const actions = {};
  let installed = false;
  const wrapper = { querySelector(selector) { return installed && selector.startsWith(':scope >') ? actions : null; } };
  assert.equal(hasDirectMessageActions(wrapper), false);
  installed = true;
  assert.equal(hasDirectMessageActions(wrapper), true);
});

test('Sidebar 单项解析成功只启动一次 Downloader 回调', async () => {
  const { resolveSidebarAndDownloadMedia } = await loadFlow();
  const media = item('blob:https://web.telegram.org/video');
  const starts = [];
  const result = await resolveSidebarAndDownloadMedia(async (mid, url, beforeClose) => {
    assert.equal(mid, 'mid-1');
    assert.equal(url, media.url);
    await beforeClose(media);
    await beforeClose({ ...media });
    return [media, { ...media }];
  }, async (entry) => starts.push(entry.url), 'mid-1', media.url);
  assert.equal(result.length, 1);
  assert.deepEqual(starts, [media.url]);
});

test('Viewer 关闭前已固定 final URL 并启动本地下载', async () => {
  const { resolveViewerMediaBeforeClose } = await loadFlow();
  const source = item('blob:https://web.telegram.org/final');
  const order = [];
  const resolved = await resolveViewerMediaBeforeClose(async () => source, async (entry) => {
    order.push(['download-start', entry.url]);
  }, async () => {
    order.push(['viewer-close']);
    source.url = 'blob:revoked';
  });
  assert.deepEqual(order, [['download-start', 'blob:https://web.telegram.org/final'], ['viewer-close']]);
  assert.equal(resolved.url, 'blob:https://web.telegram.org/final');
});

test('K Viewer MediaSource currentSrc 不直接下载，优先使用本次 Viewer 捕获的 progressive HTTP 源', async () => {
  const { resolveKViewerVideoSource } = await loadStandaloneTypeScript('../src/telegram/k-viewer-source.ts');
  let pinCount = 0;
  const source = await resolveKViewerVideoSource([], [
    { url: 'https://cdn.telegram.org/file/stream/id/video.mp4', source: 'fetch', contentType: 'video/mp4', preflightVerified: true, verifiedStrongEvidence: true, verifiedContentType: 'video/mp4' },
    { url: 'https://cdn.telegram.org/file/progressive/id/video.mp4', source: 'fetch', contentType: 'video/mp4', preflightVerified: true, verifiedStrongEvidence: true, verifiedContentType: 'video/mp4' },
  ], 'blob:https://web.telegram.org/media-source-viewer', async () => {
    pinCount += 1;
    return { ok: false, objectUrlKind: 'media-source', code: 'BLOB_MEDIA_SOURCE_NOT_DOWNLOADABLE' };
  });
  assert.equal(source.url, 'https://cdn.telegram.org/file/progressive/id/video.mp4');
  assert.equal(source.source, 'page-capture');
  assert.equal(pinCount, 0, '选到 HTTP 源后不得 pin 或提交 currentSrc MediaSource');
});

test('MediaSource pin 错误继续执行 Viewer 原生 fallback；成功时不调用 Downloader', async () => {
  const { resolveKViewerVideoSource, resolveKViewerSourceOrNativeFallback, runKViewerNativeDownloadAction } =
    await loadStandaloneTypeScript('../src/telegram/k-viewer-source.ts');
  const nativeCalls = [];
  const actionCalls = [];
  const button = { role: 'download-button' };
  const downloadOption = { label: 'Download original' };
  const nativeAction = await runKViewerNativeDownloadAction({
    findDownloadButton: () => button,
    visibleOptions: () => [],
    waitForOptions: async (timeoutMs) => {
      assert.equal(timeoutMs, 2500);
      return [downloadOption];
    },
    label: (option) => option.label,
    dispatchOriginalClick: async (target) => { actionCalls.push(target); return true; },
  });
  assert.equal(nativeAction.started, true);
  assert.equal(nativeAction.actionKind, 'download');
  assert.deepEqual(actionCalls, [button, downloadOption]);

  const outcome = await resolveKViewerSourceOrNativeFallback(
    () => resolveKViewerVideoSource([], [], 'blob:https://web.telegram.org/mse', async () => ({
      ok: false, objectUrlKind: 'media-source', code: 'BLOB_MEDIA_SOURCE_NOT_DOWNLOADABLE',
    })),
    async () => { nativeCalls.push('native'); return nativeAction.started; },
  );
  assert.equal(outcome.kind, 'native-download');
  assert.deepEqual(nativeCalls, ['native']);

  const { resolveSidebarAndDownloadMedia } = await loadFlow();
  const marker = { ...item('blob:https://web.telegram.org/mse'), nativeDownloadStarted: true };
  let downloaderCalls = 0;
  const returned = await resolveSidebarAndDownloadMedia(async (_mid, _preferred, beforeClose) => {
    await beforeClose(marker);
    return [marker];
  }, async () => { downloaderCalls += 1; }, 'mid-1');
  assert.equal(returned[0].nativeDownloadStarted, true);
  assert.equal(downloaderCalls, 0);
});

test('MediaSource 与 native fallback 都失败时只返回 K_VIEWER_MEDIA_SOURCE_UNRESOLVED', async () => {
  const { resolveKViewerVideoSource, resolveKViewerSourceOrNativeFallback, runKViewerNativeDownloadAction } =
    await loadStandaloneTypeScript('../src/telegram/k-viewer-source.ts');
  let nativeCalls = 0;
  const nativeAction = await runKViewerNativeDownloadAction({
    findDownloadButton: () => ({ role: 'download-button' }),
    visibleOptions: () => [],
    waitForOptions: async () => [],
    label: () => '',
    dispatchOriginalClick: async () => true,
  });
  assert.equal(nativeAction.started, false);
  await assert.rejects(resolveKViewerSourceOrNativeFallback(
    () => resolveKViewerVideoSource([], [], 'blob:https://web.telegram.org/mse', async () => ({
      ok: false, objectUrlKind: 'media-source', code: 'BLOB_MEDIA_SOURCE_NOT_DOWNLOADABLE',
    })),
    async () => { nativeCalls += 1; return nativeAction.started; },
  ), (error) => error.code === 'K_VIEWER_MEDIA_SOURCE_UNRESOLVED');
  assert.equal(nativeCalls, 1);
});

test('K 单项视频 Sidebar 路径不依赖可选 flag，且原生动作按原版按钮/菜单协议执行', async () => {
  const resolver = await read('../src/telegram/original-media-resolver.ts');
  const nativeSource = await read('../src/telegram/k-viewer-source.ts');
  assert.match(resolver, /const isKViewerSingleVideo = version === 'K' && sidebarContainer !== undefined && expectedKind === 'video'/);
  assert.match(resolver, /if \(isKViewerSingleVideo && captureSession\)/);
  assert.match(resolver, /if \(resolutionOptions\?\.pinVideoSource\) \{\s*return this\.resolveKViewerSidebarVideo/);
  assert.match(resolver, /resolveKViewerSourceOrNativeFallback\(/);
  assert.match(resolver, /\.media-viewer-whole\.active \.quality-download-options-button-menu/);
  assert.match(resolver, /\.media-viewer-whole\.active \.btn-icon\.tgico-download/);
  assert.match(resolver, /\.media-viewer-buttons \.btn-icon/);
  assert.match(resolver, /dispatchOriginalKViewerClick\(downloadToggle\)/);
  assert.match(nativeSource, /driver\.waitForOptions\(2500\)/);
  assert.match(nativeSource, /options\[optionIndex\]/);
  assert.match(nativeSource, /downloadIndex >= 0 \? downloadIndex : qualityIndex >= 0 \? qualityIndex : 0/);
  assert.match(resolver, /runKViewerNativeDownloadAction<HTMLElement>/);
  assert.doesNotMatch(resolver, /actionable\.click\(\)/);
});

test('未捕获 Blob 时继续等待 Viewer 延迟出现的 progressive/stream 地址', async () => {
  const { waitForKViewerHttpSource, resolveKViewerVideoSource } = await loadStandaloneTypeScript('../src/telegram/k-viewer-source.ts');
  let reads = 0;
  let pinCount = 0;
  const waited = await waitForKViewerHttpSource(async () => {
    reads += 1;
    if (reads < 3) return { menu: [], viewer: [], captured: [], performance: [] };
    return {
      menu: [], viewer: [], performance: [],
      captured: [{ url: 'https://cdn.telegram.org/file/progressive/delayed-video.mp4', source: 'xhr', contentType: 'video/mp4' }],
    };
  }, 500, 1, () => new Promise((resolve) => setTimeout(resolve, 2)), async (candidate) => ({
    ok: true, status: 206, finalUrl: candidate.url, contentType: 'video/mp4', contentRange: 'bytes 0-0/4096',
  }));
  assert.ok(reads >= 3);
  assert.equal(waited.candidate.url, 'https://cdn.telegram.org/file/progressive/delayed-video.mp4');
  const source = await resolveKViewerVideoSource([], [waited.candidate],
    'blob:https://web.telegram.org/untracked', async () => { pinCount += 1; throw new Error('must not pin after HTTP appears'); },
    waited.viewer, waited.performance);
  assert.equal(source.source, 'page-capture');
  assert.equal(pinCount, 0);
});

test('早期普通 viewer-element 弱候选不会结束等待，后续 progressive 经预检后胜出', async () => {
  const { waitForKViewerHttpSource, resolveKViewerVideoSource } = await loadStandaloneTypeScript('../src/telegram/k-viewer-source.ts');
  const { startKViewerDownloadAfterSourceResolution } = await loadFlow();
  let reads = 0;
  const preflighted = [];
  const weak = { url: 'https://web.telegram.org/k/viewer/current', source: 'viewer-element', trustedMediaElement: true };
  const progressive = { url: 'https://cdn.telegram.org/file/progressive/id/video.mp4', source: 'fetch', contentType: 'video/mp4' };
  const waited = await waitForKViewerHttpSource(async () => {
    reads += 1;
    return {
      menu: [], viewer: [weak], captured: reads >= 3 ? [progressive] : [], performance: [],
    };
  }, 500, 1, () => new Promise((resolve) => setTimeout(resolve, 2)), async (candidate) => {
    preflighted.push(candidate.url);
    if (candidate.url === weak.url) return { ok: false, status: 302, contentType: 'text/html', code: 'HTTP_REDIRECT_NOT_FOLLOWED' };
    return { ok: true, status: 206, finalUrl: candidate.url, contentType: 'video/mp4', contentRange: 'bytes 0-0/2048' };
  });
  assert.ok(reads >= 3, 'poll one weak candidate must not finish the wait');
  assert.ok(preflighted.includes(weak.url));
  assert.equal(waited.candidate.url, progressive.url);
  assert.equal(waited.candidate.preflightVerified, true);
  assert.ok(waited.rejectedCandidates.some((entry) => entry.status === 302 && entry.contentType === 'text/html'));
  const resolved = await resolveKViewerVideoSource([], [waited.candidate], '', async () => ({ ok: false }));
  const actions = [];
  await startKViewerDownloadAfterSourceResolution(async () => resolved,
    async (media) => actions.push(`download:${media.url}`), async () => actions.push('viewer-close'));
  assert.deepEqual(actions, [`download:${progressive.url}`, 'viewer-close']);
});

test('只有普通 web.telegram.org 弱候选时不启动 Downloader，继续 Blob pin 后 native fallback', async () => {
  const { waitForKViewerHttpSource, resolveKViewerVideoSource, resolveKViewerSourceOrNativeFallback } =
    await loadStandaloneTypeScript('../src/telegram/k-viewer-source.ts');
  const weak = { url: 'https://web.telegram.org/k/viewer/current', source: 'viewer-element', trustedMediaElement: true };
  const waited = await waitForKViewerHttpSource(async () => ({ menu: [], viewer: [weak], captured: [], performance: [] }),
    20, 1, async () => {}, async () => ({ ok: false, status: 302, contentType: 'text/html', code: 'HTTP_REDIRECT_NOT_FOLLOWED' }));
  assert.equal(waited.candidate, null);
  assert.equal(waited.weakCandidateCount, 1);

  let downloaderCalls = 0;
  let pinCalls = 0;
  let nativeCalls = 0;
  const outcome = await resolveKViewerSourceOrNativeFallback(async () => {
    if (waited.candidate) return resolveKViewerVideoSource([], [waited.candidate], '', async () => { pinCalls += 1; return { ok: false }; });
    return resolveKViewerVideoSource([], [], 'blob:https://web.telegram.org/mse', async () => {
      pinCalls += 1;
      return { ok: false, objectUrlKind: 'media-source', code: 'BLOB_MEDIA_SOURCE_NOT_DOWNLOADABLE' };
    });
  }, async () => { nativeCalls += 1; return true; });
  assert.equal(outcome.kind, 'native-download');
  assert.equal(pinCalls, 1);
  assert.equal(nativeCalls, 1);
  const { resolveSidebarAndDownloadMedia } = await loadFlow();
  const nativeMarker = { ...item('https://cdn.telegram.org/thumb.jpg'), nativeDownloadStarted: true };
  await resolveSidebarAndDownloadMedia(async (_messageId, _preferred, beforeClose) => {
    await beforeClose(nativeMarker);
    return [nativeMarker];
  }, async () => { downloaderCalls += 1; }, 'mid-1');
  assert.equal(downloaderCalls, 0);
});

test('全部 HTTP candidate 被 probe 拒绝后才进入 Telegram native fallback', async () => {
  const { waitForKViewerHttpSource, resolveKViewerSourceOrNativeFallback } = await loadStandaloneTypeScript('../src/telegram/k-viewer-source.ts');
  const { startKViewerDownloadAfterSourceResolution } = await loadFlow();
  const waited = await waitForKViewerHttpSource(async () => ({
    menu: [{ url: 'https://web.telegram.org/k/download/video', source: 'quality-menu', trustedQualityMenu: true }],
    viewer: [{ url: 'https://web.telegram.org/k/viewer/current', source: 'viewer-element', trustedMediaElement: true }],
    captured: [], performance: [],
  }), 10, 1, async () => {}, async (candidate) => ({
    ok: false, status: 302, finalUrl: 'https://web.telegram.org/login', contentType: 'text/html',
    code: 'HTTP_REDIRECT_NOT_FOLLOWED',
  }));
  let downloaderCalls = 0;
  let nativeCalls = 0;
  let sourceStableCalls = 0;
  await assert.rejects(startKViewerDownloadAfterSourceResolution(async () => {
    if (!waited.candidate) return null;
    sourceStableCalls += 1;
    return { url: waited.candidate.url };
  }, async () => { downloaderCalls += 1; }, async () => {}),
  (error) => error.code === 'K_VIEWER_MEDIA_SOURCE_UNRESOLVED');
  const outcome = await resolveKViewerSourceOrNativeFallback(async () => {
    if (!waited.candidate) return null;
    downloaderCalls += 1;
    return waited.candidate;
  }, async () => { nativeCalls += 1; return true; });
  assert.equal(waited.candidate, null);
  assert.equal(waited.rejectedCandidates.length, 2);
  assert.equal(downloaderCalls, 0);
  assert.equal(sourceStableCalls, 0, 'a rejected 302 candidate must never become sourceStable');
  assert.equal(nativeCalls, 1);
  assert.equal(outcome.kind, 'native-download');
});

test('弱候选 302 + HTML 被拒绝并继续轮询，不抛出为最终下载错误', async () => {
  const { waitForKViewerHttpSource } = await loadStandaloneTypeScript('../src/telegram/k-viewer-source.ts');
  let reads = 0;
  const waited = await waitForKViewerHttpSource(async () => {
    reads += 1;
    return { menu: [], viewer: [{ url: 'https://web.telegram.org/k/viewer/current', source: 'viewer-element', trustedMediaElement: true }], captured: [], performance: [] };
  }, 20, 1, async () => {}, async () => ({ ok: false, status: 302, contentType: 'text/html', code: 'HTTP_REDIRECT_NOT_FOLLOWED' }));
  assert.ok(reads > 1);
  assert.equal(waited.candidate, null);
  assert.equal(waited.rejectedCandidates[0].code, 'HTTP_REDIRECT_NOT_FOLLOWED');
});

test('strong candidate 只有在 206 video/mp4 + Content-Range 预检后才启动 Downloader', async () => {
  const [{ waitForKViewerHttpSource, resolveKViewerVideoSource }, { startKViewerDownloadAfterSourceResolution }] = await Promise.all([
    loadStandaloneTypeScript('../src/telegram/k-viewer-source.ts'), loadFlow(),
  ]);
  const strong = { url: 'https://cdn.telegram.org/file/progressive/video.mp4', source: 'fetch', contentType: 'video/mp4' };
  const waited = await waitForKViewerHttpSource(async () => ({ menu: [], viewer: [], captured: [strong], performance: [] }),
    100, 1, async () => {}, async (candidate) => ({
      ok: true, status: 206, finalUrl: candidate.url, contentType: 'video/mp4', contentRange: 'bytes 0-0/1000',
    }));
  const resolved = await resolveKViewerVideoSource([], [waited.candidate], '', async () => ({ ok: false }));
  const order = [];
  await startKViewerDownloadAfterSourceResolution(async () => resolved,
    async (media) => order.push(`downloader:${media.url}`), async () => order.push('viewer-close'));
  assert.deepEqual(order, [`downloader:${strong.url}`, 'viewer-close']);
});

test('progressive 候选预检重定向到无扩展 CDN URL 时用视频 MIME 保留已验证的媒体证据', async () => {
  const { waitForKViewerHttpSource } = await loadStandaloneTypeScript('../src/telegram/k-viewer-source.ts');
  const waited = await waitForKViewerHttpSource(async () => ({
    menu: [], viewer: [],
    captured: [{ url: 'https://web.telegram.org/file/progressive/source-id', source: 'fetch' }],
    performance: [],
  }), 100, 1, async () => {}, async () => ({
    ok: true, status: 206, finalUrl: 'https://cdn.telegram.org/file/media-id',
    contentType: 'video/mp4', contentRange: 'bytes 0-0/8192', redirected: true,
  }));
  assert.equal(waited.candidate.url, 'https://cdn.telegram.org/file/media-id');
  assert.equal(waited.candidate.preflightVerified, true);
  assert.equal(waited.candidate.verifiedStrongEvidence, true);
});

test('稳定 HTTP 来源先启动 Downloader 再关闭 Viewer；来源缺失时不启动也不关闭', async () => {
  const { startKViewerDownloadAfterSourceResolution } = await loadFlow();
  const order = [];
  const source = { url: 'https://cdn.telegram.org/file/stream/video.mp4' };
  await startKViewerDownloadAfterSourceResolution(async () => {
    order.push('source-stable');
    return source;
  }, async (item) => { order.push(`downloader-start:${item.url}`); }, async () => { order.push('viewer-close'); });
  assert.deepEqual(order, [
    'source-stable', 'downloader-start:https://cdn.telegram.org/file/stream/video.mp4', 'viewer-close',
  ]);

  const unresolved = [];
  await assert.rejects(startKViewerDownloadAfterSourceResolution(async () => null,
    async () => unresolved.push('downloader-start'), async () => unresolved.push('viewer-close')),
  (error) => error.code === 'K_VIEWER_MEDIA_SOURCE_UNRESOLVED');
  assert.deepEqual(unresolved, []);
});

test('Telegram 原生质量下载标记不会再提交给 Downloader', async () => {
  const { resolveSidebarAndDownloadMedia } = await loadFlow();
  let downloads = 0;
  const native = { ...item('https://cdn.telegram.org/thumb.jpg'), nativeDownloadStarted: true };
  const result = await resolveSidebarAndDownloadMedia(async () => [native], async () => { downloads += 1; }, 'mid-1');
  assert.equal(result[0].nativeDownloadStarted, true);
  assert.equal(downloads, 0);
});

test('K Viewer 单项诊断只记录来源类型且 HTTP Range 日志隐藏最终路径', async () => {
  const resolver = await read('../src/telegram/original-media-resolver.ts');
  const downloader = await read('../src/downloader/downloader.ts');
  const start = resolver.indexOf('private async resolveKViewerSidebarVideo');
  const end = resolver.indexOf('private makeKViewerResolvedItem', start);
  const targetedPath = resolver.slice(start, end);
  assert.doesNotMatch(targetedPath, /finalUrl\s*:/);
  assert.doesNotMatch(targetedPath, /console\.(?:info|warn|error)\([^;]*\burl\s*:/s);
  assert.match(targetedPath, /qualityMenuCandidates/);
  assert.match(targetedPath, /capturedHttpCandidates/);
  assert.match(targetedPath, /bridgeInstalledBeforeViewer/);
  for (const field of ['candidateSource', 'pathClass', 'initialHost', 'probeTransport', 'probeStatus', 'probeContentType', 'probeRedirected', 'finalHost', 'accepted', 'rejectReason']) {
    assert.match(targetedPath, new RegExp(`${field}:`), `missing redacted probe field ${field}`);
  }
  assert.match(targetedPath, /main-world-page-bridge/);
  assert.match(resolver, /requiresPageTransport: source\.source !== 'pinned-blob'/);
  const probeStart = targetedPath.indexOf('const logProbe =');
  const probeEnd = targetedPath.indexOf('const firstWait =', probeStart);
  const probeLogger = targetedPath.slice(probeStart, probeEnd);
  assert.doesNotMatch(probeLogger, /\burl\s*:/,
    'candidate probe log payload must not contain a URL field');
  assert.match(downloader, /finalUrlHost:\s*getUrlHost/);
  assert.doesNotMatch(downloader, /finalUrl:\s*String\(response\.finalUrl/);
});

test('Sidebar 单项下载日志只记录 URL 类型，不输出完整媒体地址', async () => {
  const enhancer = await read('../src/telegram/page-enhancer.ts');
  assert.match(enhancer, /const loggedItems = sidebar \? chosen\.map\(\(item\) => \(\{/);
  assert.match(enhancer, /urlType: mediaUrlType\(item\.url\)/);
  assert.doesNotMatch(enhancer, /console\.info\(force \? '[^']+' : '[^']+', chosen\)/);
});

test('K Viewer 只有在真实 Blob pin 成功后才关闭 Viewer 并启动一次下载', async () => {
  const [{ resolveKViewerVideoSource }, { resolveViewerMediaBeforeClose }] = await Promise.all([
    loadStandaloneTypeScript('../src/telegram/k-viewer-source.ts'), loadFlow(),
  ]);
  const order = [];
  let finishDownload;
  const downloadPromise = new Promise((resolve) => { finishDownload = resolve; });
  const pending = resolveViewerMediaBeforeClose(async () => resolveKViewerVideoSource([], [], 'blob:https://web.telegram.org/viewer-blob', async () => {
    order.push('pin-request');
    await Promise.resolve();
    order.push('pin-complete');
    return { ok: true, objectUrlKind: 'blob', cacheState: 'hit', size: 4, mimeType: 'video/mp4', leaseId: 'lease-1' };
  }), async (source) => {
    order.push(`download-start:${source.blobLeaseId}`);
    return downloadPromise;
  }, async () => { order.push('viewer-close'); });
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(order, ['pin-request', 'pin-complete', 'download-start:lease-1', 'viewer-close']);
  finishDownload();
  const source = await pending;
  assert.equal(source.size, 4);
  assert.equal(source.blobLeaseId, 'lease-1');
});

test('K Viewer MediaSource 无 HTTP 候选时明确失败且不启动 Downloader', async () => {
  const [{ resolveKViewerVideoSource }, { resolveViewerMediaBeforeClose }] = await Promise.all([
    loadStandaloneTypeScript('../src/telegram/k-viewer-source.ts'), loadFlow(),
  ]);
  const order = [];
  await assert.rejects(resolveViewerMediaBeforeClose(
    () => resolveKViewerVideoSource([], [], 'blob:https://web.telegram.org/mse', async () => ({
      ok: false, objectUrlKind: 'media-source', cacheState: 'hit', code: 'BLOB_MEDIA_SOURCE_NOT_DOWNLOADABLE', error: 'MediaSource is playback only',
    })),
    async () => { order.push('download-start'); },
    async () => { order.push('viewer-close'); },
  ), (error) => error.code === 'BLOB_MEDIA_SOURCE_NOT_DOWNLOADABLE');
  assert.deepEqual(order, ['viewer-close']);
});

test('Sidebar resolve 空结果显式报 NO_MEDIA_URL 并显示按钮失败文案', async () => {
  const { resolveSidebarAndDownloadMedia } = await loadFlow();
  await assert.rejects(resolveSidebarAndDownloadMedia(async () => [], async () => {}, 'mid-1'), /NO_MEDIA_URL/);
  const enhancer = await read('../src/telegram/page-enhancer.ts');
  assert.match(enhancer, /\[TG Downloader\]\[media-item\] NO_MEDIA_URL/);
  assert.match(enhancer, /LABELS\.downloadFailed/);
});

test('Advanced Download 主流程不调用 prompt', async () => {
  const content = await read('../src/content/index.ts');
  assert.doesNotMatch(content, /window\.prompt\s*\(/);
});

test('Advanced Download 主流程不调用 confirm', async () => {
  const content = await read('../src/content/index.ts');
  assert.doesNotMatch(content, /window\.confirm\s*\(/);
});

test('点击高级下载入口通过原版 OPEN_UNIFIED_CHAT_EXPORT_DIALOG 协议挂载 Shadow DOM 组件', async () => {
  const controller = await read('../src/telegram/advanced-download-dialog.ts');
  const component = await read('../src/components/AdvancedDownloadDialog.vue');
  const enhancer = await read('../src/telegram/page-enhancer.ts');
  assert.match(controller, /tg-downloader-shadow-host/);
  assert.match(controller, /OPEN_UNIFIED_CHAT_EXPORT_DIALOG/);
  assert.match(controller, /TG_START_CHAT_MEDIA_EXPORT/);
  assert.match(component, /class="tg-cme-dialog"/);
  assert.match(component, /加载完整历史媒体/);
  assert.match(enhancer, /LABELS\.advancedDownload/);
  assert.doesNotMatch(controller, /TGDownloaderShadowDOM\.show/);
});

test('高级下载过滤媒体类型并按本地历史跳过已完成项目', async () => {
  const { filterAdvancedMediaItems } = await loadFlow();
  const items = [item('https://cdn.telegram.org/a'), { ...item('https://cdn.telegram.org/b'), kind: 'image', hasDownloaded: true }, { ...item('https://cdn.telegram.org/c'), kind: 'gif' }];
  const selected = filterAdvancedMediaItems(items, { mediaTypes: ['image', 'gif'], visibleOnly: true, loadAllMedia: false, skipDownloaded: true });
  assert.deepEqual(Array.from(selected, (entry) => entry.url), ['https://cdn.telegram.org/c']);
});

test('批量预解析回调每个已选媒体最多启动一次下载', async () => {
  const { downloadBatchMedia } = await loadFlow();
  const downloads = [];
  const media = item('https://cdn.telegram.org/a');
  const result = await downloadBatchMedia([media, { ...media }], async (mid, url, beforeClose) => {
    await beforeClose(media);
    return [media];
  }, async (entry) => downloads.push(entry.url));
  assert.equal(result.success, 1);
  assert.equal(result.failed, 0);
  assert.deepEqual(downloads, [media.url]);
});

test('Sidebar 视频的 Viewer 解析回调仍在关闭前创建一次下载任务', async () => {
  const { downloadBatchMedia } = await loadFlow();
  const media = { ...item('blob:https://web.telegram.org/video'), kind: 'video' };
  const order = [];
  const result = await downloadBatchMedia([media], async (_mid, _url, beforeClose) => {
    order.push('viewer-open');
    await beforeClose(media);
    order.push('viewer-close');
    return [media];
  }, async (entry) => order.push(`download:${entry.url}`));
  assert.equal(result.success, 1);
  assert.deepEqual(order, ['viewer-open', `download:${media.url}`, 'viewer-close']);
});

test('批量首项解析失败会被隔离，第二项继续并返回成功失败计数', async () => {
  const { downloadBatchMedia } = await loadFlow();
  const first = item('https://cdn.telegram.org/image-1.jpg', 'mid-1');
  const second = item('https://cdn.telegram.org/video-2.mp4', 'mid-2');
  const downloaded = [];
  const events = [];
  const result = await downloadBatchMedia([first, second], async (mid, url) => {
    if (mid === first.messageId) throw Object.assign(new DOMException('Viewer did not open', 'InvalidStateError'), { code: 'VIEWER_NOT_OPEN' });
    return [item(url, mid)];
  }, async (entry) => downloaded.push(entry.url), (event) => events.push(event));
  assert.equal(result.success, 1);
  assert.equal(result.failed, 1);
  assert.equal(result.failures[0].stage, 'resolve');
  assert.deepEqual(downloaded, [second.url]);
  assert.deepEqual(events.filter((event) => event.status === 'complete').map((event) => event.item.messageId), ['mid-2']);
});

test('selectedKeys 只从 content canonical map 解析，不接受 Vue MediaItem 对象', async () => {
  const { resolveSelectedMediaKeys } = await loadFlow();
  const canonical = [item('blob:https://web.telegram.org/a', 'mid-1'), item('blob:https://web.telegram.org/b', 'mid-2')];
  const canonicalMap = new Map(canonical.map((entry) => [`${entry.messageId}\u0000${entry.url}`, entry]));
  const selection = resolveSelectedMediaKeys(canonicalMap, [
    { messageId: 'mid-2', url: 'blob:https://web.telegram.org/b' },
    { messageId: 'missing', url: 'blob:https://web.telegram.org/nope' },
  ]);
  assert.equal(selection.length, 1);
  assert.equal(selection[0], canonical[1]);
});

test('loadAllMedia 调用稳定身份扫描，历史扫描使用身份 key 去重', async () => {
  const resolver = await read('../src/telegram/original-media-resolver.ts');
  assert.match(resolver, /async loadAllMedia\(timeoutMs = 45000\)/);
  assert.match(resolver, /return this\.loadAllScannedIdentities\(timeoutMs\)/);
  assert.match(resolver, /collected\.set\(item\.stableKey, item\)/);
  assert.match(resolver, /scrollRoot\.scrollTop = originalTop/);
  assert.match(resolver, /A_SIDEBAR_SELECTORS[\s\S]*?scrollRoot\.scrollTop/);
  const content = await read('../src/content/index.ts');
  assert.match(content, /resolver\.loadAllMedia\(\)/);
  assert.match(content, /runFullHistoryScanSequence/);
  assert.doesNotMatch(content, /executeIdentityBatch\(.*loadAll/i);
});

test('A 版 loadAll 仅滚动并恢复 #RightColumn 媒体列表容器', async () => {
  const source = await read('../src/telegram/original-media-resolver.ts');
  const compiled = ts.transpile(source, { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 });
  const queried = [];
  const assignedScrollTops = [];
  class FakeHTMLElement {
    constructor() { this.isConnected = true; this.clientHeight = 100; this.scrollHeight = 600; this._scrollTop = 73; }
    get scrollTop() { return this._scrollTop; }
    set scrollTop(value) { this._scrollTop = value; assignedScrollTops.push(value); }
    getBoundingClientRect() { return { width: 300, height: 500 }; }
    querySelectorAll() { return []; }
    getAttribute() { return null; }
    closest() { return null; }
  }
  const scrollRoot = new FakeHTMLElement();
  const document = {
    querySelectorAll(selector) {
      queried.push(selector);
      if (selector.startsWith('#RightColumn')) return [scrollRoot];
      return [];
    },
    querySelector() { return null; },
  };
  const dependencies = {
    './adapter': { classifyMessage: () => null, classifySidebarMedia: () => null, detectTelegramVersion: () => 'A', getMessageId: () => '', messageSelector: () => '' },
    './download-flow': { resolveViewerMediaBeforeClose: async () => null },
    '../utils/filename': { filenameFromUrl: () => 'media.bin', safeFilename: (value) => value },
    '../utils/errors': { formatError: (error) => ({ name: error?.name || 'Error', message: error?.message || String(error) }), formatErrorLog: (prefix) => prefix },
    './captured-media-registry': { enrichCapturedMedia: (item) => item },
  };
  const module = { exports: {} };
  const require = (name) => dependencies[name];
  const window = { setTimeout(callback) { callback(); return 1; } };
  const context = vm.createContext({ module, exports: module.exports, require, document, window, location: { hash: '' }, HTMLElement: FakeHTMLElement, Element: FakeHTMLElement, getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }), Date, URL });
  vm.runInContext(`(function(exports, require, module) { ${compiled}\n})(exports, require, module);`, context);
  const resolver = new module.exports.TelegramMediaResolver();
  resolver.openChannelMedia = async () => true;
  const result = await resolver.loadAllMedia(1000);
  assert.equal(result.length, 0);
  assert.equal(scrollRoot.scrollTop, 73, '扫描完成后恢复用户当前滚动位置');
  assert.ok(assignedScrollTops.includes(0));
  assert.ok(assignedScrollTops.includes(600));
  assert.ok(queried.includes('#RightColumn .Profile.custom-scroll'));
});

test('Viewer blob URL 从 CapturedMediaRegistry 补充 MIME 与 size', async () => {
  const registry = await loadStandaloneTypeScript('../src/telegram/captured-media-registry.ts');
  const url = 'blob:https://web.telegram.org/viewer-blob';
  registry.rememberCapturedMedia({ url, mimeType: 'video/webm', size: 4096, source: 'blob' });
  const item = registry.enrichCapturedMedia({ url, mimeType: 'application/octet-stream', size: 0 });
  assert.equal(item.mimeType, 'video/webm');
  assert.equal(item.size, 4096);
});

test('A progressive 302 由 background Fetch 默认跟随，Downloader 仍验证最终 Range 响应', async () => {
  const background = await read('../src/background/index.ts');
  const downloader = await read('../src/downloader/downloader.ts');
  assert.match(background, /fetch\(url\.href, \{ credentials: 'include', redirect: 'follow', headers: \{ Range:/);
  assert.doesNotMatch(background, /redirect:\s*['"]manual['"]/);
  assert.match(downloader, /response\.status !== 206 \|\| !match/);
  assert.match(downloader, /rangeStart !== transfer\.offset/);
});

test('Advanced batch 在开始扫描历史和处理单项时更新实时状态文本', async () => {
  const content = await read('../src/content/index.ts');
  const component = await read('../src/components/AdvancedDownloadDialog.vue');
  assert.match(content, /正在扫描完整历史媒体/);
  assert.match(content, /已发现 \$\{withHistory\.length\} 项/);
  assert.match(content, /正在处理 \$\{index\}\/\$\{total\}/);
  assert.match(component, /progress\?\.statusText/);
  assert.match(content, /setAdvancedDownloadDialogVisible\(false\)/);
  assert.match(content, /setAdvancedDownloadDialogVisible\(true\)/);
});

test('所有下载仍只通过一个 Downloader.start 出口且仅在有 lease 时保留 revoked Blob 引用', async () => {
  const content = await read('../src/content/index.ts');
  const bridge = await read('../public/page-bridge.js');
  const downloader = await read('../src/downloader/downloader.ts');
  assert.equal((content.match(/downloader\.start\s*\(/g) || []).length, 1);
  assert.match(downloader, /\[TG Downloader\]\[download\] start/);
  assert.match(bridge, /objectUrls\.set\(url, \{ \.\.\.object, \.\.\.history, revoked: false, leases: new Set\(\) \}\)/);
  const revoke = bridge.match(/URL\.revokeObjectURL = \(url\) => \{([\s\S]*?)\n\s*\};/)?.[1] || '';
  assert.match(revoke, /if \(entry\.leases\.size === 0\) objectUrls\.delete\(url\)/);
  assert.match(revoke, /originalRevoke\(url\)/);
  assert.doesNotMatch(bridge, /knownBlobs/);
});

test('下载按钮、高级弹窗英文替换集中在 labels 映射中', async () => {
  const labels = await read('../src/i18n/labels.ts');
  const enhancer = await read('../src/telegram/page-enhancer.ts');
  assert.match(labels, /forceDownload: '强制下载'/);
  assert.match(labels, /advancedDownload: '高级下载'/);
  assert.match(labels, /downloadMonth: '下载本月媒体'/);
  assert.doesNotMatch(enhancer, /'Advanced Download'|'Progress:'|'FORCE DOWNLOAD'/);
});

const identity = (stableKey, messageId = stableKey, kind = 'video') => ({
  stableKey, version: 'K', messageId, peerId: 'peer-1', kind,
  monthGroup: '2026-10', dateTimestamp: 1790812800000, duration: '0:04',
  thumbnail: 'blob:https://web.telegram.org/thumb', sidebarKey: `K:peer-1:${messageId}`, mediaIndex: 0,
});

test('高级批量不保存扫描 Blob URL，每项开始前通过 identity 重新 resolve', async () => {
  const { downloadIdentityBatch } = await loadFlow();
  const selected = [identity('K:peer-1:m1:video:0', 'm1'), identity('K:peer-1:m2:video:0', 'm2')];
  const resolvedKeys = [];
  const downloaded = [];
  const result = await downloadIdentityBatch(selected, async (entry, startBeforeClose) => {
    resolvedKeys.push(entry.stableKey);
    assert.equal('url' in entry, false, 'ScannedMediaIdentity 没有下载 URL');
    const fresh = item(`blob:https://web.telegram.org/fresh-${entry.messageId}`, entry.messageId);
    await startBeforeClose(fresh);
    return fresh;
  }, async (fresh, entry) => {
    assert.equal(fresh.id, entry.stableKey);
    downloaded.push(fresh.url);
  });
  assert.equal(result.success, 2);
  assert.deepEqual(resolvedKeys, selected.map((entry) => entry.stableKey));
  assert.deepEqual(downloaded, [
    'blob:https://web.telegram.org/fresh-m1',
    'blob:https://web.telegram.org/fresh-m2',
  ]);
  assert.ok(downloaded.every((url) => !url.includes('scanned')));
});

test('高级批量按所选 stable identity 过滤，未勾选项目不进入 Downloader', async () => {
  const { resolveSelectedIdentities, filterScannedIdentities, downloadIdentityBatch } = await loadFlow();
  const first = identity('K:peer-1:m1:video:0', 'm1');
  const second = identity('K:peer-1:m2:image:0', 'm2', 'image');
  const canonical = new Map([[first.stableKey, first], [second.stableKey, second]]);
  const selected = resolveSelectedIdentities(canonical, [second.stableKey]);
  const eligible = filterScannedIdentities(selected, { mediaTypes: ['image', 'video', 'gif'], skipDownloaded: false });
  const downloaded = [];
  const result = await downloadIdentityBatch(eligible, async (entry, start) => {
    const fresh = item(`blob:https://web.telegram.org/${entry.messageId}`, entry.messageId);
    await start(fresh);
    return fresh;
  }, async (_item, entry) => downloaded.push(entry.stableKey));
  assert.equal(result.success, 1);
  assert.deepEqual(downloaded, [second.stableKey]);
});

test('完整历史扫描先隐藏弹窗、执行滚动扫描、更新结果，再重新打开且不触发下载', async () => {
  const { runFullHistoryScanSequence } = await loadFlow();
  const order = [];
  let hidden = false;
  let reopenedItems = [];
  const items = [identity('K:peer-1:m1:video:0', 'm1')];
  await runFullHistoryScanSequence(
    () => { hidden = true; order.push('hide'); },
    async () => {
      assert.equal(hidden, true);
      order.push('scroll-and-collect');
      return items;
    },
    (result) => { reopenedItems = result; order.push('update-list'); },
    () => { hidden = false; order.push('reopen'); },
  );
  assert.deepEqual(order, ['hide', 'scroll-and-collect', 'update-list', 'reopen']);
  assert.equal(hidden, false);
  assert.deepEqual(reopenedItems, items);
});

test('扫描结果稳定去重和 UI 都以 stable identity 为键而非 Blob URL', async () => {
  const { dedupeScannedIdentities } = await loadFlow();
  const original = identity('K:peer-1:m1:image:0', 'm1', 'image');
  const duplicate = { ...original, thumbnail: 'blob:https://web.telegram.org/new-thumbnail' };
  assert.equal(dedupeScannedIdentities([original, duplicate]).length, 1);
  assert.equal('url' in original, false);
  const component = await read('../src/components/AdvancedDownloadDialog.vue');
  assert.match(component, /type="checkbox"/);
  assert.match(component, /selectedStableKeys\.has\(item\.stableKey\)/);
  assert.match(component, /function selectAll/);
  assert.match(component, /function clearAll/);
  assert.match(component, /已选择 \{\{ selectedItems\.length \}\} \/ \{\{ typedItems\.length \}\}/);
});

test('K 批量启动点不再把 Media-card URL 作为 preferred URL 传给 Downloader', async () => {
  const content = await read('../src/content/index.ts');
  const source = await read('../src/telegram/download-flow.ts');
  assert.match(content, /resolver\.resolveScannedIdentity\(identity, beforeViewerClose\)/);
  assert.match(source, /resolveCurrent: \(\s*identity: ScannedMediaIdentity/);
  assert.doesNotMatch(content, /resolveSidebarItem\(messageId, preferredUrl, true, beforeViewerClose\)/);
});
