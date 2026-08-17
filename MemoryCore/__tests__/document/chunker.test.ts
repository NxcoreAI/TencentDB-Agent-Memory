/**
 * chunker 纯函数测试（fork 文档子系统）。
 *
 * 覆盖：标题路径切分、前缀格式、行区间、段落二切、硬上限、参数错误。
 */

import { describe, expect, it } from "vitest";

import { chunkMarkdown } from "../../src/core/document/chunker.js";
import {
  MAX_CHUNK_HARD,
  MAX_DOCUMENT_CHARS,
} from "../../src/core/document/types.js";

describe("chunkMarkdown", () => {
  it("按标题层级切分并生成嵌套 heading_path", () => {
    const md = [
      "## 环境",      // line 1
      "准备依赖。",    // line 2
      "",             // line 3
      "### Linux",    // line 4
      "apt-get 安装。", // line 5
    ].join("\n");

    const { chunks, error } = chunkMarkdown(md, "部署手册");
    expect(error).toBeUndefined();
    expect(chunks).toHaveLength(2);

    expect(chunks[0].heading_path).toBe("环境");
    expect(chunks[0].line_start).toBe(1);
    expect(chunks[0].line_end).toBe(2);
    expect(chunks[0].text).toBe("【部署手册 > 环境】\n\n准备依赖。");

    expect(chunks[1].heading_path).toBe("环境 > Linux");
    expect(chunks[1].line_start).toBe(4);
    expect(chunks[1].text).toContain("apt-get 安装。");
  });

  it("文档首 # 进入路径（title 由前缀另行携带）", () => {
    const md = "# 手册\n\n## 安装\n执行安装。\n";
    const { chunks } = chunkMarkdown(md, "手册");
    // # 手册 小节正文为空被丢弃；## 安装 path = "手册 > 安装"
    expect(chunks).toHaveLength(1);
    expect(chunks[0].heading_path).toBe("手册 > 安装");
    expect(chunks[0].text.startsWith("【手册 > 手册 > 安装】")).toBe(true);
  });

  it("无标题前言成独立小节，前缀仅含 title", () => {
    const md = "开头说明文字。\n\n## 正文\n内容。\n";
    const { chunks } = chunkMarkdown(md, "T");
    expect(chunks).toHaveLength(2);
    expect(chunks[0].heading_path).toBe("");
    expect(chunks[0].text).toBe("【T】\n\n开头说明文字。");
    expect(chunks[0].line_start).toBe(1);
  });

  it("超长小节按段落二切：块数 > 1、全部 ≤ 硬上限、index 连续", () => {
    const paragraph = "x".repeat(3000);
    const md = `## 大节\n\n${paragraph}\n\n${paragraph}\n\n${paragraph}\n\n${paragraph}\n\n${paragraph}\n`;
    const { chunks, error } = chunkMarkdown(md, "大文档");
    expect(error).toBeUndefined();
    expect(chunks.length).toBeGreaterThan(1);
    for (const [i, c] of chunks.entries()) {
      expect(c.index).toBe(i);
      expect(c.text.length).toBeLessThanOrEqual(MAX_CHUNK_HARD);
      expect(c.heading_path).toBe("大节");
      expect(c.text.startsWith("【大文档 > 大节】")).toBe(true);
    }
  });

  it("空输入与超限输入返回 error", () => {
    expect(chunkMarkdown("", "T").error).toMatch(/non-empty/);
    const huge = "x".repeat(MAX_DOCUMENT_CHARS + 1);
    const r = chunkMarkdown(huge, "T");
    expect(r.error).toMatch(/exceeds size limit/);
    expect(r.chunks).toHaveLength(0);
  });

  it("纯文本无标题文档切成单块", () => {
    const { chunks } = chunkMarkdown("一段没有任何标题的正文。", "笔记");
    expect(chunks).toHaveLength(1);
    expect(chunks[0].heading_path).toBe("");
    expect(chunks[0].text).toBe("【笔记】\n\n一段没有任何标题的正文。");
  });
});
