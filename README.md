# Artflow-core

<div align="center">

**Artflow 后端服务 | Pixiv 素材工作流与视频生成引擎**

面向私有部署的 Pixiv 素材采集、AI 工作流、视频合成与多平台发布后端。

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg?style=for-the-badge)](https://www.gnu.org/licenses/gpl-3.0)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.6+-blue.svg?style=flat-square&logo=typescript)](https://www.typescriptlang.org/)
[![Node.js](https://img.shields.io/badge/Node.js-18%2B%20LTS-green.svg?style=flat-square&logo=node.js)](https://nodejs.org/)

</div>

> English summary: Artflow-core is the backend of Artflow — Pixiv asset collection (via [pixiv-cli](https://github.com/FlanChanXwO/pixiv-cli)), AI-assisted workflow, video rendering and multi-platform publish packaging, exposed as an HTTP API for [Artflow-studio](https://github.com/tianyin231/Artflow-studio). It is a GPL-3.0-or-later derivative of [PixivFlow](https://github.com/zoidberg-xgd/PixivFlow).

---

## 目录

[架构](#架构) • [快速开始](#快速开始) • [安装 pixiv-cli](#安装-pixiv-cli) • [环境变量](#环境变量) • [开发与测试](#开发与测试) • [端到端测试与本地全栈](#端到端测试与本地全栈) • [CLI](#cli兼容-pixivflow) • [许可与致谢](#开源许可与致谢)

---

## 架构

本仓库是 **Artflow-core** 后端；前端（Web / Electron / PWA）位于独立仓库 **[Artflow-studio](https://github.com/tianyin231/Artflow-studio)**，两者通过 HTTP API 通信。

```
Artflow-studio (React / Electron / PWA)
        │  HTTP /api/*
        ▼
Artflow-core  ──  WebUI API (express, 默认 127.0.0.1)
   ├─ pixiv-provider/   PixivProvider：pixiv-cli | MCP | legacy | fixture
   ├─ auth/             PKCE 登录、pixiv-cli 令牌导入、日志脱敏
   ├─ publishers/       Publisher 抽象 + 各平台适配器
   ├─ secrets/          SecretStore（AES-256-GCM）
   ├─ workflow/         工作流编排（WorkflowManager）、模板、发布日历
   ├─ renderer/         视频管线（fast / moviepy、ugoira、字幕、转场、壁纸导出）
   ├─ jobs/             进程内 JobQueue；/api/metrics
   ├─ ai/               AI 规划 schema、校验/修复、本地规则兜底
   └─ plugins-sdk/      插件 SDK（manifest 校验、definePlugin）
```

| 模块 | 说明 | 当前状态 |
|---|---|---|
| **PixivProvider** | 统一的 Pixiv 访问接口。默认通过子进程调用 [pixiv-cli](https://github.com/FlanChanXwO/pixiv-cli)（不经 shell、令牌不进 argv）；也支持 `pixiv mcp`、原 PixivFlow 客户端（legacy）和离线 fixture。 | 已接入 WorkflowManager |
| **登录** | OAuth 2.0 PKCE 会话（`/api/auth/login/start` → `/login/complete`），或通过 pixiv-cli 导入 refresh token（`/api/auth/import-token`）；多账号切换、代理连通性测试。账号密码自动化登录已废弃（返回 410）。 | 已接入 `/api/auth` |
| **Publisher** | 本地导出、Wallpaper Engine、Bilibili、YouTube、Telegram、Steam Workshop、抖音、小红书（导出包）、Discord webhook。 | `/api/publishers` 提供列表与 dry-run |
| **SecretStore** | 平台凭据加密存储（AES-256-GCM，密钥文件 0600）。 | 库 + 测试，待接入发布流程 |
| **视频管线** | fast（ffmpeg）与 moviepy 渲染器、ugoira、封面模板、渲染预设、字幕、转场、节拍、WE 循环视频/网页壁纸。 | 库 + 测试；工作流目前仍使用 `scripts/workflow-render-video.py`，并已支持重渲染选项（转场/封面/字幕） |
| **JobQueue / metrics** | 按任务类型限并发、重试次数；`/api/metrics`。 | 队列为库，metrics 路由已挂载 |
| **AI 规划** | 计划 JSON schema、校验 + 自动修复、本地规则兜底；离线评测 `npm run eval:ai`（见 [docs/ai-eval-report.md](docs/ai-eval-report.md)）。工作流中的 AI 调用使用在 Studio「AI 集成」页配置的 OpenAI 兼容模型。 | 库 + 评测 |
| **模板 / 日历 / 插件** | 内置工作流模板、发布排期（RRule）、插件 SDK。 | 库 + 测试 |

> “库 + 测试”表示模块已实现并有单元测试，但尚未全部接入 HTTP API / 主工作流，后续 PR 逐步接入。

---

## 快速开始

### 环境要求

- **Node.js 18+**（推荐 LTS：20.x / 22.x）和 **npm 9+**
- **[pixiv-cli](#安装-pixiv-cli)**（真实抓取 Pixiv 时需要；离线 fixture 模式不需要）
- **ffmpeg**（视频合成）
- **Python 3 + moviepy**（可选，moviepy 渲染器 / `scripts/workflow-render-video.py` 使用；`npm run setup:python` 安装依赖）
- Windows 用户推荐 WSL；Android/Termux 见 [Termux 安装指南](docs/TERMUX_INSTALL.md)

### 安装与运行

```bash
git clone https://github.com/tianyin231/Artflow-core.git
cd Artflow-core
npm install
npm run setup:python      # 可选：安装 Python 渲染依赖
npm run build
npm run webui             # 启动 WebUI 后端 API，默认 http://127.0.0.1:3000
```

- 服务默认只监听 **127.0.0.1**；需要局域网访问时设置 `HOST=0.0.0.0`（请自行做好访问控制）。
- 端口通过 `PORT` 修改。Artflow-studio 开发服务器默认把 `/api` 代理到 `127.0.0.1:3300`，配合使用时可 `PORT=3300 npm run webui`，或在 studio 侧设置 `VITE_DEV_API_PORT`。
- 配置文件默认位于 `~/.pixivflow/config/standalone.config.json`；可用 `ARTFLOW_CONFIG` 指定文件，或用 `ARTFLOW_DATA_DIR` 把配置与数据隔离到单独目录。缺少 refresh token 时只告警、不阻止启动，可在 Studio 的「账号与连接」页登录。

### 5 分钟离线体验（fixture 模式）

不需要 Pixiv 账号：使用内置 fixture 数据和 mock 服务，同时启动 core 与 studio（需要把 Artflow-studio 克隆到同级目录）：

```bash
git clone https://github.com/tianyin231/Artflow-core.git
git clone https://github.com/tianyin231/Artflow-studio.git
(cd Artflow-core && npm install) && (cd Artflow-studio && npm install)
cd Artflow-core
npm run dev:stack:fixture         # = bash scripts/dev/dev-stack.sh --fixture
# 就绪后打开 http://127.0.0.1:5373 （core: 127.0.0.1:3300，mock: 127.0.0.1:3302）
```

### Docker

```bash
docker compose -f deploy/docker-compose.yml up -d                       # core + studio
ARTFLOW_FIXTURE_MODE=1 docker compose -f deploy/docker-compose.yml --profile fixture up
```

> `deploy/docker-compose.yml` 中的 studio 服务需要 Artflow-studio 提供 Dockerfile（尚未提供，当前为草稿）。仓库根目录的 `docker-compose.yml` 是继承自 PixivFlow 的旧版定时下载/WebUI 编排，详见 [Docker 使用指南](docs/DOCKER.md)。

---

## 安装 pixiv-cli

Artflow-core 通过 [FlanChanXwO/pixiv-cli](https://github.com/FlanChanXwO/pixiv-cli) 访问 Pixiv。按该项目 README 安装（下载 Release 二进制或从源码构建）后，二选一：

1. 把可执行文件放到 `PATH` 中，命名为 `pixiv`（默认查找 `pixiv`）；或
2. 设置 `PIXIV_CLI_PATH=/path/to/pixiv`（也可在配置文件中设置 `pixiv.cliPath`）。

查找顺序：配置 `pixiv.cliPath` > `PIXIV_CLI_PATH` > `ARTFLOW_PIXIV_CLI`（旧名，兼容）> `PATH` 中的 `pixiv`。
pixiv-cli 的登录状态默认保存在 `~/.pixiv-cli`，可用 `PIXIV_CLI_HOME` 指定另一个 HOME 目录。

---

## 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `HOST` / `ARTFLOW_HOST` | `127.0.0.1` | 监听地址 |
| `PORT` | `3000` | API 端口 |
| `ARTFLOW_CONFIG` | — | 配置文件路径 |
| `ARTFLOW_DATA_DIR` | — | 数据/配置隔离目录（fixture、测试、容器） |
| `ARTFLOW_PIXIV_PROVIDER` | `pixiv-cli` | `pixiv-cli` / `mcp` / `legacy` / `fixture` |
| `ARTFLOW_FIXTURE_MODE` | `0` | `1` = 离线 fixture 模式 |
| `ARTFLOW_FIXTURE_DIR` | 内置 `fixtures/pixiv` | 自定义 fixture 目录 |
| `PIXIV_CLI_PATH` | `pixiv`（PATH） | pixiv-cli 可执行文件；旧名 `ARTFLOW_PIXIV_CLI` |
| `PIXIV_CLI_HOME` | 当前 `HOME` | pixiv-cli 状态目录；旧名 `ARTFLOW_PIXIV_CLI_HOME` |
| `ARTFLOW_AUTH_IMPORTER` | 自动 | `cli` = 强制使用 pixiv-cli 导入令牌 |
| `ARTFLOW_PIXIV_OAUTH_BASE_URL` | `https://oauth.secure.pixiv.net` | OAuth 地址（测试时指向 mock） |
| `ARTFLOW_PIXIV_CLIENT_ID` / `ARTFLOW_PIXIV_CLIENT_SECRET` | Pixiv 官方客户端 | PKCE 换取令牌所用客户端 |
| `ARTFLOW_PYTHON` | 自动探测 | moviepy 渲染所用 Python |
| `ARTFLOW_TIMEZONE` | 系统时区 | 文件命名/日期使用的时区 |
| `ARTFLOW_SKIP_EXTERNAL_BGM` | — | `1` = 不联网下载 BGM |
| `ARTFLOW_SECRET_KEY` / `ARTFLOW_SECRET_KEY_FILE` | `$ARTFLOW_DATA_DIR/secret.key` | SecretStore 密钥 |
| `ARTFLOW_BILIBILI_CLIENT_ID` / `_CLIENT_SECRET` / `_REDIRECT` / `_BASE_URL` | — | B站开放平台 |
| `ARTFLOW_TELEGRAM_BOT_TOKEN` / `ARTFLOW_TELEGRAM_CHAT_ID` | — | Telegram 发布 |
| `ARTFLOW_DISCORD_WEBHOOK` | — | Discord webhook 发布 |
| `ARTFLOW_STEAMCMD` / `ARTFLOW_STEAM_USER` | — | Steam Workshop 上传 |

⚠️ 凭据只通过环境变量或 SecretStore 提供，**不要提交到仓库**。

---

## 开发与测试

```bash
npm run build            # tsc
npm run lint             # eslint
npm test                 # jest（全部单元/集成测试，离线；网络访问被测试 setup 拦截）
npm run test:fixture     # 只跑 provider / renderer 的 fixture 测试
npm run test:slow        # 慢测试（真实 moviepy 渲染，需要 Python + moviepy + ffmpeg）
npm run eval:ai          # AI 规划离线评测
```

- 建议分别在 `TZ=UTC` 与 `TZ=Asia/Shanghai` 下运行测试（时区相关用例）。
- 真实 pixiv-cli 冒烟测试默认跳过；设置 `ARTFLOW_REAL_PIXIV_CLI=/path/to/pixiv` 启用。

## 端到端测试与本地全栈

`scripts/dev/` 下的脚本默认在同级目录寻找 Artflow-studio，可用 `ARTFLOW_STUDIO_DIR` 指定；本地状态写入 `.artflow-dev/`（已 gitignore）。

| 命令 | 说明 |
|---|---|
| `npm run dev:stack` / `dev:stack:fixture` | 启动 mock + core + studio（`--prod` 用生产构建 + `vite preview`）；端口冲突或任一进程失败立即退出并清理进程组 |
| `npm run verify:all` | 一键验证：core/studio 构建、lint、测试（UTC + Asia/Shanghai）、compose 校验、Playwright E2E、AI 评测、i18n、密钥扫描 |
| `npm run scan:secrets` | 扫描工作区、日志、报告与 git 历史中的测试哨兵值 |
| `npm run validate:compose` | 静态校验 `deploy/docker-compose.yml` |
| `node scripts/dev/wait-healthy.mjs` | 等待 core / studio 健康 |

Playwright E2E 位于 Artflow-studio：在 studio 目录运行 `npx playwright test`，会自动调用本仓库的 `scripts/dev/dev-stack.sh --fixture --prod`（通过 `ARTFLOW_CORE_DIR` 指定本仓库位置，默认 `../Artflow-core`）。

---

## CLI（兼容 PixivFlow）

继承自 PixivFlow 的命令行仍可使用，命令名为 `pixivflow`：

```bash
pixivflow login                      # 登录（交互式）
pixivflow refresh <refresh_token>    # 无图形界面服务器：直接写入 refresh token
pixivflow download                   # 按配置下载
pixivflow download --url <url>       # 按 URL 下载（插画/小说/系列/用户）
pixivflow scheduler                  # 定时任务
pixivflow health                     # 健康检查
pixivflow status | logs | dirs       # 统计 / 日志 / 目录
pixivflow config show|set|backup|restore|validate
pixivflow webui                      # 启动 WebUI 后端 API
```

基本配置示例：

```json
{
  "targets": [
    { "type": "illustration", "tag": "風景", "limit": 20, "minBookmarks": 500 }
  ],
  "scheduler": { "enabled": true, "cron": "0 2 * * *" }
}
```

更多：[快速开始](docs/QUICKSTART.md) · [配置](docs/CONFIG.md) · [使用指南](docs/USAGE.md) · [API](docs/API.md) · [脚本](docs/SCRIPTS.md) · [Docker](docs/DOCKER.md)

---

## 安全提示

- 配置文件和 pixiv-cli 状态目录包含认证信息，请勿分享或提交到仓库。
- API 不回显令牌，日志经过脱敏（`auth/redact`）。
- 服务默认只监听本机；对外暴露前请加反向代理与鉴权。

---

## 开源许可与致谢

本项目以 [GPL-3.0-or-later](LICENSE) 许可开源，基于 [PixivFlow](https://github.com/zoidberg-xgd/PixivFlow)（GPL-3.0 时期的 v2.0.x 版本）二次开发，保留原许可证与版权声明。修改后的代码同样必须以 GPL 兼容方式开源。

- [PixivFlow](https://github.com/zoidberg-xgd/PixivFlow) — 本项目的上游（上游后续版本已改为 MIT 许可；本仓库继承的是 GPL-3.0 版本，若移植上游 MIT 代码请同时保留其 MIT 声明）
- [pixiv-cli](https://github.com/FlanChanXwO/pixiv-cli)（MIT）— Pixiv 访问；本项目以外部可执行文件方式调用，未包含其源码
- [PixivBatchDownloader](https://github.com/xuejianxianzun/PixivBatchDownloader) — 灵感来源
- [get-pixivpy-token](https://github.com/eggplants/get-pixivpy-token) — OAuth 认证实现参考

问题反馈与建议请使用本仓库 Issues；贡献流程见 [CONTRIBUTING.md](docs/project/CONTRIBUTING.md)，更新记录见 [CHANGELOG.md](docs/project/CHANGELOG.md)。
