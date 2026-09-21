import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeSinger, type Scene, type Singer } from './geometry';
import {
  checkPlacement,
  findUnblockPositions,
  isFeasible,
  type UnblockSearchResult,
} from './unblock';

function singer(id: string, x: number, y: number, radius = 0.3): Singer {
  return { id, name: id.toUpperCase(), x, y, radius };
}

function scene(partial: Partial<Scene> & Pick<Scene, 'conductor' | 'singers'>): Scene {
  return { version: 1, stage: { width: 12, depth: 8 }, ...partial };
}

/** 校验候选位置满足全部三条硬约束（用独立口径复查） */
function assertCandidateValid(sc: Scene, me: Singer, c: { x: number; y: number }) {
  // 界内
  assert.ok(c.x >= 0 && c.x <= sc.stage.width, `x=${c.x} 越界`);
  assert.ok(c.y >= 0 && c.y <= sc.stage.depth, `y=${c.y} 越界`);
  const others = sc.singers.filter((s) => s.id !== me.id);
  // 间距 ≥ 自身半径 + 对方半径
  for (const o of others) {
    const gap = Math.hypot(o.x - c.x, o.y - c.y);
    assert.ok(
      gap >= me.radius + o.radius - 1e-9,
      `与 ${o.name} 间距 ${gap} 小于半径和 ${me.radius + o.radius}`,
    );
  }
  // 视线不被侵入（允许相切）
  const los = analyzeSinger(sc.conductor, { ...me, x: c.x, y: c.y }, sc.singers);
  assert.ok(
    los.status === 'clear' || los.status === 'tangent',
    `候选位置视线状态应为 clear/tangent，实际 ${los.status}`,
  );
}

test('checkPlacement：逐项报告违反原因', () => {
  const stage = { width: 12, depth: 8 };
  const conductor = { x: 6, y: 0 };
  const other = singer('o', 6, 2, 0.5);
  // 间距不足（圆心距 0.4 < 0.3+0.5）
  const v1 = checkPlacement(stage, conductor, [other], 0.3, 6, 2.4);
  assert.deepEqual(v1.tooClose, ['o']);
  assert.equal(isFeasible(v1), false);
  // 视线被侵入（在指挥与遮挡者连线上，但离遮挡者足够远）
  const v2 = checkPlacement(stage, conductor, [other], 0.3, 6, 4);
  assert.deepEqual(v2.blockedBy, ['o']);
  assert.equal(isFeasible(v2), false);
  // 越界
  assert.equal(checkPlacement(stage, conductor, [other], 0.3, -0.1, 4).outOfStage, true);
  assert.equal(checkPlacement(stage, conductor, [other], 0.3, 12.1, 4).outOfStage, true);
  // 与指挥重合 → 退化
  assert.equal(checkPlacement(stage, conductor, [other], 0.3, 6, 0).degenerate, true);
  // 恰好相切的间距（0.8 = 0.3+0.5）视为满足
  const v3 = checkPlacement(stage, conductor, [other], 0.3, 6.8, 2);
  assert.equal(v3.tooClose.length, 0);
  // 完全可行的位置
  assert.equal(isFeasible(checkPlacement(stage, conductor, [other], 0.3, 3, 5)), true);
});

test('搜索：被遮挡者得到按位移升序的可行候选（≤3 个）', () => {
  // 指挥 (6,0)，遮挡者 (6,2) r=0.5，me (6,4) 正好被挡
  const sc = scene({
    conductor: { x: 6, y: 0 },
    singers: [singer('me', 6, 4, 0.3), singer('b', 6, 2, 0.5)],
  });
  const before = JSON.stringify(sc);
  const r = findUnblockPositions(sc, 'me');
  assert.ok(r);
  assert.equal(r.originFeasible, false);
  assert.ok(r.candidates.length >= 1 && r.candidates.length <= 3);
  // 升序
  for (let i = 1; i < r.candidates.length; i++) {
    assert.ok(r.candidates[i].distance >= r.candidates[i - 1].distance);
  }
  const me = sc.singers[0];
  for (const c of r.candidates) {
    assertCandidateValid(sc, me, c);
    // 位移 = 到原位置的距离
    assert.ok(Math.abs(c.distance - Math.hypot(c.x - 6, c.y - 4)) < 1e-9);
  }
  // 最小位移应明显小于舞台尺寸（侧移即可解决）
  assert.ok(r.candidates[0].distance > 0.2 && r.candidates[0].distance < 2);
  // 搜索不修改场景（其他人不动）
  assert.equal(JSON.stringify(sc), before);
  // 统计自洽
  assert.ok(r.stats.feasible > 0);
  assert.ok(r.stats.losBlocked > 0);
  assert.ok(r.stats.sampled >= r.stats.feasible);
});

test('搜索：原位置已可行时 originFeasible=true 且首候选位移为 0', () => {
  const sc = scene({
    conductor: { x: 6, y: 0 },
    singers: [singer('me', 3, 5, 0.3), singer('o', 9, 2, 0.3)],
  });
  const r = findUnblockPositions(sc, 'me');
  assert.ok(r);
  assert.equal(r.originFeasible, true);
  assert.equal(r.candidates[0].distance, 0);
  assert.equal(r.candidates[0].x, 3);
  assert.equal(r.candidates[0].y, 5);
});

test('搜索：相切视线也算可行（不判为侵入）', () => {
  // 遮挡圆 (7,2) r=1：me 在 (6,4) 时视线 x=6 与其恰好相切 → 原位置已可行
  const sc = scene({
    conductor: { x: 6, y: 0 },
    singers: [singer('me', 6, 4, 0.3), singer('g', 7, 2, 1)],
  });
  const r = findUnblockPositions(sc, 'me');
  assert.ok(r);
  assert.equal(r.originFeasible, true);
});

test('搜索：舞台被占满时返回空候选并给出不可行原因', () => {
  // 2×2 小舞台中央一个 r=1.5 的圆：任意点的圆心距 ≤ √2 < 0.3+1.5 → 全部间距不足
  const sc = scene({
    stage: { width: 2, depth: 2 },
    conductor: { x: 1, y: -1 },
    singers: [singer('me', 0.2, 0.2, 0.3), singer('big', 1, 1, 1.5)],
  });
  const r: UnblockSearchResult | null = findUnblockPositions(sc, 'me');
  assert.ok(r);
  assert.equal(r.candidates.length, 0);
  assert.equal(r.originFeasible, false);
  assert.equal(r.stats.feasible, 0);
  assert.ok(r.stats.tooClose > 0);
  assert.equal(r.stats.sampled, r.stats.tooClose); // 本例中间距是唯一原因
});

test('搜索：候选不会与其他站位间距不足（密集场景）', () => {
  // me 被 s2 遮挡，且周围站位密集
  const sc = scene({
    conductor: { x: 6, y: -1 },
    singers: [
      singer('me', 6, 4, 0.3),
      singer('s2', 6, 2, 0.4),
      singer('s3', 5, 4, 0.3),
      singer('s4', 7, 4, 0.3),
      singer('s5', 6, 5.2, 0.3),
    ],
  });
  const r = findUnblockPositions(sc, 'me');
  assert.ok(r);
  assert.ok(r.candidates.length >= 1);
  const me = sc.singers[0];
  for (const c of r.candidates) assertCandidateValid(sc, me, c);
});

test('搜索：singerId 不存在时返回 null', () => {
  const sc = scene({ conductor: { x: 6, y: 0 }, singers: [singer('a', 1, 1)] });
  assert.equal(findUnblockPositions(sc, 'nope'), null);
});

test('搜索：网格步长可配置，细化结果不劣于纯网格最优', () => {
  const sc = scene({
    conductor: { x: 6, y: 0 },
    singers: [singer('me', 6, 4, 0.3), singer('b', 6, 2, 0.5)],
  });
  const coarse = findUnblockPositions(sc, 'me', { gridStep: 0.5, refineStepMin: 0.01 });
  assert.ok(coarse && coarse.candidates.length > 0);
  // 纯网格最优可行点的位移
  const step = 0.5;
  let gridBest = Infinity;
  for (let x = 0; x <= 12; x += step) {
    for (let y = 0; y <= 8; y += step) {
      const v = checkPlacement(sc.stage, sc.conductor, [sc.singers[1]], 0.3, x, y);
      if (isFeasible(v)) gridBest = Math.min(gridBest, Math.hypot(x - 6, y - 4));
    }
  }
  // 细化后的最优候选应 ≤ 纯网格最优（允许微小数值误差）
  assert.ok(coarse.candidates[0].distance <= gridBest + 1e-9);
});
