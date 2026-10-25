import { normalizeLifeDetailText } from './lifeDetails';
import type { KnowledgeOp, MemKnowledge } from './types';

/**
 * 了解清单:每个角色知道/以为的主角的事。
 * 用途是防人设/世界书常驻导致的「全知」——注入时告诉主模型没记的私事该角色默认不知道。
 */

function norm(s: string): string {
  return s.trim().toLowerCase();
}

function text(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, ' ').trim();
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** 了解条目 id:产生它的叶子 id + 该操作在叶子 knowledge 日志里的序号(日志只追加,序号稳定) */
export function knowledgeId(leafId: string, opIndex: number): string {
  return `know:${leafId}#${opIndex}`;
}

/** 同一角色的同义条目算重复;不同角色知道同一件事各记各的 */
export function sameKnowledge(a: { subject: string; text: string }, b: { subject: string; text: string }): boolean {
  return norm(a.subject) === norm(b.subject) && normalizeLifeDetailText(a.text) === normalizeLifeDetailText(b.text);
}

/** 某角色的全部条目(名字按规范化匹配) */
export function knowledgeOf(list: MemKnowledge[], name: string): MemKnowledge[] {
  const key = norm(name);
  return key ? list.filter(k => norm(k.subject) === key) : [];
}

/** 清洗存储日志:丢掉缺字段的操作(手改数据等),其余保持原顺序 */
export function cleanKnowledgeOps(raw: unknown): KnowledgeOp[] {
  const out: KnowledgeOp[] = [];
  for (const r of arr(raw)) {
    if (!isRecord(r)) continue;
    if (r.op === 'add') {
      const subject = text(r.subject);
      const t = text(r.text);
      if (subject && t) out.push({ op: 'add', subject, text: t });
    } else if (r.op === 'update') {
      const id = text(r.id);
      const subject = text(r.subject);
      const t = text(r.text);
      if (!id || (!subject && !t)) continue;
      const u: Extract<KnowledgeOp, { op: 'update' }> = { op: 'update', id };
      if (subject) u.subject = subject;
      if (t) u.text = t;
      out.push(u);
    } else if (r.op === 'remove') {
      const id = text(r.id);
      if (id) out.push({ op: 'remove', id });
    }
  }
  return out;
}

/** 按顺序把一个叶子的操作施加到清单上(重放用);add 同角色同义去重,update 过的挪到末尾 */
export function applyKnowledgeOps(list: MemKnowledge[], ops: KnowledgeOp[], leaf: { id: string; createdAt: number; time: string }): void {
  ops.forEach((op, i) => {
    if (op.op === 'add') {
      if (list.some(k => sameKnowledge(k, op))) return;
      list.push({ id: knowledgeId(leaf.id, i), subject: op.subject, text: op.text, createdTime: leaf.time || undefined, createdAt: leaf.createdAt });
      return;
    }
    const idx = list.findIndex(k => k.id === op.id);
    if (idx < 0) return;
    const [k] = list.splice(idx, 1);
    if (op.op === 'remove') return;
    if (op.subject) k.subject = op.subject;
    if (op.text) k.text = op.text;
    // 改完和另一条撞成同一句 → 去掉改的这条(那句话已经有条目记着)
    if (list.some(o => sameKnowledge(o, k))) return;
    // 挪到末尾:注入只发最近几条,被纠正的认知往往最要紧,不能按最初记下的时间被截掉
    list.push(k);
  });
}

/**
 * AI 输出(分桶)→ 有序存储日志。
 *  - k1/k2… 按提示词里展示的顺序翻成稳定 id;已是 know: 的原样保留,查无的丢弃;
 *  - who 只认名册里的角色(含本楼新登场),按名册写法归一;主角或查无此人的整条丢弃;
 *  - 先改/删旧条,再加新条:纠正认知时「删旧加新」不会误删新加的。
 */
export function finalizeKnowledge(raw: unknown, shown: { id: string }[], npcNames: string[]): KnowledgeOp[] {
  if (!isRecord(raw)) return [];
  const canon = new Map<string, string>();
  for (const n of npcNames) if (n.trim()) canon.set(norm(n), n.trim());
  const resolveRef = (ref: unknown): string | null => {
    const t = isRecord(ref) ? text(ref.id) : text(ref);
    if (!t) return null;
    if (t.startsWith('know:')) return t;
    const m = t.match(/^k(\d+)$/i);
    return m ? shown[Number(m[1]) - 1]?.id ?? null : null;
  };
  const out: KnowledgeOp[] = [];
  for (const u of arr(raw.update)) {
    if (!isRecord(u)) continue;
    const id = resolveRef(u.id);
    const t = text(u.text);
    if (id && t) out.push({ op: 'update', id, text: t });
  }
  for (const r of arr(raw.remove)) {
    const id = resolveRef(r);
    if (id) out.push({ op: 'remove', id });
  }
  for (const a of arr(raw.add)) {
    if (!isRecord(a)) continue;
    const subject = canon.get(norm(text(a.who) || text(a.subject) || text(a.name)));
    const t = text(a.text);
    if (subject && t) out.push({ op: 'add', subject, text: t });
  }
  return out;
}

/** 副 API 只看给定角色的清单(省 token);返回顺序即 k1/k2… 编号,按 names 顺序分组 */
export function selectKnowledgeForSummary(list: MemKnowledge[], names: string[]): MemKnowledge[] {
  const out: MemKnowledge[] = [];
  const seen = new Set<string>();
  for (const name of names) {
    const key = norm(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(...knowledgeOf(list, name));
  }
  return out;
}

/** 渲染给副 API:按角色分组,编号全局连续(须与 selectKnowledgeForSummary 的顺序一致) */
export function fmtKnowledgeForSummary(shown: MemKnowledge[]): string {
  if (!shown.length) return '  (无)';
  const lines: string[] = [];
  let current = '';
  shown.forEach((k, i) => {
    if (norm(k.subject) !== current) {
      current = norm(k.subject);
      lines.push(`  ${oneLine(k.subject)}:`);
    }
    lines.push(`    k${i + 1}. ${oneLine(k.text)}`);
  });
  return lines.join('\n');
}

/** 注入时每个角色最多发几条(取最近的):相处久了清单会很长,全发太占上下文 */
export const KNOWLEDGE_INJECT_CAP = 15;

/**
 * 渲染注入块。只发给定角色(在场/主要角色);没记录的也列「暂无记录」,让「没记=不知道」对其生效。
 * 叮嘱只锁私事:看得见的、公开的、按关系本该知道的、剧情里交代过得知的照常知道,免得矫枉过正变失忆
 * (老存档开启时清单是空的,以前得知的事靠剧情记录兜住)。
 */
export function fmtKnowledgeInjection(list: MemKnowledge[], names: string[], userName: string, cap = KNOWLEDGE_INJECT_CAP): string {
  const seen = new Set<string>();
  const rows: string[] = [];
  for (const name of names) {
    const key = norm(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    const own = knowledgeOf(list, name);
    if (!own.length) {
      rows.push(`${oneLine(name)}:暂无记录`);
      continue;
    }
    const shown = own.slice(-cap);
    const more = own.length - shown.length;
    rows.push(`${oneLine(name)}:${more > 0 ? `(另有 ${more} 条较早的从略)` : ''}\n${shown.map(k => `  - ${oneLine(k.text)}`).join('\n')}`);
  }
  if (!rows.length) return '';
  const u = userName || '主角';
  return `角色对${u}的了解(下列角色只知道这里记下的${u}私事:身世、过往经历、秘密、私人喜好,以及${u}的名字,没写的就当该角色不知道,除非剧情里交代过该角色得知;别让角色凭人设或世界书说出自己不该知道的事。看得见的外貌举止、公开身份,以及按其与${u}的关系本该知道的,照常知道。条目是角色自己的认知,未必是真相:角色按自己以为的说话行事,不要替角色看穿):\n`
    + rows.join('\n');
}
