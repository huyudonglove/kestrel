import { existsSync, readFileSync, mkdirSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { runTurnWithContinuation, type LoopDeps } from "./runtime/loop.ts";
import { resolveProxy } from "./provider/uuapi.ts";
import { configuredProvider, isProviderName, providerApiKeyEnv, providerOptions } from "./provider/config.ts";
import { ensureSession, loadSession, defaultDataDir, currentSessionView, listConversations, listConversationIds, openConversation, newConversation, deleteConversation, stopTurn, recoverStaleRuns } from "./runtime/store.ts";
import { createToolBridge, type ToolBridge } from "./runtime/bridge.ts";
import { calibrateServiceCounters } from "./runtime/ids.ts";
import type { BrowserResult, BrowserHost, CurrentTabs } from "./types.ts";
import { createPlaywrightHost } from "./browser/host.ts";
import { executorVersion, executorMismatchMessage } from "./executor-version.ts";
import { abortAllLocalProcesses } from "./tools/local-process.ts";
import { cancelAllExecutions } from "./runtime/execution.ts";
import { listItems, saveItem, deleteItem, LibraryError } from "./library/store.ts";
import { readWidgetPage, saveWidgetHtml } from "./widgets/store.ts";
import { readImageById } from "./images/store.ts";
import { getStreamHub } from "./stream/pipe.ts";

const loadEnv = () => {
  const envPath = join(import.meta.dir, ".env");
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    const value = trimmed.slice(eq + 1).trim();
    if (!Bun.env[key]) Bun.env[key] = value;
  }
};
loadEnv();

/* 右栏用 iframe 直接嵌入目标页（点击/输入都是浏览器原生行为），嵌入前先判断目标页能否被
   别的站点框住：站方常用 X-Frame-Options 或 CSP 的 frame-ancestors 拒绝嵌入，被拒时右栏
   显示明确提示，而不是假装有内容。探测结果缓存 5 分钟，避免切换页面时反复请求。 */
const embedCache = new Map<string, { embeddable: boolean; at: number }>();
const EMBED_TTL_MS = 5 * 60_000;

async function probeEmbeddable(target: string): Promise<boolean> {
  let parsed: URL;
  try {
    parsed = new URL(target);
  } catch {
    return false;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return false;
  const cached = embedCache.get(target);
  if (cached && Date.now() - cached.at < EMBED_TTL_MS) return cached.embeddable;
  let embeddable = true;
  try {
    const response = await fetch(target, {
      method: "GET",
      redirect: "follow",
      headers: { "user-agent": "Mozilla/5.0 (Kestrel preview probe)" },
      signal: AbortSignal.timeout(4000),
    });
    if (response.body) {
      try { await response.body.cancel(); } catch { /* 只关心响应头，正文直接丢弃 */ }
    }
    const xfo = (response.headers.get("x-frame-options") ?? "").trim().toLowerCase();
    // DENY / SAMEORIGIN 都会挡下跨源嵌入，只有非标准的 ALLOWALL 放行。
    if (xfo && !xfo.includes("allowall")) embeddable = false;
    const csp = (response.headers.get("content-security-policy") ?? "").toLowerCase();
    const ancestors = /frame-ancestors\s+([^;]+)/.exec(csp)?.[1]?.trim();
    // 明确写了 frame-ancestors 且不含 * 时，只有列出的来源能框住它；这里保守判为
    // 不可嵌入（用户仍可手动切到网页模式再试一次）。
    if (ancestors && !ancestors.split(/\s+/).includes("*")) embeddable = false;
  } catch {
    // 连不上或超时就当作不能嵌入，右栏会提示该站点不可嵌入。
    embeddable = false;
  }
  embedCache.set(target, { embeddable, at: Date.now() });
  return embeddable;
}

export type ServeOptions = {
  dataDir?: string;
  /** Installed runtime resources, independent of the development working directory. */
  repoRoot?: string;
  provider?: LoopDeps["provider"];
  host?: LoopDeps["host"];
  bridge?: ToolBridge;
  port?: number;
  hostname?: string;
  extensionOrigin?: string;
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json",
      "vary": "Origin",
    },
  });

export function createServer(options: ServeOptions = {}) {
  const repoRoot = options.repoRoot ?? join(import.meta.dir, "..");
  const dataDir = options.dataDir ?? defaultDataDir();
  calibrateServiceCounters(dataDir);
  const connectionPath = join(dataDir, "connection.json");
  const savedConnection = existsSync(connectionPath)
    ? JSON.parse(readFileSync(connectionPath, "utf8")) : null;
  let proxyEnabled = savedConnection ? savedConnection.enabled === true : (Bun.env.KESTREL_PROXY_MODE ?? Bun.env.TCHROME_PROXY_MODE) === "proxy";
  let providerName = savedConnection?.provider ?? Bun.env.KESTREL_PROVIDER ?? Bun.env.TCHROME_PROVIDER ?? "uuapi";
  const connectionView = () => ({ enabled: proxyEnabled, provider: providerName, providers: providerOptions() });
  const proxyURL = resolveProxy({ ...Bun.env, TCHROME_PROXY_MODE: "proxy" });
  let activeProvider = configuredProvider(proxyEnabled ? proxyURL : "", providerName);
  const provider = options.provider ?? { complete: (input: Parameters<typeof activeProvider.complete>[0]) => activeProvider.complete(input) };
  const bridge = options.bridge ?? createToolBridge(dataDir);
  const expectedVersion = executorVersion(repoRoot);
  let extension: { status: "unknown" | "ready" | "mismatch"; expectedVersion: string; actualVersion: string | null; lastSeenAt: string | null; error?: string } = {
    status: "unknown", expectedVersion, actualVersion: null, lastSeenAt: null,
  };
  const extensionStaleMs = 45_000;
  const extensionView = () => ({ ...extension, status: extension.lastSeenAt && Date.now() - Date.parse(extension.lastSeenAt) >= extensionStaleMs ? "disconnected" : extension.status });
  // Kestrel 没有浏览器扩展：浏览器能力直接由本机 Playwright 驱动真实 Chrome。
  const host = options.host ?? createPlaywrightHost(dataDir);
  const deps: LoopDeps = { dataDir, repoRoot, provider, host };
  const extensionOrigin = options.extensionOrigin ?? Bun.env.KESTREL_EXTENSION_ORIGIN ?? Bun.env.TCHROME_EXTENSION_ORIGIN;
  const trustedOrigin = (origin: string, url: URL) =>
    origin === url.origin || (extensionOrigin
      ? origin === extensionOrigin
      : /^chrome-extension:\/\/[a-p]{32}$/.test(origin));
  return {
    dataDir,
    bridge,
    streamHub: getStreamHub(),
    get proxyEnabled() { return proxyEnabled; },
    get providerName() { return providerName; },
    fetch: async (request: Request) => {
      const url = new URL(request.url);
      const origin = request.headers.get("origin");
      // Widget pages are public on localhost so the frontend can load them in
      // iframes as normal web documents with their own JS context.
      if (request.method === "GET" && url.pathname.startsWith("/widget/")) {
        const id = url.pathname.slice("/widget/".length);
        const page = readWidgetPage(dataDir, id);
        if (!page) return new Response("widget not found", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
        return new Response(page, { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
      }
      // 前端页面本身是可公开浏览的静态入口（不含数据），任何来源打开都应返回；
      // 数据接口仍然走下面的同源/受信任来源校验。
      const isPageRequest = request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html");
      // Check before routing: omitting CORS headers alone cannot prevent writes.
      if (!isPageRequest && (!["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
        || (origin !== null && !trustedOrigin(origin, url))
        || (origin === null && ["cross-site", "same-site"].includes(request.headers.get("sec-fetch-site") ?? "")))) {
        return json({ error: "forbidden origin" }, 403);
      }
      const respond = (body: unknown, status = 200) => {
        const response = json(body, status);
        if (origin) response.headers.set("access-control-allow-origin", origin);
        return response;
      };
      if (request.method === "OPTIONS") {
        return new Response(null, {
          headers: {
            ...(origin ? { "access-control-allow-origin": origin } : {}),
            "vary": "Origin",
            "access-control-allow-methods": "GET,POST,OPTIONS",
            "access-control-allow-headers": "content-type",
          },
        });
      }
      if (request.method === "GET" && (url.pathname === "/" || url.pathname === "/index.html")) {
        const page = join(repoRoot, "public", "index.html");
        if (!existsSync(page)) return new Response("缺少前端文件 public/index.html", { status: 404, headers: { "content-type": "text/plain; charset=utf-8" } });
        return new Response(readFileSync(page, "utf8"), { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" } });
      }
      if (request.method === "POST" && url.pathname === "/widget") {
        let body: { html?: unknown } | null = null;
        try { body = await request.json() as { html?: unknown }; } catch { body = null; }
        const html = typeof body?.html === "string" ? body.html : "";
        const saved = saveWidgetHtml(dataDir, html);
        if ("error" in saved) return respond(saved, 400);
        return respond(saved);
      }
      if (request.method === "GET" && url.pathname === "/health") {
        return respond({ ok: true, extension: extensionView() });
      }
      if ((request.method === "GET" && url.pathname === "/tool-request") || (request.method === "POST" && url.pathname === "/tool-result")) {
        const actualVersion = url.searchParams.get("executorVersion");
        const matches = actualVersion === expectedVersion;
        extension = { status: matches ? "ready" : "mismatch", expectedVersion, actualVersion, lastSeenAt: new Date().toISOString(), ...(!matches ? { error: executorMismatchMessage } : {}) };
        if (!matches) {
          for (const request of bridge.list()) {
            bridge.resolve(request.id, { ok: false, error: `executor_version_mismatch: ${executorMismatchMessage}` });
          }
          return respond({ ok: false, requests: [], executorVersion: expectedVersion, faultCode: "executor_version_mismatch", error: executorMismatchMessage }, 409);
        }
      }
      if (request.method === "GET" && url.pathname === "/tool-request") {
        return respond({ executorVersion: expectedVersion, requests: bridge.listForDispatch() });
      }
      if (request.method === "POST" && url.pathname === "/tool-result") {
        const body = (await request.json()) as { id?: string; result?: BrowserResult };
        if (!body.id || !body.result) return respond({ ok: false, error: "缺 id 或 result" }, 400);
        if (!bridge.resolve(body.id, body.result)) return respond({ ok: false, error: "没有这个工具请求" }, 404);
        return respond({ ok: true });
      }
      // Batch entry for external scripts: run browser tool calls on the host
      // directly, so they act on real tabs.
      if (request.method === "POST" && url.pathname === "/browser-batch") {
        let body: { tasks?: unknown } | null = null;
        try { body = await request.json() as { tasks?: unknown }; } catch { body = null; }
        const tasks = Array.isArray(body?.tasks) ? body.tasks as unknown[] : [];
        if (!tasks.length) return respond({ ok: false, error: "tasks 不能为空" }, 400);
        if (tasks.length > 32) return respond({ ok: false, error: "单批最多 32 个任务" }, 400);
        const bad = tasks.findIndex((task) => {
          const t = task as { name?: unknown; input?: unknown } | null;
          if (!t || typeof t !== "object" || typeof t.name !== "string" || !t.name.trim()) return true;
          if (t.input === undefined) return false;
          return typeof t.input !== "object" || t.input === null || Array.isArray(t.input);
        });
        if (bad >= 0) return respond({ ok: false, error: `tasks[${bad}] 需要形如 { name: string, input?: object }` }, 400);
        const batchHost = host.forScope?.("external-batch") ?? host;
        const results = await Promise.all(tasks.map(async (task, index) => {
          const t = task as { name: string; input?: Record<string, unknown> };
          let timer: ReturnType<typeof setTimeout> | undefined;
          try {
            const result = await Promise.race([
              batchHost.execute(t.name, t.input ?? {}),
              new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("批量任务超时")), 60_000); }),
            ]);
            return { index, name: t.name, result };
          } catch (error) {
            return { index, name: t.name, result: { ok: false, error: error instanceof Error ? error.message : String(error) } as BrowserResult };
          } finally { clearTimeout(timer!); }
        }));
        return respond({ ok: true, count: results.length, results });
      }
      if (request.method === "GET" && url.pathname === "/session") {
        const requested = url.searchParams.get("conversationId");
        return respond(currentSessionView(dataDir, requested));
      }
      // 右侧实时预览：把 agent 正在操作的标签页截图回传，前端轮询展示（v0 / base44 那种右栏）。
      if (request.method === "GET" && url.pathname === "/api/preview") {
        const wanted = url.searchParams.get("tabId");
        const selfPort = url.port || (url.protocol === "https:" ? "443" : "80");
        const isSelfPage = (target: string) => {
          if (!target) return false;
          try {
            const parsed = new URL(target);
            return parsed.port === selfPort && ["127.0.0.1", "localhost", "::1", "[::1]"].includes(parsed.hostname);
          } catch { return false; }
        };
        const listed = await host.execute("tabs_current", {});
        if (listed.ok === false) {
          return respond({
            ok: false,
            error: listed.error ?? "浏览器不可用",
            faultCode: listed.faultCode ?? "browser_unavailable",
          });
        }
        const windows = (listed as { windows?: { tabs?: { tabId: number; url: string; title: string; active: boolean }[] }[] }).windows ?? [];
        const tabs = windows.flatMap((win) => win.tabs ?? []);
        // 只把真正承载内容的页面当作预览目标：自身前端、空白页、内部页都不算，
        // 否则右栏会停在 about:blank 白屏上。
        const usable = (tab: { tabId: number; url: string; title: string; active: boolean }) =>
          !isSelfPage(tab.url) && !!tab.url && tab.url !== "about:blank"
          && !tab.url.startsWith("chrome://") && !tab.url.startsWith("devtools://")
          && !tab.url.startsWith("chrome-extension://") && !tab.url.startsWith("edge://");
        const external = tabs.filter(usable);
        const picked = wanted ? tabs.find((tab) => String(tab.tabId) === wanted) ?? null : null;
        const target = picked && usable(picked) ? picked : external[external.length - 1] ?? null;
        if (!target) return respond({ ok: true, empty: true, message: "agent 还没有打开页面" });
        const shot = await host.execute("capture_page", { tabId: target.tabId, mode: "viewport" });
        if (!shot.ok) {
          return respond({ ok: false, error: shot.error ?? "截图失败", tabId: target.tabId, url: target.url, title: target.title });
        }
        return respond({
          ok: true,
          tabId: target.tabId,
          url: target.url,
          title: target.title,
          dataUrl: (shot as { dataUrl?: string }).dataUrl ?? null,
          at: Date.now(),
        });
      }
      // 右栏预览的目标页订阅：执行端只跟踪 agent 正在操作的页面并发 target 事件，
      // 这里用 SSE 转给前端，前端把该页嵌进 iframe（真实页面，交互由浏览器原生处理）。
      if (request.method === "GET" && url.pathname === "/api/preview/stream") {
        const watch = host.watchPreview;
        if (!watch) {
          return respond({ ok: false, error: "执行端不支持实时预览推流", faultCode: "preview_unavailable" });
        }
        const selfPort = url.port || (url.protocol === "https:" ? "443" : "80");
        const isSelfPage = (target: string) => {
          if (!target) return false;
          try {
            const parsed = new URL(target);
            return parsed.port === selfPort && ["127.0.0.1", "localhost", "::1", "[::1]"].includes(parsed.hostname);
          } catch { return false; }
        };
        const encoder = new TextEncoder();
        let stop: (() => void) | null = null;
        let ping: ReturnType<typeof setInterval> | null = null;
        let closed = false;
        const stream = new ReadableStream<Uint8Array>({
          start(controller) {
            const send = (payload: unknown) => {
              if (closed) return;
              try {
                controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
              } catch {
                closed = true;
              }
            };
            console.log("[preview] sse open");
            send({ kind: "hello", at: Date.now() });
            // target 事件到达时顺手探测目标页能否被 iframe 嵌入（结果缓存 5 分钟），
            // 再随事件下发；前端据此决定是嵌入 iframe 还是显示不可嵌入提示。
            stop = watch((event) => {
              if (event.kind !== "target") { send(event); return; }
              void probeEmbeddable(event.url)
                .then((embeddable) => send({ ...event, embeddable }))
                .catch(() => send({ ...event, embeddable: false }));
            }, { exclude: isSelfPage });
            ping = setInterval(() => {
              if (closed) return;
              try { controller.enqueue(encoder.encode(": ping\n\n")); } catch { closed = true; }
            }, 15_000);
          },
          cancel() {
            closed = true;
            if (ping) clearInterval(ping);
            stop?.();
          },
        });
        return new Response(stream, {
          headers: {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache, no-transform",
            "connection": "keep-alive",
            "x-accel-buffering": "no",
          },
        });
      }
      // 截图等图片附件按 会话 + 图片编号 返回原始字节，供网页前端以 <img> 直接加载。
      if (request.method === "GET" && url.pathname.startsWith("/images/")) {
        const [, , rawCv, rawId] = url.pathname.split("/");
        const cvId = decodeURIComponent(rawCv ?? "");
        const imageId = decodeURIComponent(rawId ?? "");
        try {
          const { ref, dataUrl } = readImageById(dataDir, cvId, imageId);
          const base64 = dataUrl.slice(dataUrl.indexOf(",") + 1);
          return new Response(Buffer.from(base64, "base64"), {
            status: 200,
            headers: { "content-type": ref.mimeType, "cache-control": "private, max-age=300" },
          });
        } catch (error) {
          return new Response(error instanceof Error ? error.message : "image not found", {
            status: 404,
            headers: { "content-type": "text/plain; charset=utf-8" },
          });
        }
      }
      if ((request.method === "GET" && url.pathname === "/library")
        || (request.method === "POST" && ["/library/save", "/library/delete"].includes(url.pathname))) {
        try {
          if (request.method === "GET") return respond({ items: listItems(dataDir, url.searchParams.get("q") ?? "") });
          const body = await request.json().catch(() => { throw new LibraryError("请求内容必须是有效的 JSON"); });
          if (url.pathname === "/library/save") return respond({ item: saveItem(dataDir, body) });
          if (!body || typeof body !== "object" || Array.isArray(body) || typeof body.id !== "string") throw new LibraryError("缺少资料 id");
          deleteItem(dataDir, body.id);
          return respond({ ok: true });
        } catch (error) {
          if (error instanceof LibraryError) return respond({ error: error.message }, error.status);
          console.error("资料库读写失败", error);
          return respond({ error: "资料库读写失败，请检查本地目录权限与服务日志" }, 500);
        }
      }
      if (request.method === "GET" && url.pathname === "/conversations") {
        return respond({ items: listConversations(dataDir) });
      }
      if (request.method === "POST" && url.pathname === "/conversations/open") {
        const body = (await request.json()) as { conversationId?: string };
        const conversationId = String(body.conversationId ?? "");
        if (!conversationId) return respond({ error: "缺 conversationId" }, 400);
        try {
          return respond(openConversation(dataDir, conversationId));
        } catch (error) {
          return respond({ error: error instanceof Error ? error.message : String(error) }, 404);
        }
      }
      if (request.method === "POST" && url.pathname === "/conversations/new") {
        return respond(newConversation(dataDir));
      }
      if (request.method === "POST" && url.pathname === "/conversations/delete") {
        const body = (await request.json()) as { conversationId?: string };
        const conversationId = String(body.conversationId ?? "");
        if (!conversationId) return respond({ error: "缺 conversationId" }, 400);
        try {
          const next = deleteConversation(dataDir, conversationId);
          host.abort?.(conversationId);
          return respond(next);
        } catch (error) {
          return respond({ error: error instanceof Error ? error.message : String(error) }, 404);
        }
      }
      if (request.method === "GET" && url.pathname === "/connection") return respond(connectionView());
      if (request.method === "POST" && url.pathname === "/connection") {
        const body = await request.json().catch(() => null);
        if (!body || typeof body !== "object" || Array.isArray(body)
          || !("enabled" in body || "provider" in body)) return respond({ error: "invalid_connection" }, 400);
        if ("enabled" in body && typeof body.enabled !== "boolean") return respond({ error: "invalid_enabled" }, 400);
        if ("provider" in body && !isProviderName(body.provider)) return respond({ error: "invalid_provider" }, 400);
        const nextEnabled = body.enabled ?? proxyEnabled;
        const nextName = body.provider ?? providerName;
        const nextApiKeyEnv = nextName ? providerApiKeyEnv[nextName] : undefined;
        if (nextName && nextName !== providerName && !(nextApiKeyEnv && Bun.env[nextApiKeyEnv]?.trim())) {
          return respond({ error: "所选 provider 尚未配置 API Key" }, 400);
        }
        try {
          const nextProvider = configuredProvider(nextEnabled ? proxyURL : "", nextName);
          mkdirSync(dataDir, { recursive: true });
          writeFileSync(`${connectionPath}.tmp`, JSON.stringify({ enabled: nextEnabled, provider: nextName }));
          renameSync(`${connectionPath}.tmp`, connectionPath);
          proxyEnabled = nextEnabled;
          providerName = nextName;
          activeProvider = nextProvider;
          return respond(connectionView());
        } catch {
          return respond({ error: "连接设置保存失败，请检查 provider 配置及本地目录权限" }, 500);
        }
      }
      if (request.method === "POST" && url.pathname === "/turn") {
        const body = (await request.json()) as { conversationId?: string; userInput?: string; submittedAt?: string };
        const userInput = String(body.userInput ?? "").trim();
        if (!userInput) return respond({ conversationId: "", turnId: "", stopReason: { kind: "error", faultCode: "empty_input" } }, 400);
        if (body.conversationId && !listConversationIds(dataDir).includes(body.conversationId)) {
          return respond({ stopReason: { kind: "error", faultCode: "unknown_conversation" } }, 404);
        }
        const submittedAt = body.submittedAt || new Date().toISOString();
        const reply = await runTurnWithContinuation(deps, { userInput, submittedAt, conversationId: body.conversationId });
        return respond(reply);
      }
      if (request.method === "POST" && url.pathname === "/stop") {
        const raw = await request.text();
        const body = raw ? (JSON.parse(raw) as { conversationId?: string | null; initiatedBy?: string }) : undefined;
        const conversationId = body?.conversationId ?? loadSession(dataDir)?.conversationId;
        if (conversationId && !listConversationIds(dataDir).includes(conversationId)) {
          return respond({ error: "没有这个会话" }, 404);
        }
        // 谁发起的停止：脚本安排的优雅重启传 service，其余（前端停止按钮）仍是 user。
        const stopped = stopTurn(dataDir, conversationId, body?.initiatedBy === "service" ? "service" : "user");
        if (conversationId) host.abort?.(conversationId);
        return respond(stopped);
      }
      return respond({ error: "not found" }, 404);
    },
  };
}

const isMain = import.meta.main;
if (isMain) {
  const hostname = "127.0.0.1";
  // 默认 18790；可用 KESTREL_PORT 覆盖，避免与本机其他服务撞端口。
  const port = Number(Bun.env.KESTREL_PORT ?? 18790);
  const server = createServer();
  // 启动即复位上一次被硬杀留下的 running 会话，否则那些会话会永远卡在 busy。
  const recovered = recoverStaleRuns(defaultDataDir());
  if (recovered.length) console.log(`Recovered stale sessions: ${recovered.join(", ")}`);
  const hub = getStreamHub();
  Bun.serve({
    hostname,
    port,
    // SSE 是长连接，两帧之间可能长时间没有数据。Bun 默认 idleTimeout 是 10 秒，
    // 会把空闲的 /api/preview/stream 直接掐断，前端 EventSource 会不停重连、右栏
    // iframe 也跟着反复重设 src。设为 0 关闭空闲超时。
    idleTimeout: 0,
    fetch: (request, bunServer) => {
      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/stream") {
        const origin = request.headers.get("origin");
        const hostOk = ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname);
        const originOk = origin === null
          || origin === `http://${url.host}`
          || /^chrome-extension:\/\/[a-p]{32}$/.test(origin)
          || origin === (Bun.env.KESTREL_EXTENSION_ORIGIN ?? Bun.env.TCHROME_EXTENSION_ORIGIN);
        if (!hostOk || !originOk) return new Response("forbidden origin", { status: 403 });
        const upgraded = bunServer.upgrade(request);
        return upgraded ? undefined as unknown as Response : new Response("stream upgrade failed", { status: 400 });
      }
      return server.fetch(request);
    },
    websocket: {
      open(ws) {
        const send = (data: ArrayBuffer) => { try { ws.send(data); } catch { /* closed */ } };
        (ws as { streamSend?: typeof send }).streamSend = send;
        hub.attach(send);
      },
      message(ws, message) {
        const raw = typeof message === "string" ? new TextEncoder().encode(message) : message;
        hub.handleMessage(raw instanceof Uint8Array ? raw : new Uint8Array(raw as ArrayBuffer));
      },
      close(ws) {
        const send = (ws as { streamSend?: (data: ArrayBuffer) => void }).streamSend;
        if (send) hub.detach(send);
      },
    },
  });
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      cancelAllExecutions();
      abortAllLocalProcesses();
      process.exit(0);
    });
  }
  console.log(`Kestrel service http://${hostname}:${port}`);
  console.log(`Model connection: ${server.proxyEnabled ? "proxy" : "direct"}`);
  console.log(`Provider: ${server.providerName}`);
}
