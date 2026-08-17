/**
 * /v3/document/* 请求 schema（fork 文档子系统）。
 *
 * 约定：
 *   - import 需要 team_id + user_id + agent_id（module 自行校验，不走 /v3 数据面
 *     的 collectV3Missing —— document 路由是 extraRouteTable 管理面入口）。
 *   - markdown 体积上限由 document-service 校验（MAX_DOCUMENT_CHARS → 413），
 *     schema 只保证非空字符串。
 */

import { z } from "zod";

export const documentImportRequestSchema = z.strictObject({
  /** 文档标题（身份键之一，与 caller_ref 联合判重升版）。 */
  title: z.string().trim().min(1).max(512),
  /** 文档正文（md）。内容随请求过境，原文不落盘 MemoryCore。 */
  markdown: z.string().min(1),
  /** 调用方引用（EverRoom 侧为知识资产 file_id）。身份键之一。 */
  caller_ref: z.string().trim().min(1).max(512),
  /** 隔离三元组：与召回隔离对齐（必填）。 */
  team_id: z.string().trim().min(1).max(256),
  user_id: z.string().trim().min(1).max(256),
  agent_id: z.string().trim().min(1).max(256),
  task_id: z.string().trim().min(1).max(256).optional(),
}).superRefine((value, ctx) => {
  if (value.markdown.length > 2 * 1024 * 1024) {
    ctx.addIssue({ code: "custom", path: ["markdown"], message: "markdown exceeds 2MB limit" });
  }
});
export type DocumentImportRequest = z.infer<typeof documentImportRequestSchema>;

export const documentDeleteRequestSchema = z.strictObject({
  document_id: z.string().trim().min(1).max(128),
});
export type DocumentDeleteRequest = z.infer<typeof documentDeleteRequestSchema>;

export const documentGetRequestSchema = z.strictObject({
  document_id: z.string().trim().min(1).max(128),
});
export type DocumentGetRequest = z.infer<typeof documentGetRequestSchema>;

const queryInt = (min: number, max: number, fallback: number) => z.preprocess(
  (value) => value === undefined || value === "" ? fallback : Number(value),
  z.number().int().min(min).max(max),
);

export const documentListRequestSchema = z.strictObject({
  team_id: z.string().trim().min(1).max(256).optional(),
  user_id: z.string().trim().min(1).max(256).optional(),
  agent_id: z.string().trim().min(1).max(256).optional(),
  limit: queryInt(1, 200, 50),
  offset: queryInt(0, 1_000_000, 0),
});
export type DocumentListRequest = z.infer<typeof documentListRequestSchema>;
