# 本地源码 Docker：从零构建到启动

本目录用于 Windows 本地运行当前工作树。Dockerfile 直接从源码构建一个整体镜像，
最终只生成 `tdai-local/memory-stack:local`，运行时只启动一个容器：

| 项目 | 值 |
| --- | --- |
| 容器 | `tdai-memory-stack` |
| 镜像 | `tdai-local/memory-stack:local` |
| 基础镜像 | `node:22-alpine` |
| Memory Core | `http://localhost:8420/` |
| Panel UI / API | `http://localhost:8125/` |
| Knowledge API | `http://localhost:8424/v3/` |
| Proxy | `http://localhost:8096/` |

Core、Panel、Knowledge、Proxy 在同一个容器内启动，服务之间通过容器内回环地址通信，
不创建自定义 Docker 网络。依赖只在构建阶段下载，启动阶段不下载依赖。

## 1. 前置条件

需要准备：

- Windows PowerShell
- Docker Desktop，切换到 Linux containers，并确认 Docker 引擎正在运行
- 当前仓库源码完整可读
- 首次构建时可以访问必要的容器镜像、Alpine 软件包和 npm 依赖源

确认 Docker 可用：

```powershell
docker version
```

Dockerfile 默认使用 `node:22-alpine`。如果 Docker Hub 在当前环境不可达，先从可访问的
镜像源下载同一镜像，再打成本地标签：

```powershell
docker pull docker.m.daocloud.io/library/node:22-alpine
docker tag docker.m.daocloud.io/library/node:22-alpine node:22-alpine
```

这一步只准备构建必需的基础镜像，不会配置代理，也不会改变运行时网络。

## 2. 首次配置

从仓库根目录进入部署目录，复制配置模板：

```powershell
cd deploy\local-source-docker
Copy-Item .env.example .env
notepad .env
```

至少填写以下配置：

```dotenv
MEMORY_LLM_BASE_URL=https://你的-memory-LLM地址/v1
MEMORY_LLM_API_KEY=你的-memory-LLM密钥
MEMORY_LLM_MODEL=你的-memory-模型名

PROXY_UPSTREAM_URL=https://你的-proxy-上游地址/v1
PROXY_UPSTREAM_API_KEY=你的-proxy-上游密钥
PROXY_UPSTREAM_MODEL=你的-proxy-模型名
```

`MEMORY_LLM_*` 用于记忆服务，`PROXY_UPSTREAM_*` 用于 Proxy 转发。两组可以使用同一
个服务，也可以分别使用不同服务。`.env` 含密钥，只保留在本机，不要提交到版本库。

默认端口和数据卷通常不需要修改：

```dotenv
MEMORY_CORE_PORT=8420
PANEL_PORT=8125
KNOWLEDGE_PORT=8424
PROXY_PORT=8096
MEMORY_CORE_VOLUME=tdai-local-memory-core-data
PANEL_VOLUME=tdai-local-panel-data
PROXY_VOLUME=tdai-local-proxy-data
```

如果这些端口被占用，修改宿主机端口即可，例如 `PANEL_PORT=18125`；容器内部端口不变。

## 3. 从源码构建整体镜像

仍在 `deploy\local-source-docker` 目录执行：

```powershell
.\build.ps1
```

脚本会在一个 Dockerfile 构建流程中完成：

1. 安装 Alpine 编译工具和 npm 依赖
2. 编译 Memory Core、Memory Proxy、Panel API、Panel UI、Knowledge
3. 将编译结果复制到最终运行层
4. 生成唯一镜像 `tdai-local/memory-stack:local`

构建阶段可能需要较长时间，原生依赖和前端依赖会写入 Docker 缓存。源码没有变化的部分
会复用缓存，不会每次重新下载。

确认镜像已生成：

```powershell
docker image inspect tdai-local/memory-stack:local
```

如果所有依赖和基础镜像已经在本机缓存，可以使用完全离线的构建：

```powershell
.\build.ps1 -Offline
```

从零开始时不要使用 `-Offline`，否则缺少的基础镜像或依赖无法下载。需要强制重建全部
缓存层时才使用：

```powershell
.\build.ps1 -NoCache
```

## 4. 启动整体容器

构建完成后执行：

```powershell
.\start-all.ps1
```

`start-all.ps1` 只负责启动，不构建镜像。它会：

- 读取 `.env`
- 移除同名旧容器和旧三件套容器（不删除数据卷）
- 映射四个服务端口
- 挂载三个 Docker 数据卷和 admin key 文件
- 启动 `tdai-memory-stack`
- 等待四个健康端点全部可用

启动成功后，容器应显示为 `healthy`：

```powershell
docker ps --filter name=tdai-memory-stack
```

也可以直接检查脚本状态：

```powershell
.\verify.ps1 -SkipLlm
```

四个健康地址：

```text
http://127.0.0.1:8420/health
http://127.0.0.1:8424/health
http://127.0.0.1:8125/health
http://127.0.0.1:8096/health
```

查看整体容器日志：

```powershell
docker logs -f tdai-memory-stack
```

## 5. 源码变更后重建

源码变更不会自动进入已经生成的镜像。重新构建并启动：

```powershell
.\build.ps1
.\start-all.ps1
```

启动脚本会替换旧容器，但保留数据卷。运行中的记忆数据、Knowledge 数据、Proxy 数据
和 admin key 不会因普通重启丢失。

## 6. 停止和清理

只停止并移除容器，保留数据：

```powershell
.\stop-all.ps1
```

删除容器、数据卷、生成配置和 admin key：

```powershell
.\stop-all.ps1 -Purge
```

`-Purge` 会清空本地持久化数据。确认不再需要已有记忆和 Knowledge 数据后再执行。

## 7. 常见问题

### 找不到 `node:22-alpine`

先执行前置条件中的 `docker pull` 和 `docker tag`，确认本机存在：

```powershell
docker image inspect node:22-alpine
```

### `-Offline` 构建失败

说明本机缓存不完整。先执行一次普通构建下载缺失内容，再执行：

```powershell
.\build.ps1
.\build.ps1 -Offline
```

### 容器没有变成 `healthy`

查看启动日志：

```powershell
docker logs --tail 200 tdai-memory-stack
```

常见原因是端口被占用、`.env` 中 LLM 配置为空，或 Docker Desktop 的 Linux 引擎未运行。

### 端口被占用

修改 `.env` 中对应的宿主机端口，例如：

```dotenv
PANEL_PORT=18125
```

然后重新启动：

```powershell
.\start-all.ps1
```

## 文件说明

| 文件 | 作用 |
| --- | --- |
| `Dockerfile` | 从源码直接构建单一整体镜像 |
| `_lib.ps1` | 本地 Docker 脚本公共函数 |
| `build.ps1` | 构建 `tdai-local/memory-stack:local` |
| `start-all.ps1` | 只启动整体容器，不构建 |
| `stop-all.ps1` | 停止容器，可选择清理数据 |
| `verify.ps1` | 检查镜像、容器和健康状态 |
| `start-unified.mjs` | 容器内按顺序启动四个服务 |
| `.env.example` | 首次配置模板 |

`deploy\global-images` 仍用于已发布镜像的三件套部署；本目录只用于当前源码的本地
构建和验证。
