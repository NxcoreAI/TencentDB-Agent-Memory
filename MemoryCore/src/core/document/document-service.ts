/**
 * 文档导入服务（fork 文档子系统核心编排）。
 *
 * 职责（EverRoom docs/memory-md-source-plan.md §5.2）：
 *   - 身份判定：同 (title, caller_ref) 命中 → 内容 sha 相同则去重返回；
 *     不同则升版（version+1），并级联清除旧版全部记忆（L0 会话 + L1 原子）；
 *   - 分块落 L0（role=user、source=document，块文本已带【标题路径】前缀）；
 *   - 登记分块锚点（document_chunks：message_id + heading_path + 行区间）；
 *   - 写 documents 登记行（不存原文，只存 caller_ref + content_sha256）；
 *   - notifyPipeline 触发既有 L1 提炼管线（文档模式由 L0 组来源标记驱动）。
 *
 * 原文不入 MemoryCore：调用方（EverRoom 知识资产层）持有原始 md。
 */

import { createHash, randomUUID } from "node:crypto";
import type { IMemoryStore, L0Record } from "../store/types.js";
import type { EmbeddingService } from "../store/embedding.js";
import type { Logger } from "../types.js";
import type { DocumentRecord, DocumentChunkRow, DocumentQueryFilter } from "./types.js";
import { documentSessionId } from "./types.js";
import { chunkMarkdown } from "./chunker.js";

const TAG = "[memory-tdai][document]";

/** 文档子系统错误：code 供 gateway 映射 HTTP 状态。 */
export class DocumentServiceError extends Error {
  readonly code:
    | "unsupported_store"
    | "invalid_argument"
    | "too_large"
    | "not_found";
  constructor(code: DocumentServiceError["code"], message: string) {
    super(message);
    this.name = "DocumentServiceError";
    this.code = code;
  }
}

export interface DocumentServiceDeps {
  getStore(): IMemoryStore | null | undefined;
  getEmbedding(): EmbeddingService | null | undefined;
  /**
   * 触发 L1 提炼管线（serviceId 已由调用方闭包绑定）。
   * rounds 用块数（每块视作一轮导入）。
   */
  notify?: (sessionId: string, rounds: number, teamId?: string, agentId?: string) => Promise<void> | void;
  logger?: Logger;
}

export interface ImportDocumentParams {
  title: string;
  markdown: string;
  /** 调用方资产引用（EverRoom 为 uploaded_files.file_id），全局唯一。 */
  callerRef: string;
  teamId?: string;
  userId?: string;
  agentId?: string;
  taskId?: string;
}

export interface ImportDocumentResult {
  document: DocumentRecord;
  /** 内容 sha 命中旧版 → 未新建，直接返回旧登记。 */
  deduplicated: boolean;
  /** 本次升版级联删除的旧版本数。 */
  replacedVersions: number;
  /** 成功落库的 L0 块数。 */
  acceptedChunks: number;
}

function requireDocumentStore(store: IMemoryStore | null | undefined): IMemoryStore & {
  upsertDocument: NonNullable<IMemoryStore["upsertDocument"]>;
  getDocument: NonNullable<IMemoryStore["getDocument"]>;
  findDocuments: NonNullable<IMemoryStore["findDocuments"]>;
  deleteDocument: NonNullable<IMemoryStore["deleteDocument"]>;
  insertDocumentChunks: NonNullable<IMemoryStore["insertDocumentChunks"]>;
  getDocumentChunks: NonNullable<IMemoryStore["getDocumentChunks"]>;
  deleteDocumentChunks: NonNullable<IMemoryStore["deleteDocumentChunks"]>;
} {
  if (!store) throw new DocumentServiceError("unsupported_store", "Store not available");
  const need = ["upsertDocument", "getDocument", "findDocuments", "deleteDocument", "insertDocumentChunks", "getDocumentChunks", "deleteDocumentChunks"] as const;
  for (const m of need) {
    if (typeof store[m] !== "function") {
      throw new DocumentServiceError("unsupported_store", `Store backend does not implement ${m} (document source unsupported on this backend)`);
    }
  }
  return store as never;
}

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf-8").digest("hex");
}

function shortUuid(): string {
  return randomUUID().replace(/-/g, "").slice(0, 12);
}

/** 隔离四元组匹配：身份判定命中后还须同租户，防止跨租户升版劫持。 */
function sameIsolation(doc: DocumentRecord, teamId?: string, userId?: string, agentId?: string): boolean {
  const t = teamId || "default";
  const u = userId || "default";
  const a = agentId || "default";
  return doc.team_id === t && doc.user_id === u && doc.agent_id === a;
}

/**
 * 导入（或重导）一份 md 文档。
 *
 * 身份 = (title, callerRef) + 隔离四元组。命中旧版：
 *   - content_sha256 相同 → 去重返回；
 *   - 不同 → version = max(old)+1，级联删除旧版 L0/L1/chunks/登记行后重建。
 */
export async function importDocument(
  deps: DocumentServiceDeps,
  params: ImportDocumentParams,
): Promise<ImportDocumentResult> {
  const store = requireDocumentStore(deps.getStore());
  const logger = deps.logger;

  const title = (params.title ?? "").trim();
  const callerRef = (params.callerRef ?? "").trim();
  if (!title) throw new DocumentServiceError("invalid_argument", "title is required");
  if (!callerRef) throw new DocumentServiceError("invalid_argument", "caller_ref is required");
  if (typeof params.markdown !== "string" || params.markdown.trim().length === 0) {
    throw new DocumentServiceError("invalid_argument", "markdown must be a non-empty string");
  }

  const contentSha = sha256(params.markdown);
  const teamId = params.teamId || "default";
  const userId = params.userId || "default";
  const agentId = params.agentId || "default";

  // ── 身份判定 ──
  const candidates = await store.findDocuments({
    callerRef, title,
    teamId: undefined, userId: undefined, agentId: undefined, // 身份键不含租户，先全取再按租户过滤
  });
  const mine = candidates.filter((d) => sameIsolation(d, teamId, userId, agentId));
  const latest = mine.reduce<DocumentRecord | null>(
    (acc, d) => (!acc || d.version > acc.version ? d : acc),
    null,
  );

  if (latest && latest.content_sha256 === contentSha) {
    logger?.info?.(`${TAG} dedup hit: title="${title}" caller_ref=${callerRef} v${latest.version}`);
    return { document: latest, deduplicated: true, replacedVersions: 0, acceptedChunks: latest.chunk_count };
  }

  const version = latest ? latest.version + 1 : 1;

  // ── 升版：级联清除旧版记忆 ──
  let replacedVersions = 0;
  for (const old of mine) {
    try {
      await purgeDocumentMemories(store, old, logger);
      replacedVersions++;
    } catch (err) {
      // 级联清除失败不阻断导入：旧 L0 会因 session_id 不同而互不干扰，
      // 但会成为孤儿数据 —— 打 warn 留痕。
      logger?.warn?.(
        `${TAG} purge old version failed (doc=${old.document_id} v${old.version}): ` +
        `${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  // ── 分块 ──
  const { chunks, error } = chunkMarkdown(params.markdown, title);
  if (error || chunks.length === 0) {
    throw new DocumentServiceError("too_large", error ?? "document produced no chunks");
  }

  // ── 落 L0（与会话链路同构：role=user + 内联 embedding）──
  const documentId = `doc-${shortUuid()}`;
  const sessionId = documentSessionId(documentId, version);
  const embedding = deps.getEmbedding();
  const baseMs = Date.now();

  const acceptedRecords: L0Record[] = [];
  for (const [index, chunk] of chunks.entries()) {
    const id = `msg-${shortUuid()}`;
    const recordedAtMs = baseMs + index;
    const record: L0Record = {
      id,
      sessionKey: sessionId,
      sessionId,
      taskId: params.taskId,
      teamId,
      userId,
      agentId,
      role: "user",
      messageText: chunk.text,
      recordedAt: new Date(recordedAtMs).toISOString(),
      timestamp: recordedAtMs,
      sourceKind: "document",
      sourceRef: documentId,
    };

    let emb: Float32Array | undefined;
    if (embedding) {
      try {
        emb = await embedding.embed(chunk.text);
      } catch (err) {
        logger?.warn?.(`${TAG} chunk embedding failed (non-fatal, meta-only write): ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    const ok = await store.upsertL0(record, emb);
    if (ok) acceptedRecords.push(record);
  }

  if (acceptedRecords.length === 0) {
    throw new DocumentServiceError("unsupported_store", "all chunk L0 writes failed");
  }

  // ── 分块锚点 ──
  const chunkRows: DocumentChunkRow[] = [];
  const acceptedSet = new Set(acceptedRecords.map((r) => r.id));
  for (const [index, chunk] of chunks.entries()) {
    const messageId = chunkMessageId(acceptedRecords, chunks, index);
    if (!acceptedSet.has(messageId)) continue;
    chunkRows.push({
      document_id: documentId,
      chunk_index: chunk.index,
      message_id: messageId,
      heading_path: chunk.heading_path,
      line_start: chunk.line_start,
      line_end: chunk.line_end,
    });
  }
  await store.insertDocumentChunks(chunkRows);

  // ── 登记行 ──
  const now = new Date().toISOString();
  const document: DocumentRecord = {
    document_id: documentId,
    title,
    caller_ref: callerRef,
    content_sha256: contentSha,
    version,
    session_id: sessionId,
    chunk_count: chunkRows.length,
    team_id: teamId,
    user_id: userId,
    agent_id: agentId,
    created_at: now,
    updated_at: now,
  };
  const upsertOk = await store.upsertDocument(document);
  if (!upsertOk) {
    logger?.warn?.(`${TAG} document registry upsert failed (doc=${documentId}); L0/chunks already persisted`);
  }

  // ── 触发 L1 提炼（warmup 阈值 1 → 首次导入立即提炼）──
  if (deps.notify) {
    try {
      await deps.notify(sessionId, chunkRows.length, teamId, agentId);
    } catch (err) {
      logger?.warn?.(`${TAG} pipeline notify failed for ${sessionId}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  logger?.info?.(
    `${TAG} imported doc=${documentId} title="${title}" v${version} chunks=${chunkRows.length} ` +
    `(replaced ${replacedVersions} old version(s), dedup=false)`,
  );

  return { document, deduplicated: false, replacedVersions, acceptedChunks: chunkRows.length };
}

/**
 * 块 → L0 message_id 映射：导入循环按 chunks 顺序写 L0，
 * acceptedRecords 与 chunks 前 acceptedChunks.length 项一一对应（跳过失败块会破坏
 * 对应关系，因此 upsertL0 失败时该块锚点直接缺位，溯源降级到块序号）。
 */
function chunkMessageId(acceptedRecords: L0Record[], chunks: { text: string }[], index: number): string {
  const record = acceptedRecords[index];
  if (record) return record.id;
  // 对应位写入失败：按文本回找一次（前缀不同块的文本不同，可精确定位）。
  const hit = acceptedRecords.find((r) => r.messageText === chunks[index]?.text);
  return hit ? hit.id : "";
}

/** 删除一份文档登记及其全部派生记忆（L0 会话 + L1 原子 + 分块锚点 + 登记行）。 */
export async function deleteDocument(
  deps: DocumentServiceDeps,
  documentId: string,
): Promise<DocumentRecord> {
  const store = requireDocumentStore(deps.getStore());
  const logger = deps.logger;

  const doc = await store.getDocument(documentId);
  if (!doc) throw new DocumentServiceError("not_found", `document not found: ${documentId}`);

  await purgeDocumentMemories(store, doc, logger);
  logger?.info?.(`${TAG} deleted doc=${documentId} title="${doc.title}" v${doc.version}`);
  return doc;
}

/** 级联清除单份文档版本的记忆数据。 */
async function purgeDocumentMemories(
  store: IMemoryStore,
  doc: DocumentRecord,
  logger?: Logger,
): Promise<void> {
  // L0：整会话删除（含 vec/fts 附属行）。
  try {
    await store.deleteL0BySession?.(doc.session_id, {
      teamId: doc.team_id,
      userId: doc.user_id,
      agentId: doc.agent_id,
    });
  } catch (err) {
    logger?.warn?.(`[memory-tdai][document] deleteL0BySession failed for ${doc.session_id}: ${err instanceof Error ? err.message : String(err)}`);
  }

  // L1：按文档会话查全量原子再批量删。
  try {
    const rows = await store.queryL1Records({ sessionId: doc.session_id });
    if (rows.length > 0) {
      await store.deleteL1Batch(
        rows.map((r) => r.record_id),
        { teamId: doc.team_id, userId: doc.user_id, agentId: doc.agent_id },
      );
    }
  } catch (err) {
    logger?.warn?.(`[memory-tdai][document] L1 cascade delete failed for ${doc.session_id}: ${err instanceof Error ? err.message : String(err)}`);
  }

  // 锚点 + 登记行。
  await store.deleteDocumentChunks?.(doc.document_id);
  await store.deleteDocument?.(doc.document_id);
}

/** 文档详情（登记行 + 分块锚点；正文由调用方按 message_id 走 getL0RecordsByIds 取）。 */
export async function getDocumentDetail(
  deps: DocumentServiceDeps,
  documentId: string,
): Promise<{ document: DocumentRecord; chunks: DocumentChunkRow[] }> {
  const store = requireDocumentStore(deps.getStore());
  const doc = await store.getDocument(documentId);
  if (!doc) throw new DocumentServiceError("not_found", `document not found: ${documentId}`);
  const chunks = await store.getDocumentChunks(documentId);
  return { document: doc, chunks };
}

/** 文档列表（按隔离过滤）。 */
export async function listDocuments(
  deps: DocumentServiceDeps,
  filter: DocumentQueryFilter,
): Promise<DocumentRecord[]> {
  const store = requireDocumentStore(deps.getStore());
  return store.findDocuments(filter);
}
