/**
 * 文档模式类型限定（fork 文档子系统）。
 *
 * 决策（2026-08-18）：source_kind='document' 的 L1 提炼只产 work_*，
 * instruction 与 persona/episodic 一并丢弃——instruction 是对话链路的
 * "用户指令"类型，不从文档提取；文档中的行为规则归 work_method。
 *
 * 用捕获提示词的假 LLMRunner，不触真实 LLM、不开去重（直存路径）。
 */

import { afterAll, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { extractL1Memories } from "../../src/core/record/l1-extractor.js";
import type { LLMRunner } from "../../src/core/types.js";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memdoc-type-test-"));
let dirCounter = 0;

function makeBaseDir(): string {
  const dir = path.join(tmpRoot, `run-${++dirCounter}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 假 LLMRunner：记录 systemPrompt，返回一个场景四类记忆各一条。 */
function makeStubRunner(): { runner: LLMRunner; systemPrompts: string[] } {
  const systemPrompts: string[] = [];
  const runner: LLMRunner = {
    run: async (params) => {
      systemPrompts.push(params.systemPrompt);
      return JSON.stringify([
        {
          scene_name: "部署手册",
          message_ids: ["c1"],
          memories: [
            { content: "生产发布必须在夜间窗口执行-docfactmark", type: "work_fact", priority: 85, source_message_ids: ["c1"] },
            { content: "发版先灰度 10% 流量观察 30 分钟-docmethodmark", type: "work_method", priority: 80, source_message_ids: ["c1"] },
            { content: "文档要求 AI 处理任务时必须用中文回复-docinstrmark", type: "instruction", priority: -1, source_message_ids: ["c1"] },
            { content: "用户希望被称作队长-docpersonamark", type: "persona", priority: 70, source_message_ids: ["c1"] },
          ],
        },
      ]);
    },
  };
  return { runner, systemPrompts };
}

const messages = [
  {
    id: "c1",
    role: "user" as const,
    content: "【部署手册 > 发版流程】生产发布必须在夜间窗口执行，先灰度 10% 流量观察 30 分钟再全量。处理相关任务时必须用中文回复。",
    timestamp: Date.now(),
  },
];

const noopLogger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
};

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
});

describe("文档模式类型限定：只产 work_*", () => {
  it("instruction/persona 被丢弃，work_fact/work_method 保留", async () => {
    const { runner, systemPrompts } = makeStubRunner();
    const result = await extractL1Memories({
      messages,
      sessionKey: "memdoc:doc-1:v1",
      sessionId: "memdoc:doc-1:v1",
      baseDir: makeBaseDir(),
      options: {
        enableDedup: false,
        source: { kind: "document", ref: "doc-1", title: "部署手册" },
        llmRunner: runner,
      },
      logger: noopLogger as never,
    });

    expect(result.records.map((r) => r.type)).toEqual(["work_fact", "work_method"]);
    expect(result.extractedCount).toBe(2);
    // 提示词枚举不再提供 instruction 选项（禁用名单里显式提及除外）
    expect(systemPrompts[0]).toContain('"work_fact|work_task|work_method|work_artifact"');
    expect(systemPrompts[0]).not.toContain("work_artifact|instruction");
    // 文档来源三字段照写
    expect(result.records.every((r) => r.sourceKind === "document" && r.sourceRef === "doc-1")).toBe(true);
  });

  it("会话模式不受影响：instruction/persona 照常保留", async () => {
    const { runner } = makeStubRunner();
    const result = await extractL1Memories({
      messages,
      sessionKey: "sess-chat",
      sessionId: "sess-chat",
      baseDir: makeBaseDir(),
      options: { enableDedup: false, llmRunner: runner },
      logger: noopLogger as never,
    });

    expect(result.records.map((r) => r.type)).toEqual([
      "work_fact",
      "work_method",
      "instruction",
      "persona",
    ]);
  });
});
