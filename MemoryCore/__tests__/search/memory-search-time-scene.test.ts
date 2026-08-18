/**
 * memory_search 时间范围过滤 + scene_name 返回（fork：atomic/search time_start/time_end）。
 *
 * - executeMemorySearch 的 timeStartMs/timeEndMs 按 updated_at（= timestamps 最大值）
 *   在 RRF 合并后过滤；窗口外命中项剔除。
 * - 结果项 scene_name 透传（v2-router handleAtomicSearch 映射的同源字段）。
 *
 * 用真实 VectorStore（dimensions=0，FTS-only 路径），不触真实 LLM/embedding。
 */

import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { VectorStore } from "../../src/core/store/sqlite.js";
import type { MemoryRecord } from "../../src/core/record/l1-writer.js";
import { executeMemorySearch } from "../../src/core/tools/memory-search.js";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memdoc-search-test-"));
let dbCounter = 0;
const stores: VectorStore[] = [];

function makeStore(): VectorStore {
  const dbPath = path.join(tmpRoot, `test-${++dbCounter}.db`);
  const store = new VectorStore(dbPath, 0, undefined);
  store.init();
  stores.push(store);
  return store;
}

function l1Record(id: string, content: string, sceneName: string, updatedAt: string): MemoryRecord {
  return {
    id,
    content,
    type: "work_fact",
    priority: 80,
    scene_name: sceneName,
    source_message_ids: [],
    metadata: {},
    timestamps: [updatedAt],
    createdAt: updatedAt,
    updatedAt,
    version: 0,
    sessionKey: "sess-search-test",
    sessionId: "sess-search-test",
    teamId: "default",
    userId: "default",
    agentId: "default",
  };
}

const T_A = "2026-08-10T08:00:00.000Z";
const T_B = "2026-08-15T08:00:00.000Z";
const T_C = "2026-08-20T08:00:00.000Z";

function seed(): VectorStore {
  const store = makeStore();
  store.upsertL1(l1Record("m-time-a", "timewindow alpha 部署窗口约定", "产品A使用手册", T_A), undefined);
  store.upsertL1(l1Record("m-time-b", "timewindow bravo 发布节奏", "产品A使用手册", T_B), undefined);
  store.upsertL1(l1Record("m-time-c", "timewindow charlie 会话部署讨论", "部署讨论", T_C), undefined);
  return store;
}

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

describe("executeMemorySearch timeStartMs/timeEndMs", () => {
  it("不带时间过滤：全量命中且每条带 scene_name", async () => {
    const store = seed();
    const result = await executeMemorySearch({
      query: "timewindow",
      limit: 10,
      vectorStore: store,
    });

    expect(result.results.length).toBe(3);
    for (const item of result.results) {
      expect(item.scene_name).toBeTruthy();
    }
    const scenes = result.results.map((r) => r.scene_name).sort();
    expect(scenes).toEqual(["产品A使用手册", "产品A使用手册", "部署讨论"].sort());
  });

  it("闭区间窗口：只留窗口内命中项", async () => {
    const store = seed();
    const result = await executeMemorySearch({
      query: "timewindow",
      limit: 10,
      timeStartMs: new Date("2026-08-13T00:00:00.000Z").getTime(),
      timeEndMs: new Date("2026-08-17T00:00:00.000Z").getTime(),
      vectorStore: store,
    });

    expect(result.results.length).toBe(1);
    expect(result.results[0].id).toBe("m-time-b");
    expect(result.results[0].scene_name).toBe("产品A使用手册");
  });

  it("只有下界：保留晚于下界的命中项", async () => {
    const store = seed();
    const result = await executeMemorySearch({
      query: "timewindow",
      limit: 10,
      timeStartMs: new Date("2026-08-13T00:00:00.000Z").getTime(),
      vectorStore: store,
    });

    expect(result.results.map((r) => r.id).sort()).toEqual(["m-time-b", "m-time-c"]);
  });

  it("空窗口：结果为空（total 同步收敛）", async () => {
    const store = seed();
    const result = await executeMemorySearch({
      query: "timewindow",
      limit: 10,
      timeStartMs: new Date("2030-01-01T00:00:00.000Z").getTime(),
      vectorStore: store,
    });

    expect(result.results.length).toBe(0);
    expect(result.total).toBe(0);
  });
});
