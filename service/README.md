# service

Kestrel 的服务端：Bun.serve 常驻进程持有模型循环、工具注册与浏览器执行端，前端只是 `public/index.html`。

模型连接使用单一 `enabled` 布尔设置，代理与直连互斥。存在 `connection.json` 时恢复用户选择；没有保存设置时默认直连，仅显式 `KESTREL_PROXY_MODE=proxy` 启用代理。普通 HTTP/HTTPS/ALL_PROXY 环境变量仅提供代理地址，不自动打开开关。切换后保存设置，服务启动日志反映实际生效模式。

环境变量正式名为 `KESTREL_*`（`KESTREL_DATA`、`KESTREL_PORT`、`KESTREL_PROVIDER`、`KESTREL_PROXY_MODE`、`KESTREL_EXTENSION_ORIGIN`）；未设置时兼容内核沿用下来的旧名，代码成对读取。密钥写在被忽略的 `service/.env`，示例见 `.env.example`，修改后重启服务生效。

会话 ID 的分配高水位保存在数据目录的 `conversation-id.json`，删除会话后不复用 ID。停止或删除会话会取消该会话尚未结束的请求；`POST /stop` 携带 `conversationId`，未知会话返回 404。启动时 `recoverStaleRuns` 复位上一次被硬杀留下的 running 会话。

循环按 Turn 分别统计 `usage.modelRequests`（请求模型次数，不含 provider 内部重试）和 `usage.toolCalls`（实际进入执行器的工具次数，含常驻及收口工具；批量调用逐个计数）。统计保存在 Turn 文件中。正常工具循环没有累计出网上限，持续至完成、追问、用户停止或执行错误。连续 3 次无效提交会中止；正常执行一批工具会重置连续失败计数。

## 目录职责

| 目录 | 层 |
|---|---|
| `runtime/` | 账本、循环、工具证据归档、`session.json`、执行状态与工具桥 |
| `context/` | modules.ts 加载上下文模块；window.ts 投影 loop 数据、记忆和已提供的工具说明 |
| `tools/` | registry.ts 读取本模块 definitions/ 内工具定义、分组和分类；参数检查、工具执行及结构化效果 |
| `browser/` | Playwright 执行端：真实 Chrome、标签页、元素编号、截图、右栏预览跟踪 |
| `agents/compression/` | Compression Agent 的 context 模块、输入输出协议、校验与 loop 分区压缩流程 |
| `agents/query/` | Query Agent 的 context 模块、输入输出协议、校验与语义检索流程 |
| `context-archive/` | 会话历史归档存储、覆盖索引与来源展开 |
| `provider/` | 模型通信、传输重试与响应解析 |
| `presentation/` | 纯函数生成会话消息、错误文案、待执行工具和列表预览 |

主 Agent 的 Prompt 正文与加载器都在 `service/context/`。唯一顺序源是 `modules.json`；每个模块是一份 XML 文件，含能力与详细描述。System 与 User 窗口都渲染完整 XML 模块；User 模块另含 `内容：` 段注入运行数据。Skill 正文位于独立的 `service/skills/<name>/SKILL.md`，由 runtime 加载后注入 `<skill>`；`context/user/skill.md` 只提供模块说明和数据占位。

工具 API 定义位于 `service/tools/definitions/`，分组在 groups.json。说明唯一来自 function.description，index 只分类；System `<baseTools>` 展示常驻能力导航，User `<tools>` 展示本会话已加载的动态能力导航；每项由工具名和 function.description 首句生成，完整调用说明与参数 schema 通过 tools[] 发送。过程展示仅使用工具 arguments.reason；最终回复、提问分别使用 finishTurn 的 text 与 askUser.arguments.question，不回退到模型 content。运行提示位于 `shared/error-messages.json`。

## HTTP

`Bun.serve` 监听 `127.0.0.1:18790`（`KESTREL_PORT` 可覆盖），`idleTimeout: 0` 以保住 SSE 长连接（默认 10 秒会掐断空闲的预览流）。

- `GET /`、`GET /index.html`：前端单页，从磁盘读取、`no-store`
- `GET /health`、`GET /session`、`GET /conversations`
- `POST /conversations/open`、`POST /conversations/new`、`POST /conversations/delete`
- `POST /turn`（同步执行整轮并返回结果）、`POST /stop`
- `GET /api/preview`（一次性截图，回退用）、`GET /api/preview/stream`（SSE，只下发右栏该显示哪个标签页）
- `GET /stream`：WebSocket 升级路由，跨端二进制分帧；网页前端不使用
- `GET /images/<conversationId>/<imageId>`：截图等二进制原始字节
- `GET /library`、`POST /library/save`、`GET|POST /connection`、`POST /widget`、`GET /widget/<id>`
- `GET /tool-request`、`POST /tool-result`：执行器协议端点（版本校验与结果回传）
- `POST /browser-batch`：按批提交浏览器工具调用，单批最多 32 条、单条 60 秒超时

## 访问边界

服务仅监听回环地址，并在路由执行前拒绝非回环 Host、外部 Origin 与跨站请求；CORS 只回显允许的来源。`GET /`、`/index.html`、`/widget/` 是无数据的静态入口，任何来源都可打开，其余路由要走校验。

受信任来源 = 同源，或 `KESTREL_EXTENSION_ORIGIN` 指定的来源（未设置时接受形如 `chrome-extension://<32 位 a-p>` 的来源）。这是浏览器来源隔离，不是本机进程身份认证；本机程序仍可直接访问。

## 存储与执行端

数据目录默认 `~/Library/Application Support/Kestrel`（`KESTREL_DATA` 可覆盖）；会话落盘为 `session.json` + `conversations/<cvId>/`（`ledger.json`、`events.jsonl`、`turns/`、`toolio/`、`images/`、`agent-logs/`）。读取 ledger / events / turns 后由 presentation 投影成会话消息，命令返回行为保持不变。

浏览器执行实现在 `service/browser/host.ts`：`createPlaywrightHost(dataDir)` 用 `launchPersistentContext` 打开本机已装的 Chrome（`channel: "chrome"`、`headless: false`），profile 持久化在数据目录下，登录态可复用。元素编号 `e_NN` 由页面内注册表分配，跨调用、跨标签复用；截图以 data URL 返回后由 `service/images/` 落盘成图片附件。host 是单实例：`forScope` 返回自身，重复创建会在同一 profile 上再开一个 Chrome，撞单例后 Playwright 立刻报 browser has been closed。

## 模型 Provider

Provider 注册表在 `service/provider/config.ts`，每行给出 id、显示名、默认模型、密钥与模型的环境变量名，以及协议类型（`openai` / `responses` / `gemini` / `uuapi`）。`KESTREL_PROVIDER` 选择默认 provider（`connection.json` 里没有保存选择时生效，缺省 `uuapi`）。密钥与模型名按注册表里的环境变量取值，写在 `service/.env`。会话列表的设置面板可切换 provider，无需重启，从下一次模型请求起生效，正在发送的请求继续使用原 provider；选择与代理开关一起保存到 `connection.json`，优先于环境变量。

Gemini 适配器把 system 写入 `systemInstruction`，user 写入 `contents`，在 `tools` 中附带内置 `google_search`（`GEMINI_GOOGLE_SEARCH=0` 可关闭）以及与 Chat 相同的 `functionDeclarations`；模型返回的 `functionCall` 分配 `gem_call_` 本地 ID 后进入既有 Runtime 校验。`groundingMetadata` 不并入正文，也不伪装成 tool_calls：Provider 以独立 `grounding` 字段返回，Runtime 分配 `call_` 写入 `toolIO`（`name=google_search`），不进入执行队列、不计入 `usage.toolCalls`。

Responses 适配器负责文本、图片 input_image、扁平 function schema 和 function_call 返回转换。请求使用 store=false，不使用 previous_response_id 串接会话；未完成的响应不会执行其中的部分工具调用。

Chat 与 Responses 的失败分类和重试决策统一由 `provider/failures.ts` 管理。连接错误、超时、HTTP 408/429/5xx、Responses 的 server_error / rate_limit_exceeded，以及响应格式无效（`provider_invalid_response`，含空回包）按 `network.maxAttempts` 静默重试（默认 10 次含首次），重试成功则正常继续，不向模型回灌错误文案。输出超限、内容拒绝、未完整结束分别返回 `provider_output_limit`、`provider_refused`、`provider_incomplete`，不自动重试，也不执行部分工具调用。401 返回密钥错误，403 返回请求被拒绝并保留上游原因；重试耗尽后面板展示失败，本轮不执行工具。

模型请求默认发送 `reasoning_effort: "high"`。可在 `service/.env` 配置对应的 `*_REASONING_EFFORT=low|medium|high`，修改后重启服务；上游是否实际采用该强度取决于所选模型及网关支持。

## 记忆、压缩与子 Agent

记忆分 conversation 与 project 两层。会话记忆每次请求都注入窗口，不随历史压缩退出；项目记忆跨会话，位于数据目录 `memory/project/`，删除来源会话后仍保留。注入超过记忆预算（`context.memoryBudgetChars`，compressAt 的 4%）时 Runtime 会提示清理。

每次发送主模型前，Runtime 按 System + User 字符数判断压缩阈值。最近 1 个 loop 完整保留，其余按 userInput / interrupt 分区顺序逐区请求；无输入分界时按条数分前后两半分别发送。loop 不拆、不递归。每批摘要全部合法才覆盖，失败停止后续批次并保留原文。摘要记录准确 loopIds，按层折叠至最高 L6；无新来源不单独折叠。

主 Agent 固定配套两个职责单一的子 Agent：Compression Agent 在主模型请求前按需压缩历史材料，Query Agent 在主 Agent 调用 `agent_query` 时按意图定位历史证据。两者复用现有无状态 `provider.complete`，各自通过 `protocol.ts` 组装提示词并校验专用返回工具调用，通过 `index.ts` 执行业务流程。

运行中的请求由 `runtime/execution.ts` 按数据目录、会话和回合统一管理，状态只允许 `active → cancelled` 或 `active → finished`，终态不能再次发出请求。回合入口给 Provider 绑定同一个 AbortSignal，主模型、压缩和查询自动共享；停止、删除会话或服务退出触发取消，网络请求及重试等待同时中止。

Compression Agent 的每次模型请求独立写入 `conversations/<cvId>/agent-logs/compression/<时间戳>-<唯一标识>.jsonl`：发送前记录完整 messages 与 tools，收到后记录完整 CompletionResult，schema 校验失败包含字段路径、规则和预期类型。日志不包含密钥或认证头，也不进入主模型上下文。

## 网络配置与计时

网络配置统一在 `service/config/runtime.json`，修改后重启服务生效。`network.idleTimeoutMs=90000` 表示等待响应头或响应体连续 90 秒没有数据才超时，不是请求总耗时；收到非空数据块重置计时。`network.maxAttempts=10` 包含首次请求，`retryDelayMs=200` 为尝试间隔。测试经 `bunfig.toml` 预载把重试间隔压到 1ms，重试循环不按生产间隔硬等。通用 HTTP 工具和主/辅助模型请求共用该策略；用户停止立即取消传输及等待。Tavily SDK 的 `sdk.tavilyTimeoutSeconds` 与 TLS 握手的 `tls.timeoutMs` 属于专用超时，独立配置在同一文件。

会话 `events.jsonl` 中，`provider-timing` 记录逻辑请求开始、结果及结束耗时；`provider-network` 记录该请求每次实际 HTTP 尝试的阶段。二者用持久递增的 `requestId` 和 `turnId` 关联，覆盖主模型、压缩、查询及子代理，并发请求独立计时。网络阶段包含发送开始、响应头、首个非空响应体数据、完成/失败/取消，耗时使用单调时钟；记录可测请求体的字节数、已接收响应体字节数与 HTTP 状态，不记录请求正文、认证头或 URL。普通 fetch 无法测出 DNS、建连、TLS 和上传完成时刻，上传字段明确为 null；首块也不等于首个内容 token。日志只用于诊断，不进入模型上下文。

服务数据目录 `provider-requests/out_NN.json` 保存最近 100 次实际模型 HTTP 发送的请求快照，所有会话共用此保留数量；一次重试也算一次发送。每条包含 `conversationId`、`turnId`、`requestId`、`attempt`、时间、HTTP 方法、不带查询参数与认证信息的 endpoint，以及最终序列化请求体 `body`。body 保留原样，不截断、不进入模型上下文；请求头不保存。`events.jsonl` 的 `provider-outbound` 记录快照路径。超过 100 条按持久递增编号删除最旧快照，重启后继续累计；文件权限为仅本用户读写。记录失败通过 `request-log-error` 标记，原请求继续执行。
