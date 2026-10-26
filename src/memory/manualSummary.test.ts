import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as settings from '@/api/settings';
import * as context from '@/st/context';
import type { STContext, STMessage } from '@/st/context';
import { createManualLeaf, createManualRangeSummary, getLeaf, leafValid } from './apply';
import { coveredSet, pendingAiFloors } from './engine';
import { derivedMeta, memory, recomputeDerived } from './store';
import { createEmptyMemory } from './types';

let seq = 0;
const aiMsg = (extra: Record<string, unknown> = {}): STMessage => ({
  name: '艾琳', is_user: false, is_system: false, mes: `第 ${++seq} 楼剧情。`,
  extra,
});
const userMsg = (): STMessage => ({
  name: '林舟', is_user: true, is_system: false, mes: `第 ${++seq} 楼发言。`,
});

function useChat(chat: STMessage[]) {
  const ctx = {
    chat, chatMetadata: {}, name1: '林舟', name2: '艾琳',
    saveChat: vi.fn().mockResolvedValue(undefined), saveMetadataDebounced: vi.fn(),
    saveMetadata: vi.fn().mockResolvedValue(undefined),
    reloadCurrentChat: vi.fn().mockResolvedValue(undefined),
    getCurrentChatId: () => 'manual-summary-test',
  } as unknown as STContext;
  vi.spyOn(context, 'getContext').mockReturnValue(ctx);
  recomputeDerived();
  return ctx;
}

const originalVector = settings.apiSettings.vector.enabled;
beforeEach(() => {
  vi.useFakeTimers();
  Object.assign(memory, createEmptyMemory());
  settings.apiSettings.vector.enabled = false;
});
afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  settings.apiSettings.vector.enabled = originalVector;
});

describe('手写单楼摘要', () => {
  it('在没有叶子的 AI 楼上写出一条有效叶子,并清掉待摘要状态', () => {
    const ctx = useChat([aiMsg(), userMsg(), aiMsg()]);
    expect(pendingAiFloors(ctx.chat)).toEqual([0, 2]);

    expect(createManualLeaf(0, { text: '  两人在雨里告别。  ', timeStart: '1988/9/29 21:00', timeEnd: '1988/9/29 21:30' })).toBe(true);

    const leaf = getLeaf(ctx.chat[0])!;
    expect(leaf.text).toBe('两人在雨里告别。'); // 首尾空白裁掉
    expect(leaf.manual).toBe(true);
    expect(leaf.swipe).toBe(0);
    expect(leaf.delta.time).toBe('1988/9/29 21:30'); // 覆盖型时间取结束时间
    expect(leafValid(ctx.chat[0])).toBe(true);
    // 派生缓存同步:该楼不再是待摘要
    expect(derivedMeta.pendingFloors).toEqual([2]);
    expect(derivedMeta.leaves.find(l => l.msgIndex === 0)?.manual).toBe(true);
  });

  it('不填时间时不推进故事内时间', () => {
    const ctx = useChat([aiMsg()]);
    expect(createManualLeaf(0, { text: '一段过场。' })).toBe(true);
    const leaf = getLeaf(ctx.chat[0])!;
    expect(leaf.timeStart).toBeUndefined();
    expect(leaf.timeEnd).toBeUndefined();
    expect(leaf.delta.time).toBeUndefined();
  });

  it('已有摘要时不静默覆盖', () => {
    const ctx = useChat([aiMsg()]);
    expect(createManualLeaf(0, { text: '第一次手写' })).toBe(true);
    const first = getLeaf(ctx.chat[0])!;
    expect(createManualLeaf(0, { text: '第二次手写' })).toBe(false);
    expect(getLeaf(ctx.chat[0])!.id).toBe(first.id);
    expect(getLeaf(ctx.chat[0])!.text).toBe('第一次手写');
  });

  it('番外楼、用户楼、空正文、越界楼层一律拒绝', () => {
    const ctx = useChat([aiMsg({ bbs_omit: true }), userMsg(), aiMsg()]);
    expect(createManualLeaf(0, { text: '番外楼' })).toBe(false); // 番外
    expect(createManualLeaf(1, { text: '用户楼' })).toBe(false); // 用户消息
    expect(createManualLeaf(2, { text: '   ' })).toBe(false); // 空正文
    expect(createManualLeaf(9, { text: '不存在' })).toBe(false); // 越界
    expect(ctx.chat.every(m => !getLeaf(m))).toBe(true);
  });

  it('翻页后手写叶子跟随页码失效,翻回原页又恢复', () => {
    const ctx = useChat([aiMsg()]);
    ctx.chat[0].swipe_id = 1;
    expect(createManualLeaf(0, { text: '第二页的摘要' })).toBe(true);
    expect(leafValid(ctx.chat[0])).toBe(true);
    ctx.chat[0].swipe_id = 0; // 翻到没写过摘要的那页
    expect(leafValid(ctx.chat[0])).toBe(false);
    ctx.chat[0].swipe_id = 1;
    expect(leafValid(ctx.chat[0])).toBe(true);
  });
});

describe('手写区间摘要', () => {
  it('写成原子节点,接管区间内楼层且不再待摘要', () => {
    const ctx = useChat([aiMsg(), aiMsg(), aiMsg(), aiMsg()]);
    const node = createManualRangeSummary(0, 2, { text: '开场三天,从初遇到结伴同行。' });

    expect(node).not.toBeNull();
    expect(node!.manual).toBe(true);
    expect(node!.imported).toBeUndefined(); // 手写区间不是「导入历史」
    expect(node!.level).toBe(2);
    expect(node!.childIds).toEqual([]);
    expect(node!.importedFloorStart).toBe(0);
    expect(node!.importedFloorEnd).toBe(2);
    // 不调 AI,也就不该有 auto 标记
    expect(node!.auto).toBe(false);

    expect(pendingAiFloors(ctx.chat)).toEqual([3]); // 0..2 已被接管
    const covered = coveredSet(ctx.chat);
    expect([0, 1, 2].every(i => covered.has(i))).toBe(true);
    expect(covered.has(3)).toBe(false);
  });

  it('空正文不落地节点', () => {
    useChat([aiMsg(), aiMsg()]);
    expect(createManualRangeSummary(0, 1, { text: '  ' })).toBeNull();
    expect(memory.summaries).toHaveLength(0);
  });

  it('起点大于终点时自动纠正顺序', () => {
    useChat([aiMsg(), aiMsg(), aiMsg()]);
    const node = createManualRangeSummary(2, 1, { text: '区间' });
    expect(node!.importedFloorStart).toBe(1);
    expect(node!.importedFloorEnd).toBe(2);
  });
});
