/**
 * 伤情局部补丁(conditionPatch)——仅供重放旧存档。
 *
 * v0.17 曾让模型按编号片段(c1、c2…)局部改 condition。状态通常就几条,这套协议收益小,
 * 格式复杂、模型易写错,编号原样入库还会随前面楼层变动而错位,已改回与 outfit 相同的全文覆盖。
 * 旧存档叶子里仍存着补丁,这里保留切分与施加逻辑让它们照常重放,否则老聊天的状态会变样。
 */

import type { ConditionPatch } from './types';

/** 片段之间的存储分隔符。 */
export const CONDITION_FRAGMENT_SEP = '；';

const FRAGMENT_ID_RE = /^c(\d+)$/i;
/** 旧存档正文里可能抄进了显示编号,还会叠多层(`[c1] [c1] …`)。 */
const FRAGMENT_PREFIX_RE = /^(?:[[【]\s*c\d+\s*[\]】]\s*)+/i;
const FRAGMENT_PREFIX_ANY_RE = /(^|[；;。\n])\s*(?:[[【]\s*c\d+\s*[\]】]\s*)+/gi;

/**
 * 把一段 condition 切成片段。按中文/英文分号、句号、换行切,逗号不切
 * (「手臂受伤,夹板固定,暂不能提重物」当时作为一个片段整体替换)。
 * 抄进去的 `[cN]` 前缀不算内容。
 */
export function splitConditionFragments(condition: string | undefined): string[] {
  const text = (condition ?? '').trim();
  if (!text) return [];
  return text
    .split(/[；;。\n]+/)
    .map(s => s.replace(FRAGMENT_PREFIX_RE, '').trim())
    .filter(Boolean);
}

/** 剥掉被抄进正文的显示编号(`[c1] 手臂受伤；[c2] …` → `手臂受伤；…`),其余原样保留。 */
export function stripConditionFragmentIds(condition: string): string {
  return condition.replace(FRAGMENT_PREFIX_ANY_RE, '$1').trim();
}

/**
 * 施加某个人物的 conditionPatch,返回新的 condition(可能是 undefined=清空)。
 * - replace:按 cN 定位旧片段;text 为空串 → 删除该片段;有内容 → 覆盖该片段。
 * - add:追加为新的尾部片段。
 * 未列入 replace 的旧片段原样保留。
 */
export function applyConditionPatch(
  current: string | undefined,
  patch: ConditionPatch | null | undefined,
): string | undefined {
  if (!patch) return current;
  const fragments = splitConditionFragments(current);
  // 编号全部相对施加前的片段:先收齐再一次性重建。边遍历边 splice 会让后续编号整体左移,
  // 同一补丁里删两段、或删一段改一段时就会删错/改错,越界的那条还静默落空。
  const replaced = new Map<number, string>();
  for (const op of patch.replace ?? []) {
    const m = typeof op.id === 'string' ? op.id.trim().match(FRAGMENT_ID_RE) : null;
    if (!m) continue;
    const idx = Number(m[1]) - 1;
    if (idx < 0 || idx >= fragments.length) continue;
    replaced.set(idx, op.text);
  }
  const next: string[] = [];
  // 写回的文本按同一规则再切一次并去掉完全重复:text 里带句号/分号不该凭空多出片段,
  // 同一句话也不该挂两遍。
  const push = (text: string) => {
    for (const frag of splitConditionFragments(text)) {
      if (!next.includes(frag)) next.push(frag);
    }
  };
  fragments.forEach((frag, i) => push(replaced.get(i) ?? frag));
  for (const op of patch.add ?? []) push(op.text);
  return next.join(CONDITION_FRAGMENT_SEP) || undefined;
}

/** 是否是一个有实际内容、可施加的补丁。 */
export function hasConditionPatchContent(patch: ConditionPatch | null | undefined): boolean {
  if (!patch) return false;
  const replace = patch.replace ?? [];
  const add = patch.add ?? [];
  return replace.length > 0 || add.some(op => op.text.trim().length > 0);
}
