# dsh-toonflow-media

DSH 插件：让 DSH agent 用 BeefTV 85 个渠道 manifest 直接生成图片/视频/音频。

不启动 Toonflow 服务器（Bun 缺失 + 网络 SSL 阻断），而是在 DSH 进程内直接解析 manifest 模板并调用上游 API。

## 工具

| 工具 | 说明 |
|------|------|
| `toonflow_media_list_models` | 列出可用渠道（image/video/audio），返回 providerId、label、capabilities |
| `toonflow_media_generate` | 生成媒体，返回 url/base64/binary |
| `toonflow_media_set_key` | 设置某渠道 API Key（持久化到 `$DSH_HOME/toonflow-media/config.json`） |

## 使用

1. 调用 `toonflow_media_set_key` 设置 API Key（每个渠道一次）。
2. 调用 `toonflow_media_list_models` 查看可用渠道。
3. 调用 `toonflow_media_generate` 指定 `providerId` 和 `model` 生成媒体。

## 构建

```bash
npm run build      # tsc 编译 src/*.ts → lib/*.js
npm run typecheck  # 类型检查
npm test           # vitest 测试
```

## 架构

- `src/template.ts` — BeefTV manifest 模板解释器（~40 个操作符）
- `src/manifest-loader.ts` — 加载 manifests/ 目录下的 manifest
- `src/generate.ts` — 生成逻辑（同步/异步轮询）
- `src/config.ts` — API Key 持久化
- `src/index.ts` — DSH 插件入口（工具注册）
- `manifests/` — 85 个 BeefTV 渠道 manifest
