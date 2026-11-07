# Kestrel

**浏览器里的 AI Agent。** 你在网页左侧对话框里说一句话，Agent 就直接驱动你本机那个真实的 Chrome——开标签、点按钮、填表单、读页面——右侧实时显示它正在操作的那个页面，你可以点进去自己接着玩。

不是"生成一段代码给你看"，也不是"云端的无头浏览器截图"：跑的是本机 Chrome，用的是你已有的登录态，对话、工具调用、页面操作全在同一个网页里发生。

![架构示意](#架构) · 演示视频：[`docs/demo-3x.mp4`](docs/demo-3x.mp4)

---

## 目录

- [它是什么、不是什么](#它是什么不是什么)
- [演示](#演示)
- [快速开始](#快速开始)
- [架构](#架构)
- [几个关键取舍](#几个关键取舍)
- [迭代过程](#迭代过程)
- [配置项](#配置项)
- [已知限制](#已知限制)

---

## 它是什么、不是什么

**是：**

- 一个自带 agent loop 的网页应用：后端跑模型循环和工具执行，前端就是一个浏览器页面，没有扩展、没有 Electron、没有 IPC 桥
- 执行端是 Playwright/CDP 驱动的**真实 Chrome**（持久化 profile，登录态保留），不是无头沙箱
- 工具集完整：标签管理、导航、元素定位与点击、输入、下拉、等待、网络等待、截图、断言、控制台、cookie……共 187 份工具定义，其中浏览器类 121 个
- 右栏是**真的浏览器渲染**（iframe 嵌入被控页面），指针、键盘、滚动、游戏输入都是原生行为

**不是：**

- 不是"自然语言生成应用"的代码生成器（那是上一版原型的形态，已废弃）
- 不是多用户服务：没有账号体系、没有鉴权，默认只监听 `127.0.0.1`
- 不是远程浏览器：Chrome 跑在你这台机器上，页面数据不出本机

---

## 演示

`docs/demo-3x.mp4`（19 MB，1 分 58 秒，2748×1840）

原片 37 分 51 秒，是整段真实开发过程录屏。为了看的人不睡着，剪辑脚本先逐秒计算画面运动量（`ffmpeg tblend + signalstats` 拿到运动曲线，静止率约 90%），把「思考过程」这类画面不动的段落加速 30 倍、真实操作段保留 3 倍速，再拼成一版成片。所以视频里能看到：改代码 → 刷新 → Agent 自己在页面里点进去验证 → 录屏里我在这边指哪打哪。

素材里还包括一段反复打磨小游戏生成的过程：让 Agent 现场写/改一个像素小游戏页面，它改完自己刷新、进关卡、按方向键试玩，HUD 上的 `TIME` 从 300 开始倒数——这类"它真的在操作"的痕迹，比任何截图都直观。

---

## 快速开始

前置：**Bun ≥ 1.4**、本机已安装 **Google Chrome**（`playwright-core` 直接复用系统 Chrome，不额外下载浏览器）。

```bash
git clone git@github.com:huyudonglove/kestrel.git
cd kestrel
bun install

cp service/.env.example service/.env
# 打开 service/.env，任选一家 provider 填 API key，
# 并设置 KESTREL_PROVIDER（例如 opencode / hetune / openai）

bun run start
# → http://127.0.0.1:18790/
```

首次启动会自动用独立的 profile 目录拉起一个 Chrome（`<dataDir>/chrome-profile`）。这个 Chrome 和你的日常浏览器互不干扰。

在左侧输入框里说点具体的，例如：

> 打开 example.com，读出页面标题和第一段正文
> 去 127.0.0.1:7802 玩一局，按方向键走到旗杆

右侧会自动切到它正在操作的那个标签页。

---

## 架构

```
public/index.html          ← 整个前端（单文件，无构建）
        │  POST /turn  →  SSE /stream  ←  事件流
        ▼
service/server.ts          ← Bun.serve，路由 + 来源校验 + 静态托管
        │
        ├── service/runtime/     agent loop、工具校验与执行、压缩调度、执行状态机
        ├── service/context/     提示词模块（System/User 窗口）、记忆注入、压缩窗口
        ├── service/tools/       187 份工具定义 + registry + 参数校验（ajv）
        ├── service/browser/     ★ 执行端：Playwright 驱动真实 Chrome
        ├── service/provider/    多家 OpenAI 兼容网关适配、重试、响应解析
        ├── service/memory/      会话记忆 / 项目长期记忆
        ├── service/context-archive/  历史归档与摘要折叠
        ├── service/agents/      Compression Agent / Query Agent（子模型）
        ├── service/images/      工具截图落盘与 /images/ 路由
        └── shared/             与前端共享的类型和常量
```

**执行端是唯一被重写的层。** 内核（loop、provider、tools、context/记忆/压缩）来自我另一个项目 tChrome——那是一个 Chrome 扩展形态的 agent。Kestrel 把浏览器执行端从「扩展后台脚本」换成「Playwright 直连本机 Chrome」，工具 schema 与语义一字未改，所以服务端那 187 份工具定义可以原样沿用。

数据流一句话：**模型 → 工具调用 → BrowserHost.execute() → Playwright → 真实 Chrome → 结果回灌模型**，每一步的工具调用与截图都通过 SSE 推给前端渲染。

### 右栏是怎么显示的

`GET /api/preview/stream` 是一条 SSE，服务端只跟踪"当前该显示哪个标签页"并下发 `target` 事件；前端拿到就设 `iframe.src`。

嵌入前服务端会探一次响应头（`X-Frame-Options` / CSP `frame-ancestors`，4 秒超时、结果缓存 5 分钟）：

- 允许 → 直接 iframe 嵌入，**原生可交互**
- 禁止（GitHub、大部分银行和社交站）→ 明确提示"该站点禁止被嵌入"并给一个「在新标签打开」，不回退成截图糊弄人

---

## 几个关键取舍

**1. 为什么右栏不是截图流？**

第一版是「每 2 秒重新截图 → 替换 img.src」，于是画面一闪一闪。改成 CDP `Page.startScreencast` 推帧 + canvas 双缓冲后确实流畅了，但那是**只能看不能点**的——要支持交互就得自己做坐标映射、把 pointer/key 事件转发回被控页，还要处理缩放、滚动、焦点，坑比收益多。

最后想明白了：**iframe 里放的就是真页面，交互本来就是浏览器原生的事**，不需要转发任何事件。代价是遇到禁嵌站点显示不了，那就诚实告知并给出口，而不是偷偷降级成截图。

**2. 补丁记录里最贵的三个 bug**

- `Bun.serve` 默认 `idleTimeout = 10s` 会掐断帧间静默的 SSE，`EventSource` 于是反复重连，右栏周期性闪动。心跳 15 秒救不了 10 秒超时——必须 `idleTimeout: 0`。
- CDP screencast **对后台标签不出帧**，`startScreencast` 前必须 `await page.bringToFront()`。表现是 attach 成功但零帧，很容易误判成编码参数问题。
- `forScope()` 如果每次调用都新建 host，会在同一个 chrome-profile 上再开一个 Chrome，撞单例后 Playwright 立刻报 `browser has been closed`。必须复用同一个 host 实例。

**3. 前端是最土的那一版**

单文件 `public/index.html`，没有框架、没有构建步骤、没有 `node_modules` 前端依赖。Markdown 是自己写的 30 行渲染器。理由很实际：这个项目的难点在 agent 循环和浏览器执行，不在前端工程化；能靠一个文件说清楚的事，不值得引入一整套工具链。

---

## 迭代过程

这个项目的形态变过三次，每次都是被真实问题顶回来的：

| 阶段 | 形态 | 为什么放弃 |
|---|---|---|
| 1 | **自然语言生成小应用**：一句话 → LLM 流式吐出单文件 HTML → iframe 里跑，数据走宿主存储桥 | 能跑通，但和 v0 / base44 没有本质差别；而且最难的部分（准确定位并操作真实页面）被绕过了 |
| 2 | **把 agent 搬到网页**：后端跑 agent 循环，执行端换成 Playwright 直连本机 Chrome | 这就是 Kestrel 的起点。第一版右栏用 2 秒轮询截图 |
| 3 | **右栏实时 + 可交互**：CDP 推流 → 最终收敛为纯 iframe 嵌入 | 见上一节。现在是"你看得见它在操作什么，也能自己接手" |

界面也照着 base44 的浅色风格重做过一版（米白底 `#f9f8f6`、墨色主按钮、点阵画布、工具调用收成可折叠的「思考了 N 秒 · M 步」活动行），整页不滚动、只有左侧消息区滚动。

关于"反复调整小游戏的生成"那段：让 Agent 现场写一个像素小游戏页面，然后它自己开标签、进关卡、按方向键试玩。这个过程暴露的问题非常真实——第一次它写的游戏在 iframe 里按不动方向键，因为焦点没进嵌套文档；第二次跳跃判定写错了，它自己看截图发现人物卡在砖块里；第三次才是对的。这种"改—跑—看—再改"的闭环，比单轮生成更能说明 agent 该长什么样。录屏里保留的就是这段。

---

## 配置项

`service/.env`（参考 `service/.env.example`，支持十几家 OpenAI 兼容网关）：

| 变量 | 默认 | 说明 |
|---|---|---|
| `KESTREL_PROVIDER` | `uuapi` | 走哪家网关，需与下方对应 `*_API_KEY` 配套 |
| `KESTREL_PORT` | `18790` | 监听端口 |
| `KESTREL_DATA` | `~/Library/Application Support/Kestrel` | 数据目录（会话、截图、Chrome profile、长期记忆） |
| `KESTREL_REASONING_EFFORT` | `high` | 推理强度，上游是否采纳取决于模型 |

API key 只放在服务端 `.env`，不进前端、不进仓库（`.gitignore` 已覆盖 `.env` 与 `.env.*`，只保留 `.env.example`）。

常用命令：

```bash
bun run start      # 启动服务
bun run typecheck  # tsc --noEmit
bun run test       # bun test
```

---

## 已知限制

诚实列一下现在不完整的地方：

- **没有任何鉴权，且只监听 `127.0.0.1`。** 直接映射到公网等于把本机浏览器和 47 个本机操作类工具（`local_run`、`local_fs_*`、`script_*`…）交给任何人。要对外必须自己补工具白名单 + 访问口令 + Host 放行。
- `see_zoom` / `set_zoom` / `emulate_device` 三个工具在执行端仍返回 `tool_not_implemented`。
- `executeTracked` 返回空 id，按 id 中止正在执行的操作实际无效（会话级 `/stop` 是可用的）。
- `/health` 里还留着从 tChrome 继承的 `extension.status` 字段，恒为 `unknown`，不影响使用。
- `service/README.md` 是内核的原始文档，部分描述仍指向「Chrome 扩展」与旧端口 18789，以本文件为准。
- 单机单用户设计：并发多会话没有隔离验证过。

---

## 来源

内核（agent loop、工具注册与校验、上下文/记忆/压缩、provider 适配、提示词模块）来自作者的另一个项目 **tChrome**（Chrome 扩展形态的浏览器 agent）。Kestrel 是它的网页形态衍生版：独立仓库、独立数据目录、独立身份，唯一替换的是浏览器执行端——从扩展桥改为 Playwright 直连本机 Chrome。
