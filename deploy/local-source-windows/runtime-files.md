# `.runtime` 文件说明

`.runtime` 是 `local-source-windows` 的本机运行目录，由 `start-all.ps1` 自动创建和维护。它不属于源码，不应提交到 Git。

```text
.runtime/
├─ config/       运行时配置
├─ data/         用户数据和索引
├─ logs/         服务日志
└─ processes/    服务进程记录
```

## config：运行时配置

| 文件 | 负责服务 | 作用 |
| --- | --- | --- |
| `config/metadata-instances.json` | MemoryPanel | 记录本机实例 `default` 的 Core、Proxy 地址和访问配置。每次启动会按启动脚本重新生成。 |
| `config/proxy.yaml` | MemoryProxy | Proxy 的监听、上游、注入和存储配置。Windows 源码部署使用 `../data/proxy/proxy.db` 这样的相对数据库路径，Proxy 按该配置文件所在目录解析。每次启动会重新生成。 |

配置文件可以删除，下一次启动会重新生成；手工修改不会长期保留。

## data：持久化用户数据

### `data/memory-core/`

由 MemoryCore 负责：

- `vectors.db`：本地记忆内容、BM25/向量索引及其 SQLite WAL 文件。
- `metadata/tdai_metadata_default/metadata.db`：用户、团队、助手、任务、资产等元数据。
- `.metadata/manifest.json`：MemoryCore 数据布局和存储清单。

### `data/knowledge/`

由 MemoryKnowledge 负责：

- `knowledge.db`：Wiki、Code Graph、LLM binding 和审计等业务元数据。
- `_wiki_engines/wiki-sources.json`：Wiki 引擎状态。现在保存相对于 `data/knowledge/` 的项目路径，例如 `default/team-x/wiki-x`。
- `{service_id}/{team_id}/{wiki_id}/`：Wiki 资产目录。
  - `raw/sources/`：用户上传的 Markdown/TXT 原文。
  - `wiki/`：Ingest 生成的知识页面、`index.md`、`overview.md` 等。
  - `index.db`：该 Wiki 的页面、来源、全文检索和图谱索引。
- `{service_id}/{team_id}/{code_graph_id}/`：Code Graph 源码副本及 `.codegraph/codegraph.db` 索引。

### `data/proxy/`

由 MemoryProxy 负责：

- `proxy.db`：Proxy 的会话、绑定、缓存等本地持久化数据及 SQLite WAL 文件。

## logs：诊断日志

由启动脚本重定向生成：

- `memory-core.stdout.log` / `memory-core.stderr.log`
- `knowledge.stdout.log` / `knowledge.stderr.log`
- `panel.stdout.log` / `panel.stderr.log`
- `proxy.stdout.log` / `proxy.stderr.log`
- `observability.log`

日志用于排查启动、请求、Ingest 和上游调用问题，不是业务数据。日志中可能包含本机绝对路径，删除不会影响用户数据。

## processes：进程状态

每个服务对应一个 `*.json`，记录 PID、启动时间以及 stdout/stderr 日志文件位置。`status.ps1` 和 `stop-all.ps1` 使用这些文件识别和停止本次启动的进程。

这些文件属于临时状态，服务停止后可以删除。为保证 PowerShell 在任意工作目录下都能正确管理服务，其中的日志路径可能使用绝对路径，这是预期行为。

## 备份、迁移和清理

- 完整备份用户数据：复制整个 `.runtime/data/`。
- 只备份 Wiki：复制 `.runtime/data/knowledge/`，不要只复制 `knowledge.db`，因为原文和生成页面在 Wiki 目录中。
- 停止服务不会删除 `.runtime`。
- 删除 `data/` 会删除用户数据；删除前应确认已完成备份。
- 旧版 `wiki-sources.json` 中的绝对路径会在下一次启动时兼容读取，并在对应目录存在时迁移为相对路径。
- `config/`、`logs/`、`processes/` 均可在服务停止后清理，下一次启动会重新创建必要文件。

