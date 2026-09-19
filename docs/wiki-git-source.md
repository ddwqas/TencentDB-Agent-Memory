# Wiki Git 文档来源

创建 Wiki 时选择“手动上传文档”或“Git 仓库”。Git Wiki 绑定一个仓库、一个分支和一个文档子目录。创建后在“原始文档”页点击“仅同步文档”，再勾选需要分析的原文；也可使用“同步并分析全部待处理文档”快捷入口。不支持改绑、切换来源或混合上传。

## 配置与接口

知识服务使用 `POST /v3/wiki/create` 创建；Panel 对应 `POST /api/v1/knowledge/wiki/create`：

```json
{
  "team_id": "team-id",
  "name": "舆论研读",
  "source_type": "git",
  "repo_url": "https://git.example.com/team/novels.git",
  "branch": "main",
  "docs_path": "output/舆论研读与应用"
}
```

分支必须填写，`docs_path` 留空表示整个仓库。仓库地址及认证沿用 Code 的 Git 拉取能力；私有仓库使用知识服务运行环境的 Git 凭据，不在 URL 中填写 HTTP 令牌或密码。远程仓库中必须已经包含目标提交，未提交或未推送的本地修改不会被同步。

`POST /v3/wiki/sync` 和 Panel 的 `POST /api/v1/knowledge/wiki/sync` 接收 `{"wiki_id":"wiki-id"}`，异步返回 202。原有 `/wiki/ingest` 对 Git Wiki 也执行同步后分析。通过 `/wiki/get` 查看 `ingest_status`、`internal_status`、`sync_error` 和 `git.last_sync`。

Git Wiki 的 `/raw/write`、`/raw/rm` 返回 409，原文通过仓库更新；原文读取、知识页面操作、搜索、版本历史和回滚沿用现有接口。

## 增量与版本

- 每次同步固定完整 commit，只获取指定目录下受 Git 跟踪的普通 `.md` 文件，扩展名不区分大小写。保留相对目录，禁止路径穿越和 Markdown 符号链接。
- 单文件限制为 5 MiB。全部文件通过校验后，才替换待处理原文；目录错误、文件超限等会明确报告路径，不会静默跳过。
- 比较基线来自当前生效版本的源文件索引。新增和修改进入分析，重命名作为删除旧路径和新增路径处理，未变化且已成功分析的文档跳过。
- Git 删除的原文显示为“待确认删除”，同步及批量分析都不会自动清理知识。勾选后单独确认清理，才生成新版本并删除独占知识及悬空引用，共享知识保留其余来源；支持确认全部删除以及版本回滚。
- 没有差异且没有失败待重试项时，不调用 LLM、不分配新版本；`git.last_sync.commit_hash` 记录检查到的提交，`git.commit_hash` 仍表示当前发布版本的资料提交。
- 构建沿用现有候选版本发布规则。全部待分析文档失败时不发布；部分失败沿用现有发布策略，并显示失败路径和原因。再次同步同一个 commit 会重试失败文档。
- 版本清单中的 `git_source` 记录本批输入的仓库、分支、目录和完整 commit；分批分析时，未选中知识可能来自较早提交，不能将这个 commit 理解为所有知识均已更新。各文档状态以当前生效版本的源索引为准。手动修改产生的版本继承来源，回滚恢复所选版本的提交与源索引。

Git 缓存位于 Wiki 独立的 `git-cache` 子目录，Git reset/clean 不作用于原文、SQLite 索引或发布版本。来源配置和最近同步统计使用已有 `metadata_json` 存储，无需修改旧数据库结构。

## AI 分析与中断续跑

“原始文档”页默认不勾选，支持名称/路径搜索、目录及状态筛选、每页 50 项、全选当前页、全选筛选结果、选择整个目录、选择待处理或失败文档。勾选跨分页和筛选保留。上传型 Wiki 与 Git Wiki 使用同一套选择分析和版本流程。

- **分析所选文档**：只处理选中的新增、变更及失败文档，成功且未变化的原文直接跳过。未选中原文、已发布知识和共享来源不会被当作删除项。
- **强制重新分析**：需单独确认，用于已分析且未变化的文档；新任务不复用上次的 AI 结果，同一任务暂停后继续仍复用自己的检查点。
- **仅同步文档**：只更新 Git 原文及差异，不调用 AI、不生成知识版本。同步中断后需要重新同步，不会自动变为 AI 续跑。
- **确认清理所选删除项**：单独确认，不能清理仓库中仍然存在的原文；回滚可恢复清理前的知识。
- 提交时将选择范围、当前知识基线和完整原文快照固定到任务中。后续上传或“仅同步文档”不会改变已暂停任务的输入。启动新选择会替代旧任务的续跑入口，页面会提示确认；基线版本已变化时必须新建分析任务。
- 页面分别显示本批分析进度和全库已完成数。本批完成不代表全库完成。

新增接口（知识服务前缀 `/v3`，Panel 前缀 `/api/v1/knowledge`）：

| POST 接口 | 请求 | 行为 |
| --- | --- | --- |
| `/wiki/documents` | `{"wiki_id":"wiki-id"}` | 返回 `items`（路径、大小、状态、失败原因）、`total`、`completed`、`deleted` |
| `/wiki/sync-documents` | `{"wiki_id":"wiki-id"}` | 202，异步仅同步 Git 原文 |
| `/wiki/analyze` | `{"wiki_id":"wiki-id","filenames":["章节/文档.md"],"force":false}` | 202，固定所选范围并分析 |
| `/wiki/analyze` | `{"wiki_id":"wiki-id","filenames":[],"deleted_filenames":["旧文档.md"]}` | 202，确认清理指定删除项 |

无选择、非法路径、删除仍存在的原文返回 400；正在执行任务时返回 409；跨租户访问返回 404。`/wiki/get` 增加 `document_summary` 与 `selection_resumable`，`analysis.selected_count`、`analysis.cleanup_count` 为本批固定范围数量。

详情页展示持久化的 AI 分析阶段、完成数、失败数、复用检查点数量及当前文件，刷新页面或重启面板后仍可查看。原文抽取完成后才合并知识并发布版本，因此首次分析期间知识页数量可能仍为零。

- **暂停 AI 分析**：停止在途模型调用和后续分析，保存已完成的模型响应、文档候选页和进度；已发布版本继续可用。
- **继续 AI 分析**：使用上次中断时的 Git 文档快照，不拉取新提交；恢复已经保存的 AI 结果并处理剩余文档。原始资料相同、知识基线及模型配置相同时，不重复调用已经完成的 AI 请求。
- **同步并分析全部待处理文档**：重新获取远端指定分支的最新提交，分析全部新增、变更及失败文档，仍需单独确认删除清理。
- 服务重启会把正在分析的 Wiki 标记为“已暂停”，等待用户手动继续，不会自动重新启动付费模型调用。

知识服务新增 `POST /v3/wiki/pause` 和 `POST /v3/wiki/resume`，Panel 对应 `/api/v1/knowledge/wiki/pause`、`/resume`；请求为 `{"wiki_id":"wiki-id"}`，返回 202，未运行的分析请求暂停返回 409。`/wiki/get` 的 `analysis` 字段提供持久进度，`ingest_status` 增加 `paused`。

检查点保存在 Wiki 数据目录内的 `analysis-cache`，进度为 `analysis-progress.json`。这一能力只能保存新代码运行之后产生的结果，无法自动补写旧进程中尚未落盘的内存数据。

## 验证

`MemoryKnowledge/src/store/wiki-git.test.ts` 使用临时 Git 仓库和真实 SQLite、版本引擎，仅替代 LLM 输出。覆盖增删改、重命名、共享知识删除、无变化跳过、失败重试、回滚后同步、访问隔离、禁止混合上传，以及 2,615 个嵌套文件和超过浏览器上传限制的文档。

```powershell
cd MemoryKnowledge
pnpm test
pnpm typecheck
```
