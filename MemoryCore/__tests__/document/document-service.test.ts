/**
 * document-service 集成测试（fork 文档子系统）。
 *
 * 用真实 SqliteMemoryStore（dimensions=0，metadata/FTS-only，不依赖 sqlite-vec）
 * 走完整导入 → 判重 → 升版级联 → 删除级联链路。不触 LLM（L1 由管线异步负责，
 * 本文件只验证登记/L0/锚点/级联的正确性）。
 */

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { VectorStore } from "../../src/core/store/sqlite.js";
import type { IMemoryStore } from "../../src/core/store/types.js";
import {
  DocumentServiceError,
  deleteDocument,
  getDocumentDetail,
  importDocument,
  listDocuments,
} from "../../src/core/document/document-service.js";
import { documentSessionId } from "../../src/core/document/types.js";

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "memdoc-test-"));
let dbCounter = 0;
const stores: VectorStore[] = [];

function makeStore(): VectorStore {
  const dbPath = path.join(tmpRoot, `test-${++dbCounter}.db`);
  const store = new VectorStore(dbPath, 0, undefined);
  store.init();
  stores.push(store);
  return store;
}

function makeDeps(store: IMemoryStore, notify?: () => void) {
  return {
    getStore: () => store,
    getEmbedding: () => undefined,
    ...(notify ? { notify } : {}),
  };
}

const MD_V1 = "## 环境\n准备依赖。\n\n## 步骤\n执行安装。\n";
const MD_V2 = "## 环境\n准备依赖与镜像。\n\n## 步骤\n执行安装。\n\n## 验证\n健康检查。\n";

afterAll(() => {
  // Windows 下 better-sqlite3 持有文件句柄，必须先 close 才能删临时目录（EBUSY）
  for (const store of stores) {
    try {
      store.close();
    } catch {
      // 已关闭则忽略
    }
  }
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

describe("importDocument", () => {
  let store: VectorStore;
  beforeEach(() => {
    store = makeStore();
  });

  it("首导：登记 v1 + L0 带 source 标记 + 锚点 + 触发管线", async () => {
    const notify = vi.fn();
    const result = await importDocument(makeDeps(store, notify), {
      title: "部署手册",
      markdown: MD_V1,
      callerRef: "file-1",
      teamId: "t1",
      userId: "u1",
      agentId: "a1",
    });

    expect(result.deduplicated).toBe(false);
    expect(result.document.version).toBe(1);
    expect(result.document.chunk_count).toBe(2);
    expect(result.acceptedChunks).toBe(2);
    expect(result.document.session_id).toBe(documentSessionId(result.document.document_id, 1));
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(result.document.session_id, 2, "t1", "a1");

    // L0 行带 source 标记
    const l0 = await store.queryL0ForL1(result.document.session_id);
    expect(l0).toHaveLength(2);
    expect(l0.every((r) => r.source_kind === "document" && r.source_ref === result.document.document_id)).toBe(true);

    // 登记行 + 分块锚点
    const detail = await getDocumentDetail(makeDeps(store), result.document.document_id);
    expect(detail.document.title).toBe("部署手册");
    expect(detail.chunks).toHaveLength(2);
    expect(detail.chunks.map((c) => c.heading_path)).toEqual(["环境", "步骤"]);
  });

  it("同内容重导：deduplicated 命中，不新建、不再触发管线", async () => {
    const notify = vi.fn();
    const first = await importDocument(makeDeps(store, notify), {
      title: "部署手册", markdown: MD_V1, callerRef: "file-1",
      teamId: "t1", userId: "u1", agentId: "a1",
    });
    const second = await importDocument(makeDeps(store, notify), {
      title: "部署手册", markdown: MD_V1, callerRef: "file-1",
      teamId: "t1", userId: "u1", agentId: "a1",
    });

    expect(second.deduplicated).toBe(true);
    expect(second.document.document_id).toBe(first.document.document_id);
    expect(second.document.version).toBe(1);
    expect(notify).toHaveBeenCalledTimes(1);

    // 只有一份登记
    const docs = await listDocuments(makeDeps(store), { teamId: "t1" });
    expect(docs).toHaveLength(1);
  });

  it("内容变更重导：升版 v2，旧版 L0 级联清除", async () => {
    const first = await importDocument(makeDeps(store), {
      title: "部署手册", markdown: MD_V1, callerRef: "file-1",
      teamId: "t1", userId: "u1", agentId: "a1",
    });
    const second = await importDocument(makeDeps(store), {
      title: "部署手册", markdown: MD_V2, callerRef: "file-1",
      teamId: "t1", userId: "u1", agentId: "a1",
    });

    expect(second.deduplicated).toBe(false);
    expect(second.replacedVersions).toBe(1);
    expect(second.document.version).toBe(2);
    expect(second.document.document_id).not.toBe(first.document.document_id);

    // 旧会话 L0 清空、新会话就位
    const oldL0 = await store.queryL0ForL1(first.document.session_id);
    expect(oldL0).toHaveLength(0);
    const newL0 = await store.queryL0ForL1(second.document.session_id);
    expect(newL0).toHaveLength(3);

    // 身份键只保留最新版登记
    const docs = await listDocuments(makeDeps(store), { teamId: "t1" });
    expect(docs).toHaveLength(1);
    expect(docs[0].version).toBe(2);
  });

  it("隔离独立：同身份不同 team 各自成档", async () => {
    await importDocument(makeDeps(store), {
      title: "部署手册", markdown: MD_V1, callerRef: "file-1",
      teamId: "t1", userId: "u1", agentId: "a1",
    });
    const other = await importDocument(makeDeps(store), {
      title: "部署手册", markdown: MD_V1, callerRef: "file-1",
      teamId: "t2", userId: "u1", agentId: "a1",
    });
    expect(other.deduplicated).toBe(false);
    expect(other.document.version).toBe(1);

    expect(await listDocuments(makeDeps(store), { teamId: "t1" })).toHaveLength(1);
    expect(await listDocuments(makeDeps(store), { teamId: "t2" })).toHaveLength(1);
  });

  it("非法参数与不支持的后端", async () => {
    await expect(importDocument(makeDeps(store), {
      title: "", markdown: MD_V1, callerRef: "f",
    })).rejects.toMatchObject({ code: "invalid_argument" });
    await expect(importDocument(makeDeps(store), {
      title: "T", markdown: "  ", callerRef: "f",
    })).rejects.toMatchObject({ code: "invalid_argument" });

    const stubDeps = {
      getStore: () => ({ upsertDocument: undefined }) as unknown as IMemoryStore,
      getEmbedding: () => undefined,
    };
    await expect(importDocument(stubDeps, {
      title: "T", markdown: MD_V1, callerRef: "f",
    })).rejects.toMatchObject(
      expect.objectContaining({ code: "unsupported_store" }) as Partial<DocumentServiceError>,
    );
  });
});

describe("deleteDocument", () => {
  it("级联删除：登记、L0 会话、分块锚点全部清除", async () => {
    const store = makeStore();
    const { document } = await importDocument(makeDeps(store), {
      title: "部署手册", markdown: MD_V1, callerRef: "file-1",
      teamId: "t1", userId: "u1", agentId: "a1",
    });

    const deleted = await deleteDocument(makeDeps(store), document.document_id);
    expect(deleted.document_id).toBe(document.document_id);

    // 登记行、锚点、L0 全部无残留
    await expect(getDocumentDetail(makeDeps(store), document.document_id))
      .rejects.toMatchObject({ code: "not_found" });
    expect(await store.queryL0ForL1(document.session_id)).toHaveLength(0);
    expect(await store.getDocumentChunks(document.document_id)).toHaveLength(0);

    // 重复删除 → not_found
    await expect(deleteDocument(makeDeps(store), document.document_id))
      .rejects.toMatchObject({ code: "not_found" });
  });
});
