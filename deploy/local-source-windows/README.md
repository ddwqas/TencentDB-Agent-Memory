# Windows 本地源码运行

这套脚本在 Windows 宿主机上安装、构建并运行完整源码栈：

| 服务 | 源码目录 | 默认地址 |
|---|---|---|
| MemoryCore | `MemoryCore` | <http://127.0.0.1:8420> |
| MemoryKnowledge | `MemoryKnowledge` | <http://127.0.0.1:8424> |
| MemoryPanel | `MemoryPanel` | <http://127.0.0.1:8125> |
| MemoryProxy | `MemoryProxy` | <http://127.0.0.1:8096> |

服务均为本机进程，不使用 Docker。SQLite 数据、进程记录和日志集中保存在本目录的 `.runtime`，不会写入源码模块。

## 环境要求

- Windows 10/11
- PowerShell 7（`pwsh`）
- Windows x64；推荐预先安装 Node.js 22.16 或更高的 22.x 版本
- npm
- pnpm
- Git

`build.ps1` 和 `start-all.ps1` 会强制使用 Node.js 22。当前 Node 不是 22.x 时，脚本会从
Node.js 官网下载最新的 Windows x64 ZIP，校验 SHA-256 后解压到 `.runtime/tools`。PATH
只对当前脚本及其启动的子进程生效，不会修改系统 Node.js，也不影响其他工程使用 Node 24。

依赖包含原生 Node.js 模块；没有对应预编译包时，需要安装 Visual Studio 2022 Build Tools 的“使用 C++ 的桌面开发”工作负载。

## 构建

先停止占用同一组端口的 Docker 版，再准备配置：

```powershell
cd deploy\global-images
.\stop-all.ps1

cd ..\local-source-windows
Copy-Item .env.example .env
notepad .env
```

填写两组 LLM 参数后安装依赖并构建：

```powershell
.\build.ps1
```

`build.ps1` 执行各模块自己的构建方式：

- MemoryCore：安装依赖并构建运行插件产物
- MemoryKnowledge：安装依赖并构建 `dist`
- MemoryPanel：构建后端和 Web 前端，后端同源托管前端产物
- MemoryProxy：安装运行依赖，启动时由 `tsx` 加载源码

只重新生成构建产物时可跳过安装：

```powershell
.\build.ps1 -SkipInstall
```

## 运行

```powershell
.\start-all.ps1
```

脚本按 MemoryCore、MemoryKnowledge、MemoryPanel、MemoryProxy 的顺序启动，并等待每个服务的健康检查完成。首次启动会创建本地管理员，用户 key 保存在 `.admin-key`。

查看状态和日志位置：

```powershell
.\status.ps1
Get-Content .\.runtime\logs\proxy.stderr.log -Wait
```

停止服务并保留 SQLite 数据：

```powershell
.\stop-all.ps1
```

停止服务并删除运行数据、日志和管理员 key：

```powershell
.\stop-all.ps1 -Purge
```

PowerShell 执行策略受限时，可使用同名 `.cmd` 入口，例如 `build.cmd`、`start-all.cmd`、`status.cmd` 和 `stop-all.cmd`。

## 客户端接入

以 Claude Code 为例：

```powershell
$env:ANTHROPIC_BASE_URL='http://127.0.0.1:8096/claude-code/default'
$env:ANTHROPIC_AUTH_TOKEN=Get-Content .\.admin-key -Raw
claude --model <PROXY_UPSTREAM_MODEL>
```
