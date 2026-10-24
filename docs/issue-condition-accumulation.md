# 问题分析:主角「状态」(condition)只叠加不删除、越用越长

- 记录时间:基于 `21f7488`（v1.3.2）代码
- 复现方式:纯静态阅读 + 用 node 直接调用真实 `applyConditionPatch` 跑实验(见文末脚本)
- 状态:**未改任何代码**,本文只是诊断 + 修法建议

## 用户反馈

> user 状态只叠加不删除,后面会越来越长。

限定范围:**只有 `protagonist.condition` / `npcs.condition`**(即时层的「状态」字段)有这个现象。
同组的 `gender / identity / appearance / outfit` 都是纯覆盖写(`apply.ts:866-878` 的
`applyProtagonistState` 逐键赋值),给新值就整段替换,不会累积;`age` 走锚点机制,也不会。
所以问题集中在 condition —— 它是唯一一个走「片段补丁(conditionPatch)」协议的字段。

## 结论速览

| # | 问题 | 性质 | 已验证 |
|---|---|---|---|
| 1 | `applyConditionPatch` 边遍历边 `splice`,多段删除时编号错位;越界静默跳过 | **代码级硬 bug**:唯一能让状态变短的路径是坏的 | ✅ 实测 |
| 2 | 同轮同时出现 `condition` 与 `conditionPatch` 时,补丁施加在**新文本**上 | 代码级 bug(清洗层未互斥) | ✅ 实测 |
| 3 | 自定义模板用户能看到 `[c1]` 编号,但**拿不到** conditionPatch 协议 | 提示词组装缺口 | ✅ 读码 |
| 4 | 片段切分按 `。；\n` 切、不剥 `[cN]` 前缀 → 片段数会自我膨胀 | 放大器 | ✅ 实测 |
| 5 | 状态片段**没有 TTL / 上限 / 去重**,只能靠模型显式 replace 才删 | 结构性设计缺口 | ✅ 读码 |

前两条是「删除失效」的直接原因;后三条解释了为什么即使删除偶尔生效,长度仍在长。

---

## 1. 硬 bug:`applyConditionPatch` 多段删除时编号错位

`src/memory/conditionPatch.ts:50-72`

```ts
const fragments = splitConditionFragments(current);
const next = [...fragments];
for (const op of patch.replace ?? []) {
  const m = typeof op.id === 'string' ? op.id.match(FRAGMENT_ID_RE) : null;
  if (!m) continue;
  const idx = Number(m[1]) - 1;
  if (idx < 0 || idx >= next.length) continue;   // ← 越界静默跳过，无日志
  const text = op.text.trim();
  if (!text) next.splice(idx, 1);                // ← 边遍历边删，后续编号全部左移
  else next[idx] = text;
}
```

片段编号是按**施加前**的原始数组算的,但 `splice` 会缩短数组:第一个删除之后,后面所有
`idx` 都指到错的片段;指到尾部之外时 `continue`,**目标片段永远删不掉,且没有任何 warn**。

### 实测(node 直跑真实函数)

```
初始: [c1] 手臂受伤,夹板固定；[c2] 需休养三天；[c3] 左腿擦伤

清 c1 + c3     →  "需休养三天；左腿擦伤"
                   期望 "需休养三天";c3(左腿擦伤)没删掉
清 c1 + 改 c2  →  "需休养三天；休养结束,可提轻物"
                   期望 "休养结束,可提轻物；左腿擦伤";
                   实际:c2 没改到、改的是 c3,c3 原文被覆盖丢失
```

### 为什么这正好打中「该变短的场景」

`src/memory/prompts/builtin-protocols.txt:117` 明确要求多段一起删:

> 明确全部恢复/纠错时**逐项 replace 清空**,不能用时间流逝或闪回健康清除当前伤情。

「伤好了」= 模型在同一补丁里给多条空 `replace` = 必然踩 bug。表现就是:伤明明写好了,
下一轮状态里还挂着,模型（看到旧伤仍在）接着 add 新情况 → 单调变长。

### 为什么现有测试没抓到

`src/memory/conditionPatch.test.ts` 里只有单片段清空:

```ts
it('全部片段清空后返回 undefined', () => {
  expect(applyConditionPatch('手臂受伤', { replace: [{ id: 'c1', text: '' }] })).toBeUndefined();
});
```

没有「一个补丁删 ≥2 段」或「删一段 + 改一段」的用例。

---

## 2. 硬 bug:`condition` 与 `conditionPatch` 同轮出现,补丁打到新文本上

`src/memory/apply.ts:334-344`(`cleanProtagonistDelta`)两个字段都收:

```ts
for (const key of ['gender', 'age', 'ageTime', 'identity', 'appearance', 'outfit', 'condition'] as const) {
  const value = patchText(raw[key]);          // condition 收入
  if (value !== undefined) out[key] = value;
}
const conditionPatch = cleanConditionPatch(raw.conditionPatch);   // conditionPatch 也收入
if (conditionPatch) out.conditionPatch = conditionPatch;
```

而 `apply.ts:872-875` 是「先整段覆盖 → 再施加补丁」:

```ts
if (typeof src[key] === 'string') target[key] = src[key]!.trim() || undefined;
if (src.conditionPatch && hasConditionPatchContent(src.conditionPatch)) {
  target.condition = applyConditionPatch(target.condition, src.conditionPatch);
}
```

补丁编号是相对**旧**片段算的,却施加在刚被覆盖的新文本上:

```
旧: 手臂受伤；需休养三天；左腿擦伤
模型同时给 condition="手臂已痊愈；脚踝扭伤" + replace c2
→ 实际结果 "手臂已痊愈；休养结束"     # 脚踝扭伤被 c2 覆盖掉了
```

注意:`src/memory/protagonist.ts:15-24` 的 `mergeProtagonistDelta` **已经**处理了这个问题
(给了 condition 就删掉同叶子的 conditionPatch) —— 但那只用于**手动编辑**路径
(`appendOpToLatestLeaf`,`apply.ts:1866`)。上一次修复提交 `21f7488` 修的正是手动保存被
同叶子残留补丁二次施加导致「越长越长」。**AI 输出这条路径(main path)没有做互斥。**

---

## 3. 自定义模板:看得到 `[cN]` 编号,拿不到协议

- 编号显示来源:`src/memory/prompts.ts:660-672` 的 `fmtProtagonist`,
  `['状态', fmtConditionFragments(protagonist.condition)]` → 渲染成 `[c1] xxx；[c2] yyy`。
- 协议注入:`prompts.ts:458` `SUMMARY_RULES = SUMMARY_SPLIT.rules + CONDITION_PATCH_PROTOCOL`
  —— 只在**内置**摘要模板下生效(`isBuiltinSummaryPrompt()`,`prompts.ts:951`)。
- 自定义模板分支(`prompts.ts:997-1012`)补的是 `PROTAGONIST_PROTOCOL_SUPPLEMENT`
  (`prompts.ts:900-912`),里面**没有** conditionPatch,只说「condition=当前身体状态/健康」。
- 但 `{{protagonist_block}}` 在自定义分支里照样展开(`prompts.ts:1008`),`[cN]` 编号照样给模型看。

结果:自定义模板用户拿到一份带编号的状态却没有任何编号解释 → 模型只能整段抄回去,
编号被抄进 condition 内容。见第 4 节实测,会每轮叠加。

---

## 4. 放大器:切分规则 + 不剥 `[cN]` 前缀 → 片段数自我膨胀

`conditionPatch.ts:28-35` 按 `[；;。\n]` 切片段,而 `applyConditionPatch` 把 replace/add 的
text **原样**写回(不做规范化)。因此:

1. **句号会凭空多出片段**:模型写 `text: "手臂痊愈。仅留疤"` → 下一轮变成 2 个片段。
   信息没增加,片段数、`；` 分隔符、token 都在涨。
2. **`[cN]` 前缀会指数叠层**(自定义模板场景最容易触发):模型把显示格式抄回 condition,
   下一轮渲染再前缀一次。

实测叠层:

```
第1轮抄回: [c1] 手臂受伤；[c2] 需休养三天；需休养三天          片段数 3
第2轮抄回: [c1] [c1] 手臂受伤；[c2] [c2] 需休养三天；...      片段数 5
第3轮抄回: [c1] [c1] [c1] 手臂受伤；...                      片段数 9
```

代码里没有任何地方剥 `[c\d+]`、没有合并空片段、也没有「片段数上限」保护。

---

## 5. 结构性:状态片段没有生命周期

- `types.ts:532` 注释:`condition` 是「即时层、覆盖型」,但实际存储是**片段列表**。
- 片段**没有 TTL / 到期时间**(对比:`lifeDetails` 有 `until`;`timeRel.ts` / `timeTag.ts`
  已有成熟的故事内时间推算能力,这里完全没用)。
- `prompts/builtin-protocols.txt:114` 的设计意图是「未列入 replace 的旧片段由程序原样保留」,
  即**永远不会自动回血**。于是删不删完全取决于模型是否主动 replace,而 replace 又被
  evidence 门槛(「必须是本轮正文连续原文」)卡着,再叠加第 1 条的 bug → 净效果只能是 add 增长。
- `add` 也没有近似去重:同一处伤换个说法复述一次就多一段。
- 顺带:`cleanConditionPatchOp`(`apply.ts:173-183`)把 `evidence` 直接丢弃、**并不校验**
  (协议文字说「程序只校验编号、类型和引文存在」,实际未实现) —— 与本题方向相反(它导致
  更容易误删而非积累),但同属「协议与实现不一致」,建议一并处理或改文案。

---

## 建议修法(按性价比,前 4 条为纯 bug 修复、不改产品口径)

1. **重写 `applyConditionPatch` 的 replace 施加**:一次遍历、不 `splice`。
   先把 `replace` 收进 `Map<idx, text | DELETE>`,再按原长度重建数组,最后 push `add`;
   `idx` 越界时 `console.warn`(带人物名/编号/片段数),不要静默 `continue`。
   约 10 行,能直接让「痊愈/了结」生效。
2. **清洗层互斥**:`cleanProtagonistDelta` / `cleanNpcDelta`(`apply.ts:334-344`、
   `apply.ts:196-262`)里若同时出现 `condition` 与 `conditionPatch`,丢弃 patch
   (与 `mergeProtagonistDelta` 同语义),或反过来以 patch 为准 —— 二者只能选一个,语义写进注释。
3. **入库前规范化 condition**:剥掉行首 `[c\d+]`、`trim`、剔除空片段、`；` 归一。
   写库前统一走一次(最省事的位置:`applyConditionPatch` 的输出 + `applyProtagonistState`/
   `applyNpcState` 的赋值处,或 `cleanProtagonistDelta`/`cleanNpcDelta` 收尾)。
4. **补测试**:多 op 删除(删2段 / 删1段+改1段)、越界编号、`condition`+`conditionPatch` 同出、
   `[cN]` 剥除、句号切分。放在 `src/memory/conditionPatch.test.ts`。
5. **自定义模板也要带协议**:要么在自定义分支追加 `CONDITION_PATCH_PROTOCOL`(最短兼容写法也行),
   要么在 `{{protagonist_block}}` 旁边补一行「`[cN]` 是片段编号,不要抄进 condition 文本」。
   （建议两者都做:前者治语义,后者治抄写。）
6. **给片段加生命周期(需要产品口径,先别动)**:
   - 片段带故事内「到期/复评时间」,`state.time` 越过就降级为一句或清理(复用 `timeRel.ts`);
   - 或硬上限 N 段,超出把最旧的若干段压成一句总述;
   - `add` 时对近似重复做合并。
   这三条都会改变「不会自动回血」这一既有承诺,需要明确取哪个方向。

## 复现脚本(只读,不改仓库)

在本目录用 node(≥22,原生剥类型)直接跑真实模块:

```bash
node --input-type=module -e "
import { applyConditionPatch, splitConditionFragments, fmtConditionFragments } from './src/memory/conditionPatch.ts';
const start = '手臂受伤,夹板固定；需休养三天；左腿擦伤';
console.log('显示给模型:', fmtConditionFragments(start));
console.log('清 c1 + c3  →', applyConditionPatch(start, { replace: [{id:'c1',text:''},{id:'c3',text:''}] }));
// 期望 '需休养三天'，实际 '需休养三天；左腿擦伤'
console.log('清 c1 + 改 c2 →', applyConditionPatch(start, { replace: [{id:'c1',text:''},{id:'c2',text:'休养结束,可提轻物'}] }));
// 期望 '休养结束,可提轻物；左腿擦伤'，实际 '需休养三天；休养结束,可提轻物'
console.log('越界编号 →', applyConditionPatch('手臂受伤；需休养三天', { replace: [{id:'c9',text:''}] }));
// 静默无操作、无日志
"
```

## 附:与历史修复的关系

- `21f7488` 修的是**手动保存**被同叶子残留 conditionPatch 二次施加(现象同样是「越长越长」)。
  本次用户反馈的应该是**日常自动摘要**路径,该路径在第 1、2 条层面仍未修。
- 判断用户版本:若用户仍在 v0.17 之前(无 conditionPatch 协议),现象会以「模型整段重写时把
  旧伤情越写越长」出现,修法侧重第 5 条;v0.17+ 则是第 1 条为主。
