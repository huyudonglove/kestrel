import { existsSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, sep } from "node:path";

/* agent 产出的页面/素材落在数据目录（容器里是 /data 挂载卷）下的 artifacts/，
   由 /artifact/<相对路径> 直接对外提供，刷新页面、重建容器都不会丢。 */

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/plain; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
};

export function artifactDir(dataDir: string): string {
  return join(dataDir, "artifacts");
}

/** 只允许读 artifacts/ 之内的普通文件；越界或不存在返回 null。
    返回的 body 复制到独立 ArrayBuffer，可直接作为 Response 的 BodyInit。 */
export function readArtifact(dataDir: string, relative: string): { body: Uint8Array<ArrayBuffer>; type: string } | null {
  const cleaned = (relative ?? "").replace(/^\/+/, "");
  if (!cleaned) return null;
  const root = normalize(artifactDir(dataDir));
  const full = normalize(join(root, cleaned));
  if (full !== root && !full.startsWith(root + sep)) return null;
  if (!existsSync(full)) return null;
  try {
    if (!statSync(full).isFile()) return null;
    const body = new Uint8Array(readFileSync(full));
    return { body, type: TYPES[extname(full).toLowerCase()] ?? "application/octet-stream" };
  } catch { /* 读不到（权限/并发删除）按未找到处理 */ return null; }
}
