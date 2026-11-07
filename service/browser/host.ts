import { chromium, type BrowserContext, type Page } from "playwright-core";
import { existsSync, readFileSync, readlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import type { BrowserHost, BrowserResult, CurrentTabs, PreviewEvent, PreviewWatchOptions } from "../types.ts";

type Json = Record<string, unknown>;

/** Element ids (`e_03`) live inside the page; tabs live here. */
const pageIds = new WeakMap<Page, number>();
const idPages = new Map<number, Page>();
const consoleLogs = new WeakMap<Page, { level: string; text: string }[]>();
let nextTabId = 0;
let defaultTabId: number | null = null;

function tabIdOf(page: Page): number {
  const existing = pageIds.get(page);
  if (existing !== undefined) return existing;
  nextTabId += 1;
  pageIds.set(page, nextTabId);
  idPages.set(nextTabId, page);
  return nextTabId;
}

function pageOf(id: unknown): Page | null {
  const numeric = typeof id === "number" ? id : Number(String(id ?? ""));
  if (!Number.isFinite(numeric)) return null;
  const page = idPages.get(numeric);
  return page && !page.isClosed() ? page : null;
}

const ok = (extra: Json = {}): BrowserResult => ({ ok: true, ...extra }) as BrowserResult;
const fail = (faultCode: string, error: string, extra: Json = {}): BrowserResult =>
  ({ ok: false, faultCode, error, ...extra }) as BrowserResult;
const textArg = (value: unknown, fallback = ""): string => (typeof value === "string" ? value : fallback);
const numArg = (value: unknown): number | undefined =>
  typeof value === "number" && Number.isFinite(value) ? value : undefined;

type ScanElement = {
  id: string;
  role: string;
  name: string;
  text: string;
  label: string;
  tag: string;
  inView: boolean;
};

type ScanResult = {
  url: string;
  title: string;
  bodyText: string;
  headings: string[];
  elements: ScanElement[];
};

/** Chrome launched once and reused; a persistent profile keeps logins across restarts. */
class ChromeRuntime {
  private contextPromise: Promise<BrowserContext> | null = null;

  constructor(private readonly userDataDir: string) {}

  /**
   * Chrome 崩溃或被外部杀掉后会留下 SingletonLock，再次 launch 时 Chromium 直接
   * 退出，Playwright 报 "Target page, context or browser has been closed"。
   * 只在能确认锁的持有进程已经不在了才删，避免误伤正在运行的 profile。
   */
  private clearStaleLocks(): void {
    const lock = join(this.userDataDir, "SingletonLock");
    let target = "";
    try {
      target = readlinkSync(lock);
    } catch {
      return; // 没有锁文件，Chromium 自己会创建
    }
    const pid = Number(target.slice(target.lastIndexOf("-") + 1));
    if (!Number.isFinite(pid) || pid <= 0) return;
    try {
      process.kill(pid, 0);
      return; // 持有者还活着，锁必须保留
    } catch {
      // 持有者已退出，可以安全清理
    }
    for (const name of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) {
      try {
        unlinkSync(join(this.userDataDir, name));
      } catch {
        // 文件本来就不存在，无需处理
      }
    }
  }

  context(): Promise<BrowserContext> {
    if (!this.contextPromise) {
      this.clearStaleLocks();
      const attempt = chromium
        .launchPersistentContext(this.userDataDir, {
          channel: "chrome",
          headless: false,
          viewport: null,
          args: ["--no-first-run", "--no-default-browser-check", "--disable-blink-features=AutomationControlled"],
        })
        .then((context) => {
          const watch = (page: Page) => {
            tabIdOf(page);
            const logs: { level: string; text: string }[] = [];
            consoleLogs.set(page, logs);
            page.on("console", (message) => {
              logs.push({ level: message.type(), text: message.text().slice(0, 500) });
              if (logs.length > 200) logs.shift();
            });
            page.on("close", () => pageIds.delete(page));
          };
          for (const page of context.pages()) watch(page);
          context.on("page", watch);
          // 持久 context 一旦被关闭（Chrome 崩溃、被外部杀掉），不能继续复用这个
          // promise，否则后续每次工具调用都会报 "Target page ... has been closed"。
          context.on("close", () => {
            if (this.contextPromise === attempt) this.contextPromise = null;
          });
          return context;
        })
        .catch((error) => {
          if (this.contextPromise === attempt) this.contextPromise = null;
          throw error;
        });
      this.contextPromise = attempt;
    }
    return this.contextPromise;
  }

  async pages(): Promise<Page[]> {
    const context = await this.context();
    return context.pages().filter((page) => !page.isClosed());
  }

  async page(tabId: unknown): Promise<Page | null> {
    const direct = pageOf(tabId);
    if (direct) return direct;
    if (tabId !== undefined && tabId !== null) return null;
    const pages = await this.pages();
    return pages[pages.length - 1] ?? null;
  }

  async newPage(): Promise<Page> {
    const context = await this.context();
    const page = await context.newPage();
    return page;
  }
}

/** Rewrites the interactive tree into stable `e_NN` ids that survive across calls. */
async function scanPage(page: Page): Promise<ScanResult> {
  return page.evaluate(() => {
    const holder = window as unknown as {
      __kestrel?: { nextId: number; ids: WeakMap<Element, number>; els: Map<number, Element> };
    };
    if (!holder.__kestrel) holder.__kestrel = { nextId: 1, ids: new WeakMap(), els: new Map() };
    const registry = holder.__kestrel;
    const visible = (el: Element) => {
      const rect = el.getBoundingClientRect();
      const style = getComputedStyle(el);
      return rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none";
    };
    const roleOf = (el: Element) => {
      const explicit = el.getAttribute("role");
      if (explicit) return explicit;
      const tag = el.tagName.toLowerCase();
      if (tag === "a") return "link";
      if (tag === "button") return "button";
      if (tag === "select") return "combobox";
      if (tag === "textarea") return "textbox";
      if (tag === "input") {
        const type = (el.getAttribute("type") ?? "text").toLowerCase();
        if (type === "checkbox") return "checkbox";
        if (type === "radio") return "radio";
        if (type === "submit" || type === "button" || type === "reset") return "button";
        if (type === "search") return "searchbox";
        return "textbox";
      }
      if ((el as HTMLElement).isContentEditable) return "textbox";
      return "generic";
    };
    const nameOf = (el: Element) => {
      const aria = el.getAttribute("aria-label");
      if (aria && aria.trim()) return aria.trim();
      const labelled = el.getAttribute("aria-labelledby");
      if (labelled) {
        const target = document.getElementById(labelled);
        if (target?.textContent?.trim()) return target.textContent.trim();
      }
      const placeholder = el.getAttribute("placeholder");
      if (placeholder && placeholder.trim()) return placeholder.trim();
      const title = el.getAttribute("title");
      if (title && title.trim()) return title.trim();
      const inner = (el as HTMLElement).innerText;
      if (inner && inner.trim()) return inner.trim().replace(/\s+/g, " ").slice(0, 80);
      const value = (el as HTMLInputElement).value;
      return typeof value === "string" ? value.slice(0, 40) : "";
    };
    const elements: {
      id: string; role: string; name: string; text: string; label: string; tag: string; inView: boolean;
    }[] = [];
    const selector =
      'a[href],button,input:not([type="hidden"]),select,textarea,summary,[role],[contenteditable="true"],[tabindex]:not([tabindex="-1"])';
    for (const el of Array.from(document.querySelectorAll(selector))) {
      if (!visible(el)) continue;
      let id = registry.ids.get(el);
      if (id === undefined) {
        id = registry.nextId;
        registry.nextId += 1;
        registry.ids.set(el, id);
      }
      registry.els.set(id, el);
      const rect = el.getBoundingClientRect();
      const text = ((el as HTMLElement).innerText ?? "").trim().replace(/\s+/g, " ").slice(0, 120);
      const name = nameOf(el);
      elements.push({
        id: `e_${String(id).padStart(2, "0")}`,
        role: roleOf(el),
        name,
        text,
        label: name,
        tag: el.tagName.toLowerCase(),
        inView: rect.top < window.innerHeight && rect.bottom > 0,
      });
      if (elements.length >= 400) break;
    }
    const headings = Array.from(document.querySelectorAll("h1,h2,h3"))
      .slice(0, 20)
      .map((node) => (node.textContent ?? "").trim())
      .filter(Boolean);
    return {
      url: location.href,
      title: document.title,
      bodyText: (document.body?.innerText ?? "").slice(0, 4000),
      headings,
      elements,
    };
  });
}

const rawIdOf = (id: string) => Number(String(id).replace(/^[a-z]_/i, ""));

async function elementRect(page: Page, id: string) {
  return page.evaluate((rawId: number) => {
    const registry = (window as unknown as { __kestrel?: { els: Map<number, Element> } }).__kestrel;
    const el = registry?.els.get(rawId);
    if (!el) return null;
    el.scrollIntoView({ block: "center", inline: "center" });
    const rect = el.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height };
  }, rawIdOf(id));
}

async function clickElement(page: Page, id: string): Promise<BrowserResult> {
  const rect = await elementRect(page, id);
  if (!rect) return fail("not_found", `页面上没有元素 ${id}`, { id });
  await page.mouse.click(rect.x + rect.width / 2, rect.y + rect.height / 2);
  return ok({ id, clicked: true });
}

async function typeInto(
  page: Page,
  id: string,
  text: string,
  clear: boolean,
  enter: boolean,
): Promise<BrowserResult> {
  const focused = await page.evaluate((rawId: number) => {
    const registry = (window as unknown as { __kestrel?: { els: Map<number, Element> } }).__kestrel;
    const el = registry?.els.get(rawId) as HTMLElement | undefined;
    if (!el) return false;
    el.scrollIntoView({ block: "center" });
    el.focus();
    return true;
  }, rawIdOf(id));
  if (!focused) return fail("not_found", `页面上没有元素 ${id}`, { id });
  if (clear) {
    await page.evaluate(() => {
      const el = document.activeElement as HTMLInputElement | HTMLTextAreaElement | null;
      if (!el) return;
      if ("value" in el && typeof el.value === "string") {
        el.value = "";
        el.dispatchEvent(new Event("input", { bubbles: true }));
      } else if (el.isContentEditable) {
        el.textContent = "";
      }
    });
  }
  await page.keyboard.type(text, { delay: 10 });
  if (enter) await page.keyboard.press("Enter");
  const value = await page.evaluate(() => {
    const el = document.activeElement as HTMLInputElement | null;
    return el && typeof el.value === "string" ? el.value : null;
  });
  return ok({ id, value, typed: text });
}

async function selectOption(page: Page, id: string, value: string): Promise<BrowserResult> {
  const result = await page.evaluate(
    ({ rawId, wanted }: { rawId: number; wanted: string }) => {
      const registry = (window as unknown as { __kestrel?: { els: Map<number, Element> } }).__kestrel;
      const el = registry?.els.get(rawId) as HTMLSelectElement | undefined;
      if (!el || !el.options) return { ok: false, reason: "not_select" };
      const options = Array.from(el.options);
      const hit = options.find(
        (option) => option.value === wanted || option.text.trim() === wanted || option.text.includes(wanted),
      );
      if (!hit) return { ok: false, reason: "no_option", options: options.map((option) => ({ value: option.value, text: option.text })) };
      el.value = hit.value;
      el.dispatchEvent(new Event("input", { bubbles: true }));
      el.dispatchEvent(new Event("change", { bubbles: true }));
      return { ok: true, value: el.value, text: hit.text };
    },
    { rawId: rawIdOf(id), wanted: value },
  );
  if (!result.ok) return fail("not_found", `无法在下拉框 ${id} 中选择 ${value}：${result.reason}`, { ...result });
  return ok({ id, value: result.value, text: result.text });
}

async function waitFor(page: Page, args: Json): Promise<BrowserResult> {
  const timeout = numArg(args.timeoutMs) ?? 8000;
  const text = textArg(args.text);
  const selector = textArg(args.selector);
  try {
    if (text) await page.waitForFunction((needle) => (document.body?.innerText ?? "").includes(needle), text, { timeout });
    else if (selector) await page.waitForSelector(selector, { timeout });
    else await page.waitForLoadState("domcontentloaded", { timeout });
    return ok({ found: true, text: text || undefined, selector: selector || undefined });
  } catch {
    return fail("timeout", `等待超时：${text || selector || "页面就绪"}`, { waitText: text || undefined });
  }
}

async function waitResponse(page: Page, args: Json): Promise<BrowserResult> {
  const urlContains = textArg(args.urlContains);
  const timeout = numArg(args.timeoutMs) ?? 8000;
  const clickId = textArg(args.clickId);
  const status = numArg(args.status);
  const pending = page
    .waitForResponse(
      (response) =>
        response.url().includes(urlContains) && (status === undefined || response.status() === status),
      { timeout },
    )
    .then((response) => ({ response }))
    .catch((error: unknown) => ({ error: error instanceof Error ? error.message : String(error) }));
  let clicked: BrowserResult | null = null;
  if (clickId) clicked = await clickElement(page, clickId);
  const result = await pending;
  if ("error" in result) {
    return fail("timeout", `未等到 ${urlContains} 的响应：${result.error}`, {
      clicked: clicked?.ok === true,
      failureStage: clicked && !clicked.ok ? "click" : "wait_response",
      click: clicked ?? undefined,
    });
  }
  const body = await result.response.text().catch(() => "");
  return ok({
    clicked: clicked?.ok === true,
    click: clicked ?? undefined,
    url: result.response.url(),
    status: result.response.status(),
    mimeType: result.response.headers()["content-type"],
    body: body.slice(0, 4000),
  });
}

export function createPlaywrightHost(dataDir: string): BrowserHost {
  const runtime = new ChromeRuntime(join(dataDir, "chrome-profile"));

  const currentTabs = async (): Promise<CurrentTabs> => {
    try {
      const pages = await runtime.pages();
      const last = pages[pages.length - 1];
      const tabs = [];
      for (const page of pages) {
        const tabId = tabIdOf(page);
        tabs.push({
          tabId,
          url: page.url(),
          title: await page.title().catch(() => ""),
          active: page === last,
        });
      }
      return { ok: true, windows: [{ windowId: 1, focused: true, tabs }] };
    } catch (error) {
      return { ok: false, error: error instanceof Error ? error.message : String(error) };
    }
  };

  const resolve = async (args: Json) => runtime.page(args.tabId);
  const missing = () => fail("tab_not_found", "目标标签不存在或已关闭；先调用 tabs_current 确认", {});

  const execute = async (name: string, input: Json): Promise<BrowserResult> => {
    const args: Json = { ...input };
    if ((args.tabId === undefined || args.tabId === null) && defaultTabId !== null) args.tabId = defaultTabId;

    try {
      if (name === "tabs_current" || name === "list_tabs" || name === "list_windows") {
        const tabs = await currentTabs();
        if (!tabs.ok) return fail("browser_unavailable", tabs.error);
        return ok({ windows: tabs.windows, count: tabs.windows[0]?.tabs.length ?? 0 });
      }
      if (name === "tab_context") {
        const action = textArg(args.action, "get");
        if (action === "set") {
          const page = pageOf(args.tabId);
          if (!page) return fail("tab_not_found", `标签 ${String(args.tabId)} 不存在`);
          defaultTabId = tabIdOf(page);
          return ok({ action, tabId: defaultTabId });
        }
        if (action === "clear") {
          defaultTabId = null;
          return ok({ action, tabId: null });
        }
        return ok({ action, tabId: defaultTabId });
      }
      if (name === "open_tab") {
        const page = await runtime.newPage();
        const url = textArg(args.url, "about:blank");
        if (url !== "about:blank") await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
        const tabId = tabIdOf(page);
        return ok({ tabId, windowId: 1, url: page.url(), title: await page.title().catch(() => ""), loadState: "complete" });
      }
      if (name === "open_url") {
        const page = await resolve(args);
        if (!page) return missing();
        const url = textArg(args.url);
        if (!/^https?:\/\//.test(url) && !url.startsWith("about:")) return fail("invalid_arguments", "url 必须以 http(s):// 开头", { url });
        await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30000 });
        const scan = await scanPage(page).catch(() => null);
        return ok({ tabId: tabIdOf(page), url: page.url(), title: await page.title().catch(() => ""), text: scan?.bodyText?.slice(0, 3000) ?? "" });
      }
      if (name === "reload") {
        const page = await resolve(args);
        if (!page) return missing();
        await page.reload({ waitUntil: "domcontentloaded", timeout: 30000 });
        return ok({ tabId: tabIdOf(page), url: page.url(), title: await page.title().catch(() => "") });
      }
      if (name === "close_tab") {
        const page = await resolve(args);
        if (!page) return missing();
        const tabId = tabIdOf(page);
        await page.close();
        idPages.delete(tabId);
        return ok({ tabId, closed: true });
      }
      if (name === "switch_tab") {
        const page = await resolve(args);
        if (!page) return missing();
        await page.bringToFront();
        return ok({ tabId: tabIdOf(page), active: true });
      }
      if (name === "go_history") {
        const page = await resolve(args);
        if (!page) return missing();
        const direction = textArg(args.direction, "back");
        const response = direction === "forward" ? await page.goForward() : await page.goBack();
        return ok({ tabId: tabIdOf(page), url: page.url(), navigated: Boolean(response) });
      }
      if (name === "page_get_summary") {
        const page = await resolve(args);
        if (!page) return missing();
        const scan = await scanPage(page);
        return ok({
          tabId: tabIdOf(page),
          title: scan.title,
          url: scan.url,
          headings: scan.headings,
          interactiveCount: scan.elements.length,
          inViewCount: scan.elements.filter((element) => element.inView).length,
        });
      }
      if (name === "see_page" || name === "see_page_info" || name === "page_find" || name === "check_page") {
        const page = await resolve(args);
        if (!page) return missing();
        const scan = await scanPage(page);
        return ok({
          tabId: tabIdOf(page),
          title: scan.title,
          url: scan.url,
          text: scan.bodyText,
          headings: scan.headings,
          count: scan.elements.length,
        });
      }
      if (name === "page_list_interactive_elements") {
        const page = await resolve(args);
        if (!page) return missing();
        const scan = await scanPage(page);
        return ok({ tabId: tabIdOf(page), elements: scan.elements, count: scan.elements.length });
      }
      if (name === "page_get_by_role") {
        const page = await resolve(args);
        if (!page) return missing();
        const scan = await scanPage(page);
        const role = textArg(args.role).toLowerCase();
        const wanted = textArg(args.name).toLowerCase();
        const matched = scan.elements.filter(
          (element) =>
            (!role || element.role.toLowerCase() === role || element.role.toLowerCase().includes(role)) &&
            (!wanted || element.name.toLowerCase().includes(wanted)),
        );
        return ok({ tabId: tabIdOf(page), total: matched.length, elements: matched.slice(0, 20) });
      }
      if (name === "find_on_page") {
        const page = await resolve(args);
        if (!page) return missing();
        const scan = await scanPage(page);
        const needle = textArg(args.text).toLowerCase();
        const limit = numArg(args.limit) ?? 20;
        const matched = scan.elements.filter(
          (element) => (element.name && element.name.toLowerCase().includes(needle)) || (element.text && element.text.toLowerCase().includes(needle)),
        );
        return ok({ tabId: tabIdOf(page), total: matched.length, elements: matched.slice(0, limit) });
      }
      if (name === "page_inspect_element") {
        const page = await resolve(args);
        if (!page) return missing();
        const scan = await scanPage(page);
        const element = scan.elements.find((row) => row.id === String(args.id));
        if (!element) return fail("not_found", `页面上没有元素 ${String(args.id)}`);
        return ok({ element });
      }
      if (name === "page_get_dom") {
        const page = await resolve(args);
        if (!page) return missing();
        const id = textArg(args.id);
        const html = await page.evaluate((rawId: number) => {
          const registry = (window as unknown as { __kestrel?: { els: Map<number, Element> } }).__kestrel;
          if (!Number.isFinite(rawId)) return (document.body?.outerHTML ?? "").slice(0, 20000);
          const el = registry?.els.get(rawId);
          return (el?.outerHTML ?? "").slice(0, 20000);
        }, id ? rawIdOf(id) : Number.NaN);
        return ok({ id, html, totalChars: html.length });
      }
      if (name === "page_click" || name === "page_submit") {
        const page = await resolve(args);
        if (!page) return missing();
        return clickElement(page, textArg(args.id));
      }
      if (name === "page_type") {
        const page = await resolve(args);
        if (!page) return missing();
        return typeInto(page, textArg(args.id), textArg(args.text), args.clearBeforeType === true, args.pressEnter === true);
      }
      if (name === "combo_select") {
        const page = await resolve(args);
        if (!page) return missing();
        return selectOption(page, textArg(args.id), textArg(args.value));
      }
      if (name === "wait") {
        const page = await resolve(args);
        if (!page) return missing();
        return waitFor(page, args);
      }
      if (name === "wait_response") {
        const page = await resolve(args);
        if (!page) return missing();
        return waitResponse(page, args);
      }
      if (name === "wait_network") {
        const page = await resolve(args);
        if (!page) return missing();
        await page.waitForLoadState("networkidle", { timeout: numArg(args.timeoutMs) ?? 8000 }).catch(() => undefined);
        const scan = await scanPage(page);
        return ok({ tabId: tabIdOf(page), title: scan.title, url: scan.url, text: scan.bodyText.slice(0, 2000) });
      }
      if (name === "capture_page") {
        const page = await resolve(args);
        if (!page) return missing();
        const mode = textArg(args.mode, "viewport");
        let clip: { x: number; y: number; width: number; height: number } | undefined;
        if (mode === "element" && textArg(args.ref)) {
          const rect = await elementRect(page, textArg(args.ref));
          if (!rect) return fail("not_found", `页面上没有元素 ${textArg(args.ref)}`);
          clip = { x: rect.x, y: rect.y, width: Math.max(1, rect.width), height: Math.max(1, rect.height) };
        }
        const buffer = await page.screenshot({
          type: "png",
          fullPage: mode === "full_page",
          ...(clip ? { clip } : {}),
        });
        return ok({ mode, dataUrl: `data:image/png;base64,${Buffer.from(buffer).toString("base64")}` });
      }
      if (name === "page_eval_expr") {
        const page = await resolve(args);
        if (!page) return missing();
        const expr = textArg(args.expr);
        if (!expr) return fail("invalid_arguments", "expr 不能为空");
        try {
          const value = await page.evaluate(expr);
          return ok({ tabId: tabIdOf(page), value: value ?? null, type: typeof value });
        } catch (error) {
          return fail("eval_failed", error instanceof Error ? error.message : String(error));
        }
      }
      if (name === "execute_javascript") {
        const page = await resolve(args);
        if (!page) return missing();
        const filename = textArg(args.filename);
        const path = join(dataDir, "scripts", filename);
        const source = existsSync(path)
          ? readFileSync(path, "utf8")
          : join(process.cwd(), "service/scripts", filename);
        const code = existsSync(path) ? source : existsSync(source) ? readFileSync(source, "utf8") : "";
        if (!code) return fail("not_found", `脚本 ${filename} 不存在`);
        try {
          const value = await page.evaluate(`(async () => { ${code} })()`);
          return ok({ tabId: tabIdOf(page), value: value ?? null });
        } catch (error) {
          return fail("eval_failed", error instanceof Error ? error.message : String(error));
        }
      }
      if (name === "click_xy") {
        const page = await resolve(args);
        if (!page) return missing();
        const point = Array.isArray(args.point) ? (args.point as number[]) : [numArg(args.x) ?? 0, numArg(args.y) ?? 0];
        await page.mouse.click(point[0] ?? 0, point[1] ?? 0);
        return ok({ point });
      }
      if (name === "hover" || name === "double_click" || name === "long_press" || name === "context_menu") {
        const page = await resolve(args);
        if (!page) return missing();
        const rect = await elementRect(page, textArg(args.id));
        if (!rect) return fail("not_found", `页面上没有元素 ${textArg(args.id)}`);
        const x = rect.x + rect.width / 2;
        const y = rect.y + rect.height / 2;
        if (name === "hover") await page.mouse.move(x, y);
        else if (name === "double_click") await page.mouse.dblclick(x, y);
        else if (name === "context_menu") await page.mouse.click(x, y, { button: "right" });
        else {
          await page.mouse.move(x, y);
          await page.mouse.down();
          await new Promise((resolve) => setTimeout(resolve, 700));
          await page.mouse.up();
        }
        return ok({ id: textArg(args.id), done: true });
      }
      if (name === "scroll" || name === "scroll_to") {
        const page = await resolve(args);
        if (!page) return missing();
        const deltaY = numArg(args.deltaY) ?? numArg(args.delta) ?? 600;
        const deltaX = numArg(args.deltaX) ?? 0;
        await page.mouse.wheel(deltaX, deltaY);
        return ok({ tabId: tabIdOf(page), deltaY, deltaX });
      }
      if (name === "page_list_regions") {
        const page = await resolve(args);
        if (!page) return missing();
        const scan = await scanPage(page);
        const regions = [
          { id: "r_01", role: "main", name: "正文", heading: scan.headings[0] ?? scan.title, interactiveCount: scan.elements.length },
          ...scan.headings.slice(1).map((heading, index) => ({
            id: `r_${String(index + 2).padStart(2, "0")}`,
            role: "region",
            name: heading,
            heading,
            interactiveCount: 0,
          })),
        ];
        return ok({ tabId: tabIdOf(page), regions });
      }
      if (name === "page_inspect_region") {
        const page = await resolve(args);
        if (!page) return missing();
        const scan = await scanPage(page);
        return ok({ id: args.id, text: scan.bodyText, elements: scan.elements.slice(0, 40) });
      }
      if (name === "frame_list") {
        const page = await resolve(args);
        if (!page) return missing();
        const frames = page.frames().map((frame, index) => ({
          frameId: index,
          isTop: frame === page.mainFrame(),
          url: frame.url(),
          name: frame.name(),
          title: "",
        }));
        return ok({ frames });
      }
      if (name === "page_recheck" || name === "page_assert") {
        const page = await resolve(args);
        if (!page) return missing();
        const scan = await scanPage(page);
        const checks: { name: string; ok: boolean }[] = [];
        const text = textArg(args.text);
        if (text) checks.push({ name: `text:${text}`, ok: scan.bodyText.includes(text) });
        const urlContains = textArg(args.urlContains);
        if (urlContains) checks.push({ name: `url:${urlContains}`, ok: scan.url.includes(urlContains) });
        const titleContains = textArg(args.titleContains);
        if (titleContains) checks.push({ name: `title:${titleContains}`, ok: scan.title.includes(titleContains) });
        const id = textArg(args.id);
        if (id) checks.push({ name: `element:${id}`, ok: scan.elements.some((element) => element.id === id) });
        const passed = checks.length === 0 || checks.every((check) => check.ok);
        return ok({ checks, passed, ...(passed ? {} : { faultCode: "assertion_failed" }) });
      }
      if (name === "see_console") {
        const page = await resolve(args);
        if (!page) return missing();
        tabIdOf(page);
        const logs = consoleLogs.get(page) ?? [];
        const level = textArg(args.level, "error");
        const items = level === "all" ? logs : logs.filter((entry) => entry.level === level);
        return ok({ count: items.length, items });
      }
      if (name === "cookies") {
        const context = await runtime.context();
        const cookies = await context.cookies(textArg(args.url) || undefined);
        return ok({ cookies: cookies.slice(0, 100), count: cookies.length });
      }
      if (name === "see_zoom" || name === "set_zoom" || name === "emulate_device") {
        return fail("tool_not_implemented", `${name} 在 Kestrel 的 Playwright 执行端尚未实现`);
      }
      return fail("tool_not_implemented", `${name} 在 Kestrel 的 Playwright 执行端尚未实现`, { name });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return fail("browser_execution_failed", message, { name });
    }
  };

  // ---- 右栏预览：跟踪 agent 正在操作的页面，把目标交给前端 iframe 嵌入 -------------
  // 推流（CDP Page.startScreencast）已移除：右栏改成真实 iframe，点击/输入都是浏览器原生行为。
  // 执行端只需在目标页变化时发 target 事件，告诉前端当前该显示哪个页面。
  type PreviewSub = { listener: (event: PreviewEvent) => void; exclude?: (url: string) => boolean };
  const previewSubs = new Set<PreviewSub>();
  const previewLog = (message: string) => {
    console.log(`[preview] ${message}`);
  };
  const previewState = {
    page: null as Page | null,
    url: "",
    title: "",
    attaching: false,
    timer: null as ReturnType<typeof setInterval> | null,
    empty: false,
  };

  const emitPreview = (event: PreviewEvent) => {
    for (const sub of previewSubs) {
      try {
        sub.listener(event);
      } catch {
        // 订阅者（SSE 连接）已断开，这条投递失败无需处理
      }
    }
  };

  const previewUsable = (page: Page): boolean => {
    if (page.isClosed()) return false;
    const target = page.url();
    if (!target || target === "about:blank") return false;
    if (["chrome://", "devtools://", "chrome-extension://", "edge://"].some((prefix) => target.startsWith(prefix))) return false;
    for (const sub of previewSubs) {
      if (sub.exclude?.(target)) return false;
    }
    return true;
  };

  /** 右栏现在是真实 iframe：执行端只记录目标页，并在变化时把目标发给前端。 */
  const attachPreview = async (page: Page) => {
    previewState.attaching = true;
    try {
      const title = await page.title().catch(() => "");
      previewState.page = page;
      previewState.title = title;
      previewState.url = page.url();
      previewState.empty = false;
      emitPreview({ kind: "target", tabId: tabIdOf(page), url: previewState.url, title, at: Date.now() });
    } catch (error) {
      emitPreview({ kind: "error", error: error instanceof Error ? error.message : String(error), faultCode: "preview_unavailable" });
    } finally {
      previewState.attaching = false;
    }
  };

  /** 只在目标页面变化（新开/关闭/换页/标题变化）时重新取目标，把 target 事件发给前端。 */
  const tickPreview = async () => {
    if (!previewSubs.size || previewState.attaching) return;
    let pages: Page[] = [];
    try {
      pages = await runtime.pages();
    } catch (error) {
      previewLog(`pages 失败: ${error instanceof Error ? error.message : String(error)}`);
      if (!previewState.empty) {
        previewState.empty = true;
        emitPreview({ kind: "empty", message: "浏览器未启动" });
      }
      return;
    }
    const usable = pages.filter(previewUsable);
    const target = usable.pop() ?? null;
    if (!target) {
      if (previewState.page) {
        previewState.page = null;
        previewState.url = "";
        previewState.title = "";
      }
      if (!previewState.empty) {
        previewState.empty = true;
        emitPreview({ kind: "empty", message: "agent 还没有打开页面" });
      }
      return;
    }
    if (target !== previewState.page) {
      previewLog(`attach -> ${target.url()}`);
      await attachPreview(target);
      return;
    }
    const title = await target.title().catch(() => "");
    if (title !== previewState.title || target.url() !== previewState.url) {
      previewState.title = title;
      previewState.url = target.url();
      previewState.empty = false;
      emitPreview({ kind: "target", tabId: tabIdOf(target), url: previewState.url, title, at: Date.now() });
    }
  };

  const watchPreview = (listener: (event: PreviewEvent) => void, options?: PreviewWatchOptions): (() => void) => {
    const sub: PreviewSub = { listener, exclude: options?.exclude };
    previewSubs.add(sub);
    previewLog(`subscribe subs=${previewSubs.size}`);
    // 新订阅者补发当前目标：否则前端刷新后迟迟收不到 target 事件，
    // 右栏 iframe 就一直没有嵌入目标。
    if (previewState.page && !previewState.empty) {
      const current = previewState.page;
      listener({
        kind: "target",
        tabId: tabIdOf(current),
        url: current.url(),
        title: previewState.title || "",
        at: Date.now(),
      });
    }
    if (previewSubs.size === 1) {
      void tickPreview();
      previewState.timer = setInterval(() => { void tickPreview(); }, 1500);
    }
    return () => {
      previewSubs.delete(sub);
      if (previewSubs.size) return;
      if (previewState.timer) {
        clearInterval(previewState.timer);
        previewState.timer = null;
      }
      previewState.page = null;
    };
  };

  // forScope 必须复用同一个 host：新建一份会在同一 chrome-profile 上再开一个
  // Chrome，撞上单例后 Playwright 立刻报 browser has been closed。
  const host: BrowserHost = {
    readCurrentTabs: currentTabs,
    watchPreview,
    execute,
    executeTracked: (name: string, input: Json) => ({ id: "", result: execute(name, input) }),
    abort: () => undefined,
    abortById: () => false,
    forScope: () => host,
  };
  return host;
}
