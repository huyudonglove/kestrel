import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Kestrel has no browser extension: fingerprint its own executor and tool definitions.
// Keep this deterministic: file names and bytes only, no paths, timestamps or env.
export function executorVersion(repoRoot: string): string {
  const hash = createHash("sha256");
  const files: string[] = [];
  for (const file of ["service/browser/host.ts", "service/executor-version.ts"]) {
    if (existsSync(join(repoRoot, file))) files.push(file);
  }
  const definitions = join(repoRoot, "service/tools/definitions");
  if (existsSync(definitions)) {
    for (const name of readdirSync(definitions).sort()) {
      if (name.endsWith(".json")) files.push(`service/tools/definitions/${name}`);
    }
  }
  for (const file of files.sort()) hash.update(file).update("\0").update(readFileSync(join(repoRoot, file))).update("\0");
  return hash.digest("hex");
}

export const executorMismatchMessage = "Kestrel 执行端与服务工具版本不一致。请重启本地服务后重试。";
