# `.runtime` 文件说明

`.runtime` 是 `local-source-windows` 的本机运行目录，由 `start-all.ps1` 自动创建和维护。它不属于源码，不应提交到 Git。

```text
.runtime/
├─ config/       运行时配置
├─ data/         用户数据和索引
├─ downloads/    便携 Node.js 的下载压缩包
├─ logs/         服务日志
├─ processes/    服务进程记录
└─ tools/        解压后的便携 Node.js 22
```

`downloads/` 和 `tools/` 都可安全删除；系统 Node.js 不是 22.x 时，下次构建或启动会自动
重新下载。删除它们不会影响 `data/` 中的业务数据。

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

- 完整整机备份：先停止全部服务，再复制整个 `.runtime/`；不要只复制 `data/`。可运行
  `./backup-runtime.ps1`，脚本会停止服务、复制完整目录，并逐文件比较大小和 SHA-256。
- `./backup-runtime.ps1 -Restart` 只会在全部文件校验成功后重新启动服务；校验失败时服务保持停止。
- 整机恢复属于灾难恢复：停止服务后，用完整备份覆盖当前 `.runtime`，会恢复到备份时状态。
- Web「迁移中心」属于跨实例的追加迁移：只支持 Skill、Wiki、Code Graph，每次导入均创建
  新 ID 和副本，不覆盖目标数据，也不导入 Agent、Agent L0–L3、Chat Memory、Task 或资产绑定。
- 同名对象会自动改名：Wiki / Code Graph 追加“（导入 N）”；Skill 的 `name` 受可移植格式
  `^[a-z0-9][a-z0-9-]*$` 约束，因此追加 `-import-N`。
- Wiki / Code Graph 的迁移包采用“可读文件快照 + 元数据”的方式，导入时不联网、不调用 LLM、
  不重建索引；Code Graph 保留原 `repo_url`，以后可由用户手动同步。
- 迁移上传包处理完即删除，失败重试需要重新选择原 ZIP；逐项报告默认保留 30 天。

### 在 Web 中导出指定对象并追加导入

1. 在源实例选择团队，打开“迁移中心”，勾选要导出的 Skill、Wiki、Code Graph，下载 ZIP。
2. 在目标实例选择目标团队，打开“迁移中心”并选择该 ZIP；页面会先显示对象、目标名称和
   源端导出失败项，不会直接写入。
3. 勾选本次要导入的对象并点击“追加导入”。每项独立处理，部分失败不会回滚已成功项；
   结果页会列出源 ID、新 ID、新名称或错误。
4. 若需重试失败项，点击“重试失败项”并重新选择原 ZIP。页面只会勾选失败项，避免再次
   导入已成功对象。

迁移包内部正是“文件快照 + 必要 SQLite 索引 + 少量元数据”：Wiki / Code Graph 的大部分
落地文件直接复制，业务记录和权限资产则通过导入流程以新 ID 追加。这比手工跨实例复制目录
安全，因为手工复制不会补齐 `knowledge.db`、Core metadata 与 Wiki 引擎登记。只有整机灾难
恢复才应在停服后整体替换 `.runtime`；该操作会覆盖目标状态，不属于追加导入。

- 只备份 Wiki：复制 `.runtime/data/knowledge/`，不要只复制 `knowledge.db`，因为原文和生成页面在 Wiki 目录中。
- 停止服务不会删除 `.runtime`。
- 删除 `data/` 会删除用户数据；删除前应确认已完成备份。
- 旧版 `wiki-sources.json` 中的绝对路径会在下一次启动时兼容读取，并在对应目录存在时迁移为相对路径。
- `config/`、`logs/`、`processes/` 均可在服务停止后清理，下一次启动会重新创建必要文件。
