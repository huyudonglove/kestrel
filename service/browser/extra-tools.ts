/**
 * Playwright 执行端的补充能力。
 *
 * host.ts 的 execute() 是一条很长的 if 分派链，只覆盖了最常用的一小批工具；
 * 其余工具虽然还在 definitions 里（模型可见、可调用），但落到兜底分支只会返回
 * `tool_not_implemented`。这个模块把 Playwright 本身能支撑的那些补上，
 * host.ts 只在兜底前委托一次，避免继续往分派链里塞分支。
 *
 * 约定：
 * - 返回值一律是 BrowserResult；名字不认识时返回 null，交回 host.ts 报未实现。
 * - 浏览器扩展专有、Playwright 没有对等 API 的能力（标签分组/多窗口/密码库）
 *   明确返回 not_supported，不伪造成功。
 */
import type { BrowserContext, Dialog, Page, Request } from "playwright-core";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BrowserResult } from "../types.ts";

type Json = Record<string, unknown>;

export type ExtraScanElement = {
  id: string;
  role: string;
  name: string;
  text: string;
  label: string;
  tag: string;
  inView: boolean;
};

export type ExtraScan = {
  url: string;
  title: string;
  bodyText: string;
  headings: string[];
  elements: ExtraScanElement[];
};

export type ExtraContext = {
  dataDir: string;
  runtime: {
    context(): Promise<BrowserContext>;
    pages(): Promise<Page[]>;
    newPage(): Promise<Page>;
    page(tabId: unknown): Promise<Page | null>;
  };
  resolve(args: Json): Promise<Page | null>;
  scanPage(page: Page): Promise<ExtraScan>;
  clickElement(page: Page, id: string): Promise<BrowserResult>;
  typeInto(page: Page, id: string, text: string, clear: boolean, enter: boolean): Promise<BrowserResult>;
  selectOption(page: Page, id: string, value: string): Promise<BrowserResult>;
  tabIdOf(page: Page): number;
  rawIdOf(id: string): number;
};

const ok = (extra: Json = {}): BrowserResult => ({ ok: true, ...extra }) as BrowserResult;
const fail = (faultCode: string, error: string, extra: Json = {}): BrowserResult =>
  ({ ok: false, faultCode, error, ...extra }) as BrowserResult;

const str = (value: unknown, fallback = ""): string => (typeof value === "string" ? value : fallback);
const num = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;
const flag = (value: unknown): boolean => value === true || value === "true";
const missingTab = () => fail("tab_not_found", "目标标签不存在或已关闭；先调用 tabs_current 确认");
const notSupported = (name: string, why: string) => fail("tool_not_supported", `${name}：${why}`, { name });
const outDir = (ctx: ExtraContext, sub: string): string => {
  const dir = join(ctx.dataDir, sub);
  mkdirSync(dir, { recursive: true });
  return dir;
};

/** 元素在页面坐标系里的中心点（会先滚动到可视区）。 */
async function centerOf(page: Page, rawId: number): Promise<{ x: number; y: number } | null> {
  return page.evaluate((id: number) => {
    const holder = (window as unknown as { __kestrel?: { els: Map<number, Element> } }).__kestrel;
    const el = holder?.els.get(id);
    if (!el) return null;
    el.scrollIntoView({ block: "center", inline: "center" });
    const rect = el.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
  }, rawId);
}

/** 带可选抖动的鼠标拖拽，模拟真人轨迹。 */
async function dragBetween(
  page: Page,
  from: { x: number; y: number },
  to: { x: number; y: number },
  humanize: boolean,
): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  const steps = humanize ? 30 : 12;
  for (let index = 1; index <= steps; index += 1) {
    const ratio = index / steps;
    const jitterX = humanize ? (Math.random() - 0.5) * 2 : 0;
    const jitterY = humanize ? (Math.random() - 0.5) * 2 : 0;
    await page.mouse.move(
      from.x + (to.x - from.x) * ratio + jitterX,
      from.y + (to.y - from.y) * ratio + jitterY,
    );
    if (humanize) await page.waitForTimeout(10 + Math.random() * 12);
  }
  await page.mouse.up();
}

// ---- 网络：请求记录、HAR、mock、节流、WebSocket ---------------------------------

/** 按可见文字找元素中心点：挑最内层的可见命中元素，滚到视野中央再取坐标。 */
async function centerOfText(page: Page, text: string): Promise<{ x: number; y: number } | null> {
  try {
    return await page.evaluate((wanted: string) => {
      const visible = (el: Element) => {
        const rect = el.getBoundingClientRect();
        const style = getComputedStyle(el);
        return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
      };
      const ownText = (el: Element) => (el.textContent ?? "").replace(/\s+/g, " ").trim();
      const nodes = Array.from(document.body?.querySelectorAll("*") ?? []);
      const hits = nodes.filter((el) => visible(el) && ownText(el).includes(wanted));
      // 最内层优先：子元素都不再包含目标文字，才算真正的落点。
      const inner = hits.find((el) => !Array.from(el.children).some((child) => ownText(child).includes(wanted)));
      const target = (inner ?? hits[hits.length - 1]) as HTMLElement | undefined;
      if (!target) return null;
      target.scrollIntoView({ block: "center", inline: "center" });
      const rect = target.getBoundingClientRect();
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
    }, text);
  } catch {
    return null; // 页面正在导航时取不到坐标，交给上层报 not_found
  }
}

/** 在正文里找关键词，返回带上下文的命中片段。 */
function grepBody(
  body: string,
  keyword: string,
  contextChars: number,
): { offset: number; before: string; hit: string; after: string }[] {
  const matches: { offset: number; before: string; hit: string; after: string }[] = [];
  let cursor = body.indexOf(keyword);
  while (cursor >= 0 && matches.length < 20) {
    matches.push({
      offset: cursor,
      before: body.slice(Math.max(0, cursor - contextChars), cursor),
      hit: keyword,
      after: body.slice(cursor + keyword.length, cursor + keyword.length + contextChars),
    });
    cursor = body.indexOf(keyword, cursor + keyword.length);
  }
  return matches;
}

type NetEntry = {
  url: string;
  method: string;
  resourceType: string;
  status: number;
  mimeType: string;
  requestHeaders: Record<string, string>;
  startedAt: number;
  durationMs: number;
  /** 文本类响应的正文（有上限），供 network_grep 检索已经发生的请求。 */
  bodyText?: string;
  /** 本次录制内的稳定编号，供 stream_pull 按 requestId 定位响应。 */
  id: string;
};

const netByPage = new WeakMap<Page, NetEntry[]>();

function ensureNet(page: Page): NetEntry[] {
  const cached = netByPage.get(page);
  if (cached) return cached;
  const entries: NetEntry[] = [];
  netByPage.set(page, entries);
  let seq = 0;
  const nextId = () => `net-${++seq}`;
  const started = new Map<Request, number>();
  page.on("request", (request) => {
    started.set(request, Date.now());
  });
  page.on("response", (response) => {
    const request = response.request();
    const begin = started.get(request) ?? Date.now();
    const entry: NetEntry = {
      id: nextId(),
      url: request.url(),
      method: request.method(),
      resourceType: request.resourceType(),
      status: response.status(),
      mimeType: response.headers()["content-type"] ?? "",
      requestHeaders: request.headers(),
      startedAt: begin,
      durationMs: Date.now() - begin,
    };
    entries.push(entry);
    if (entries.length > 3000) entries.shift();
    // network_grep 要能检索已经发生的响应，所以顺手留下文本类正文（有上限）。
    if (/json|text|javascript|xml|x-www-form-urlencoded/i.test(entry.mimeType)) {
      void response
        .text()
        .then((body) => {
          if (typeof body === "string" && body.length <= 200_000) entry.bodyText = body;
        })
        .catch(() => undefined); // 重定向或正文已被消费时拿不到，忽略
    }
  });
  page.on("requestfailed", (request) => {
    const begin = started.get(request) ?? Date.now();
    entries.push({
      id: nextId(),
      url: request.url(),
      method: request.method(),
      resourceType: request.resourceType(),
      status: 0,
      mimeType: "",
      requestHeaders: request.headers(),
      startedAt: begin,
      durationMs: Date.now() - begin,
    });
    if (entries.length > 3000) entries.shift();
  });
  return entries;
}

type WsFrame = { dir: "sent" | "received"; payload: string; at: number };
const wsByPage = new WeakMap<Page, { url: string; frames: WsFrame[] }[]>();

function ensureWs(page: Page): { url: string; frames: WsFrame[] }[] {
  const cached = wsByPage.get(page);
  if (cached) return cached;
  const sockets: { url: string; frames: WsFrame[] }[] = [];
  wsByPage.set(page, sockets);
  page.on("websocket", (socket) => {
    const record = { url: socket.url(), frames: [] as WsFrame[] };
    sockets.push(record);
    socket.on("framesent", (event) => {
      record.frames.push({ dir: "sent", payload: String(event.payload ?? "").slice(0, 2000), at: Date.now() });
      if (record.frames.length > 500) record.frames.shift();
    });
    socket.on("framereceived", (event) => {
      record.frames.push({ dir: "received", payload: String(event.payload ?? "").slice(0, 2000), at: Date.now() });
      if (record.frames.length > 500) record.frames.shift();
    });
  });
  return sockets;
}

type MockRule = { id: string; pattern: string; status: number; body: string; contentType: string; delayMs: number };
const mockRules: MockRule[] = [];

function harEntry(entry: NetEntry): Json {
  const iso = new Date(entry.startedAt).toISOString();
  return {
    startedDateTime: iso,
    time: entry.durationMs,
    request: {
      method: entry.method,
      url: entry.url,
      httpVersion: "HTTP/1.1",
      headers: Object.entries(entry.requestHeaders).map(([name, value]) => ({ name, value })),
      queryString: (() => {
        try {
          const parsed = new URL(entry.url);
          return Array.from(parsed.searchParams.entries()).map(([name, value]) => ({ name, value }));
        } catch {
          return []; // URL 不可解析（data:/about:）时没有 query
        }
      })(),
      cookies: [] as Json[],
      headersSize: -1,
      bodySize: -1,
    },
    response: {
      status: entry.status,
      statusText: "",
      httpVersion: "HTTP/1.1",
      headers: entry.mimeType ? [{ name: "content-type", value: entry.mimeType }] : [],
      cookies: [] as Json[],
      content: { size: 0, mimeType: entry.mimeType },
      redirectURL: "",
      headersSize: -1,
      bodySize: -1,
    },
    cache: {},
    timings: { send: 0, wait: entry.durationMs, receive: 0 },
  };
}

const throttlePresets: Record<string, { offline: boolean; latency: number; download: number; upload: number }> = {
  offline: { offline: true, latency: 0, download: 0, upload: 0 },
  slow3g: { offline: false, latency: 400, download: 400 * 1024, upload: 400 * 1024 },
  fast3g: { offline: false, latency: 150, download: 1.6 * 1024 * 1024, upload: 750 * 1024 },
  slow4g: { offline: false, latency: 80, download: 5 * 1024 * 1024, upload: 2 * 1024 * 1024 },
  reset: { offline: false, latency: 0, download: -1, upload: -1 },
};

async function cdp(page: Page) {
  return page.context().newCDPSession(page);
}

async function handleNetwork(name: string, args: Json, ctx: ExtraContext, page: Page | null): Promise<BrowserResult | null> {
  if (name === "har") {
    if (!page) return missingTab();
    const action = str(args.action, "read");
    const entries = ensureNet(page);
    if (action === "start") {
      entries.length = 0;
      return ok({ tabId: ctx.tabIdOf(page), recording: true, entryCount: 0 });
    }
    if (action === "read") {
      return ok({ tabId: ctx.tabIdOf(page), recording: netByPage.has(page), entryCount: entries.length });
    }
    const har = {
      log: {
        version: "1.2",
        creator: { name: "kestrel", version: "0.1.0" },
        pages: [] as Json[],
        entries: entries.map(harEntry),
      },
    };
    return ok({ tabId: ctx.tabIdOf(page), entryCount: entries.length, har });
  }
  if (name === "capture_network_traffic") {
    if (!page) return missingTab();
    const filter = str(args.urlContains);
    const entries = ensureNet(page);
    const items = entries
      .filter((entry) => !filter || entry.url.includes(filter))
      .slice(-200)
      .map((entry) => ({
        requestId: entry.id,
        url: entry.url,
        method: entry.method,
        status: entry.status,
        type: entry.resourceType,
        ms: entry.durationMs,
      }));
    return ok({ tabId: ctx.tabIdOf(page), count: items.length, entries: items });
  }
  if (name === "network_grep") {
    if (!page) return missingTab();
    const urlContains = str(args.urlContains);
    const keyword = str(args.keyword);
    if (!urlContains || !keyword) return fail("invalid_arguments", "network_grep 需要 urlContains 与 keyword");
    const status = num(args.status);
    const contextChars = num(args.contextChars) ?? 400;
    const timeout = num(args.timeoutMs) ?? 8000;
    // 先检索已经记录下来的响应：调用工具时请求往往已经发生，只等未来响应会白等到超时。
    // 正文由 response.text() 异步填充，紧接着请求调用时可能还没就绪，先给它一点收敛时间。
    const bodyDeadline = Date.now() + 1500;
    const bodyPending = () =>
      ensureNet(page).some(
        (entry) =>
          entry.url.includes(urlContains) &&
          /json|text|javascript|xml|x-www-form-urlencoded/i.test(entry.mimeType) &&
          typeof entry.bodyText !== "string",
      );
    while (Date.now() < bodyDeadline && bodyPending()) await page.waitForTimeout(100);
    const recorded = ensureNet(page)
      .filter(
        (entry) =>
          entry.url.includes(urlContains) &&
          (status === undefined || entry.status === status) &&
          typeof entry.bodyText === "string",
      )
      .reverse();
    for (const entry of recorded) {
      const body = entry.bodyText ?? "";
      const matches = grepBody(body, keyword, contextChars);
      if (matches.length) {
        return ok({
          requestId: entry.id,
          url: entry.url,
          status: entry.status,
          matches,
          totalChars: body.length,
          source: "recorded",
        });
      }
    }
    try {
      const response = await page.waitForResponse(
        (candidate) =>
          candidate.url().includes(urlContains) && (status === undefined || candidate.status() === status),
        { timeout },
      );
      const body = await response.text().catch(() => "");
      return ok({
        requestId: String(ctx.tabIdOf(page)),
        url: response.url(),
        status: response.status(),
        matches: grepBody(body, keyword, contextChars),
        totalChars: body.length,
        source: "wait",
      });
    } catch (error) {
      return fail("timeout", `未等到 ${urlContains} 的响应：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (name === "network_mock") {
    if (!page) return missingTab();
    const action = str(args.action, "list");
    const context = await ctx.runtime.context();
    const ruleId = str(args.ruleId);
    if (action === "list" || action === "read") {
      return ok({ count: mockRules.length, rules: mockRules.map(({ id, pattern, status, contentType }) => ({ id, pattern, status, contentType })) });
    }
    if (action === "clear" || action === "stop") {
      for (const rule of mockRules.splice(0, mockRules.length)) {
        await context.unroute((url) => url.href.includes(rule.pattern)).catch(() => undefined);
      }
      return ok({ cleared: true, count: 0 });
    }
    if (action === "remove" && ruleId) {
      const index = mockRules.findIndex((rule) => rule.id === ruleId);
      if (index < 0) return fail("not_found", `没有 ruleId=${ruleId} 的 mock 规则`);
      const [rule] = mockRules.splice(index, 1);
      if (rule) await context.unroute((url) => url.href.includes(rule.pattern)).catch(() => undefined);
      return ok({ removed: ruleId, count: mockRules.length });
    }
    const rule = (args.rule ?? {}) as Json;
    const pattern = str(rule.urlContains, str(args.urlContains));
    if (!pattern) return fail("invalid_arguments", "network_mock 需要 rule.urlContains（URL 子串）");
    const created: MockRule = {
      id: ruleId || `mock_${Date.now().toString(36)}`,
      pattern,
      status: num(rule.status) ?? 200,
      body: str(rule.body, ""),
      contentType: str(rule.contentType, "application/json"),
      delayMs: num(rule.delayMs) ?? 0,
    };
    mockRules.push(created);
    await context.route(
      (url) => url.href.includes(created.pattern),
      async (route) => {
        if (created.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, created.delayMs));
        await route.fulfill({ status: created.status, body: created.body, contentType: created.contentType });
      },
    );
    return ok({ ruleId: created.id, pattern: created.pattern, status: created.status, count: mockRules.length });
  }
  if (name === "network_throttle") {
    if (!page) return missingTab();
    const preset = str(args.preset, str(args.profile, "slow3g"));
    const profile = throttlePresets[preset];
    if (!profile) {
      return fail("invalid_arguments", `未知预设 ${preset}`, { presets: Object.keys(throttlePresets) });
    }
    const session = await cdp(page);
    await session.send("Network.enable");
    await session.send("Network.emulateNetworkConditions", {
      offline: profile.offline,
      latency: profile.latency,
      downloadThroughput: profile.download,
      uploadThroughput: profile.upload,
    });
    return ok({ tabId: ctx.tabIdOf(page), preset, profile });
  }
  if (name === "websocket_monitor") {
    if (!page) return missingTab();
    const action = str(args.action, "read");
    const sockets = ensureWs(page);
    const items = sockets.map((socket) => ({ url: socket.url, frameCount: socket.frames.length, frames: socket.frames.slice(-50) }));
    return ok({ tabId: ctx.tabIdOf(page), action, count: items.length, sockets: items });
  }
  return null;
}

// ---- 存储与身份 ----------------------------------------------------------------

async function handleStorage(name: string, args: Json, ctx: ExtraContext, page: Page | null): Promise<BrowserResult | null> {
  if (name === "set_cookie") {
    const context = await ctx.runtime.context();
    const name_ = str(args.name);
    const value = str(args.value);
    if (!name_) return fail("invalid_arguments", "set_cookie 需要 name");
    const url = str(args.url) || (page ? page.url() : "");
    if (!url) return fail("invalid_arguments", "set_cookie 需要 url 或已激活的标签页");
    const expires = num(args.expires);
    // Playwright 只接受两种定位方式：url，或者 domain + path；两者同时传会被 CDP 拒掉。
    const domain = str(args.domain);
    const path = str(args.path) || "/";
    const scope = domain ? { domain, path } : { url };
    await context.addCookies([
      {
        name: name_,
        value,
        ...scope,
        secure: typeof args.secure === "boolean" ? args.secure : undefined,
        expires: expires && expires > 0 ? expires : undefined,
      } as never,
    ]);
    return ok({ name: name_, ...scope });
  }
  if (name === "delete_cookie") {
    const context = await ctx.runtime.context();
    const cookieName = str(args.name);
    if (!cookieName) return fail("invalid_arguments", "delete_cookie 需要 name");
    await context.clearCookies({
      name: cookieName,
      domain: str(args.domain) || undefined,
      path: str(args.path) || undefined,
    });
    return ok({ deleted: cookieName });
  }
  if (name === "clear_cookies") {
    const context = await ctx.runtime.context();
    await context.clearCookies();
    return ok({ cleared: true, origin: str(args.origin) || null });
  }
  if (name === "page_storage") {
    if (!page) return missingTab();
    // definitions 的词表是 read/write/delete/list，内部实现用 get/set/remove，两套都接受。
    const asked = str(args.action, "read");
    const action = ({ read: "get", write: "set", delete: "remove", remove: "remove" } as Record<string, string>)[asked] ?? asked;
    const area = str(args.area, "local") === "session" ? "sessionStorage" : "localStorage";
    const key = str(args.key);
    const result = await page.evaluate(
      ({ action: next, area: target, key: name_, value }: { action: string; area: string; key: string; value: string }) => {
        const store = (window as unknown as Record<string, Storage>)[target] as Storage | undefined;
        if (!store) return { ok: false, reason: "storage_unavailable" };
        if (next === "set" && name_) {
          store.setItem(name_, value);
          return { ok: true, key: name_, value };
        }
        if (next === "remove" && name_) {
          store.removeItem(name_);
          return { ok: true, key: name_, removed: true };
        }
        if (next === "clear") {
          store.clear();
          return { ok: true, cleared: true };
        }
        if (name_) return { ok: true, key: name_, value: store.getItem(name_) };
        const entries: { key: string; value: string }[] = [];
        for (let index = 0; index < store.length && index < 200; index += 1) {
          const itemKey = store.key(index) ?? "";
          entries.push({ key: itemKey, value: (store.getItem(itemKey) ?? "").slice(0, 2000) });
        }
        return { ok: true, count: store.length, entries };
      },
      { action, area, key, value: str(args.value) },
    );
    return ok({ tabId: ctx.tabIdOf(page), action, area, ...result });
  }
  if (name === "indexeddb") {
    if (!page) return missingTab();
    const action = str(args.action, "list");
    const db = str(args.db);
    const store = str(args.store);
    const key = args.key === undefined ? null : args.key;
    const result = await page.evaluate(
      async ({ action: next, db: dbName, store: storeName, key: wanted, value }: {
        action: string;
        db: string;
        store: string;
        key: unknown;
        value: unknown;
      }) => {
        const factory = (window as unknown as { indexedDB?: IDBFactory }).indexedDB;
        if (!factory) return { ok: false, reason: "indexeddb_unavailable" };
        if (next === "list" || !dbName) {
          const withDatabases = factory as IDBFactory & { databases?: () => Promise<{ name?: string }[]> };
          if (!withDatabases.databases) return { ok: true, databases: [] };
          const list = await withDatabases.databases();
          return { ok: true, databases: list.map((item) => item.name ?? "") };
        }
        const open = () => new Promise<IDBDatabase>((resolve, reject) => {
          const request = factory.open(dbName);
          request.onsuccess = () => resolve(request.result);
          request.onerror = () => reject(request.error ?? new Error("indexeddb_open_failed"));
        });
        const database = await open();
        try {
          if (next === "list" || !storeName) return { ok: true, stores: Array.from(database.objectStoreNames) };
          if (!storeName) return { ok: false, reason: "store_required" };
          const tx = database.transaction(storeName, next === "set" || next === "delete" ? "readwrite" : "readonly");
          const objectStore = tx.objectStore(storeName);
          const done = (request: IDBRequest) => new Promise<unknown>((resolve, reject) => {
            request.onsuccess = () => resolve(request.result);
            request.onerror = () => reject(request.error ?? new Error("indexeddb_request_failed"));
          });
          if (next === "set") {
            await done(objectStore.put(value, wanted === null ? undefined : (wanted as IDBValidKey)));
            return { ok: true, written: true };
          }
          if (next === "delete") {
            await done(objectStore.delete(wanted as IDBValidKey));
            return { ok: true, deleted: true };
          }
          const value_ = wanted === null ? await done(objectStore.getAll()) : await done(objectStore.get(wanted as IDBValidKey));
          return { ok: true, value: JSON.parse(JSON.stringify(value_ ?? null)) as unknown };
        } finally {
          database.close();
        }
      },
      { action, db, store, key, value: args.value ?? null },
    );
    return ok({ tabId: ctx.tabIdOf(page), action, ...result });
  }
  if (name === "cache_storage") {
    if (!page) return missingTab();
    const action = str(args.action, "list");
    const result = await page.evaluate(
      async ({ action: next, cache, key, value }: { action: string; cache: string; key: string; value: string }) => {
        if (!("caches" in window)) return { ok: false, reason: "cache_storage_unavailable" };
        if (next === "list" || !cache) return { ok: true, caches: await caches.keys() };
        if (next === "clear") {
          const removed = await caches.delete(cache);
          return { ok: true, removed };
        }
        const target = await caches.open(cache);
        if (next === "keys") {
          const requests = await target.keys();
          return { ok: true, keys: requests.slice(0, 200).map((item) => item.url) };
        }
        if (next === "read" || next === "get") {
          if (!key) return { ok: false, reason: "key_required" };
          const response = await target.match(key);
          if (!response) return { ok: true, found: false };
          return { ok: true, found: true, status: response.status, body: (await response.text()).slice(0, 4000) };
        }
        if (next === "set") {
          if (!key) return { ok: false, reason: "key_required" };
          await target.put(key, new Response(value));
          return { ok: true, written: true };
        }
        if (next === "delete") {
          if (!key) return { ok: false, reason: "key_required" };
          return { ok: true, deleted: await target.delete(key) };
        }
        return { ok: false, reason: `unknown_action:${next}` };
      },
      { action, cache: str(args.cache), key: str(args.key), value: str(args.value) },
    );
    return ok({ tabId: ctx.tabIdOf(page), action, ...result });
  }
  if (name === "set_geolocation") {
    const context = await ctx.runtime.context();
    const latitude = num(args.latitude) ?? num(args.lat) ?? 39.9087;
    const longitude = num(args.longitude) ?? num(args.lng) ?? num(args.lon) ?? 116.3975;
    const accuracy = num(args.accuracy) ?? 25;
    await context.setGeolocation({ latitude, longitude, accuracy });
    if (page) await context.grantPermissions(["geolocation"], { origin: page.url() }).catch(() => undefined);
    return ok({ latitude, longitude, accuracy, tabId: page ? ctx.tabIdOf(page) : null });
  }
  if (name === "fingerprint_read") {
    if (!page) return missingTab();
    const data = await page.evaluate(() => ({
      userAgent: navigator.userAgent,
      platform: navigator.platform,
      language: navigator.language,
      languages: navigator.languages,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      timezoneOffset: new Date().getTimezoneOffset(),
      screen: { width: screen.width, height: screen.height, colorDepth: screen.colorDepth },
      viewport: { width: window.innerWidth, height: window.innerHeight, devicePixelRatio: window.devicePixelRatio },
      hardwareConcurrency: navigator.hardwareConcurrency,
      deviceMemory: (navigator as unknown as { deviceMemory?: number }).deviceMemory ?? null,
      webdriver: (navigator as unknown as { webdriver?: boolean }).webdriver ?? null,
    }));
    return ok({ tabId: ctx.tabIdOf(page), ...data });
  }
  if (name === "fingerprint_apply" || name === "emulate_device") {
    if (!page) return missingTab();
    const session = await cdp(page);
    const applied: string[] = [];
    const userAgent = str(args.userAgent);
    const platform = str(args.platform);
    const acceptLanguage = str(args.acceptLanguage);
    if (userAgent || platform || acceptLanguage) {
      await session.send("Emulation.setUserAgentOverride", {
        userAgent: userAgent || (await page.evaluate(() => navigator.userAgent)),
        platform: platform || undefined,
        acceptLanguage: acceptLanguage || undefined,
      });
      applied.push("userAgent");
    }
    const timezone = str(args.timezone);
    if (timezone) {
      await session.send("Emulation.setTimezoneOverride", { timezoneId: timezone });
      applied.push("timezone");
    }
    const locale = str(args.locale);
    if (locale) {
      await session.send("Emulation.setLocaleOverride", { locale });
      applied.push("locale");
    }
    const width = num(args.width);
    const height = num(args.height);
    const deviceScaleFactor = num(args.deviceScaleFactor);
    if (flag(args.mobile) || width || height) {
      await session.send("Emulation.setDeviceMetricsOverride", {
        width: width ?? 390,
        height: height ?? 844,
        deviceScaleFactor: deviceScaleFactor ?? 3,
        mobile: flag(args.mobile),
      });
      applied.push("deviceMetrics");
    }
    return ok({ tabId: ctx.tabIdOf(page), applied });
  }
  if (name === "set_zoom") {
    if (!page) return missingTab();
    const factor = num(args.factor) ?? num(args.zoom) ?? 1;
    const session = await cdp(page);
    await session.send("Emulation.setPageScaleFactor", { pageScaleFactor: factor });
    return ok({ tabId: ctx.tabIdOf(page), pageScaleFactor: factor });
  }
  if (name === "see_zoom") {
    if (!page) return missingTab();
    const data = await page.evaluate(() => ({
      visualViewportScale: window.visualViewport?.scale ?? 1,
      devicePixelRatio: window.devicePixelRatio,
      innerWidth: window.innerWidth,
      deviceWidth: window.screen.width,
    }));
    return ok({ tabId: ctx.tabIdOf(page), ...data });
  }
  return null;
}

// ---- 交互 ----------------------------------------------------------------------

async function handleInteraction(name: string, args: Json, ctx: ExtraContext, page: Page | null): Promise<BrowserResult | null> {
  if (name === "hover" || name === "focus" || name === "double_click") {
    if (!page) return missingTab();
    const id = str(args.id) || str(args.ref);
    const text = str(args.text);
    let target: { x: number; y: number } | null = null;
    if (id) target = await centerOf(page, ctx.rawIdOf(id));
    if (!target && text) {
      const scan = await ctx.scanPage(page);
      const hit = scan.elements.find((element) => element.text.includes(text) || element.name.includes(text));
      if (hit) target = await centerOf(page, ctx.rawIdOf(hit.id));
      // scanPage 只收交互元素，承载 hover 的往往是普通 div，退回按可见文字找落点。
      if (!target) target = await centerOfText(page, text);
    }
    if (name === "focus") {
      const focused = await page.evaluate((wanted: string) => {
        const holder = (window as unknown as { __kestrel?: { els: Map<number, Element> } }).__kestrel;
        const raw = Number(wanted.replace(/^[a-z]_/i, ""));
        const el = holder?.els.get(raw) as HTMLElement | undefined;
        if (!el) return false;
        el.scrollIntoView({ block: "center" });
        el.focus();
        return true;
      }, id);
      if (!focused) return fail("not_found", `页面上没有元素 ${id}`, { id });
      return ok({ id, focused: true });
    }
    if (!target) return fail("not_found", `页面上没有元素 ${id || text}`, { id, text });
    if (name === "hover") {
      await page.mouse.move(target.x, target.y);
      return ok({ id, hovered: true, at: target });
    }
    await page.mouse.dblclick(target.x, target.y);
    return ok({ id, doubleClicked: true, at: target });
  }
  if (name === "click_xy") {
    if (!page) return missingTab();
    const x = num(args.x);
    const y = num(args.y);
    if (x === undefined || y === undefined) return fail("invalid_arguments", "click_xy 需要 x 与 y");
    await page.mouse.click(x, y);
    return ok({ tabId: ctx.tabIdOf(page), clicked: { x, y } });
  }
  if (name === "long_press") {
    if (!page) return missingTab();
    const id = str(args.id);
    const holdMs = num(args.durationMs) ?? num(args.holdMs) ?? 800;
    const point = id ? await centerOf(page, ctx.rawIdOf(id)) : { x: num(args.x) ?? 0, y: num(args.y) ?? 0 };
    if (!point) return fail("not_found", `页面上没有元素 ${id}`, { id });
    await page.mouse.move(point.x, point.y);
    await page.mouse.down();
    await page.waitForTimeout(holdMs);
    await page.mouse.up();
    return ok({ id, heldMs: holdMs, at: point });
  }
  if (name === "context_menu") {
    if (!page) return missingTab();
    const id = str(args.id);
    const point = id ? await centerOf(page, ctx.rawIdOf(id)) : { x: num(args.x) ?? 0, y: num(args.y) ?? 0 };
    if (!point) return fail("not_found", `页面上没有元素 ${id}`, { id });
    await page.mouse.click(point.x, point.y, { button: "right" });
    return ok({ id, contextMenu: true, at: point });
  }
  if (name === "drag") {
    if (!page) return missingTab();
    const x1 = num(args.x1);
    const y1 = num(args.y1);
    const x2 = num(args.x2);
    const y2 = num(args.y2);
    if (x1 === undefined || y1 === undefined || x2 === undefined || y2 === undefined) {
      return fail("invalid_arguments", "drag 需要 x1/y1/x2/y2");
    }
    await dragBetween(page, { x: x1, y: y1 }, { x: x2, y: y2 }, flag(args.humanize));
    return ok({ tabId: ctx.tabIdOf(page), from: { x: x1, y: y1 }, to: { x: x2, y: y2 } });
  }
  if (name === "calibrate_drag") {
    const point1 = (args.point1 ?? {}) as Json;
    const point2 = (args.point2 ?? {}) as Json;
    const from = { x: num(point1.x) ?? num(args.x1) ?? 0, y: num(point1.y) ?? num(args.y1) ?? 0 };
    const to = { x: num(point2.x) ?? num(args.x2) ?? 0, y: num(point2.y) ?? num(args.y2) ?? 0 };
    const distance = Math.hypot(to.x - from.x, to.y - from.y);
    return ok({ from, to, distance: Math.round(distance * 100) / 100, angle: Math.round((Math.atan2(to.y - from.y, to.x - from.x) * 180) / Math.PI) });
  }
  if (name === "page_drag_to_id") {
    if (!page) return missingTab();
    const sourceId = str(args.sourceId);
    const targetId = str(args.targetId);
    if (!sourceId || !targetId) return fail("invalid_arguments", "page_drag_to_id 需要 sourceId 与 targetId");
    const from = await centerOf(page, ctx.rawIdOf(sourceId));
    const to = await centerOf(page, ctx.rawIdOf(targetId));
    if (!from) return fail("not_found", `页面上没有元素 ${sourceId}`, { sourceId });
    if (!to) return fail("not_found", `页面上没有元素 ${targetId}`, { targetId });
    await dragBetween(page, from, to, flag(args.humanize));
    return ok({ tabId: ctx.tabIdOf(page), sourceId, targetId, from, to });
  }
  if (name === "scroll_to") {
    if (!page) return missingTab();
    const id = str(args.id);
    if (id) {
      const scrolled = await page.evaluate((wanted: string) => {
        const holder = (window as unknown as { __kestrel?: { els: Map<number, Element> } }).__kestrel;
        const raw = Number(wanted.replace(/^[a-z]_/i, ""));
        const el = holder?.els.get(raw);
        if (!el) return false;
        el.scrollIntoView({ block: "center", inline: "center" });
        return true;
      }, id);
      if (!scrolled) return fail("not_found", `页面上没有元素 ${id}`, { id });
      return ok({ id, scrolled: true });
    }
    const x = num(args.x) ?? 0;
    const y = num(args.y) ?? num(args.top) ?? 0;
    await page.evaluate(({ x: left, y: top }: { x: number; y: number }) => window.scrollTo(left, top), { x, y });
    return ok({ tabId: ctx.tabIdOf(page), x, y });
  }
  if (name === "tick") {
    if (!page) return missingTab();
    const dx = num(args.dx) ?? 2;
    const dy = num(args.dy) ?? 2;
    await page.evaluate(() => undefined);
    await page.mouse.move(dx, dy);
    return ok({ tabId: ctx.tabIdOf(page), moved: { dx, dy } });
  }
  if (name === "submit") {
    if (!page) return missingTab();
    const id = str(args.id);
    if (id) {
      await ctx.clickElement(page, id);
      return ok({ id, submitted: true });
    }
    const result = await page.evaluate(() => {
      const form = (document.activeElement as HTMLElement | null)?.closest?.("form");
      if (form) {
        form.requestSubmit();
        return { submitted: true, via: "form" };
      }
      return { submitted: false, via: "none" };
    });
    if (!result.submitted) await page.keyboard.press("Enter");
    return ok({ ...result, tabId: ctx.tabIdOf(page) });
  }
  if (name === "date_select") {
    if (!page) return missingTab();
    const id = str(args.id);
    const value = str(args.value);
    if (!id || !value) return fail("invalid_arguments", "date_select 需要 id 与 value");
    const result = await page.evaluate(({ wanted, next }: { wanted: string; next: string }) => {
      const holder = (window as unknown as { __kestrel?: { els: Map<number, Element> } }).__kestrel;
      const raw = Number(wanted.replace(/^[a-z]_/i, ""));
      const el = holder?.els.get(raw) as HTMLInputElement | undefined;
      if (!el) return { ok: false, reason: "not_found" };
      const descriptor = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
      descriptor?.set?.call(el, next);
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      el.dispatchEvent(new Event("blur", { bubbles: true }));
      return { ok: true, value: el.value, type: el.type };
    }, { wanted: id, next: value });
    if (!result.ok) return fail("not_found", `页面上没有元素 ${id}`, { id });
    return ok({ id, ...result });
  }
  if (name === "dialog_wait" || name === "handle_dialog") {
    if (!page) return missingTab();
    const tabId = ctx.tabIdOf(page);
    if (name === "dialog_wait") {
      const timeout = num(args.timeoutMs) ?? 5000;
      try {
        const dialog = await page.waitForEvent("dialog", { timeout });
        pendingDialogs.set(tabId, dialog);
        return ok({ tabId, type: dialog.type(), message: dialog.message(), defaultValue: dialog.defaultValue() });
      } catch {
        return fail("timeout", "在超时前没有出现原生弹窗", { tabId });
      }
    }
    const action = str(args.action, "accept");
    const promptText = str(args.promptText);
    const pending = pendingDialogs.get(tabId);
    if (pending) {
      pendingDialogs.delete(tabId);
      if (action === "accept") await pending.accept(promptText || undefined);
      else await pending.dismiss();
      return ok({ tabId, action, handled: true });
    }
    page.once("dialog", (dialog) => {
      void (action === "accept" ? dialog.accept(promptText || undefined) : dialog.dismiss());
    });
    return ok({ tabId, action, armed: true });
  }
  if (name === "wait_new_tab") {
    const context = await ctx.runtime.context();
    const timeout = num(args.timeoutMs) ?? 8000;
    try {
      const created = await context.waitForEvent("page", { timeout });
      await created.waitForLoadState("domcontentloaded", { timeout: 8000 }).catch(() => undefined);
      return ok({ tabId: ctx.tabIdOf(created), url: created.url(), title: await created.title().catch(() => "") });
    } catch {
      return fail("timeout", "在超时前没有出现新标签", { timeout });
    }
  }
  return null;
}

const pendingDialogs = new Map<number, Dialog>();

// ---- 观察 ----------------------------------------------------------------------

async function handleObservation(name: string, args: Json, ctx: ExtraContext, page: Page | null): Promise<BrowserResult | null> {
  if (name === "snapshot_page" || name === "see_page" || name === "page_find" || name === "find_on_page") {
    if (!page) return missingTab();
    const scan = await ctx.scanPage(page);
    const limit = num(args.limit) ?? 60;
    if (name === "find_on_page" || name === "page_find") {
      const needle = str(args.text);
      const hits = scan.elements
        .filter((element) => !needle || element.text.includes(needle) || element.name.includes(needle) || element.label.includes(needle))
        .slice(0, limit);
      return ok({ tabId: ctx.tabIdOf(page), query: needle, count: hits.length, elements: hits });
    }
    const text = str(args.text);
    return ok({
      tabId: ctx.tabIdOf(page),
      url: scan.url,
      title: scan.title,
      headings: scan.headings,
      interactiveCount: scan.elements.length,
      elements: scan.elements.slice(0, limit),
      text: text ? scan.bodyText.slice(0, 2000) : scan.bodyText.slice(0, 4000),
    });
  }
  if (name === "page_get_dom") {
    if (!page) return missingTab();
    const selector = str(args.selector);
    const id = str(args.id);
    if (id) {
      const html = await page.evaluate((wanted: string) => {
        const holder = (window as unknown as { __kestrel?: { els: Map<number, Element> } }).__kestrel;
        const raw = Number(wanted.replace(/^[a-z]_/i, ""));
        const el = holder?.els.get(raw);
        return el ? el.outerHTML.slice(0, 4000) : "";
      }, id);
      if (!html) return fail("not_found", `页面上没有元素 ${id}`, { id });
      return ok({ id, html });
    }
    const html = selector
      ? await page.evaluate((wanted: string) => document.querySelector(wanted)?.outerHTML.slice(0, 4000) ?? "", selector)
      : (await page.content()).slice(0, 6000);
    return ok({ tabId: ctx.tabIdOf(page), selector: selector || "document", html });
  }
  if (name === "page_get_accessibility_tree") {
    if (!page) return missingTab();
    const session = await cdp(page);
    await session.send("Accessibility.enable");
    const tree = (await session.send("Accessibility.getFullAXTree")) as {
      nodes?: { ignored?: boolean; role?: { value?: string }; name?: { value?: string }; value?: { value?: string } }[];
    };
    const nodes = (tree.nodes ?? [])
      .filter((node) => !node.ignored && (node.role?.value || node.name?.value))
      .slice(0, 200)
      .map((node) => ({ role: node.role?.value ?? "", name: node.name?.value ?? "", value: node.value?.value ?? "" }));
    return ok({ tabId: ctx.tabIdOf(page), count: nodes.length, nodes });
  }
  if (name === "page_get_element_state") {
    if (!page) return missingTab();
    const id = str(args.id);
    if (!id) return fail("invalid_arguments", "page_get_element_state 需要 id");
    const state = await page.evaluate((wanted: string) => {
      const holder = (window as unknown as { __kestrel?: { els: Map<number, Element> } }).__kestrel;
      const raw = Number(wanted.replace(/^[a-z]_/i, ""));
      const el = holder?.els.get(raw) as HTMLElement | undefined;
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      const input = el as HTMLInputElement;
      const attributes: Record<string, string> = {};
      for (const attribute of Array.from(el.attributes).slice(0, 20)) attributes[attribute.name] = attribute.value.slice(0, 120);
      return {
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute("role") ?? "",
        text: (el.innerText ?? "").trim().slice(0, 200),
        value: typeof input.value === "string" ? input.value : "",
        enabled: !input.disabled,
        checked: typeof input.checked === "boolean" ? input.checked : null,
        focused: document.activeElement === el,
        visible: rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none",
        rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
        attributes,
      };
    }, id);
    if (!state) return fail("not_found", `页面上没有元素 ${id}`, { id });
    return ok({ id, ...state });
  }
  if (name === "extract_table") {
    if (!page) return missingTab();
    const tables = await page.evaluate(() => {
      const out: { index: number; rows: string[][] }[] = [];
      Array.from(document.querySelectorAll("table")).slice(0, 5).forEach((table, index) => {
        const rows = Array.from(table.querySelectorAll("tr")).slice(0, 200).map((row) =>
          Array.from(row.querySelectorAll("th,td")).map((cell) => (cell.textContent ?? "").trim().slice(0, 200)),
        );
        out.push({ index, rows });
      });
      return out;
    });
    return ok({ tabId: ctx.tabIdOf(page), tableCount: tables.length, tables });
  }
  if (name === "see_page_info" || name === "check_page" || name === "watch_page") {
    if (!page) return missingTab();
    const info = await page.evaluate(() => ({
      url: location.href,
      title: document.title,
      readyState: document.readyState,
      viewport: { width: window.innerWidth, height: window.innerHeight },
      scroll: { x: window.scrollX, y: window.scrollY },
      documentSize: { width: document.documentElement.scrollWidth, height: document.documentElement.scrollHeight },
    }));
    if (name === "watch_page" || name === "see_page_info") {
      return ok({ tabId: ctx.tabIdOf(page), ...info });
    }
    const scan = await ctx.scanPage(page);
    const checks: { name: string; ok: boolean }[] = [];
    const text = str(args.text);
    if (text) checks.push({ name: `text:${text}`, ok: scan.bodyText.includes(text) });
    const urlContains = str(args.urlContains);
    if (urlContains) checks.push({ name: `url:${urlContains}`, ok: scan.url.includes(urlContains) });
    const titleContains = str(args.titleContains);
    if (titleContains) checks.push({ name: `title:${titleContains}`, ok: scan.title.includes(titleContains) });
    const id = str(args.id);
    if (id) checks.push({ name: `element:${id}`, ok: scan.elements.some((element) => element.id === id) });
    const passed = checks.length === 0 || checks.every((check) => check.ok);
    return ok({ checks, passed, ...(passed ? {} : { faultCode: "assertion_failed" }), ...info });
  }
  return null;
}

// ---- 文件、导出、录制 -----------------------------------------------------------

type DownloadRec = { id: string; url: string; filename: string; state: string; path: string; cancel: () => Promise<void> };
const downloads: DownloadRec[] = [];
const downloadPages = new WeakSet<Page>();
let downloadSeq = 0;

function watchDownloads(page: Page): void {
  if (downloadPages.has(page)) return;
  downloadPages.add(page);
  page.on("download", (download) => {
    downloadSeq += 1;
    const record: DownloadRec = {
      id: `dl_${downloadSeq}`,
      url: download.url(),
      filename: download.suggestedFilename(),
      state: "downloading",
      path: "",
      cancel: () => download.cancel(),
    };
    downloads.push(record);
    void download
      .path()
      .then((saved) => {
        record.state = "done";
        record.path = saved ?? "";
      })
      .catch(() => {
        record.state = "failed";
      });
  });
}

/**
 * 借一个空白页面做 canvas 运算：Kestrel 不引入原生图像库，
 * 裁剪/缩放这类像素操作全部交给浏览器自己完成。
 */
async function onScratchPage(
  ctx: ExtraContext,
  run: (page: Page) => Promise<BrowserResult>,
): Promise<BrowserResult> {
  const scratch = await ctx.runtime.newPage();
  try {
    return await run(scratch);
  } finally {
    await scratch.close().catch(() => undefined);
  }
}

/** 按矩形从来源图裁出子图，返回新的 dataUrl；image_crop 的底层实现。 */
async function cropImagePixels(ctx: ExtraContext, args: Json): Promise<BrowserResult> {
  const dataUrl = str(args.dataUrl);
  const x = num(args.x) ?? 0;
  const y = num(args.y) ?? 0;
  const width = num(args.width) ?? 0;
  const height = num(args.height) ?? 0;
  if (!dataUrl.startsWith("data:image/")) return fail("invalid_arguments", "需要 dataUrl（data:image/… 开头）");
  if (width <= 0 || height <= 0) return fail("invalid_arguments", "width/height 必须大于 0");
  return onScratchPage(ctx, async (page) => {
    const cropped = await page.evaluate(
      async (input: { dataUrl: string; x: number; y: number; width: number; height: number }) => {
        const image = new Image();
        await new Promise<void>((resolve, reject) => {
          image.onload = () => resolve();
          image.onerror = () => reject(new Error("图片解码失败"));
          image.src = input.dataUrl;
        });
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(input.width));
        canvas.height = Math.max(1, Math.round(input.height));
        const painter = canvas.getContext("2d");
        if (!painter) throw new Error("拿不到 canvas 2d 上下文");
        painter.drawImage(
          image,
          Math.round(input.x),
          Math.round(input.y),
          canvas.width,
          canvas.height,
          0,
          0,
          canvas.width,
          canvas.height,
        );
        return { dataUrl: canvas.toDataURL("image/png"), width: canvas.width, height: canvas.height };
      },
      { dataUrl, x, y, width, height },
    );
    return ok({ ...cropped });
  });
}

/** 等比缩到最长边 maxSide，输出 jpeg；image.shrink 的底层实现（缩略图用）。 */
async function shrinkImage(ctx: ExtraContext, args: Json): Promise<BrowserResult> {
  const dataUrl = str(args.dataUrl);
  const maxSide = Math.max(64, num(args.maxSide) ?? 384);
  if (!dataUrl.startsWith("data:image/")) return fail("invalid_arguments", "需要 dataUrl（data:image/… 开头）");
  return onScratchPage(ctx, async (page) => {
    const shrunk = await page.evaluate(
      async (input: { dataUrl: string; maxSide: number }) => {
        const image = new Image();
        await new Promise<void>((resolve, reject) => {
          image.onload = () => resolve();
          image.onerror = () => reject(new Error("图片解码失败"));
          image.src = input.dataUrl;
        });
        const sourceWidth = image.naturalWidth || image.width;
        const sourceHeight = image.naturalHeight || image.height;
        const longest = Math.max(sourceWidth, sourceHeight, 1);
        const scale = Math.min(1, input.maxSide / longest);
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(sourceWidth * scale));
        canvas.height = Math.max(1, Math.round(sourceHeight * scale));
        const painter = canvas.getContext("2d");
        if (!painter) throw new Error("拿不到 canvas 2d 上下文");
        painter.imageSmoothingQuality = "high";
        painter.drawImage(image, 0, 0, canvas.width, canvas.height);
        return { dataUrl: canvas.toDataURL("image/jpeg", 0.82), width: canvas.width, height: canvas.height };
      },
      { dataUrl, maxSide },
    );
    return ok({ ...shrunk });
  });
}

async function handleFiles(name: string, args: Json, ctx: ExtraContext, page: Page | null): Promise<BrowserResult | null> {
  if (name === "image_crop_pixels") return cropImagePixels(ctx, args);
  if (name === "image.shrink") return shrinkImage(ctx, args);
  if (name === "attach_file") {
    if (!page) return missingTab();
    const paths = Array.isArray(args.paths)
      ? (args.paths as unknown[]).filter((item): item is string => typeof item === "string")
      : [str(args.path)].filter(Boolean);
    if (!paths.length) return fail("invalid_arguments", "attach_file 需要 path 或 paths");
    const selector = str(args.selector);
    const id = str(args.id);
    let target = page.locator(selector || 'input[type="file"]').first();
    if (!selector && id) {
      const marker = await page.evaluate((wanted: string) => {
        const holder = (window as unknown as { __kestrel?: { els: Map<number, Element> } }).__kestrel;
        const raw = Number(wanted.replace(/^[a-z]_/i, ""));
        const el = holder?.els.get(raw) as HTMLElement | undefined;
        if (!el) return "";
        el.setAttribute("data-kestrel-attach", wanted);
        return `[data-kestrel-attach="${wanted}"]`;
      }, id);
      if (!marker) return fail("not_found", `页面上没有元素 ${id}`, { id });
      target = page.locator(marker).first();
    }
    await target.setInputFiles(paths);
    return ok({ tabId: ctx.tabIdOf(page), files: paths, selector: selector || id || "input[type=file]" });
  }
  if (name === "clear_file") {
    if (!page) return missingTab();
    await page.evaluate(() => {
      for (const input of Array.from(document.querySelectorAll('input[type="file"]'))) {
        (input as HTMLInputElement).value = "";
      }
    });
    return ok({ tabId: ctx.tabIdOf(page), cleared: true });
  }
  if (name === "save_pdf") {
    if (!page) return missingTab();
    const filename = str(args.filename, `page-${Date.now()}.pdf`);
    const path = join(outDir(ctx, "exports"), filename.endsWith(".pdf") ? filename : `${filename}.pdf`);
    try {
      await page.pdf({ path });
    } catch (error) {
      return fail("pdf_unavailable", `PDF 导出失败（有头模式或平台限制）：${error instanceof Error ? error.message : String(error)}`, { path });
    }
    return ok({ tabId: ctx.tabIdOf(page), path });
  }
  if (name === "download") {
    const url = str(args.url);
    if (!url) return fail("invalid_arguments", "download 需要 url");
    const context = await ctx.runtime.context();
    const response = await context.request.get(url);
    const filename = str(args.filename, url.split("/").pop() || `download-${Date.now()}`);
    const path = join(outDir(ctx, "downloads"), filename);
    writeFileSync(path, await response.body());
    return ok({ url, status: response.status(), path, bytes: (await response.body()).length });
  }
  if (name === "list_downloads") {
    if (page) watchDownloads(page);
    return ok({ count: downloads.length, items: downloads.map(({ id, url, filename, state, path }) => ({ id, url, filename, state, path })) });
  }
  if (name === "wait_download") {
    if (!page) return missingTab();
    watchDownloads(page);
    const wanted = str(args.downloadId);
    const timeout = num(args.timeoutMs) ?? 15000;
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      const hit = wanted ? downloads.find((item) => item.id === wanted) : downloads[downloads.length - 1];
      if (hit && hit.state !== "downloading") {
        return ok({ id: hit.id, url: hit.url, filename: hit.filename, state: hit.state, path: hit.path });
      }
      await page.waitForTimeout(200);
    }
    return fail("timeout", "等待下载超时", { downloadId: wanted || null });
  }
  if (name === "control_download") {
    const downloadId = str(args.downloadId);
    const action = str(args.action, "cancel");
    const record = downloads.find((item) => item.id === downloadId);
    if (!record) return fail("not_found", `没有 downloadId=${downloadId} 的下载`, { downloadId });
    if (action === "cancel" || action === "delete") {
      await record.cancel().catch(() => undefined);
      record.state = "cancelled";
      return ok({ downloadId, action, state: record.state });
    }
    return ok({ downloadId, action, state: record.state, path: record.path });
  }
  if (name === "export_data") {
    const filename = str(args.filename, `export-${Date.now()}.json`);
    const path = join(outDir(ctx, "exports"), filename);
    writeFileSync(path, JSON.stringify(args.data ?? null, null, 2), "utf8");
    return ok({ path, filename });
  }
  if (name === "video_capture_sequence") {
    if (!page) return missingTab();
    const count = Math.min(Math.max(num(args.count) ?? 5, 1), 20);
    const intervalMs = Math.min(Math.max(num(args.intervalMs) ?? 500, 200), 5000);
    const frames: { index: number; time: number; image: string; mime: string }[] = [];
    for (let index = 0; index < count; index += 1) {
      const shot = await page.screenshot({ type: "jpeg", quality: 50 });
      frames.push({ index, time: Date.now(), image: shot.toString("base64"), mime: "image/jpeg" });
      if (index < count - 1) await page.waitForTimeout(intervalMs);
    }
    return ok({ tabId: ctx.tabIdOf(page), count: frames.length, frames });
  }
  if (name === "video_record") {
    if (!page) return missingTab();
    const action = str(args.action, "status");
    const existingRecorder = recorders.get(page);
    if (action === "start") {
      if (existingRecorder?.timer) return ok({ tabId: ctx.tabIdOf(page), recording: true, frames: existingRecorder.frames.length });
      const fps = Math.min(Math.max(num(args.fps) ?? 2, 1), 5);
      const maxFrames = Math.min(Math.max(num(args.maxFrames) ?? 30, 1), 60);
      const recorder = { frames: [] as { index: number; time: number; image: string; mime: string }[], timer: null as ReturnType<typeof setInterval> | null };
      recorders.set(page, recorder);
      const capture = async () => {
        if (recorder.frames.length >= maxFrames) return;
        const shot = await page.screenshot({ type: "jpeg", quality: 50 }).catch(() => null);
        if (shot) recorder.frames.push({ index: recorder.frames.length, time: Date.now(), image: shot.toString("base64"), mime: "image/jpeg" });
      };
      void capture();
      recorder.timer = setInterval(() => {
        void capture();
      }, Math.round(1000 / fps));
      return ok({ tabId: ctx.tabIdOf(page), recording: true, fps, maxFrames });
    }
    if (action === "stop") {
      if (!existingRecorder) return ok({ tabId: ctx.tabIdOf(page), recording: false, count: 0, frames: [] });
      if (existingRecorder.timer) clearInterval(existingRecorder.timer);
      existingRecorder.timer = null;
      return ok({ tabId: ctx.tabIdOf(page), recording: false, count: existingRecorder.frames.length, frames: existingRecorder.frames });
    }
    return ok({ tabId: ctx.tabIdOf(page), recording: Boolean(existingRecorder?.timer), frames: existingRecorder?.frames.length ?? 0 });
  }
  if (name === "clipboard_page_write" || name === "clipboard_page_read") {
    if (!page) return missingTab();
    const origin = page.url();
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin }).catch(() => undefined);
    if (name === "clipboard_page_write") {
      const text = str(args.text);
      try {
        await page.evaluate((value: string) => navigator.clipboard.writeText(value), text);
        return ok({ tabId: ctx.tabIdOf(page), written: text.length });
      } catch (error) {
        return fail("clipboard_unavailable", `写剪贴板失败：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    try {
      const text = await page.evaluate(() => navigator.clipboard.readText());
      return ok({ tabId: ctx.tabIdOf(page), text });
    } catch (error) {
      return fail("clipboard_unavailable", `读剪贴板失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (name === "measure_timing" || name === "measure_paint" || name === "measure_files") {
    if (!page) return missingTab();
    const data = await page.evaluate((kind: string) => {
      const performance_ = window.performance;
      if (kind === "paint") {
        return { paint: performance_.getEntriesByType("paint").map((entry) => ({ name: entry.name, startTime: Math.round(entry.startTime) })) };
      }
      if (kind === "files") {
        const resources = performance_.getEntriesByType("resource") as PerformanceResourceTiming[];
        const items = resources.slice(-200).map((entry) => ({
          name: entry.name,
          type: entry.initiatorType,
          ms: Math.round(entry.duration),
          transferSize: entry.transferSize,
          encodedBodySize: entry.encodedBodySize,
        }));
        return { count: resources.length, totalTransfer: resources.reduce((sum, entry) => sum + (entry.transferSize || 0), 0), items };
      }
      const navigation = performance_.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined;
      return {
        navigation: navigation
          ? {
              domContentLoaded: Math.round(navigation.domContentLoadedEventEnd),
              loadEvent: Math.round(navigation.loadEventEnd),
              responseEnd: Math.round(navigation.responseEnd),
              transferSize: navigation.transferSize,
            }
          : null,
        resourceCount: performance_.getEntriesByType("resource").length,
      };
    }, name === "measure_paint" ? "paint" : name === "measure_files" ? "files" : "timing");
    return ok({ tabId: ctx.tabIdOf(page), ...data });
  }
  return null;
}

const recorders = new WeakMap<Page, { frames: { index: number; time: number; image: string; mime: string }[]; timer: ReturnType<typeof setInterval> | null }>();

// ---- 标签、窗口、诊断、验证码 ---------------------------------------------------

async function handleTabsAndMisc(name: string, args: Json, ctx: ExtraContext, page: Page | null): Promise<BrowserResult | null> {
  if (name === "duplicate_tab") {
    if (!page) return missingTab();
    const created = await ctx.runtime.newPage();
    const url = page.url();
    if (url && url !== "about:blank") await created.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => undefined);
    await created.bringToFront().catch(() => undefined);
    return ok({ tabId: ctx.tabIdOf(created), sourceTabId: ctx.tabIdOf(page), url: created.url() });
  }
  if (name === "move_tab") return notSupported(name, "Playwright 无法调整标签顺序或跨窗口移动，这是浏览器扩展专有能力");
  if (name === "group_tabs" || name === "ungroup_tabs") return notSupported(name, "标签分组依赖 chrome.tabGroups，Playwright 无对等 API");
  if (name === "update_tab") return notSupported(name, "置顶/静音依赖 chrome.tabs.update，Playwright 无对等 API");
  if (name === "create_window") {
    const created = await ctx.runtime.newPage();
    const url = str(args.url);
    if (url) await created.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 }).catch(() => undefined);
    return ok({ windowId: 1, tabId: ctx.tabIdOf(created), note: "持久化 context 只有单一窗口，新页面以标签形式打开" });
  }
  if (name === "update_window" || name === "close_window") return notSupported(name, "持久化 context 无法操作窗口状态（最小化/最大化/关闭窗口），Playwright 无对等 API");
  if (name === "service_worker_list") {
    const context = await ctx.runtime.context();
    const workers = context.serviceWorkers().map((worker) => ({ url: worker.url() }));
    return ok({ count: workers.length, workers });
  }
  if (name === "detach_debugger") {
    if (!page) return missingTab();
    await cdp(page).then(async (session) => session.detach()).catch(() => undefined);
    return ok({ tabId: ctx.tabIdOf(page), detached: true });
  }
  if (name === "see_captcha" || name === "wait_captcha" || name === "click_captcha") {
    if (!page) return missingTab();
    const detect = async () => page.evaluate(() => {
      const selectors = [
        "#nc_1_wrapper",
        ".nc-container",
        ".geetest_panel",
        ".geetest_holder",
        "iframe[src*='captcha']",
        "iframe[src*='recaptcha']",
        "iframe[src*='hcaptcha']",
        "[class*='captcha']",
        "[id*='captcha']",
        "img[src*='captcha']",
      ];
      const hits: { selector: string; tag: string; id: string; className: string; rect: { x: number; y: number; width: number; height: number } }[] = [];
      for (const selector of selectors) {
        for (const element of Array.from(document.querySelectorAll(selector)).slice(0, 5)) {
          const rect = element.getBoundingClientRect();
          if (rect.width < 8 || rect.height < 8) continue;
          hits.push({
            selector,
            tag: element.tagName.toLowerCase(),
            id: element.id,
            className: typeof element.className === "string" ? element.className.slice(0, 80) : "",
            rect: { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) },
          });
        }
      }
      return hits;
    });
    if (name === "see_captcha") {
      const hits = await detect();
      return ok({ tabId: ctx.tabIdOf(page), found: hits.length > 0, count: hits.length, candidates: hits });
    }
    if (name === "wait_captcha") {
      const timeout = num(args.timeoutMs) ?? 12000;
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) {
        const hits = await detect();
        if (hits.length) return ok({ tabId: ctx.tabIdOf(page), found: true, count: hits.length, candidates: hits });
        await page.waitForTimeout(500);
      }
      return fail("timeout", "在超时前没有发现验证码元素", { timeout });
    }
    const hits = await detect();
    const first = hits[0];
    if (!first) return fail("not_found", "页面上没有发现可点击的验证码元素");
    await page.mouse.click(first.rect.x + first.rect.width / 2, first.rect.y + first.rect.height / 2);
    return ok({ tabId: ctx.tabIdOf(page), clicked: first });
  }
  if (name === "solve_captcha") {
    return notSupported(name, "Kestrel 未接入第三方打码服务；请用 see_captcha/capture_page 观察后人工处理，或把识别结果传进来");
  }
  if (name === "solve_slider") {
    if (!page) return missingTab();
    const sliderSelector = str(args.sliderSelector);
    if (!sliderSelector) return fail("invalid_arguments", "solve_slider 需要 sliderSelector 指向滑块手柄");
    const distance = num(args.distance);
    const handle = page.locator(sliderSelector).first();
    const box = await handle.boundingBox();
    if (!box) return fail("not_found", `定位不到滑块手柄：${sliderSelector}`, { sliderSelector });
    const target = num(args.targetX) ?? (distance ?? 0);
    if (!target) {
      return fail("invalid_arguments", "solve_slider 需要 distance 或 targetX（缺口距离）；本端不做图像识别，请先用截图量好缺口", { sliderSelector });
    }
    const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
    await dragBetween(page, start, { x: start.x + target, y: start.y }, flag(args.humanize));
    return ok({ tabId: ctx.tabIdOf(page), sliderSelector, dragged: target, from: start });
  }
  if (name === "bind_tab") {
    if (!page) return missingTab();
    return ok({ tabId: ctx.tabIdOf(page), windowId: 1, url: page.url(), title: await page.title().catch(() => ""), note: "只做校验，未设置隐式绑定" });
  }
  if (name === "see_diag") {
    if (!page) return missingTab();
    const tabId = ctx.tabIdOf(page);
    const pending = pendingDialogs.get(tabId);
    const dialog = pending
      ? { status: "open", type: pending.type(), message: pending.message(), defaultValue: pending.defaultValue() }
      : { status: "unknown", note: "没有登记的待处理弹窗；Playwright 在无监听时自动关闭弹窗，确认前先用 dialog_wait" };
    return ok({
      tabId,
      url: page.url(),
      title: await page.title().catch(() => ""),
      closed: page.isClosed(),
      dialog,
    });
  }
  if (name === "stream_pull") {
    const source = (args.source ?? {}) as Json;
    const kind = str(source.kind);
    const targetPath = str(args.path);
    if (!targetPath) return fail("invalid_arguments", "stream_pull 需要宿主绝对路径 path");
    mkdirSync(dirname(targetPath), { recursive: true });
    const streamId = `stream-${Date.now().toString(36)}`;
    if (kind === "http") {
      const url = str(source.url);
      if (!url) return fail("invalid_arguments", "kind=http 时 source.url 必填");
      const method = str(source.method, "GET").toUpperCase();
      const headers = (source.headers as Record<string, string> | undefined) ?? {};
      const response = await fetch(url, { method, headers });
      const buffer = Buffer.from(await response.arrayBuffer());
      writeFileSync(targetPath, buffer);
      return ok({
        streamId,
        path: targetPath,
        bytes: buffer.byteLength,
        status: response.status,
        contentType: response.headers.get("content-type") ?? "",
      });
    }
    if (kind === "network") {
      const requestId = str(source.requestId);
      const tabId = num(source.tabId);
      const target = tabId !== undefined ? await ctx.runtime.page(tabId) : page;
      if (!target) return missingTab();
      const entry = ensureNet(target).find((item) => item.id === requestId || item.url === requestId);
      if (!entry) {
        return fail("not_found", `网络记录里没有 requestId=${requestId}；先用 capture_network_traffic 取编号`, { requestId });
      }
      if (typeof entry.bodyText === "string") {
        const buffer = Buffer.from(entry.bodyText, "utf8");
        writeFileSync(targetPath, buffer);
        return ok({ streamId, path: targetPath, bytes: buffer.byteLength, url: entry.url, status: entry.status });
      }
      // 正文没留在记录里（二进制或超限）：按原地址与请求头重新取一次。
      const response = await fetch(entry.url, { headers: entry.requestHeaders });
      const buffer = Buffer.from(await response.arrayBuffer());
      writeFileSync(targetPath, buffer);
      return ok({
        streamId,
        path: targetPath,
        bytes: buffer.byteLength,
        url: entry.url,
        status: response.status,
        refetched: true,
      });
    }
    if (kind === "dom") {
      if (!page) return missingTab();
      const format = str(source.format, "html");
      const data =
        format === "json"
          ? JSON.stringify(
              await page.evaluate(() => ({ url: location.href, title: document.title, html: document.documentElement.outerHTML })),
              null,
              1,
            )
          : await page.content();
      writeFileSync(targetPath, data, "utf8");
      return ok({ streamId, path: targetPath, bytes: Buffer.byteLength(data, "utf8"), format, tabId: ctx.tabIdOf(page) });
    }
    return fail("invalid_arguments", "stream_pull 需要 source.kind=http|network|dom");
  }
  if (name === "stream_push") {
    const targetPath = str(args.path);
    if (!targetPath) return fail("invalid_arguments", "stream_push 需要宿主绝对路径 path");
    const target = (args.target ?? {}) as Json;
    if (str(target.kind) !== "http") return fail("invalid_arguments", "stream_push 目前只支持 target.kind=http");
    const url = str(target.url);
    if (!url) return fail("invalid_arguments", "target.url 必填");
    let buffer: Buffer;
    try {
      buffer = readFileSync(targetPath);
    } catch {
      // 文件不存在或不可读：按参数错误回，不抛到通用 catch。
      return fail("file_not_found", `读不到宿主文件：${targetPath}`, { path: targetPath });
    }
    const method = str(target.method, "POST").toUpperCase();
    const headers = (target.headers as Record<string, string> | undefined) ?? {};
    const response = await fetch(url, { method, headers, body: new Uint8Array(buffer) });
    const text = await response.text().catch(() => "");
    return ok({
      streamId: `stream-${Date.now().toString(36)}`,
      bytes: buffer.byteLength,
      status: response.status,
      responseHead: text.slice(0, 500),
    });
  }
  if (name === "read_page_credentials" || name === "profile_vault" || name === "account_vault") {
    return notSupported(name, "凭据库读取依赖浏览器扩展/系统钥匙串，Playwright 执行端拿不到；请在配置文件里维护账号");
  }
  return null;
}

/**
 * 未在 host.ts 内实现的能力入口。返回 null 表示这个名字不归本模块管，
 * host.ts 会照旧报 tool_not_implemented。
 */
export async function runExtraBrowserTool(name: string, args: Json, ctx: ExtraContext): Promise<BrowserResult | null> {
  let page: Page | null = null;
  const needsPage = !["clear_cookies", "set_cookie", "delete_cookie", "wait_new_tab", "export_data", "download", "create_window", "list_downloads", "service_worker_list", "calibrate_drag", "stream_push", "image_crop_pixels", "image.shrink"].includes(name);
  if (needsPage) page = await ctx.resolve(args);
  try {
    for (const handler of [handleNetwork, handleStorage, handleInteraction, handleObservation, handleFiles, handleTabsAndMisc]) {
      const result = await handler(name, args, ctx, page);
      if (result) return result;
    }
    return null;
  } catch (error) {
    return fail("browser_execution_failed", error instanceof Error ? error.message : String(error), { name });
  }
}
