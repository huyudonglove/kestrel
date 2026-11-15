import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/* 右栏预览的目标页只存在执行端内存里时，刷新网页就全丢了。这里把最后一次下发过的目标
   落到数据目录（容器里是挂载卷），新连接连上时先补发一次，刷新后右栏仍然停在那个页面。 */

export type PreviewTarget = { url: string; title: string; tabId: number; at: number };

function previewDir(dataDir: string): string {
  return join(dataDir, "preview");
}

function targetPath(dataDir: string): string {
  return join(previewDir(dataDir), "last-target.json");
}

export function savePreviewTarget(dataDir: string, target: PreviewTarget): void {
  const url = target.url ?? "";
  if (!url || url === "about:blank") return;
  try {
    mkdirSync(previewDir(dataDir), { recursive: true });
    writeFileSync(targetPath(dataDir), JSON.stringify({ ...target, savedAt: Date.now() }), "utf8");
  } catch { /* 记录失败不影响预览本身 */ }
}

export function loadPreviewTarget(dataDir: string): PreviewTarget | null {
  const path = targetPath(dataDir);
  if (!existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<PreviewTarget>;
    if (typeof raw.url !== "string" || !raw.url) return null;
    return {
      url: raw.url,
      title: typeof raw.title === "string" ? raw.title : "",
      tabId: typeof raw.tabId === "number" ? raw.tabId : -1,
      at: typeof raw.at === "number" ? raw.at : Date.now(),
    };
  } catch { /* 文件损坏就当没有记录 */ return null; }
}
