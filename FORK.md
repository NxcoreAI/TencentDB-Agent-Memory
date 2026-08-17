# Nxcore fork of TencentDB-Agent-Memory

本仓库是 [TencentCloud/TencentDB-Agent-Memory](https://github.com/TencentCloud/TencentDB-Agent-Memory)
的 fork，保留上游 monorepo 双包结构，供 EverRoom 以 pnpm git 子目录依赖的方式内嵌使用，
让队友拉下 EverRoom 代码后无需手工部署即可拥有本地记忆/知识服务。

## EverRoom 侧用法（同 commit，各自子目录）

```jsonc
// apps/desktop/package.json
"@tencentdb-agent-memory/memory-tencentdb-v2": "https://github.com/NxcoreAI/TencentDB-Agent-Memory.git#<commit>#path:MemoryCore",
"@tencentdb-agent-memory/knowledge-service": "https://github.com/NxcoreAI/TencentDB-Agent-Memory.git#<commit>#path:MemoryKnowledge",
```

两个包钉**同一个 commit**；`#path:` 是 pnpm 的 git 子目录依赖语法（pnpm ≥ 7.24 支持
`#<ref>#path:<dir>` 形式）。注意 pnpm 安装 git 依赖不装 devDependencies，故两个包的
运行时 loader（tsx）都在 dependencies 里。

## 与上游的差异（有意保持最小，按包列出）

### MemoryCore/

| 改动 | 原因 |
| --- | --- |
| `bin/memory-gateway.mjs` + package.json 的 `bin`/`exports`/`files` 条目 | 提供可 spawn 的 HTTP gateway 启动入口（等价于 `node --import tsx src/gateway/server.ts`），含 Windows `--import` file:// URL 修复 |
| 移除 `prepack` 脚本 | pnpm 安装 git 依赖时不装 devDependencies，`npm run build` 必然失败；EverRoom 直接从 `src` 经 tsx 运行，不需要 `dist` |
| `version` 后缀 `-everroom.N` | 标记 fork 版本，便于区分上游 |
| 文档记忆子系统：l0/l1 `source_kind`/`source_ref` 列 + `documents` 登记表/分块锚点表（`core/document/`），`/v3/document/import|get|list|delete`，`/v3/atomic/provenance`，query/search 的 `source_kind` 过滤 | md 文档一等记忆来源 + 双向溯源（EverRoom `docs/memory-md-source-plan.md`）。原文不落盘（只存 caller_ref 与内容指纹）；TCVDB 后端不加列不实现 document 方法，走 503 守卫 |
| 基线包含本地修复 commit `93f904d`（事实提取 prompt 修复） | 业务需要的上游未合入修改 |

### MemoryKnowledge/

| 改动 | 原因 |
| --- | --- |
| `src/server.ts` 直跑判断用 `pathToFileURL` 归一化 | win32 下 `import.meta.url` 与 `file://${argv[1]}` 拼串比较必不相等，`startServer()` 永不执行 |
| `src/store/wiki-service.ts` 路径校验用 `path.sep` 前缀比较 | win32 下 `resolve()` 产出反斜杠路径，硬编码 `"/"` 前缀会把所有合法路径误判为 traversal |
| `tsx` 移入 dependencies | 同 MemoryCore：git 依赖不装 devDeps，EverRoom supervisor 需要 `--import tsx` 跑源码 |
| `version` 后缀 `-everroom.N` | 同上 |
| `pnpm-workspace.yaml`（构建脚本白名单 + workspace 锚点） | 同 MemoryCore 侧：默认全禁、显式放行 better-sqlite3/esbuild/protobufjs；锚定 workspace 避免 pnpm 向上识别 EverRoom 根 |

### 仓库级

- `.gitignore` 增加 `MemoryKnowledge/data/`——wiki 运行数据（原文/生成页/索引库）绝不入库。

## 托管方式

两个服务均由 `apps/desktop` 的 supervisor（`MemoryCoreSupervisor` / `KnowledgeServiceSupervisor`）
托管，全部通过环境变量配置（MemoryCore 用 `TDAI_*`，Knowledge 用 `PORT`/`KNOWLEDGE_*`/`LLM_*`），
手工启动分别为 `node bin/memory-gateway.mjs` 与 `node --import tsx src/server.ts`。

## 同步上游

拉取上游 → 把上游 `MemoryCore/`、`MemoryKnowledge/` 覆盖本仓库对应目录 →
重新应用上表补丁 → 升级 EverRoom 中两条 git 依赖的 commit。
