// 打字桌上行正则:深度门,纯函数单测。
import test from 'node:test';
import assert from 'node:assert/strict';

import { applyUpRegex, ruleAppliesAtDepth, type DeskRegexRule } from '../src/tools/deskMacro.ts';

const rule = (o: Partial<DeskRegexRule> & { find: string }): DeskRegexRule =>
  ({ flags: '', replace: '', direction: 'up', ...o });

test('ruleAppliesAtDepth: no depth configured means it applies at any depth; min/max each act as their own gate; null/garbage counts as unconfigured', () => {
  assert.equal(ruleAppliesAtDepth(rule({ find: 'x' }), 0), true);
  assert.equal(ruleAppliesAtDepth(rule({ find: 'x', meta: { minDepth: 5 } }), 4), false);
  assert.equal(ruleAppliesAtDepth(rule({ find: 'x', meta: { minDepth: 5 } }), 5), true);
  assert.equal(ruleAppliesAtDepth(rule({ find: 'x', meta: { maxDepth: 2 } }), 3), false);
  assert.equal(ruleAppliesAtDepth(rule({ find: 'x', meta: { maxDepth: 2 } }), 2), true);
  assert.equal(ruleAppliesAtDepth(rule({ find: 'x', meta: { minDepth: null, maxDepth: null } }), 99), true);
  assert.equal(ruleAppliesAtDepth(rule({ find: 'x', meta: { minDepth: 'a' as any } }), 0), true);
});

test('applyUpRegex: omitting depth runs every rule; passing depth only runs rules whose interval covers it', () => {
  const r = rule({ find: 'a', replace: 'b', flags: 'g', meta: { minDepth: 3 } });
  assert.equal(applyUpRegex('aaa', [r]), 'bbb');
  assert.equal(applyUpRegex('aaa', [r], 1), 'aaa');
  assert.equal(applyUpRegex('aaa', [r], 3), 'bbb');
});

// 深楼摘要规则样本:5 楼外只保留摘要标签内的内容
const deepSummary = rule({ find: '^[\\s\\S]*(<summary>[\\s\\S]*$)', replace: '$1', flags: 'i', meta: { minDepth: 5 } });
// 无深度限制的剪除规则样本:剪掉小剧场/序言/选项标签
const stripAside = rule({ find: '^.+</thinking>|<prologue>.+?</[^>]*>|\\s<branches>.+$|\\s<snow>.+$', replace: '', flags: 'gis' });

test('deep-summary rule: near floors untouched, deep floors keep only the summary tag; floors without the tag are untouched at any depth', () => {
  const withTag = '正文一大段\n<summary>\n小结\n</summary>';
  assert.equal(applyUpRegex(withTag, [deepSummary], 1), withTag);
  assert.equal(applyUpRegex(withTag, [deepSummary], 4), withTag);
  assert.equal(applyUpRegex(withTag, [deepSummary], 5), '<summary>\n小结\n</summary>');
  const plain = '普通楼层原文,没有这套标签';
  assert.equal(applyUpRegex(plain, [deepSummary], 9), plain);
});

test('strip-aside rule: cuts prologue/branches/aside tags; clean floors are untouched', () => {
  assert.equal(applyUpRegex('正文\n<branches>选项A/选项B', [stripAside], 1), '正文');
  assert.equal(applyUpRegex('<prologue>序言</prologue>正文', [stripAside], 1), '正文');
  const plain = '就是正文';
  assert.equal(applyUpRegex(plain, [stripAside], 1), plain);
});
