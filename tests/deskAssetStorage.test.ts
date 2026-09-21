import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStorage } from '../src/adapters/memoryStorage.ts';

test('serves desk assembly assets without Cloudflare or a database', async () => {
  const storage = createMemoryStorage({
    deskPresetIds: ['preset'],
    deskRecipes: [{ id: 'recipe', presetId: 'preset', weight: 'heavy', overrides: {}, regexIds: ['r2'], lightSystem: '' }],
    deskRegex: [
      { id: 'r1', find: 'x', flags: 'g', replace: 'y', direction: 'up', meta: {} },
      { id: 'r2', find: 'a', flags: '', replace: 'b', direction: 'both', meta: { scope: 'prompt' } },
    ],
    deskBlocks: [{ presetId: 'preset', identifier: 'main', name: 'Main', role: 'system', content: 'Prompt', marker: true, queuePos: 0, enabledDefault: true }],
    deskLore: [
      { project: 'P', id: 'z', name: 'Z', content: 'z', keys: [], position: 'broken', isCharacter: true, constant: false, triggerMode: 'presence', fields: {} },
      { project: 'P', id: 'a', name: 'A', content: 'a', keys: [], position: 'before', isCharacter: false, constant: true, triggerMode: 'scan', fields: {} },
    ],
  });
  assert.equal(await storage.deskAssets.hasPreset('preset'), true);
  assert.equal((await storage.deskAssets.getRecipe('recipe'))?.regexIds[0], 'r2');
  assert.deepEqual((await storage.deskAssets.listRegex(['r2'])).map((row) => row.id), ['r2']);
  assert.deepEqual((await storage.deskAssets.listQueueBlocks('preset')).map((row) => row.identifier), ['main']);
  const lore = await storage.deskAssets.listLore('P');
  assert.deepEqual(lore.map((row) => row.id), ['a', 'z']);
  assert.equal(lore[1].position, 'broken');
});

test('empty regex list falls back to preset+global, only up/both/enabled rules, preset before global', async () => {
  const storage = createMemoryStorage({
    deskPresetIds: ['preset', 'other'],
    deskRegex: [
      { id: 'g-down', find: 'x', flags: '', replace: 'y', direction: 'down', meta: {}, scope: 'global', sortOrder: 0 },
      { id: 'g-off', find: 'x', flags: '', replace: 'y', direction: 'both', meta: {}, scope: 'global', enabled: false, sortOrder: 1 },
      { id: 'g1', find: 'x', flags: '', replace: 'y', direction: 'up', meta: {}, scope: 'global', sortOrder: 2 },
      { id: 'p1', find: 'x', flags: '', replace: 'y', direction: 'both', meta: {}, scope: 'preset', presetId: 'preset', sortOrder: 1 },
      { id: 'p0', find: 'x', flags: '', replace: 'y', direction: 'up', meta: {}, scope: 'preset', presetId: 'preset', sortOrder: 0 },
      { id: 'other-preset', find: 'x', flags: '', replace: 'y', direction: 'up', meta: {}, scope: 'preset', presetId: 'other', sortOrder: 0 },
    ],
  });
  const ids = (await storage.deskAssets.listUpRegexForPreset('preset')).map((row) => row.id);
  assert.deepEqual(ids, ['p0', 'p1', 'g1']);
});

test('returns cloned asset values rather than exposing adapter state', async () => {
  const storage = createMemoryStorage({ deskPresetIds: ['p'], deskRecipes: [
    { id: 'r', presetId: 'p', weight: 'heavy', overrides: {}, regexIds: ['x'], lightSystem: '' },
  ] });
  const first = await storage.deskAssets.getRecipe('r');
  first!.regexIds.push('mutated');
  assert.deepEqual((await storage.deskAssets.getRecipe('r'))?.regexIds, ['x']);
});

test('serves desk story state and published chapter hydration from memory', async () => {
  const chapter = (id: string, status: 'draft' | 'published', content = 'body') => ({ id, project: 'P', chapterNo: id,
    title: id, content, summary: '', status, createdAt: '2026-01-01', updatedAt: null, publishedAt: null });
  const storage = createMemoryStorage({ deskState: { 'desk_core:P': 'core' }, chapters: [
    chapter('1', 'published'), chapter('2', 'draft'), chapter('3', 'published', '   '),
  ] });
  assert.equal(await storage.deskStory.getState('desk_core:P'), 'core');
  assert.deepEqual((await storage.deskStory.listPublishedChapters('P')).map((row) => row.id), ['1', '3']);
  assert.deepEqual((await storage.deskStory.getPublishedChapters(['1', '2', '3'], 'P')).map((row) => row.id), ['1']);
});
