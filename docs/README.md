# Artflow-core 文档

Artflow-core 是 Artflow 的后端服务，负责 Pixiv 素材抓取、AI 工作流、视频生成、发布包生成和 Web API。

当前目录中保留了部分上游文档，主要用于查询 CLI、配置、登录、Docker 和 API 细节。上传仓库时，以根目录 README 中的 Artflow 部署说明为准。

## 核心文档

- **[快速开始](./QUICKSTART.md)**: 3分钟上手。
- **[配置手册](./CONFIG.md)**: 完整配置参数说明。
- **[使用指南](./USAGE.md)**: 功能详解。
- **[登录指南](./LOGIN.md)**: 账号登录相关。
- **[Docker 部署](./DOCKER.md)**: 容器化部署方案。

## 进阶文档

- [脚本工具](./SCRIPTS.md): 实用维护脚本。
- [架构设计](./ARCHITECTURE.md): 系统架构与 API。
- [API 参考](./API.md): RESTful 接口文档。
- [Termux 安装](./TERMUX_INSTALL.md): Android 手机运行指南。

---

## 快速开始

### 安装

从源码部署：

```bash
git clone https://github.com/tianyin231/Artflow-core.git
cd Artflow-core
npm install
npm run setup:python
npm run build
```

### 运行

1. **启动 Web API**
   ```bash
   npm run webui
   ```

2. **登录或命令行下载**
   ```bash
   npm run login
   npm run download
   ```

当前兼容 CLI 命令名仍为 `pixivflow`，旧文档中的命令可以按兼容命令理解。

---

## 功能特性

- **独立运行**: 后端可独立运行，也可配合 Artflow-studio 使用。
- **自动化**: 支持定时任务和工作流计划。
- **AI 工作流**: 支持 AI 规划、BGM 选择、镜头配方和发布文案生成。
- **视频生成**: 支持封面确认、视频合成、来源角标和本地 BGM。
- **高性能**: 异步并发下载，自动处理限流。
- **多模式**: 支持搜索、排行榜、画师全集、小说系列等。
- **API 支持**: 提供 RESTful API 和 WebSocket，方便二次开发。

## 帮助与支持

- 当前仓库 Issues
- 当前仓库 Discussions
