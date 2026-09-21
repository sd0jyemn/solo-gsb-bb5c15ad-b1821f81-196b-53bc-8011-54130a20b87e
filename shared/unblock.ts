/**
 * 自动解遮挡 —— 最小位移搜索（前后端共用，纯函数，不修改场景）。
 *
 * 目标：为被选中的演唱者寻找舞台内的新站位，使得
 *  1. 视线：该演唱者（新位置）到指挥的视线线段不被任何其他站位圆侵入
 *          （相切允许，与 analyzeSinger 的判定语义一致）；
 *  2. 间距：与每个其他站位圆的圆心距 ≥ 自身半径 + 对方半径（允许恰好相切）；
 *  3. 界内：圆心留在舞台矩形 [0,width] × [0,depth] 内（与编辑器拖拽钳制一致）。
 *
 * 算法：先在舞台网格上采样并统计不可行原因，再对位移最小的若干可行种子
 * 做模式搜索（pattern search）逐步细化，最后按位移升序去重取前 N 个。
 * 搜索只读取场景，绝不修改其他演唱者。
 */

import {
  DEGENERATE_EPS,
  segmentIntrudesCircle,
  type Scene,
  type Singer,
  type Vec,
} from './geometry';

/** 间距判定容差（米）：圆心距 ≥ 半径和 − 该值 视为满足“至少半径和”的间距 */
const SPACING_EPS = 1e-9;
/** 候选去重容差（米）：细化结果间距小于该值视为同一候选 */
const DEDUPE_EPS = 0.02;

/** 单个位置相对全部约束的违反情况（全部为假/空 = 可行） */
export interface PlacementViolation {
  /** 圆心超出舞台矩形 */
  outOfStage: boolean;
  /** 与指挥位置重合（视线退化为点） */
  degenerate: boolean;
  /** 间距不足的其他站位 id（圆心距 < 半径和） */
  tooClose: string[];
  /** 侵入视线的其他站位 id（圆与视线线段相交，相切不计） */
  blockedBy: string[];
}

export function isFeasible(v: PlacementViolation): boolean {
  return !v.outOfStage && !v.degenerate && v.tooClose.length === 0 && v.blockedBy.length === 0;
}

/**
 * 检查把半径为 radius 的演唱者放到 (x, y) 是否满足全部约束。
 * others 为场景中的其他演唱者（不含被移动者）。
 */
export function checkPlacement(
  stage: Scene['stage'],
  conductor: Vec,
  others: readonly Singer[],
  radius: number,
  x: number,
  y: number,
): PlacementViolation {
  const outOfStage = x < 0 || x > stage.width || y < 0 || y > stage.depth;
  const degenerate = Math.hypot(x - conductor.x, y - conductor.y) < DEGENERATE_EPS;
  const tooClose: string[] = [];
  const blockedBy: string[] = [];
  const eye: Vec = { x, y };
  for (const o of others) {
    if (Math.hypot(o.x - x, o.y - y) < radius + o.radius - SPACING_EPS) {
      tooClose.push(o.id);
    }
    if (segmentIntrudesCircle(eye, conductor, o, o.radius)) {
      blockedBy.push(o.id);
    }
  }
  return { outOfStage, degenerate, tooClose, blockedBy };
}

/** 一个可行候选位置 */
export interface UnblockCandidate {
  x: number;
  y: number;
  /** 相对原位置的位移距离（米） */
  distance: number;
}

/** 网格采样的不可行原因统计（同一采样点可命中多种原因） */
export interface UnblockStats {
  /** 网格采样点总数 */
  sampled: number;
  /** 可行采样点数 */
  feasible: number;
  /** 因视线被其他站位圆侵入而不可行 */
  losBlocked: number;
  /** 因与其他站位间距不足而不可行 */
  tooClose: number;
  /** 因超出舞台而不可行（网格本身在界内，正常为 0） */
  outOfStage: number;
  /** 因与指挥重合（视线退化）而不可行 */
  degenerate: number;
}

export interface UnblockSearchResult {
  singerId: string;
  /** 原位置 */
  origin: Vec;
  /** 原位置是否已满足全部约束（无需移动） */
  originFeasible: boolean;
  /** 候选位置，按位移升序，最多 maxCandidates 个 */
  candidates: UnblockCandidate[];
  stats: UnblockStats;
  /** 实际使用的网格步长（米） */
  gridStep: number;
}

export interface UnblockOptions {
  /** 网格步长（米），默认按舞台尺寸自适应（约 0.1–0.5 m） */
  gridStep?: number;
  /** 模式搜索的最小步长（米），默认 0.01 */
  refineStepMin?: number;
  /** 返回的候选数量，默认 3 */
  maxCandidates?: number;
  /** 参与细化搜索的可行种子数量，默认 10 */
  seedCount?: number;
}

/** 默认网格步长：短边的 1/32，钳制到 [0.1, 0.5] 米 */
function defaultGridStep(width: number, depth: number): number {
  return Math.min(0.5, Math.max(0.1, Math.min(width, depth) / 32));
}

/** 模式搜索：从 start 出发，在保持可行的前提下逐步缩短到原点的位移 */
function refineToward(
  start: Vec,
  origin: Vec,
  feasible: (x: number, y: number) => boolean,
  step0: number,
  minStep: number,
): Vec {
  const SQRT1_2 = Math.SQRT1_2;
  const dirs: ReadonlyArray<readonly [number, number]> = [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
    [SQRT1_2, SQRT1_2],
    [SQRT1_2, -SQRT1_2],
    [-SQRT1_2, SQRT1_2],
    [-SQRT1_2, -SQRT1_2],
  ];
  let p = start;
  let best = Math.hypot(p.x - origin.x, p.y - origin.y);
  let step = step0;
  let guard = 0;
  while (step >= minStep && guard++ < 500) {
    let moved = false;
    for (const [dx, dy] of dirs) {
      const nx = p.x + dx * step;
      const ny = p.y + dy * step;
      const d = Math.hypot(nx - origin.x, ny - origin.y);
      if (d < best - 1e-12 && feasible(nx, ny)) {
        p = { x: nx, y: ny };
        best = d;
        moved = true;
        break; // 接受首个改进方向，重新扫描
      }
    }
    if (!moved) step /= 2;
  }
  return p;
}

/**
 * 为指定演唱者搜索最小位移的解遮挡位置。
 * 返回 null 表示 singerId 不存在；不会修改传入的 scene。
 */
export function findUnblockPositions(
  scene: Scene,
  singerId: string,
  options: UnblockOptions = {},
): UnblockSearchResult | null {
  const singer = scene.singers.find((s) => s.id === singerId);
  if (!singer) return null;
  const others = scene.singers.filter((s) => s.id !== singerId);
  const { width: W, depth: D } = scene.stage;
  const origin: Vec = { x: singer.x, y: singer.y };

  const gridStep = options.gridStep ?? defaultGridStep(W, D);
  const minStep = options.refineStepMin ?? 0.01;
  const maxCandidates = options.maxCandidates ?? 3;
  const seedCount = options.seedCount ?? 10;

  const check = (x: number, y: number) =>
    checkPlacement(scene.stage, scene.conductor, others, singer.radius, x, y);
  const feasible = (x: number, y: number) => isFeasible(check(x, y));

  // ---- 1. 网格采样：收集可行点并统计不可行原因 ----
  const stats: UnblockStats = {
    sampled: 0,
    feasible: 0,
    losBlocked: 0,
    tooClose: 0,
    outOfStage: 0,
    degenerate: 0,
  };
  const feasiblePoints: { p: Vec; d: number }[] = [];
  const nx = Math.max(1, Math.ceil(W / gridStep));
  const ny = Math.max(1, Math.ceil(D / gridStep));
  for (let i = 0; i <= nx; i++) {
    const x = Math.min(W, i * gridStep);
    for (let j = 0; j <= ny; j++) {
      const y = Math.min(D, j * gridStep);
      stats.sampled++;
      const v = check(x, y);
      if (isFeasible(v)) {
        stats.feasible++;
        feasiblePoints.push({ p: { x, y }, d: Math.hypot(x - origin.x, y - origin.y) });
      } else {
        if (v.outOfStage) stats.outOfStage++;
        if (v.degenerate) stats.degenerate++;
        if (v.tooClose.length > 0) stats.tooClose++;
        if (v.blockedBy.length > 0) stats.losBlocked++;
      }
    }
  }

  // ---- 2. 原位置直接判定（可能不在网格点上） ----
  const originFeasible = feasible(origin.x, origin.y);

  // ---- 3. 取位移最小的若干种子做细化 ----
  feasiblePoints.sort((a, b) => a.d - b.d);
  const refined: UnblockCandidate[] = [];
  if (originFeasible) refined.push({ x: origin.x, y: origin.y, distance: 0 });
  for (const seed of feasiblePoints.slice(0, seedCount)) {
    const p = refineToward(seed.p, origin, feasible, gridStep, minStep);
    refined.push({ x: p.x, y: p.y, distance: Math.hypot(p.x - origin.x, p.y - origin.y) });
  }

  // ---- 4. 按位移升序去重，取前 maxCandidates 个 ----
  refined.sort((a, b) => a.distance - b.distance);
  const candidates: UnblockCandidate[] = [];
  for (const c of refined) {
    if (candidates.some((k) => Math.hypot(k.x - c.x, k.y - c.y) < DEDUPE_EPS)) continue;
    candidates.push(c);
    if (candidates.length >= maxCandidates) break;
  }

  return { singerId, origin, originFeasible, candidates, stats, gridStep };
}
