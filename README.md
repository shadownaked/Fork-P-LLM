# ProxyLLM

一个本地的 Electron 应用，用于捕获 LLM 网站的浏览器会话，并在本机暴露 OpenAI 兼容 API。它提供控制面板来管理站点、查看捕获请求与测试模型。

语言：中文 | English (`README.md`)

## 功能概览

- OpenAI 兼容 API：`POST /v1/chat/completions`、`GET /v1/models`，以及 Anthropic 原生 `POST /v1/messages`。
- 多站点控制面板：添加/删除站点、打开/刷新窗口、查看请求并选择凭据。
- 凭据捕获：Electron `webRequest`、CDP（HTTP + WebSocket），以及可选本地 MITM 代理。
- 适配器体系：将不同站点协议转换为 OpenAI 格式，内置多种特定适配器。
- OAuth 设备码/PKCE 登录：Gemini、OpenAI Codex、Qwen。
- 可选 API Key 校验、模型别名、动态模型发现与刷新策略。
- Claude Code 接管/恢复：将 Claude CLI 指向本地代理。
- 本地持久化与脱敏日志。

## 工作流程

1. 应用在独立的 Electron 窗口打开目标站点并监听网络流量。
2. 捕获规则从请求/响应中提取 Authorization、Cookie、Session ID 等凭据。
3. 根据响应内容自动识别模型列表（如可解析）。
4. 本地 API 服务器将 OpenAI 规范请求映射到站点适配器。
5. 以 OpenAI 兼容 SSE 或 WebSocket 方式返回响应。

## 快速开始

安装依赖：

```bash
npm install
npm --prefix renderer install
```

构建 UI 并启动：

```bash
npm --prefix renderer run build
npm run build
npm run start
```

开发模式（UI 热更新）：

```bash
npm --prefix renderer run dev
npm run dev
```

应用会打开控制面板，API 默认绑定到 `127.0.0.1:8080`。

## 使用步骤

1. 打开应用并添加一个目标站点。
2. 点击 Open 打开站点窗口。
3. 与站点交互以捕获请求。
4. 打开 Requests 选择一个请求作为凭据。
5. 从 UI 复制模型名称并调用本地 API。

示例：获取模型列表

```bash
curl http://127.0.0.1:8080/v1/models
```

示例：Chat Completion

```bash
curl http://127.0.0.1:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{"model":"your-model-name","messages":[{"role":"user","content":"Hello"}]}'
```

若启用 `requireApiKey`，请在 `/v1/*` 请求中携带 `Authorization: Bearer <key>`。

## API 接口

- `GET /health` - 健康检查
- `GET /status` - 站点/模型/凭据信息摘要
- `POST /v1/chat/completions` - OpenAI 兼容对话
- `GET /v1/models` - 模型列表（站点 ID + 动态模型）
- `POST /v1/messages` - Anthropic 原生 messages
- `GET /oauth/providers` - OAuth 提供方列表
- `POST /oauth/start` - 启动 OAuth
- `GET /oauth/callback/:provider` - OAuth 回调
- `GET /oauth/status` - OAuth 会话状态
- `POST /oauth/poll` - 设备码轮询

## 配置

`config/rules.json` 控制 API 服务器：

- `apiServerPort`, `apiServerHost`
- `requireApiKey`, `apiKeys`
- `modelAliases`
- `defaultTargetUrl`

站点与凭据保存在本地。开发环境默认存放于 `data/` 和 `logs/`，打包后存放于 Electron `userData` 目录。

## 适配器

内置适配器：

- `template`（通用 HTTP 适配）
- `openai`（按站点配置）
- `theoldllm`
- `orchids`
- `gumloop`

新增适配器可放入 `src/adapters/special/`，默认导出即可自动注册。

## 数据与隐私

- 代理与 API 默认仅本机访问（`127.0.0.1`）。
- MITM 证书仅在 Electron 窗口内被信任，不会写入系统级证书链。
- 凭据来自你自己的浏览器会话，并保存在本地。
- 请遵守目标站点条款，仅在你有权限的账号上使用。

## Claude Code 接管

通过头部按钮可将 Claude Code 指向本地代理（修改 `~/.claude/settings.json` 并创建备份），可随时恢复。

## 开发与测试

- 构建主进程：`npm run build`
- Lint：`npm run lint`
- 单元测试：`npm test`
- E2E 代理测试：`npm run test:e2e`（需要运行中的应用与已捕获凭据）

## License

MIT
