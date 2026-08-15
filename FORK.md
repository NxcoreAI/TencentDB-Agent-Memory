# Nxcore fork of TencentDB-Agent-Memory / MemoryCore

本仓库是 [TencentCloud/TencentDB-Agent-Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory)
中 `MemoryCore` 的**独立仓库快照**，供 EverRoom 以 pnpm git 依赖的方式内嵌使用，
让队友拉下 EverRoom 代码后无需手工部署即可拥有本地记忆服务。

## 与上游的差异（有意保持最小）

| 改动 | 原因 |
| --- | --- |
| `bin/memory-gateway.mjs` + package.json 的 `bin`/`exports`/`files` 条目 | 提供可 spawn 的 HTTP gateway 启动入口（等价于 `node --import tsx src/gateway/server.ts`） |
| 移除 `prepack` 脚本 | pnpm 安装 git 依赖时不会装 devDependencies，`npm run build` 必然失败；EverRoom 直接从 `src` 经 tsx 运行，不需要 `dist` |
| `version` 后缀 `-everroom.N` | 标记 fork 版本，便于区分上游 |
| 基线包含本地修复 commit `93f904d`（事实提取 prompt 修复） | 业务需要的上游未合入修改 |

其余内容与上游一致。同步上游时：拉取上游 → `git archive` 导出 `MemoryCore/` 覆盖本仓库 →
重新应用上表补丁 → 升级 EverRoom 中的 git 依赖 commit。

## 用法（EverRoom 侧）

由 `apps/desktop` 的 `MemoryCoreSupervisor` 托管，全部通过环境变量配置：

```bash
TDAI_GATEWAY_PORT=8420          # 监听端口
TDAI_GATEWAY_HOST=127.0.0.1
TDAI_GATEWAY_API_KEY=...        # Bearer 鉴权
TDAI_LLM_BASE_URL=...           # 提炼用 LLM（openai 兼容）
TDAI_LLM_API_KEY=...
TDAI_LLM_MODEL=...
TDAI_DATA_DIR=...               # SQLite/JSONL 数据目录
```

手工启动：`node bin/memory-gateway.mjs`（要求 Node >= 22.16）。
