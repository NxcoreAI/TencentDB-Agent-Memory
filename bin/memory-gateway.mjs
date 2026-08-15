#!/usr/bin/env node
/**
 * EverRoom 托管启动器 — 等价于 `node --import tsx src/gateway/server.ts`。
 *
 * 由 EverRoom 的 MemoryCoreSupervisor 作为子进程拉起；所有配置通过
 * TDAI_* 环境变量注入（TDAI_GATEWAY_PORT / TDAI_GATEWAY_HOST /
 * TDAI_GATEWAY_API_KEY / TDAI_LLM_* / TDAI_DATA_DIR），无需任何 yaml。
 *
 * Windows + Node 22 的注意点：
 * - `--import` 必须传 tsx loader 的 file:// URL（裸盘符路径会被判为 URL scheme）；
 * - 主入口必须传正斜杠路径（file:// URL 会被误判为 CJS 相对路径）。
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const tsxEntryUrl = pathToFileURL(require.resolve("tsx")).href;
const serverEntry = fileURLToPath(new URL("../src/gateway/server.ts", import.meta.url)).replace(/\\/g, "/");

const result = spawnSync(process.execPath, ["--import", tsxEntryUrl, serverEntry], {
  stdio: "inherit",
  env: process.env,
});

if (result.error) {
  console.error("[memory-gateway] failed to start:", result.error);
  process.exit(1);
}
process.exit(result.status ?? 1);
