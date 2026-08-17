/**
 * Markdown 标题感知分块器（纯函数，无 IO）。
 *
 * 规则（EverRoom docs/memory-md-source-plan.md §5.1）：
 *   - 按 ATX 标题（## 及更深；文档首 # 视为文档题名并入路径）切分小节；
 *   - 单块目标 ≤ MAX_CHUNK_CHARS，硬上限 MAX_CHUNK_HARD（含前缀）；
 *   - 超长小节内部按空行段落二切；
 *   - 块首带标题路径前缀【{title} > {heading_path}】，让每块自含位置语境；
 *   - 记录行区间（1-based，含端点）供溯源高亮。
 */

import {
  MAX_CHUNK_CHARS,
  MAX_CHUNK_HARD,
  MAX_DOCUMENT_CHARS,
  MAX_DOCUMENT_CHUNKS,
  type DocumentChunk,
} from "./types.js";

// ============================
// Section scanning
// ============================

interface Section {
  /** 不含文档题名的标题路径（如 "环境准备 > 依赖"），可为空串。 */
  headingPath: string;
  /** 小节正文（不含标题行本身；标题信息已入 headingPath）。 */
  body: string;
  lineStart: number; // 1-based，含标题行
  lineEnd: number; // 1-based，含端点
}

const ATX_RE = /^(#{1,6})\s+(.*)$/;

/** 把 md 切成带标题路径的小节。无标题的前言成一个 path="" 的小节。 */
function splitSections(markdown: string): Section[] {
  const lines = markdown.split(/\r?\n/);
  const sections: Section[] = [];
  // 标题栈：level → 标题文本。文档首 # 通常与 title 重复，遇到 level-1 时视为
  // 章级重置而非路径根（title 已由前缀携带）。
  const stack: string[] = [];
  let current: Section | null = null;

  const pushCurrent = (endLine: number) => {
    if (current && current.body.trim().length > 0) {
      // 末尾空行不计入区间：body 已 trim，行区间与之对齐，溯源高亮不虚标空行。
      let last = endLine;
      while (last > current.lineStart && lines[last - 1].trim() === "") last--;
      current.lineEnd = Math.max(current.lineStart, last);
      current.body = current.body.replace(/\s+$/, "");
      sections.push(current);
    }
    current = null;
  };

  for (let i = 0; i < lines.length; i++) {
    const m = ATX_RE.exec(lines[i]);
    if (m) {
      pushCurrent(i); // 上一小节在第 i 行（标题行）前结束
      const level = m[1].length;
      const text = m[2].trim();
      stack.length = Math.min(stack.length, level - 1);
      stack[level - 1] = text;
      stack.length = level;
      current = {
        headingPath: stack.filter(Boolean).join(" > "),
        body: "",
        lineStart: i + 1,
        lineEnd: i + 1,
      };
    } else if (current) {
      current.body += (current.body ? "\n" : "") + lines[i];
    } else if (lines[i].trim().length > 0 || sections.length === 0) {
      // 标题前的前言：直到首个标题行为止合成一节
      current = { headingPath: "", body: lines[i], lineStart: i + 1, lineEnd: i + 1 };
    }
  }
  pushCurrent(lines.length);

  return sections;
}

// ============================
// Section → chunks
// ============================

/** 段落二切超长小节；返回的每段都带各自的行区间。 */
function splitSectionByParagraph(section: Section, budget: number): Array<{ body: string; lineStart: number; lineEnd: number }> {
  // 以空行为界切段落，保留原文行数信息：用行的索引重组。
  // 这里复用 body 行列表——先按行拆开，再按空行分组。
  const bodyLines = section.body.split("\n");
  // lineStart 指向正文首行（标题行 +1，因为 body 不含标题行）
  const firstBodyLine = section.lineStart + 1;

  const paragraphs: Array<{ lines: string[]; startLine: number }> = [];
  let buf: string[] = [];
  let bufStart = firstBodyLine;
  for (let i = 0; i < bodyLines.length; i++) {
    const line = bodyLines[i];
    if (line.trim() === "" && buf.length > 0) {
      paragraphs.push({ lines: [...buf], startLine: bufStart });
      buf = [];
      bufStart = firstBodyLine + i + 1;
    } else {
      if (buf.length === 0) bufStart = firstBodyLine + i;
      buf.push(line);
    }
  }
  if (buf.length > 0) paragraphs.push({ lines: buf, startLine: bufStart });

  if (paragraphs.length === 0) {
    return [{ body: section.body, lineStart: section.lineStart, lineEnd: section.lineEnd }];
  }

  const out: Array<{ body: string; lineStart: number; lineEnd: number }> = [];
  let acc: string[] = [];
  let accStart = paragraphs[0].startLine;
  let accEnd = accStart;
  const flush = () => {
    if (acc.length === 0) return;
    out.push({ body: acc.join("\n"), lineStart: accStart, lineEnd: accEnd });
    acc = [];
  };
  for (const p of paragraphs) {
    const candidate = acc.length === 0 ? p.lines : [...acc, "", ...p.lines];
    if (candidate.join("\n").length > budget && acc.length > 0) {
      flush();
      acc = [...p.lines];
      accStart = p.startLine;
      accEnd = p.startLine + p.lines.length - 1;
    } else {
      if (acc.length === 0) accStart = p.startLine;
      acc = candidate;
      accEnd = p.startLine + p.lines.length - 1;
    }
    // 单段超预算：硬切（保底前进，防死循环）
    if (acc.join("\n").length > MAX_CHUNK_HARD) {
      const joined = acc.join("\n");
      for (let s = 0; s < joined.length; s += budget) {
        out.push({ body: joined.slice(s, s + budget), lineStart: accStart, lineEnd: accEnd });
      }
      acc = [];
    }
  }
  flush();
  return out.length > 0 ? out : [{ body: section.body, lineStart: section.lineStart, lineEnd: section.lineEnd }];
}

// ============================
// Public API
// ============================

export interface ChunkMarkdownResult {
  chunks: DocumentChunk[];
  /** 分块失败原因（超上限等），非空时 chunks 为空。 */
  error?: string;
}

/**
 * 把 md 原文切成带标题路径前缀的块。
 *
 * @param markdown 原文
 * @param title    文档标题（进前缀与 L2 场景命名）
 */
export function chunkMarkdown(markdown: string, title: string): ChunkMarkdownResult {
  if (typeof markdown !== "string" || markdown.length === 0) {
    return { chunks: [], error: "markdown must be a non-empty string" };
  }
  if (markdown.length > MAX_DOCUMENT_CHARS) {
    return { chunks: [], error: `document exceeds size limit (${markdown.length} chars > ${MAX_DOCUMENT_CHARS})` };
  }

  const sections = splitSections(markdown);
  const chunks: DocumentChunk[] = [];

  for (const section of sections) {
    const prefixBody = section.headingPath ? `${title} > ${section.headingPath}` : title;
    const prefix = `【${prefixBody}】\n\n`;
    const budget = Math.max(1000, MAX_CHUNK_CHARS - prefix.length);

    const pieces = section.body.length + prefix.length > MAX_CHUNK_HARD
      ? splitSectionByParagraph(section, budget)
      : [{ body: section.body, lineStart: section.lineStart, lineEnd: section.lineEnd }];

    for (const piece of pieces) {
      const text = `${prefix}${piece.body}`;
      if (text.length > MAX_CHUNK_HARD) {
        // 段落硬切兜底（理论上 splitSectionByParagraph 已保证，防御性再切）
        for (let s = 0; s < piece.body.length; s += budget) {
          chunks.push({
            index: chunks.length,
            text: `${prefix}${piece.body.slice(s, s + budget)}`,
            heading_path: section.headingPath,
            line_start: piece.lineStart,
            line_end: piece.lineEnd,
          });
        }
        continue;
      }
      chunks.push({
        index: chunks.length,
        text,
        heading_path: section.headingPath,
        line_start: piece.lineStart,
        line_end: piece.lineEnd,
      });
    }
  }

  if (chunks.length === 0) {
    return { chunks: [], error: "document produced no chunks (empty after sectioning)" };
  }
  if (chunks.length > MAX_DOCUMENT_CHUNKS) {
    return { chunks: [], error: `document exceeds chunk limit (${chunks.length} > ${MAX_DOCUMENT_CHUNKS})` };
  }
  return { chunks };
}
