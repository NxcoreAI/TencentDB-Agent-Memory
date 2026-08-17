/**
 * /v3/document/* 路由（fork 文档子系统）。
 *
 * extraRouteTable 模块入口（同 skill/knowledge/memory-generation-log）：
 * 每个模块自带 schema 校验与 deps 视图（`deps: unknown` → 本模块的 DocumentDeps），
 * 由 server.ts 把 V2RouterDeps（含 per-request resolve 后的 store/embedding）
 * 作为合并 deps 传入。HTTP 语义：
 *   - import POST、delete POST、get GET|POST、list GET|POST
 *   - DocumentServiceError.code → {unsupported_store:503, invalid_argument:400,
 *     too_large:413, not_found:404}
 *
 * get/list 附带派生 L1（queryL1Records({sourceRef})）与块正文
 * （getL0RecordsByIds），供 UI 直接渲染溯源，不必二次调用 conversation/query。
 */

import type { ZodError } from "zod";

import { errorEnvelope, successEnvelope } from "./v2-router.js";
import type { ApiResponseEnvelope, V2AuthContext } from "./v2-schemas.js";
import type { IMemoryStore } from "../core/store/types.js";
import type { EmbeddingService } from "../core/store/embedding.js";
import type { Logger } from "../core/types.js";
import type { DocumentRecord } from "../core/document/types.js";
import {
  DocumentServiceError,
  deleteDocument,
  getDocumentDetail,
  importDocument,
  listDocuments,
} from "../core/document/document-service.js";
import {
  documentDeleteRequestSchema,
  documentGetRequestSchema,
  documentImportRequestSchema,
  documentListRequestSchema,
} from "./document-schemas.js";

interface DocumentDeps {
  getStore?: () => IMemoryStore | undefined;
  getEmbedding?: () => EmbeddingService | undefined;
  /** 与 V2RouterDeps.notifyPipeline 同形：serviceId 由调用方闭包绑定。 */
  notifyPipeline?: (
    instanceId: string,
    sessionId: string,
    rounds: number,
    teamId?: string,
    agentId?: string,
  ) => Promise<void>;
  /** V2RouterDeps.logger 视图（合并 deps 透传）。 */
  logger?: Logger;
}

function formatZodErr(error: ZodError): string {
  return error.issues.map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`).join("; ");
}

/** DocumentServiceError.code → HTTP status；非本模块错误向上抛给 classifyError。 */
const DOCUMENT_ERROR_STATUS: Record<DocumentServiceError["code"], number> = {
  unsupported_store: 503,
  invalid_argument: 400,
  too_large: 413,
  not_found: 404,
};

function toDocumentErrorResponse(err: unknown, requestId: string): ApiResponseEnvelope | null {
  if (err instanceof DocumentServiceError) {
    const status = DOCUMENT_ERROR_STATUS[err.code] ?? 500;
    return errorEnvelope(status, err.message, requestId);
  }
  return null;
}

/** 对外登记行视图（snake_case 原样 + 派生记忆数在 list/get 时补）。 */
function documentView(doc: DocumentRecord, derivedCount?: number): Record<string, unknown> {
  return {
    document_id: doc.document_id,
    title: doc.title,
    caller_ref: doc.caller_ref,
    version: doc.version,
    session_id: doc.session_id,
    chunk_count: doc.chunk_count,
    team_id: doc.team_id,
    user_id: doc.user_id,
    agent_id: doc.agent_id,
    created_at: doc.created_at,
    updated_at: doc.updated_at,
    ...(derivedCount !== undefined ? { derived_memory_count: derivedCount } : {}),
  };
}

async function countDerivedMemories(
  store: IMemoryStore,
  doc: DocumentRecord,
): Promise<number | undefined> {
  try {
    return await store.countL1({
      sourceRef: doc.document_id,
      teamId: doc.team_id,
      userId: doc.user_id,
      agentId: doc.agent_id,
    });
  } catch {
    return undefined; // best-effort：countL1 不支持 sourceRef 时略过
  }
}

async function handleImport(body: unknown, auth: V2AuthContext, requestId: string, rawDeps: unknown): Promise<ApiResponseEnvelope> {
  const parsed = documentImportRequestSchema.safeParse(body);
  if (!parsed.success) return errorEnvelope(400, formatZodErr(parsed.error), requestId);
  const deps = rawDeps as DocumentDeps;
  const store = deps.getStore?.();
  if (!store) return errorEnvelope(503, "Store not available", requestId);
  const { title, markdown, caller_ref, team_id, user_id, agent_id, task_id } = parsed.data;

  const serviceDeps = {
    getStore: () => store,
    getEmbedding: () => deps.getEmbedding?.(),
    notify: deps.notifyPipeline
      ? (sessionId: string, rounds: number, teamId?: string, agentId?: string) =>
          deps.notifyPipeline!(auth.serviceId, sessionId, rounds, teamId, agentId)
      : undefined,
    logger: deps.logger,
  };

  try {
    const result = await importDocument(serviceDeps, {
      title,
      markdown,
      callerRef: caller_ref,
      teamId: team_id,
      userId: user_id,
      agentId: agent_id,
      taskId: task_id,
    });
    return successEnvelope({
      document: documentView(result.document, result.deduplicated ? undefined : 0),
      document_id: result.document.document_id,
      version: `v${result.document.version}`,
      session_id: result.document.session_id,
      chunk_count: result.document.chunk_count,
      deduplicated: result.deduplicated,
      replaced_versions: result.replacedVersions,
      accepted_chunks: result.acceptedChunks,
    }, requestId);
  } catch (err) {
    const envelope = toDocumentErrorResponse(err, requestId);
    if (envelope) return envelope;
    throw err;
  }
}

async function handleDelete(body: unknown, _auth: V2AuthContext, requestId: string, rawDeps: unknown): Promise<ApiResponseEnvelope> {
  const parsed = documentDeleteRequestSchema.safeParse(body);
  if (!parsed.success) return errorEnvelope(400, formatZodErr(parsed.error), requestId);
  const deps = rawDeps as DocumentDeps;
  const store = deps.getStore?.();
  if (!store) return errorEnvelope(503, "Store not available", requestId);

  try {
    const doc = await deleteDocument({ getStore: () => store, getEmbedding: () => undefined, logger: deps.logger }, parsed.data.document_id);
    deps.logger?.info?.(`[v3/document] deleted document=${doc.document_id} cascaded (L0/L1/chunks)`);
    return successEnvelope({ document_id: doc.document_id, deleted: true }, requestId);
  } catch (err) {
    const envelope = toDocumentErrorResponse(err, requestId);
    if (envelope) return envelope;
    throw err;
  }
}

async function handleGet(body: unknown, _auth: V2AuthContext, requestId: string, rawDeps: unknown): Promise<ApiResponseEnvelope> {
  const parsed = documentGetRequestSchema.safeParse(body);
  if (!parsed.success) return errorEnvelope(400, formatZodErr(parsed.error), requestId);
  const deps = rawDeps as DocumentDeps;
  const store = deps.getStore?.();
  if (!store) return errorEnvelope(503, "Store not available", requestId);

  try {
    const { document, chunks } = await getDocumentDetail({ getStore: () => store, getEmbedding: () => undefined }, parsed.data.document_id);

    // 块正文（正向溯源预览）：按 L0 主键批量取，缺失（已清理/降级）时留空。
    const messageIds = chunks.map((c) => c.message_id);
    let rowsById = new Map<string, { role: string; message_text: string; recorded_at: string }>();
    if (messageIds.length > 0 && store.getL0RecordsByIds) {
      try {
        const records = await store.getL0RecordsByIds(messageIds);
        rowsById = new Map(records.map((r) => [r.record_id, { role: r.role, message_text: r.message_text, recorded_at: r.recorded_at }]));
      } catch (err) {
        deps.logger?.warn?.(`[v3/document] getL0RecordsByIds failed for ${document.document_id}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    const chunkViews = chunks.map((c) => {
      const l0 = rowsById.get(c.message_id);
      return {
        chunk_index: c.chunk_index,
        message_id: c.message_id,
        heading_path: c.heading_path,
        line_start: c.line_start,
        line_end: c.line_end,
        content: l0?.message_text ?? "",
        recorded_at: l0?.recorded_at,
      };
    });

    // 派生 L1 列表（反向溯源入口）。
    let memories: Array<Record<string, unknown>> = [];
    try {
      const records = await store.queryL1Records({
        sourceRef: document.document_id,
        teamId: document.team_id,
        userId: document.user_id,
        agentId: document.agent_id,
      });
      memories = records.map((r) => ({
        id: r.record_id,
        type: r.type,
        content: r.content,
        priority: r.priority,
        background: r.scene_name || undefined,
        source_message_ids: safeParseIds(r.source_message_ids_json),
        created_at: r.created_time,
        updated_at: r.updated_time,
      }));
    } catch (err) {
      deps.logger?.warn?.(`[v3/document] queryL1Records failed for ${document.document_id}: ${err instanceof Error ? err.message : String(err)}`);
    }

    return successEnvelope({
      document: documentView(document, memories.length),
      chunks: chunkViews,
      memories,
    }, requestId);
  } catch (err) {
    const envelope = toDocumentErrorResponse(err, requestId);
    if (envelope) return envelope;
    throw err;
  }
}

async function handleList(body: unknown, _auth: V2AuthContext, requestId: string, rawDeps: unknown): Promise<ApiResponseEnvelope> {
  const parsed = documentListRequestSchema.safeParse(body);
  if (!parsed.success) return errorEnvelope(400, formatZodErr(parsed.error), requestId);
  const deps = rawDeps as DocumentDeps;
  const store = deps.getStore?.();
  if (!store) return errorEnvelope(503, "Store not available", requestId);
  const { team_id, user_id, agent_id, limit, offset } = parsed.data;

  try {
    const documents = await listDocuments(
      { getStore: () => store, getEmbedding: () => undefined },
      { teamId: team_id, userId: user_id, agentId: agent_id, limit, offset },
    );
    const items = await Promise.all(documents.map(async (doc) => documentView(doc, await countDerivedMemories(store, doc))));
    return successEnvelope({ documents: items, total: items.length, limit, offset }, requestId);
  } catch (err) {
    const envelope = toDocumentErrorResponse(err, requestId);
    if (envelope) return envelope;
    throw err;
  }
}

function safeParseIds(json: string | undefined): string[] {
  if (!json) return [];
  try {
    const parsed = JSON.parse(json);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

type RouteHandler = (body: unknown, auth: V2AuthContext, requestId: string, deps: unknown) => Promise<ApiResponseEnvelope>;

export function makeDocumentRouteTable(): Record<string, RouteHandler> {
  return {
    "/v3/document/import": handleImport,
    "/v3/document/delete": handleDelete,
    "/v3/document/get": handleGet,
    "/v3/document/list": handleList,
  };
}
