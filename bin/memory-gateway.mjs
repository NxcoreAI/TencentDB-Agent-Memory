#!/usr/bin/env node
/**
 * EverRoom 托管启动器 — 等价于 `node --import tsx src/gateway/server.ts`。
 *
 * 由 EverRoom 的 MemoryCoreSupervisor 作为子进程拉起；所有配置通过
 * TDAI_* 环境变量注入（TDAI_GATEWAY_PORT / TDAI_GATEWAY_HOST /
 * TDAI_GATEWAY_API_KEY / TDAI_LLM_* / TDAI_DATA_DIR），无需任何 yaml。
 *
 * 通过 require.resolve 拿到本包 node_modules 内的 tsx 绝对路径再传给
 * --import，避免子进程 cwd 不在本包目录时解析失败。
 */
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const tsxEntry = require.resolve("tsx");
const serverEntry = pathToFileURL(new URL("../src/gateway/server.ts", import.meta.url).href);

const result = spawnSync(process.execPath, ["--import", tsxEntry, serverEntry], {
  stdio: "inherit",
  env: process.env,
});

if (result.error) {
  console.error("[memory-gateway] failed to start:", result.error);
  process.exit(1);
}
process.exit(result.status ?? 1);
