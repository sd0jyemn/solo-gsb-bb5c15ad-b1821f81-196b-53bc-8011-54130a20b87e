import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  analyzeScene,
  analyzeSinger,
  validateScene,
  TANGENT_EPS,
  type Scene,
  type Singer,
} from './geometry';

function singer(id: string, x: number, y: number, radius = 0.3): Singer {
  return { id, name: id.toUpperCase(), x, y, radius };
}

function scene(partial: Partial<Scene> & Pick<Scene, 'conductor' | 'singers'>): Scene {
  return { version: 1, stage: { width: 12, depth: 8 }, ...partial };
}

test('无遮挡：视线通畅', () => {
  const s1 = singer('s1', 2, 3);
  const s2 = singer('s2', 8, 3);
  const r = analyzeSinger({ x: 6, y: 0 }, s1, [s1, s2]);
  assert.equal(r.status, 'clear');
  assert.equal(r.occlusions.length, 0);
});

test('遮挡：中间一人挡住视线，进入点距离正确', () => {
  // 指挥 (0,0)，演唱者 (0,4)，遮挡者 (0,2) r=0.5 → 进入点距眼睛 4-2-0.5 = 1.5
  const me = singer('me', 0, 4);
  const blocker = singer('b', 0, 2, 0.5);
  const r = analyzeSinger({ x: 0, y: 0 }, me, [me, blocker]);
  assert.equal(r.status, 'blocked');
  assert.equal(r.nearest?.blockerId, 'b');
  assert.ok(Math.abs((r.nearest?.distance ?? 0) - 1.5) < 1e-9);
});

test('相切：圆心距恰好等于半径 → tangent，不判为遮挡', () => {
  // 视线为 x=0 的竖直线，遮挡圆心 (1,2)，r=1 → 恰好相切
  const me = singer('me', 0, 4);
  const grazer = singer('g', 1, 2, 1);
  const r = analyzeSinger({ x: 0, y: 0 }, me, [me, grazer]);
  assert.equal(r.status, 'tangent');
  assert.equal(r.occlusions.length, 1);
  assert.equal(r.occlusions[0].tangent, true);
  assert.ok(Math.abs(r.occlusions[0].clearance) <= TANGENT_EPS);
});

test('相切容差边界：+eps 内相切，-eps 外遮挡', () => {
  const me = singer('me', 0, 4);
  // 圆心距 = 1，半径 = 1 + 0.5e-6 → 净余量 -0.5e-6，在容差内 → 相切
  const a = singer('a', 1, 2, 1 + TANGENT_EPS / 2);
  assert.equal(analyzeSinger({ x: 0, y: 0 }, me, [me, a]).status, 'tangent');
  // 半径 = 1 + 2e-6 → 净余量 -2e-6，超出容差 → 遮挡
  const b = singer('b', 1, 2, 1 + 2 * TANGENT_EPS);
  assert.equal(analyzeSinger({ x: 0, y: 0 }, me, [me, b]).status, 'blocked');
  // 半径 = 1 - 2e-6 → 净余量 +2e-6 → 通畅
  const c = singer('c', 1, 2, 1 - 2 * TANGENT_EPS);
  assert.equal(analyzeSinger({ x: 0, y: 0 }, me, [me, c]).status, 'clear');
});

test('多人共线：最近遮挡者决定着色，遮挡列表按距离升序', () => {
  // 指挥 (0,0)，me (0,10)，中间共线两人：near (0,3)、far (0,7)
  const me = singer('me', 0, 10);
  const near = singer('near', 0, 3, 0.3);
  const far = singer('far', 0, 7, 0.3);
  const r = analyzeSinger({ x: 0, y: 0 }, me, [me, near, far]);
  assert.equal(r.status, 'blocked');
  assert.equal(r.nearest?.blockerId, 'far'); // 距眼睛 10-7-0.3=2.7 < 10-3-0.3=6.7
  assert.deepEqual(
    r.occlusions.map((o) => o.blockerId),
    ['far', 'near'],
  );
  assert.ok(r.occlusions[0].tEnter < r.occlusions[1].tEnter);
});

test('重合：遮挡者与演唱者圆心重合 → 进入参数 t=0', () => {
  const me = singer('me', 0, 4);
  const twin = singer('twin', 0, 4, 0.3);
  const r = analyzeSinger({ x: 0, y: 0 }, me, [me, twin]);
  assert.equal(r.status, 'blocked');
  assert.equal(r.nearest?.tEnter, 0);
  assert.equal(r.nearest?.distance, 0);
});

test('重合：演唱者与指挥重合 → 视线退化', () => {
  const me = singer('me', 5, 5);
  const r = analyzeSinger({ x: 5, y: 5 }, me, [me]);
  assert.equal(r.status, 'degenerate');
});

test('遮挡圆包含指挥端点 → 遮挡且进入点 t<1', () => {
  // 指挥 (0,0) 位于遮挡圆 (0,0.2) r=0.5 内
  const me = singer('me', 0, 4);
  const atConductor = singer('c', 0, 0.2, 0.5);
  const r = analyzeSinger({ x: 0, y: 0 }, me, [me, atConductor]);
  assert.equal(r.status, 'blocked');
  assert.ok((r.nearest?.tEnter ?? 1) < 1);
});

test('投影在线段延长线上的圆不遮挡', () => {
  // 圆在指挥身后（t>1），且距指挥超过半径
  const me = singer('me', 0, 4);
  const behind = singer('behind', 0, -2, 0.5);
  const r = analyzeSinger({ x: 0, y: 0 }, me, [me, behind]);
  assert.equal(r.status, 'clear');
});

test('analyzeScene：统计与重合警告', () => {
  const sc = scene({
    conductor: { x: 0, y: 0 },
    singers: [
      singer('a', 0, 4), // 被 b 遮挡
      singer('b', 0, 2),
      singer('c', 5, 5), // 通畅
      singer('d', 5, 5), // 与 c 重合 → 也被遮挡（c 包含其眼睛）
    ],
  });
  const a = analyzeScene(sc);
  assert.equal(a.summary.total, 4);
  // a 被 b 挡；c 与 d 圆心重合 → 互相遮挡（对方圆包含自己的眼睛）
  assert.equal(a.summary.blocked, 3);
  assert.equal(a.summary.clear, 1); // 仅 b 通畅
  assert.ok(a.warnings.some((w) => w.type === 'coincident-singers'));
});

test('validateScene：接受合法场景并规范化', () => {
  const v = validateScene({
    version: 1,
    stage: { width: 10, depth: 6 },
    conductor: { x: 5, y: -1 },
    singers: [{ id: 's1', name: 'S1', x: 1, y: 2, radius: 0.3 }],
  });
  assert.ok(v.ok);
  if (v.ok) assert.equal(v.scene.singers.length, 1);
});

test('validateScene：拒绝非法输入并给出错误', () => {
  assert.equal(validateScene(null).ok, false);
  assert.equal(validateScene({}).ok, false);
  const bad = validateScene({
    stage: { width: 10, depth: 6 },
    conductor: { x: 0, y: 0 },
    singers: [
      { id: 's1', x: 0, y: 1, radius: 0 }, // 半径非法
      { id: 's1', x: 0, y: 2, radius: 0.3 }, // id 重复
      { id: 's2', x: NaN, y: 2, radius: 0.3 }, // 坐标非法
    ],
  });
  assert.equal(bad.ok, false);
  if (!bad.ok) assert.ok(bad.errors.length >= 3);
});
