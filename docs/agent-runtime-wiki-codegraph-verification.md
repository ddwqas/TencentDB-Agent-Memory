# 会话 Agent 使用 Wiki 与 CodeGraph：运行时验证指南

## 目的

本文用于验证会话 Agent 如何关联、注入并按需使用 Wiki 与 CodeGraph，并根据每一步的真实返回评估知识质量。

验证对象分为四层：

1. 绑定：Agent 是否绑定了 Wiki、CodeGraph 等固定资产。
2. 注入：绑定资产是否以可调用资源目录进入会话上下文。
3. 调用：Agent 是否按任务选择正确资源，并通过工具获取内容。
4. 使用：返回内容是否相关、准确、完整，并被本地工程验证后采用。

资源已绑定不等于资源已使用，工具调用成功也不等于知识质量合格。每个步骤都要保留请求、返回和判断依据。

## 核心结论

~~~text
选择 Team / Agent
    -> 查询 Agent 固定资产绑定
    -> 查询 Wiki / CodeGraph 资源明细
    -> Proxy 在 session_init 预热并缓存 <knowledge_tools>
    -> Agent 根据任务调用 tools/list
    -> Agent 调用 tools/call 获取 Wiki 页面或代码图结果
    -> 用返回内容形成方案
    -> 用当前工程本地源码、编译和测试确认
~~~

Wiki 与 CodeGraph 的职责不同：

| 资源 | 适合回答 | 不应替代 |
| --- | --- | --- |
| Wiki | 设计原因、背景权衡、团队定义、历史决策、使用约束 | 当前源码的精确内容 |
| CodeGraph | 模块结构、符号位置、类似实现、调用关系、依赖和影响范围 | 当前工作区未提交修改和最终编译结果 |
| 本地源码 | 当前工程的实际文件、版本、未提交修改和可编译实现 | 团队历史和设计背景 |

CodeGraph 的 match 是仓库对应关系提示，不是服务端调用权限。匹配时，结果可用于当前工程的结构和影响分析；不匹配或无法确认时，仍可作为外部实现参考，但不能把其中的路径、符号关系或调用链直接当作当前工程事实。

## 证据范围

本指南以当前仓库源码、Windows 本地运行记录和历史会话为证据。历史会话中的示例资源是：

~~~text
Agent:     agt-0k57f4qsbs
Team:      team-0k5xzl1n6f
Wiki:      wiki-phqlk01l
CodeGraph: cg-6rtgzo1b
Skill:     skl-0sax7XS1tyM6
~~~

实际验证时优先使用当前返回的 ID；上面的 ID 只用于复现历史会话，不应假定在其他环境中存在。

关键证据：

| 内容 | 位置 |
| --- | --- |
| 主会话：绑定、注入、命中、运行时示例 | C:\Users\admin\.codex\sessions\2026\09\04\rollout-2026-09-04T15-49-34-01a06b64-f7f7-7901-b908-59be9e2fe0bd.jsonl |
| 主会话中的绑定确认 | 主会话第 304 行附近 |
| 主会话中的运行时关联问题 | 主会话第 332 行附近 |
| 主会话中的 Wiki / CodeGraph 命中解释 | 主会话第 457 行附近 |
| 主会话中的 CodeGraph 使用结果 | 主会话第 1464 行附近 |
| 会话执行记录 | .record/agt-0k57f4qsbs_2026-09-04_15-58-52.log |
| 当前 Knowledge 服务日志 | deploy/local-source-windows/.runtime/logs/knowledge.stdout.log |
| 当前 Panel 绑定和资产日志 | deploy/local-source-windows/.runtime/logs/panel.stdout.log |
| 当前 Proxy 注入实现 | MemoryProxy/src/injection/injectors/knowledge-tools-injector.ts |
| 当前 Knowledge 工具路由 | MemoryKnowledge/src/routes/tools.ts |
| 当前 Proxy 资产查询 | MemoryProxy/src/knowledge/core-client.ts |
| 绑定写入逻辑 | MemoryPanel/src/panel/http/routes/knowledge/allocate-routes.ts |

会话 JSONL 和运行日志可能包含凭据、路径或用户信息。展示给他人前只保留验证所需字段，脱敏 Token、用户 key 和无关内容。

## 前置条件

验证时需要：

- MemoryCore、MemoryKnowledge、MemoryPanel、MemoryProxy 已启动。
- 当前部署的地址以实际配置为准。Windows 本地源码默认值为：Core 8420、Knowledge 8424、Panel 8125、Proxy 8096。
- 一个可用的 Team、Agent、Wiki 和 CodeGraph 绑定。
- 当前 Agent 使用的用户 key、服务 ID 和服务 Token。Token 只从本地环境读取，不写入文档或命令历史。
- 一个可以提出实际任务的 Agent 客户端，例如 Claude Code 或 CodeBuddy。

Windows 本地源码运行说明见 deploy/local-source-windows/README.md。服务已经运行时，不需要重复启动。

先确认服务可访问：

~~~powershell
Invoke-RestMethod 'http://127.0.0.1:8420/health'
Invoke-RestMethod 'http://127.0.0.1:8424/health'
Invoke-RestMethod 'http://127.0.0.1:8096/health'
~~~

记录三个返回，并确认服务地址、版本和状态符合当前部署。这里只确认运行状态，不把健康检查当成知识质量结论。

## 验证步骤

### 1. 确认 Agent 的身份和会话

在客户端发起一次普通请求，确认会话初始化选择了 Team 和 Agent。记录：

~~~text
session_id
team_id
agent_id
space_id
agent source
~~~

检查 Proxy 日志或会话记录中是否出现本次会话的 Agent。若没有 Agent 身份，后续会退回 Team 级资产列表，不能把该结果当作 Agent 固定绑定验证。

返回质量判断：身份字段应能唯一对应本次会话；Team、Agent 和 Space 应保持一致。只出现客户端名称或自然语言 Agent 名称，不能证明运行时已经完成绑定。

### 2. 查询 Agent 固定资产

Proxy 的 per-agent 路径调用 Core：

~~~text
POST http://127.0.0.1:8420/v3/meta/agent-fixed-asset/list-with-detail
~~~

请求体使用当前会话的 Agent：

~~~json
{
  "agent_id": "agt-0k57f4qsbs",
  "apply_visibility_filter": true,
  "touch_usage": false,
  "asset_types": ["llm_wiki", "code_graph"],
  "limit": 100,
  "offset": 0
}
~~~

请求头至少包括：

~~~text
Authorization: Bearer <service-token>
x-tdai-user-key: <current-user-key>
x-tdai-service-id: <space-id>
Content-Type: application/json
~~~

PowerShell 示例：

~~~powershell
$coreHeaders = @{
  Authorization = "Bearer $env:TDAI_SERVICE_TOKEN"
  'x-tdai-user-key' = $env:TDAI_USER_KEY
  'x-tdai-service-id' = $env:TDAI_SPACE_ID
  'Content-Type' = 'application/json'
}
$bindingBody = @{
  agent_id = $env:TDAI_AGENT_ID
  apply_visibility_filter = $true
  touch_usage = $false
  asset_types = @('llm_wiki', 'code_graph')
  limit = 100
  offset = 0
} | ConvertTo-Json
Invoke-RestMethod 'http://127.0.0.1:8420/v3/meta/agent-fixed-asset/list-with-detail' -Method Post -Headers $coreHeaders -Body $bindingBody
~~~

保留返回中的 asset_id、asset_type、name、status、content_ref 和分页信息。

返回质量判断：

- wiki-* 且 asset_type=llm_wiki，以及 cg-* 且 asset_type=code_graph，才能作为本指南的两类资源。
- 资源状态应允许读取；archived、deprecated、failed 不应进入可用资产集合。
- 返回的 ID 必须与当前 Agent 对应；只在 Panel 页面看到资源，不能证明运行时读取到了绑定。
- 如果返回为空，先判定为“没有可验证的绑定”，不要继续把 Team 全量资产误认为 Agent 绑定。

实现依据：MemoryProxy/src/knowledge/core-client.ts 第 237 行附近；绑定写入使用 injection_mode: tool，见 MemoryPanel/src/panel/http/routes/knowledge/allocate-routes.ts 第 175 行附近。

### 3. 查询资源明细并确认工具服务地址

Proxy 根据上一步的 ID 查询 Knowledge 资源明细：

~~~text
POST http://127.0.0.1:8420/v3/knowledge/list
~~~

请求体：

~~~json
{
  "team_id": "team-0k5xzl1n6f",
  "knowledge_ids": ["wiki-phqlk01l", "cg-6rtgzo1b"],
  "pagination": { "limit": 200, "offset": 0 }
}
~~~

记录每个资源的：

~~~text
knowledge_id
asset_type / type
name
status
service_url
summary 或 about
repo_url、repo_slug、branch（CodeGraph）
~~~

返回质量判断：

- Wiki 必须有能帮助任务路由的名称和摘要；摘要过短或与实际页面不符，会降低 Agent 选 Wiki 的准确性。
- CodeGraph 必须能识别仓库、分支和索引状态；缺少仓库锚点时，后续结果只能按外部参考处理。
- service_url 应指向实际 Knowledge 服务并包含 /v3。它是工具自发现地址，不是资源 ID 的 URL 路径。

实现依据：MemoryProxy/src/knowledge/core-client.ts 第 211 行附近和 MemoryProxy/src/injection/injectors/knowledge-tools-injector.ts 第 73 行附近。

### 4. 确认 <knowledge_tools> 已注入会话

Knowledge 资源不会把全文直接塞进上下文。Proxy 在 session_init 预热后，将资源目录和调用约定写入一个 <knowledge_tools> 文本块，并按 session_init 策略缓存。

在 Proxy 日志或会话记录中查找：

~~~text
listAgentKnowledgeIds
listKnowledgeByIds
knowledge-tools-injector
knowledge_tools
wiki-phqlk01l
cg-6rtgzo1b
~~~

注入块应至少包含类似结构：

~~~xml
<knowledge_tools>
  <knowledge type="wiki" id="wiki-phqlk01l"
    url="http://127.0.0.1:8424/v3"
    name="UIElements"
    about="..." />

  <knowledge type="code-graph" id="cg-6rtgzo1b"
    url="http://127.0.0.1:8424/v3"
    name="...Packages-alpha.git"
    match="...Packages-alpha"
    branch="main" />
</knowledge_tools>
~~~

返回质量判断：

- 资源目录中出现 ID，只能证明“已注入候选资源”，不能证明 Agent 已读取页面或代码。
- Wiki 应有 about，CodeGraph 应有 match 和 branch（如果后端提供）；字段缺失时应降低判断可信度，而不是补造值。
- 注入块必须同时说明 tools/list 和 tools/call 的用途。若只注入资源名称而没有可调用地址，Agent 无法完成自发现。
- Skill 是独立的注入块，不应与 <knowledge_tools> 中的 Wiki / CodeGraph 混为一类。

### 5. 调用 tools/list，确认资源能力

每个资源首次使用时调用一次：

~~~text
POST <service_url>/tools/list
~~~

请求头：

~~~text
x-tdai-service-id: <space-id>
Content-Type: application/json
~~~

请求体：

~~~json
{
  "knowledge_id": "wiki-phqlk01l"
}
~~~

CodeGraph 只需把 ID 换成 cg-6rtgzo1b。PowerShell 示例：

~~~powershell
$knowledgeHeaders = @{
  'x-tdai-service-id' = $env:TDAI_SPACE_ID
  'Content-Type' = 'application/json'
}
$listBody = @{ knowledge_id = $env:TDAI_WIKI_ID } | ConvertTo-Json
Invoke-RestMethod "$env:TDAI_KNOWLEDGE_URL/tools/list" -Method Post -Headers $knowledgeHeaders -Body $listBody
~~~

成功返回的核心结构为：

~~~json
{
  "code": 0,
  "message": "ok",
  "data": {
    "knowledge_id": "wiki-phqlk01l",
    "type": "wiki",
    "name": "UIElements",
    "summary": "...",
    "status": "ready",
    "tools": [
      { "name": "search", "description": "...", "params": {} }
    ]
  }
}
~~~

返回质量判断：

- data.knowledge_id 必须与请求 ID 一致，type 必须与资产类型一致。
- 工具名和参数定义是后续调用的唯一依据；不能凭记忆拼写工具名或参数。
- Wiki 预期包含 search、read_page 等工具；CodeGraph 预期包含 explore、search、node、callers、callees、impact 等工具。
- status 不是 ready 时，调用结果可能为空；这应记录为资源状态问题，不应直接评价为检索质量差。

实现依据：MemoryKnowledge/src/routes/tools.ts 第 192 行附近；完整工具定义见 MemoryKnowledge/v3-api-memoryknowledge-doc.md 第 505 行附近。

### 6. 调用 Wiki：搜索后读取页面

先根据 tools/list 返回的参数调用 search：

~~~json
{
  "knowledge_id": "wiki-phqlk01l",
  "tool_name": "search",
  "params": {
    "query": "EditorWindow UIElements ObjectField prefab AssetDatabase PrefabUtility",
    "limit": 10
  }
}
~~~

请求地址：

~~~text
POST http://127.0.0.1:8424/v3/tools/call
~~~

随后从搜索结果中选出真正相关的 ref，再调用 read_page：

~~~json
{
  "knowledge_id": "wiki-phqlk01l",
  "tool_name": "read_page",
  "params": {
    "refs": [
      "<search 返回的页面 ref>"
    ]
  }
}
~~~

记录完整的搜索结果和读取页面的标题、ref、正文摘要、版本说明及代码/API 片段。不要只记录“命中了 Wiki”。

Wiki 质量评估：

| 维度 | 观察内容 | 合格表现 |
| --- | --- | --- |
| 相关性 | 搜索结果标题、摘要、关键词 | 与当前任务的组件、框架或设计问题直接相关 |
| 可执行性 | 读取页面中的 API、生命周期、约束 | 能转化为下一步实现或验证动作 |
| 完整性 | 是否覆盖关键前置、边界和组合方式 | 没有只返回概念标题而缺少关键细节 |
| 版本适用性 | Unity、包或服务版本 | 与当前工程版本相符，或明确标记差异 |
| 可追溯性 | ref、页面标题和原文 | Human 能回到同一页面复查 |

本次历史会话中，Wiki 命中了 Unity 编辑器窗口扩展架构、Unity EditorWindow、XCoreEditorWindow 和 UIElements 相关页面。这个结果可以支持窗口生命周期和 UI 组织，但不能仅凭命中标题证明 Wiki 提供了 Prefab 替换算法。

### 7. 调用 CodeGraph：理解实现并追踪关系

先调用 tools/list 返回的 explore 或 search。以历史任务为例：

~~~json
{
  "knowledge_id": "cg-6rtgzo1b",
  "tool_name": "explore",
  "params": {
    "query": "XCoreEditorWindow ReplaceAssetHelper PrefabAssetCopier ModifyReference ObjectField"
  }
}
~~~

再按返回的工具参数查询具体符号或关系，例如：

~~~json
{
  "knowledge_id": "cg-6rtgzo1b",
  "tool_name": "callers",
  "params": {
    "symbol": "<explore 返回的符号>"
  }
}
~~~

或：

~~~json
{
  "knowledge_id": "cg-6rtgzo1b",
  "tool_name": "impact",
  "params": {
    "symbol": "<待评估符号>"
  }
}
~~~

记录仓库、分支、提交、命中的文件和符号、调用者/被调用者、依赖边及工具返回的错误状态。

CodeGraph 质量评估：

| 维度 | 观察内容 | 合格表现 |
| --- | --- | --- |
| 仓库对应关系 | match、仓库名、分支、提交 | 能明确当前工程事实或外部参考身份 |
| 符号精度 | 文件、类型、方法、行或签名 | 命中的是实际相关实现，不是同名噪声 |
| 关系完整性 | callers、callees、imports、impact | 关系方向和范围与本地源码一致 |
| 实现可借鉴性 | API 组合、代码组织、处理流程 | 能提取模式，但不盲目复制外部路径和依赖 |
| 新鲜度 | 分支、提交、索引更新时间 | 能判断索引是否可能落后当前工作区 |
| 本地可证实性 | 当前工程的源码、包版本、编译结果 | 关键结论能在本地再次确认 |

CodeGraph 返回的外部实现只能作为参考。若当前工作区没有 Git remote，记录“仓库对应关系无法确认”，但不要因此把 CodeGraph 直接判定为不可用。

### 8. 用本地工程确认返回内容

选择一个实际任务验证组合使用方式：

~~~text
创建一个 EditorWindow，提供替换 Unity 工程中 Prefab 引用的功能。
~~~

按以下顺序记录：

1. Wiki 返回 EditorWindow、UIElements 和窗口生命周期资料。
2. CodeGraph 返回类似窗口、序列化引用遍历、依赖扫描或已有替换工具实现。
3. 在当前工程本地搜索同名包、类型和 API，确认版本与可用性。
4. 以本地源码为准实现，不把外部仓库路径、符号关系或代码直接当作本地事实。
5. 运行编译、EditMode 测试或实际功能验证，记录结果。

历史会话中从 CodeGraph 提取的实现模式包括：

~~~csharp
var serializedObject = new SerializedObject(target);
var property = serializedObject.GetIterator();

while (property.Next(true))
{
    if (property.propertyType != SerializedPropertyType.ObjectReference)
    {
        continue;
    }

    property.objectReferenceValue = newReference;
}

serializedObject.ApplyModifiedPropertiesWithoutUndo();
EditorUtility.SetDirty(target);
~~~

Human 需要确认这段模式是否存在于 CodeGraph 返回中、是否适用于当前工程，以及最终实现是否经过本地 Unity API 和测试确认。历史会话的最终实现整理为本地的 PrefabReferenceUtility 与 PrefabReferenceWindow，运行时不依赖 CodeGraph 服务。

### 9. 验证缓存刷新

Knowledge 注入器的缓存策略是 session_init。资源绑定或注入文案发生变化后：

1. 仅重启 Proxy 不足以证明已有会话缓存已刷新。
2. 在当前会话执行 mem:sync，刷新 Skill、记忆、Knowledge 和 Agent/Task 描述。
3. 或创建新会话，让 session_init 重新预热。
4. 再次检查 <knowledge_tools> 和 Proxy 日志中的资源 ID、摘要与工具地址。

记录 mem:sync 返回、刷新耗时、刷新项和刷新后的注入内容。若旧资源仍出现，判断为缓存未刷新；若资源已更新但工具返回旧内容，再检查 Knowledge 索引状态和更新时间。

实现依据：MemoryProxy/src/injection/prewarm.ts 第 1 行附近和 MemoryProxy/src/mem-command/commands/sync.ts 第 1 行附近。

## 失败分支判定

| 现象 | 应判定为 | 下一步 |
| --- | --- | --- |
| Agent 固定资产返回为空 | 未确认绑定 | 核对 Agent、用户 key、Team 和可见性 |
| Panel 能看到资源，固定资产返回没有资源 | 管理面存在但运行时绑定未生效 | 检查 agent-fixed-asset 绑定和资源状态 |
| 资源 ID 已注入，但没有工具调用 | 已注入，未使用 | 检查任务相关性和 Agent 的工具选择 |
| tools/list 成功，search 无结果 | 工具可用但索引未命中 | 调整查询词，同时检查资源状态和索引更新时间 |
| Wiki 命中页面标题但正文不相关 | Wiki 内容质量不足或查询过宽 | 更换查询并记录误命中，不要把标题当结论 |
| CodeGraph 命中外部仓库实现 | 外部参考命中 | 用本地源码确认，不能直接当作当前工程事实 |
| 工具返回 data.isError=true 或服务错误 | 调用链失败 | 保留返回和日志，回退本地检索或修复服务状态 |
| mem:sync 后仍是旧 <knowledge_tools> | 会话注入缓存未刷新 | 创建新会话并再次比对注入内容 |
| CodeGraph 与本地源码不一致 | 索引快照落后或仓库不匹配 | 以本地源码、编译和测试为准，记录索引版本 |

## 验证记录模板

Human 每次验证至少填写以下内容：

~~~markdown
## 验证时间

- 时间：
- session_id：
- team_id / agent_id / space_id：
- 当前工程路径：
- 当前工程版本或 Git remote：

## 资产绑定返回

- 请求位置：
- Wiki ID / 状态：
- CodeGraph ID / 状态：
- 原始返回或脱敏摘录：
- 绑定结论：

## 会话注入返回

- 注入块是否存在：
- Wiki 字段：
- CodeGraph 字段：
- 日志或会话证据：
- 注入结论：

## Wiki 调用

- tools/list 返回的工具：
- search 请求：
- search 返回：
- read_page 请求：
- read_page 返回：
- 相关性 / 可执行性 / 完整性 / 版本适用性 / 可追溯性：
- Wiki 质量结论：

## CodeGraph 调用

- tools/list 返回的工具：
- explore/search 请求：
- 符号、文件和关系返回：
- 仓库对应关系：
- 本地源码确认：
- CodeGraph 质量结论：

## 本地验证

- 使用了哪些参考：
- 哪些结论被本地源码修正或排除：
- 编译 / 测试 / 实际运行结果：
- 最终结论：
~~~

## 完成标准

一次完整验证只有同时满足以下条件，才能说“Agent 已正确关联并使用 Wiki 与 CodeGraph”：

- 能证明当前会话使用了哪个 Team、Agent 和 Space。
- 能从运行时返回中确认 Wiki 和 CodeGraph 的绑定 ID、类型、状态和服务地址。
- 能看到 <knowledge_tools> 注入证据，并区分候选资源和实际调用。
- Wiki 至少完成一次 tools/list -> search -> read_page，且 Human 能根据返回评估质量。
- CodeGraph 至少完成一次 tools/list -> explore/search，必要时继续查询符号关系，并完成仓库对应关系判断。
- 每个关键步骤都保留真实返回或日志证据，包括空结果、跳过和失败结果。
- 参考结果已经与当前工程本地源码、编译或测试结果对照。
- 最终结论明确说明：哪些内容来自 Wiki，哪些来自 CodeGraph，哪些由本地工程确认，哪些未被采用以及原因。

## 实现对照

当前实现的关键职责边界如下：

- MemoryPanel 写入 Agent 与 Knowledge 的固定绑定。
- MemoryProxy 读取 Agent 绑定、查询资源明细，并渲染 <knowledge_tools>。
- MemoryKnowledge 根据 knowledge_id 返回 Wiki 或 CodeGraph 的工具清单，并执行工具白名单内的查询。
- 当前会话 Agent 决定何时调用工具；服务不会把全部知识内容自动注入上下文。
- 当前工程本地源码、编译和测试负责最终事实确认。

这套边界保证了资源管理、运行时注入、知识查询和工程实现各自独立，Human 可以沿着每一层的返回逐步定位问题并评价知识质量。
