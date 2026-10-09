# TG Feiji Downloader

[English](README.md)

TG Feiji Downloader 是一个 Manifest V3 浏览器扩展，目标是在 TG 飞机网页版（Telegram Web）提供更自由、灵活的媒体文件下载能力。

**目前处于开发阶段。** 功能和兼容性仍在完善，构建成功不代表所有 Telegram 媒体来源均可下载。仅处理当前登录账号可以访问、且你有权下载的媒体。

## 项目范围

- Telegram Web 页面集成与媒体识别。
- 单项及所选媒体的批量下载流程。
- 下载任务、进度、暂停/继续及本地历史记录。
- Popup、设置页、Side Panel 和页面内媒体控件。
- 使用扩展本地存储，无需额外注册本项目账号或订阅。

项目使用 Vue 3、TypeScript 和 Vite，包含自动化测试。面向支持 Manifest V3 的 Chromium 浏览器，包括 Chrome 和 Edge。Telegram Web 页面变化可能影响兼容性。

## 开发环境与构建

准备 Node.js 22 或更新版本及 npm，在项目根目录执行：

```sh
npm ci
npm run typecheck
npm test
npm run build
```

`npm test` 会先构建扩展，再运行测试。`npm run build` 生成 `dist/`。依赖目录和构建产物不纳入 Git 提交。

## 加载扩展

1. 打开 `chrome://extensions` 或 `edge://extensions`。
2. 开启开发者模式，选择“加载已解压的扩展程序”。
3. 选择构建生成的 `dist/` 目录。
4. 打开或刷新 [Telegram Web](https://web.telegram.org/)，通过 Telegram 自身登录。
5. 修改源码并重新构建后，重新加载扩展并刷新 Telegram 页面。

## 目录说明

```text
src/
  background/   扩展后台服务
  content/      隔离环境页面入口
  telegram/     Telegram 适配与页面控件
  downloader/   下载任务与媒体校验
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
scripts/        构建脚本、测试及合成测试数据
```

## 数据与权限

扩展申请 Telegram 站点访问、本地存储、标签页访问、侧边面板及声明式网络规则权限。扩展读取页面中可访问的媒体，设置和下载历史保存在 `chrome.storage.local`。

请勿提交会话数据、真实媒体链接、Cookie、凭据、私人聊天导出、截图或本地调试日志。通用 ID 字段及合成测试数据属于正常源码和测试内容。

本项目与 Telegram 官方无关联。实际保存和媒体播放结果需要在浏览器及播放器中检查，自动化检查不能代替真实使用验证。
