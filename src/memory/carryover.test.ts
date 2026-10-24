import { describe, expect, it } from 'vitest';
import type { STMessage } from '@/st/context';
import { sanitizeCarryMessage } from './carryover';

describe('新开聊天搬运窗口楼层', () => {
  it('窗口内对旧计划的了结/更新/重启/删除引用改指种子叶上的新 id', () => {
    const m = {
      name: '艾琳', is_user: false, is_system: true, mes: '剧情。',
      extra: { bbs_hidden: true, bbs_leaf: { id: 'w1', text: '摘要', createdAt: 1, swipe: 0, v: 1, delta: { plans: {
        resolve: ['plan:old#0', { id: 'plan:old#1', outcome: 'done' }],
        update: [{ id: 'plan:old#2', content: '改期' }],
        reopen: ['plan:old#3'],
        remove: ['plan:w0#0'],
      } } } },
    } as unknown as STMessage;
    const planIds = new Map([0, 1, 2, 3].map(i => [`plan:old#${i}`, `plan:seed#${i}`]));
    const out = sanitizeCarryMessage(m, new Map(), planIds);
    expect(out.extra?.bbs_leaf?.delta.plans).toEqual({
      resolve: ['plan:seed#0', { id: 'plan:seed#1', outcome: 'done' }],
      update: [{ id: 'plan:seed#2', content: '改期' }],
      reopen: ['plan:seed#3'],
      // 窗口内自己新增的计划 id 不在映射里,保持不变
      remove: ['plan:w0#0'],
    });
    // 深拷贝:源聊天的叶子不被改动
    expect(m.extra?.bbs_leaf?.delta.plans?.update?.[0].id).toBe('plan:old#2');
  });
});
