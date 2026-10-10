# TG Feiji Downloader

[English](README.md)

TG Feiji Downloader 是一个 Manifest V3 浏览器扩展，用于在飞机网页版中解析并下载当前账号有权访问的媒体。

> 项目仍处于开发阶段。当前重点完成并经过真实页面验证的是：**Microsoft Edge + K 版网页普通消息中的图片和视频单项下载主链**。本文只描述当前源码与现有验证能够支持的能力，不代表所有网页版本、消息结构或媒体类型均已完成。

## 当前开发范围

当前版本主要完成了 K 版网页普通消息中图片和视频的单项下载：

- 根据消息和附件身份确定用户点击的具体媒体，而不是只用 `img` 或 `video` 标签猜测类型。
- 优先解析当前附件卡片已经拥有的视频来源；必要时再激活当前附件或打开 Viewer。
- 对媒体来源执行主机、响应类型、Range 等验证，再交给统一 Downloader。
- 对当前 Viewer 主图片使用严格限定的 Blob adoption 和 lease 流程。
- 多附件下载会隔离不同 attachment session，降低历史来源或预加载来源串用的风险。

源码中还包含 Popup、设置页、Side Panel、下载任务、本地历史、Channel Info 媒体入口和高级下载等相关实现，但这些不属于本文声明已经完整验证的范围。当前不默认宣称以下范围已经完成：

- 所有飞机网页版本，尤其是 A 版的完整兼容性；
- 音频、任意文件附件和所有媒体编码；
- 所有 grouped album、Channel Info 或高级批量下载场景；
- 所有 Chromium 浏览器和所有未来页面结构。

## K 版普通消息媒体下载实现

普通消息的 `Download` 主链不再简单采用“`img` 就是图片、`video` 就是视频”的粗略判断。当前实现遵循：

```text
当前消息和 attachment identity
→ 当前附件拥有的真实媒体来源
→ 来源与响应验证
→ 统一 Downloader
```

DOM 的主要作用是确定用户点击了哪一个 attachment，并收集与该附件直接关联的媒体证据。最终下载来源还必须经过独立解析和验证；页面中的缩略图、视频 poster、预加载媒体或历史 Viewer 来源不会因为出现在 DOM 中就自动成为下载结果。

### 视频来源解析

如果当前 K 版消息卡片已经存在以下来源之一：

- `video.currentSrc`
- `video[src]`
- `source[src]`

并且解析后的路径属于当前支持的 `/stream/`、`/progressive/` 或 `/download/` 媒体路径，扩展会优先走 card-local fast path：

```text
Download
→ 定位当前 attachment
→ 读取当前卡片的视频来源
→ 使用页面地址解析相对 URL
→ 页面媒体请求预验证
→ 统一 Downloader
```

这条路径使用页面已经加载并归属于当前附件的真实来源，因此验证成功后不需要先打开 Viewer。`/stream/` 路径中编码的 JSON 只用于补充 `size`、`mimeType` 和 `fileName` 等元数据提示，不能替代网络预验证。

#### 只有 poster 的视频

K 版页面中部分视频最初只有 poster、`.video-time` 和 `.video-play`，尚未创建真正的 `video` 或 `source`。当前实现会：

1. 根据当前 attachment 内的视频元素、视频样式、时长或播放按钮确认视频意图。
2. 只激活当前 attachment 内的播放按钮。
3. 等待同一个 attachment 创建 `video` 或 `source`。
4. 捕获新出现的 `/stream/`、`/progressive/` 或 `/download/` 来源。
5. 验证来源后交给统一 Downloader。

视频 poster、缩略图和 canvas 不会被当作最终视频文件，也不会被改名保存成 MP4。

#### 页面请求 transport

这些媒体地址有时依赖当前页面环境、登录凭据和重定向行为。项目没有为它们建立第二套下载器，而是复用现有 Page Bridge 和 Downloader：

- 在页面主世界使用带凭据、允许重定向的请求进行轻量 preflight；
- 检查允许的主机、最终响应地址、媒体 MIME、状态码和 `Content-Range`；
- 对需要页面环境的来源使用现有页面 Range transport 分段读取；
- 继续由统一 Downloader 管理任务、媒体容器验证和文件保存。

### 图片来源解析

K 版网页图片经常以 `blob:` URL 显示。Blob URL 只是当前页面会话中的对象地址，本身不能证明底层对象是一张完整、稳定、可读取的图片。因此普通 `PIN_BLOB` 仍保持严格：页面桥接没有捕获到底层 Blob 引用时，会明确返回失败，而不是把任意 Blob URL 直接当作文件。

#### Active Image Blob Adoption

对于已经打开的 Viewer，只有同时满足以下条件时，单项下载主链才允许请求当前图片 Blob adoption：

- 媒体来自当前 active/current slide；
- Viewer scope 明确拥有当前 attachment；
- DOM 节点是当前主图片；
- 当前 attachment 没有视频意图；
- 候选不是视频 poster，也不是 inactive/preloaded slide。

满足条件后，Page Bridge 在页面主世界通过保存的原始 `fetch` 读取当前 Blob，并验证：

- Blob 大小必须大于零；
- MIME 应为 `image/*`；MIME 缺失时只接受可识别的轻量图片签名；
- MediaSource、视频/音频 Blob 和无法确认类型的大文件会被拒绝。

验证通过的真实 Blob 会进入现有 Blob cache，并创建 lease。Downloader 继续使用现有 Blob 分片读取流程；不会生成 data URL，也不会把大 Blob 复制到 content script。普通未验证 Blob 仍不会被直接接受，因此 Active Image Blob Adoption 不是“所有 Blob URL 自动可信”的通用放宽。

### 附件隔离与来源归属

每次普通消息下载会维护 message identity、attachment identity、开始时间和 baseline。baseline 用来隔离本次操作之前已经存在的来源，例如上一附件 URL、历史 Viewer URL 或预加载 URL。

当前卡片直接拥有的 card-local 媒体来源具有明确的 current-attachment ownership，会在通用历史候选筛选之前单独验证；其他 bridge、performance 或预加载来源仍受 baseline 约束。

对于 K 版 grouped album / 多附件消息，当前实现继续使用 `.album-item`，并优先复用每个 item 的 `data-mid` 作为 attachment identity。不同 item 会建立独立 session，以降低多个附件之间串用媒体来源的风险。当前版本已在真实 K 页面进行多媒体消息流程测试，但不据此声明所有相册结构均已覆盖。

### 不使用网页原生下载作为普通消息 fallback

普通消息 single-download 主链不再把网页自身的 Download、质量菜单或最高质量菜单作为自动 fallback。card-local、播放激活和 Viewer 来源都无法安全验证时，当前操作会返回明确失败；Downloader transport 失败也会保留原错误。

项目其他功能路径仍可能保留原生下载相关 helper，因此这不表示整个代码库已经删除所有相关实现。该约束只针对普通消息 single-download 主链。

### 文件命名

当前命名流程会在可用时使用消息正文作为文件 basename。多附件消息按稳定顺序增加序号，最终扩展名依据已经解析出的媒体类型、MIME、来源文件名或 URL 信息生成。相关规则由 `src/utils/filename.ts` 和单项下载 session 统一调用；未识别媒体仍使用保守的后备命名。

## 媒体来源验证与安全边界

当前实现包含以下边界：

- 不把未经验证的 HTTP 地址直接作为媒体下载来源；
- 只允许预设的飞机网页相关主机，并验证重定向后的最终地址；
- 对 Range 响应检查状态码和 `Content-Range`；
- 不把 MediaSource object URL 当作普通完整文件 Blob；
- 不把视频 poster、缩略图或 canvas 当作真实视频；
- 普通 Blob pin 保持严格；
- 当前图片 Blob adoption 只允许已确认归属当前 active attachment 的主图片；
- 单项下载诊断日志只记录来源类型、验证状态、大小、MIME 和错误码等必要字段，避免输出完整敏感媒体 URL、Cookie、Token 或 Authorization。

这些措施是当前实现的来源约束，不代表项目已经经过独立安全审计或获得安全认证。请勿提交真实会话数据、私人媒体链接、聊天导出、截图或本地调试日志。

## 当前验证状态

当前提交前的定向自动验证结果：

- `scripts/page-flow.test.mjs`：82/82 PASS
- `scripts/page-bridge.test.mjs`：28/28 PASS
- TypeScript typecheck：PASS
- Production build：PASS
- `git diff --check`：PASS

真实浏览器验证与自动测试分开记录。当前版本已经在真实 Microsoft Edge + K 版网页环境中完成普通消息图片、视频以及多媒体消息下载流程验证。项目仍处于开发阶段，后续仍需验证更多消息结构、媒体类型、网页版本和边缘场景；上述结果不表示所有场景均已通过。

## 开发环境与构建

准备 Node.js 22 或更新版本及 npm，在项目根目录执行：

```sh
npm ci
npm run typecheck
npm test
npm run build
```

`npm test` 会先构建扩展，再运行项目测试。`npm run build` 生成 `dist/`。依赖目录和构建产物不纳入 Git 提交。

## 加载扩展

1. 打开 `edge://extensions` 或 `chrome://extensions`。
2. 开启开发者模式，选择“加载已解压的扩展程序”。
3. 选择构建生成的 `dist/` 目录。
4. 打开或刷新 [飞机网页版](https://web.telegram.org/)，通过网页自身完成登录。
5. 修改源码并重新构建后，重新加载扩展并刷新页面。

## 目录说明

```text
src/
  background/   扩展后台服务
  content/      隔离环境页面入口
  telegram/     飞机网页适配、来源解析与页面控件
  downloader/   下载任务、Range transport 与媒体校验
  components/   共用 Vue 组件
  popup/        弹出窗口
  options/      设置页面
  side-panel/   侧边面板
  storage/      本地设置与历史记录
  exporter/     导出辅助模块
  types/        共用类型
  utils/        工具函数
  i18n/         界面文案
public/         MAIN world 页面 bridge
scripts/        构建脚本和定向测试
```

## 数据与权限

扩展申请飞机网页站点访问、本地存储、标签页访问、侧边面板及声明式网络规则权限。扩展只处理当前登录账号可以访问、且用户有权下载的媒体；设置和下载历史保存在 `chrome.storage.local`。

本项目与飞机网页官方无关联。媒体文件是否满足预期仍应在真实浏览器和播放器中检查，自动测试不能代替真实使用验证。
