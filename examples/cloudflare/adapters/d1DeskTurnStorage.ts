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
  // content/commitToken 未变,全部成立才写。两条 UPDATE 放同一个 db.batch(D1 的 batch 是单个隐式
  // 事务,同一连接内顺序执行,报错才整体回滚;命中 0 行不算错,不会自动联动另一条)。
  // ⚠️batch 不自动联动:第一条(窗口)WHERE 命中 0 行时,第二条(楼层)若只看 content/commitToken,
  // 这两个值跟窗口那条是否写成功无关——窗口那条落空、楼层这条照样能命中,楼层被打上
  // stateBoardAutoRefreshed 但 boardAfter 指向一块从未真正写进窗口的板(反向半截态)。
  // 修法:楼层这条也加一个 EXISTS,绑窗口那条**写入后的新值**(nextBoard JSON、refreshedAt)——
  // 同一事务里第二条能看见第一条已经写下的结果,第一条没写成,窗口的 state_board/updated_at
  // 就还是旧值、绝不会等于这里绑的新值,这条 EXISTS 必然判假,两条真正同进同退。
  async autoRefreshBoard(input: DeskAutoRefreshBoardInput): Promise<DeskAutoRefreshBoardResult> {
    const results = await this.db.batch([
      this.db.prepare(
        `UPDATE desk_windows SET state_board = ?, updated_at = ?
          WHERE id = ? AND state_board = ? AND updated_at = ?
            AND NOT EXISTS (SELECT 1 FROM desk_floors WHERE window_id = ? AND (created_at > ? OR (created_at = ? AND id > ?)))
            AND EXISTS (SELECT 1 FROM desk_floors WHERE id = ? AND content = ? AND json_extract(report, '$.commitToken') = ?)`
      ).bind(
        JSON.stringify(input.nextBoard), input.refreshedAt,
        input.windowId, JSON.stringify(input.expectedWindowStateBoard), input.expectedWindowUpdatedAt,
        input.windowId, input.expectedFloorCreatedAt, input.expectedFloorCreatedAt, input.floorId,
        input.floorId, input.expectedFloorContent, input.expectedFloorCommitToken,
      ),
      this.db.prepare(
        `UPDATE desk_floors SET report = ? WHERE id = ? AND content = ? AND json_extract(report, '$.commitToken') = ?
          AND EXISTS (SELECT 1 FROM desk_windows WHERE id = ? AND state_board = ? AND updated_at = ?)`
      ).bind(
        JSON.stringify(input.nextFloorReport), input.floorId, input.expectedFloorContent, input.expectedFloorCommitToken,
        input.windowId, JSON.stringify(input.nextBoard), input.refreshedAt,
      ),
    ]);
    const winChanges = results[0]?.meta?.changes ?? 0;
    const repChanges = results[1]?.meta?.changes ?? 0;
    if (winChanges !== 1 || repChanges !== 1) {
      return { ok: false, reason: `window CAS ${winChanges === 1 ? 'matched' : 'missed'}, floor report tag ${repChanges === 1 ? 'matched' : 'missed'}` };
    }
    return { ok: true };
  }
}
