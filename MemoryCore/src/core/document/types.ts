/**
 * Document source subsystem — types.
 *
 * md 文档是与会话并列的一等记忆来源（fork 特性，见 EverRoom
 * docs/memory-md-source-plan.md）。文档经标题感知分块后以 role=user 消息
 * 写入 L0（session_id = memdoc:<documentId>:v<n>），走既有提炼管道产出
 * L1 原子；来源标记（source_kind/source_ref）随 L0/L1 行持久化，支撑
 * 正反向记忆溯源。
 *
 * 边界（用户拍板）：原文不落 MemoryCore。导入请求内容随体过境，仅持久化
 * 登记行的 caller_ref（内容链接）与 content_sha256（判重）；原文归调用方
 * 资产层（如 EverRoom 知识资产层）所有。
 */

// ============================
// Constants
// ============================

/** 单块目标长度（字符）。块首标题路径前缀占用额度，硬上限见 MAX_CHUNK_HARD。 */
export const MAX_CHUNK_CHARS = 6000;

/** 单块硬上限（与 L0 conversation/add 的 8192 字符约束对齐，含前缀）。 */
export const MAX_CHUNK_HARD = 8192;

/** 原文长度上限（字符）。 */
export const MAX_DOCUMENT_CHARS = 2 * 1024 * 1024;

/** 分块数量上限。 */
export const MAX_DOCUMENT_CHUNKS = 2000;

/** 文档会话 id 前缀。 */
export const DOCUMENT_SESSION_PREFIX = "memdoc:";

// ============================
// Source stamp
// ============================

/** L0/L1 行的来源标记。conversation 为存量默认语义。 */
export interface MemorySource {
  /** "conversation" | "document" */
  kind: string;
  /** document 时为 document_id。 */
  ref?: string;
  /** document 时为文档标题（仅用于 LLM prompt 场景框架，不持久化单独列）。 */
  title?: string;
}

// ============================
// Document registry
// ============================

/** documents 登记行。 */
export interface DocumentRecord {
  /** doc-<uuid前12位> */
  document_id: string;
  title: string;
  /** 内容链接（如 EverRoom uploaded_files.id），溯源跳转用，可空。 */
  caller_ref: string;
  /** 导入时对请求体计算，仅用于判重（不存原文）。 */
  content_sha256: string;
  /** 从 1 起，重导递增。 */
  version: number;
  /** memdoc:<documentId>:v<n> */
  session_id: string;
  chunk_count: number;
  team_id: string;
  user_id: string;
  agent_id: string;
  created_at: string;
  updated_at: string;
}

/** document_chunks 登记行（L0 溯源锚点）。 */
export interface DocumentChunkRow {
  document_id: string;
  chunk_index: number;
  /** 对应 L0 record_id（正向溯源锚点）。 */
  message_id: string;
  /** "部署手册 > 环境准备 > 依赖" */
  heading_path: string;
  line_start: number;
  line_end: number;
}

/** 分块器输出的中间结构（写 L0 前）。 */
export interface DocumentChunk {
  index: number;
  /** 含标题路径前缀的最终文本（写入 L0 message_text 的内容）。 */
  text: string;
  heading_path: string;
  line_start: number;
  line_end: number;
}

/** findDocuments 过滤条件（全部可选；隔离字段 camelCase 与 L0/L1 filter 对齐）。 */
export interface DocumentQueryFilter {
  documentId?: string;
  title?: string;
  callerRef?: string;
  teamId?: string;
  userId?: string;
  agentId?: string;
  limit?: number;
  offset?: number;
}

// ============================
// Helpers
// ============================

/** 构造文档会话 id。 */
export function documentSessionId(documentId: string, version: number): string {
  return `${DOCUMENT_SESSION_PREFIX}${documentId}:v${version}`;
}

/** 判断会话 id 是否文档会话。 */
export function isDocumentSession(sessionId: string): boolean {
  return sessionId.startsWith(DOCUMENT_SESSION_PREFIX);
}

/** 从文档会话 id 解析 document_id（解析失败返回 null）。 */
export function parseDocumentSessionId(sessionId: string): { documentId: string; version: number } | null {
  if (!sessionId.startsWith(DOCUMENT_SESSION_PREFIX)) return null;
  const rest = sessionId.slice(DOCUMENT_SESSION_PREFIX.length);
  const match = rest.match(/^(.+):v(\d+)$/);
  if (!match) return null;
  return { documentId: match[1], version: Number(match[2]) };
}
