# Wiki Git 文档来源

创建 Wiki 时选择“手动上传文档”或“Git 仓库”。Git Wiki 绑定一个仓库、一个分支和一个文档子目录，创建后点击“同步并分析”开始处理。已有上传型 Wiki 的行为保持兼容；不支持改绑、切换来源或混合上传。

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
- 删除文档会清理独占知识及悬空引用，共享知识保留其余来源。已发布 Wiki 的源文档全部删除也会形成新的更新。
- 没有差异且没有失败待重试项时，不调用 LLM、不分配新版本；`git.last_sync.commit_hash` 记录检查到的提交，`git.commit_hash` 仍表示当前发布版本的资料提交。
- 构建沿用现有候选版本发布规则。全部待分析文档失败时不发布；部分失败沿用现有发布策略，并显示失败路径和原因。再次同步同一个 commit 会重试失败文档。
- 版本清单中的 `git_source` 记录仓库、分支、目录和完整 commit；手动修改产生的版本继承来源。回滚恢复当前版本的提交信息，后续同步仍与该生效版本比较。

Git 缓存位于 Wiki 独立的 `git-cache` 子目录，Git reset/clean 不作用于原文、SQLite 索引或发布版本。来源配置和最近同步统计使用已有 `metadata_json` 存储，无需修改旧数据库结构。

## AI 分析与中断续跑

详情页展示持久化的 AI 分析阶段、完成数、失败数、复用检查点数量及当前文件，刷新页面或重启面板后仍可查看。原文抽取完成后才合并知识并发布版本，因此首次分析期间知识页数量可能仍为零。

- **暂停 AI 分析**：停止在途模型调用和后续分析，保存已完成的模型响应、文档候选页和进度；已发布版本继续可用。
- **继续 AI 分析**：使用上次中断时的 Git 文档快照，不拉取新提交；恢复已经保存的 AI 结果并处理剩余文档。原始资料相同、知识基线及模型配置相同时，不重复调用已经完成的 AI 请求。
- **同步最新文档并分析**：重新获取远端指定分支的最新提交，沿用正常增量更新流程。
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
