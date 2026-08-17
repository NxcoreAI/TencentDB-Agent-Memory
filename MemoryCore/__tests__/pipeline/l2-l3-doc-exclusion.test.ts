/**
 * L2/L3 排除文档派生原子（fork 文档子系统）。
 *
 * 决策（2026-08-18）：source_kind='document' 的 L1 原子——
 *   - 不进 L2 场景块（createL2Runner 查询后过滤；纯文档批次仍推进游标）
 *   - 不催更 L3（memories_since_last_persona 不计入文档派生 stored 数；
 *     persona 内容本身只从场景块生成，无需单独闸门）
 *
 * 用真实 VectorStore（dimensions=0，FTS-only）+ 捕获提示词的假 LLMRunner，
 * 不触真实 LLM。
 */

import { afterAll, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { VectorStore } from "../../src/core/store/sqlite.js";
import type { MemoryRecord } from "../../src/core/record/l1-writer.js";
import { createL2Runner } from "../../src/utils/pipeline-factory.js";
import { CheckpointManager } from "../../src/utils/checkpoint.js";
import type { MemoryTdaiConfig } from "../../src/config.js";
import type { LLMRunner } from "../../src/core/types.js";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memdoc-l2l3-test-"));
let dbCounter = 0;
let dirCounter = 0;
const stores: VectorStore[] = [];

function makeStore(): VectorStore {
  const dbPath = path.join(tmpRoot, `test-${++dbCounter}.db`);
  const store = new VectorStore(dbPath, 0, undefined);
  store.init();
  stores.push(store);
  return store;
}

function makeDataDir(): string {
  const dir = path.join(tmpRoot, `data-${++dirCounter}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function l1Record(overrides: Partial<MemoryRecord> & Pick<MemoryRecord, "id" | "content" | "type" | "sourceKind">): MemoryRecord {
  const now = new Date().toISOString();
  return {
    priority: 80,
    scene_name: "s",
    source_message_ids: [],
    metadata: {},
    timestamps: [now],
    createdAt: now,
    updatedAt: now,
    version: 0,
    sessionKey: "sess-l2-test",
    sessionId: "sess-l2-test",
    teamId: "default",
    userId: "default",
    agentId: "default",
    ...overrides,
  };
}

/** 假 L2 LLMRunner：记录收到的提示词，返回空文本（不写场景文件 → empty extraction）。 */
function makeCapturingRunner(): { runner: LLMRunner; prompts: string[] } {
  const prompts: string[] = [];
  const runner: LLMRunner = {
    run: async (params) => {
      prompts.push(`${params.systemPrompt}\n\n${params.prompt}`);
      return "";
    },
  };
  return { runner, prompts };
}

// createL2Runner 只读 cfg.persona.{model, promptMode, maxScenes, sceneBackupCount}
const cfg = {
  persona: { model: "test-model", promptMode: "chat", maxScenes: 15, sceneBackupCount: 10 },
} as unknown as MemoryTdaiConfig;

const noopLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

afterAll(() => {
  // Windows 下 sqlite 句柄必须先 close 才能删临时目录（EBUSY）
  for (const store of stores) {
    try {
      store.close();
    } catch {
      // 已关闭则忽略
    }
  }
  fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("createL2Runner 文档派生原子排除", () => {
  it("混合批次：只有会话派生原子进入场景提取提示词", async () => {
    const store = makeStore();
    const dataDir = makeDataDir();
    // 预置一个场景块：让本批提取后 scene_index 非空（否则走 emptyExtraction→skipped，
    // 游标不返回，那是上游对「LLM 空跑」的既有语义，与本测试无关）。
    // L2 输出按 team+agent 作用域分目录：profiles/<scope>/scene_blocks/
    const scopeDir = path.join(dataDir, "profiles", encodeURIComponent("team:default|agent:default"));
    fs.mkdirSync(path.join(scopeDir, "scene_blocks"), { recursive: true });
    fs.writeFileSync(path.join(scopeDir, "scene_blocks", "deploy-rhythm.md"), "# 部署节奏\n\n用户偏好夜间部署。\n", "utf-8");
    store.upsertL1(
      l1Record({ id: "m-chat-1", content: "用户偏好夜间部署窗口-chatmark", type: "work_fact", sourceKind: "conversation" }),
      undefined,
    );
    store.upsertL1(
      l1Record({ id: "m-doc-1", content: "镜像来自内部仓库 nexcore/everroom-docmark", type: "work_fact", sourceKind: "document", sourceRef: "doc-1" }),
      undefined,
    );

    const { runner, prompts } = makeCapturingRunner();
    const l2 = createL2Runner({
      pluginDataDir: dataDir,
      cfg,
      openclawConfig: {},
      vectorStore: store,
      logger: noopLogger as never,
      llmRunner: runner,
    });

    const result = await l2("sess-l2-test");

    expect(prompts.length).toBe(1);
    expect(prompts[0]).toContain("用户偏好夜间部署窗口-chatmark");
    expect(prompts[0]).not.toContain("m-doc-1");
    expect(prompts[0]).not.toContain("nexcore/everroom-docmark");
    // 游标按全量批次推进（晚于会话行的文档行不应被反复重查）
    expect(result && typeof result === "object" && "latestCursor" in result && result.latestCursor).toBeTruthy();
  });

  it("纯文档批次：不触 LLM，游标仍推进", async () => {
    const store = makeStore();
    const dataDir = makeDataDir();
    const docUpdatedAt = "2026-08-18T10:00:00.000Z";
    store.upsertL1(
      l1Record({
        id: "m-doc-only",
        content: "纯文档派生原子-doconlymark",
        type: "work_fact",
        sourceKind: "document",
        sourceRef: "doc-2",
        updatedAt: docUpdatedAt,
      }),
      undefined,
    );

    const { runner, prompts } = makeCapturingRunner();
    const l2 = createL2Runner({
      pluginDataDir: dataDir,
      cfg,
      openclawConfig: {},
      vectorStore: store,
      logger: noopLogger as never,
      llmRunner: runner,
    });

    const result = await l2("sess-l2-test");

    expect(prompts.length).toBe(0);
    expect(result).toEqual({ latestCursor: docUpdatedAt });
  });
});

describe("markL1ExtractionComplete personaVisibleExtracted", () => {
  it("文档派生 stored 数不计入 L3 触发计数，总量计数仍完整", async () => {
    const dataDir = makeDataDir();
    const cp = new CheckpointManager(dataDir, noopLogger as never, undefined);

    // 模拟一批：会话 2 条 + 文档 3 条 stored
    await cp.markL1ExtractionComplete("sess-a", 5, 1000, undefined, 2);
    let state = await cp.read();
    expect(state.total_memories_extracted).toBe(5);
    expect(state.memories_since_last_persona).toBe(2);

    // 存量调用方（不带第 5 参）语义不变
    await cp.markL1ExtractionComplete("sess-a", 4, 2000, undefined);
    state = await cp.read();
    expect(state.total_memories_extracted).toBe(9);
    expect(state.memories_since_last_persona).toBe(6);

    // 纯文档批次：persona 计数不动
    await cp.markL1ExtractionComplete("sess-b", 7, 3000, undefined, 0);
    state = await cp.read();
    expect(state.total_memories_extracted).toBe(16);
    expect(state.memories_since_last_persona).toBe(6);
  });
});
