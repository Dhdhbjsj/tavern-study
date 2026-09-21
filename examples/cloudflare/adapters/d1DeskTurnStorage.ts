import type { DeskAutoRefreshBoardInput, DeskAutoRefreshBoardResult, DeskTurnCommit, DeskTurnStorage } from '../../../src/core/storage.ts';
import type { DeskFloor } from '../../../src/core/types.ts';
import { D1DeskStorage } from './d1DeskStorage.ts';

export class D1DeskTurnStorage implements DeskTurnStorage {
  private readonly db: D1Database; private readonly desk: D1DeskStorage;
  constructor(db: D1Database) { this.db = db; this.desk = new D1DeskStorage(db); }

  async commitAssistantFloor(windowId: string, floorId: string, commit: DeskTurnCommit) {
    const report = { ...commit.report, commitToken: crypto.randomUUID() };
    try {
      const results = await this.db.batch([
        this.db.prepare(`INSERT INTO desk_floors (id, window_id, role, content, variants, active_variant, thinking, report, created_at)
          SELECT ?, ?, 'assistant', ?, ?, 0, ?, ?, ? WHERE EXISTS (SELECT 1 FROM desk_windows WHERE id = ?)`)
          .bind(floorId, windowId, commit.content, JSON.stringify([commit.content]), commit.thinking, JSON.stringify(report), commit.committedAt, windowId),
        this.db.prepare(`UPDATE desk_windows SET state_board = ?, updated_at = ? WHERE id = ?`)
          .bind(JSON.stringify(commit.stateBoard), commit.committedAt, windowId),
      ]);
      return results[0]?.meta?.changes ? this.desk.getFloor(floorId) : null;
    } catch (error) { if (/unique|primary key/i.test(String(error))) return null; throw error; }
  }

  async rollAssistantFloor(input: { windowId: string; floorId: string; expected: Pick<DeskFloor, 'content' | 'variants' | 'activeVariant' | 'thinking' | 'report'>; commit: DeskTurnCommit }) {
    const nextVariants = [...input.expected.variants, input.commit.content];
    const token = crypto.randomUUID(); const report = { ...input.commit.report, commitToken: token };
    const expectedReport = input.expected.report == null ? null : JSON.stringify(input.expected.report);
    const results = await this.db.batch([
      this.db.prepare(`UPDATE desk_floors SET content = ?, variants = ?, active_variant = ?, thinking = ?, report = ?
        WHERE id = ? AND window_id = ? AND role = 'assistant' AND content = ?
          AND CASE WHEN json_valid(variants) THEN json(variants) = json(?) ELSE 0 END
          AND active_variant = ? AND thinking IS ?
          AND CASE WHEN report IS NULL THEN (? IS NULL)
            WHEN json_valid(report) AND ? IS NOT NULL THEN json(report) = json(?) ELSE 0 END`)
        .bind(input.commit.content, JSON.stringify(nextVariants), nextVariants.length - 1, input.commit.thinking, JSON.stringify(report),
          input.floorId, input.windowId, input.expected.content, JSON.stringify(input.expected.variants), input.expected.activeVariant,
          input.expected.thinking, expectedReport, expectedReport, expectedReport),
      this.db.prepare(`UPDATE desk_windows SET state_board = ?, updated_at = ? WHERE id = ?
        AND EXISTS (SELECT 1 FROM desk_floors WHERE id = ? AND window_id = ?
          AND CASE WHEN json_valid(report) THEN json_extract(report, '$.commitToken') = ? ELSE 0 END)`)
        .bind(JSON.stringify(input.commit.stateBoard), input.commit.committedAt, input.windowId, input.floorId, input.windowId, token),
    ]);
    return results[0]?.meta?.changes && results[1]?.meta?.changes ? this.desk.getFloor(input.floorId) : null;
  }

  // 四证 CAS:板字节+窗口updated_at 未变、本楼仍是该窗最新一楼(NOT EXISTS 更晚的楼层)、楼层
  // content/commitToken 未变,全部成立才写;第二条 UPDATE 若被挤掉只记日志,窗口那条已经写成功不回滚。
  async autoRefreshBoard(input: DeskAutoRefreshBoardInput): Promise<DeskAutoRefreshBoardResult> {
    const winRes = await this.db.prepare(
      `UPDATE desk_windows SET state_board = ?, updated_at = ?
        WHERE id = ? AND state_board = ? AND updated_at = ?
          AND NOT EXISTS (SELECT 1 FROM desk_floors WHERE window_id = ? AND (created_at > ? OR (created_at = ? AND id > ?)))
          AND EXISTS (SELECT 1 FROM desk_floors WHERE id = ? AND content = ? AND json_extract(report, '$.commitToken') = ?)`
    ).bind(
      JSON.stringify(input.nextBoard), input.refreshedAt,
      input.windowId, JSON.stringify(input.expectedWindowStateBoard), input.expectedWindowUpdatedAt,
      input.windowId, input.expectedFloorCreatedAt, input.expectedFloorCreatedAt, input.floorId,
      input.floorId, input.expectedFloorContent, input.expectedFloorCommitToken,
    ).run();
    if ((winRes.meta?.changes ?? 0) !== 1) return { ok: false, reason: 'window CAS missed (board/updated_at stale, floor superseded, or content/commitToken mismatch)' };
    const repRes = await this.db.prepare(
      `UPDATE desk_floors SET report = ? WHERE id = ? AND content = ? AND json_extract(report, '$.commitToken') = ?`
    ).bind(JSON.stringify(input.nextFloorReport), input.floorId, input.expectedFloorContent, input.expectedFloorCommitToken).run();
    if ((repRes.meta?.changes ?? 0) !== 1) return { ok: false, reason: 'window CAS committed but floor changed before its report could be tagged' };
    return { ok: true };
  }
}
