/**
 * 合唱视线遮挡检查 —— 共享几何核心。
 *
 * 该模块同时被前端（实时分析）与后端（/api/analyze 校验）引用，保证两端判定结果一致。
 *
 * 判定语义（单位：米）：
 *  - 视线：演唱者眼睛（站位圆圆心）到指挥点的线段。
 *  - 遮挡：其他站位圆与视线线段相交（圆心到线段的距离 < 半径 - TANGENT_EPS）。
 *  - 相切：圆心到线段的距离与半径之差在 ±TANGENT_EPS 内，视为“擦边”，
 *          单独标注为 tangent，不判定为遮挡（线段与圆仅一个接触点）。
 *  - 重合：站位圆包含眼睛或指挥点时按相交处理（进入参数 t 被钳制到 0/1）；
 *          演唱者与指挥重合时视线退化（degenerate），单独标注。
 *  - 共线：多个遮挡圆按进入参数 tEnter 升序排列，最近的非相切遮挡者决定着色。
 */

export interface Vec {
  x: number;
  y: number;
}

export interface Singer {
  id: string;
  name: string;
  x: number;
  y: number;
  /** 人体半径（米），> 0 */
  radius: number;
}

export interface Scene {
  version: 1;
  /** 舞台尺寸（米）：宽 × 深 */
  stage: { width: number; depth: number };
  /** 指挥位置（舞台坐标，y<0 表示舞台前方） */
  conductor: Vec;
  singers: Singer[];
}

/** 相切判定容差（米）：|圆心距 - 半径| ≤ 该值视为相切 */
export const TANGENT_EPS = 1e-6;
/** 视线退化阈值：演唱者与指挥距离小于该值视为重合 */
const DEGENERATE_EPS = 1e-9;
/** 站位重合阈值：两圆心距离小于该值视为重合 */
const COINCIDE_EPS = 1e-9;

export type LOSStatus = 'clear' | 'tangent' | 'blocked' | 'degenerate';

export interface Occlusion {
  blockerId: string;
  blockerName: string;
  /** 视线进入遮挡圆时的参数 t（0 = 演唱者眼睛，1 = 指挥） */
  tEnter: number;
  /** 沿视线从眼睛到进入点的距离（米） */
  distance: number;
  /** 净余量 = 圆心到线段距离 - 半径；< 0 表示侵入（遮挡），≈0 表示相切 */
  clearance: number;
  /** 是否相切（擦边，不判定为遮挡） */
  tangent: boolean;
}

export interface SingerLOS {
  singerId: string;
  singerName: string;
  status: LOSStatus;
  /** 全部遮挡/相切事件，按 tEnter 升序（沿视线由近及远） */
  occlusions: Occlusion[];
  /** 最近的非相切遮挡者（决定该演唱者的着色）；无则 undefined */
  nearest?: Occlusion;
}

export interface SceneWarning {
  type: 'coincident-singers' | 'coincident-conductor';
  message: string;
  ids: string[];
}

export interface AnalysisSummary {
  total: number;
  clear: number;
  tangent: number;
  blocked: number;
  degenerate: number;
}

export interface Analysis {
  results: SingerLOS[];
  warnings: SceneWarning[];
  summary: AnalysisSummary;
}

/** 分析单个演唱者到指挥的视线。 */
export function analyzeSinger(conductor: Vec, singer: Singer, all: Singer[]): SingerLOS {
  const p0x = singer.x;
  const p0y = singer.y;
  const dx = conductor.x - p0x;
  const dy = conductor.y - p0y;
  const len2 = dx * dx + dy * dy;

  if (len2 < DEGENERATE_EPS * DEGENERATE_EPS) {
    return { singerId: singer.id, singerName: singer.name, status: 'degenerate', occlusions: [] };
  }
  const len = Math.sqrt(len2);

  const occlusions: Occlusion[] = [];
  for (const o of all) {
    if (o.id === singer.id) continue;
    if (!(o.radius > 0)) continue;

    // 圆心在线段上的投影参数（钳制到 [0,1]，正确处理端点外/包含端点的圆）
    const tRaw = ((o.x - p0x) * dx + (o.y - p0y) * dy) / len2;
    const t = tRaw < 0 ? 0 : tRaw > 1 ? 1 : tRaw;
    const qx = p0x + t * dx;
    const qy = p0y + t * dy;
    const dist = Math.hypot(o.x - qx, o.y - qy);
    const clearance = dist - o.radius;

    if (clearance < -TANGENT_EPS) {
      // 遮挡：求视线进入圆的参数（线段-圆求交，取较小根并钳制）
      const half = Math.sqrt(Math.max(0, o.radius * o.radius - dist * dist)) / len;
      let tEnter = t - half;
      if (tEnter < 0) tEnter = 0;
      else if (tEnter > 1) tEnter = 1;
      occlusions.push({
        blockerId: o.id,
        blockerName: o.name,
        tEnter,
        distance: tEnter * len,
        clearance,
        tangent: false,
      });
    } else if (clearance <= TANGENT_EPS) {
      // 相切（擦边）：记录但不判定为遮挡
      occlusions.push({
        blockerId: o.id,
        blockerName: o.name,
        tEnter: t,
        distance: t * len,
        clearance,
        tangent: true,
      });
    }
  }

  occlusions.sort((a, b) => a.tEnter - b.tEnter);
  const nearest = occlusions.find((o) => !o.tangent);
  const status: LOSStatus = nearest ? 'blocked' : occlusions.length > 0 ? 'tangent' : 'clear';
  return { singerId: singer.id, singerName: singer.name, status, occlusions, nearest };
}

/** 分析整个场景：每位演唱者的视线 + 全局警告 + 统计。 */
export function analyzeScene(scene: Scene): Analysis {
  const results = scene.singers.map((s) => analyzeSinger(scene.conductor, s, scene.singers));

  const warnings: SceneWarning[] = [];
  // 站位两两重合检查
  for (let i = 0; i < scene.singers.length; i++) {
    for (let j = i + 1; j < scene.singers.length; j++) {
      const a = scene.singers[i];
      const b = scene.singers[j];
      if (Math.hypot(a.x - b.x, a.y - b.y) < COINCIDE_EPS) {
        warnings.push({
          type: 'coincident-singers',
          message: `站位重合：${a.name} 与 ${b.name} 的圆心重合`,
          ids: [a.id, b.id],
        });
      }
    }
  }
  // 演唱者与指挥重合检查
  for (const s of scene.singers) {
    if (Math.hypot(s.x - scene.conductor.x, s.y - scene.conductor.y) < DEGENERATE_EPS) {
      warnings.push({
        type: 'coincident-conductor',
        message: `视线退化：${s.name} 与指挥位置重合`,
        ids: [s.id],
      });
    }
  }

  const summary: AnalysisSummary = { total: results.length, clear: 0, tangent: 0, blocked: 0, degenerate: 0 };
  for (const r of results) summary[r.status]++;

  return { results, warnings, summary };
}

// ---------------------------------------------------------------------------
// 场景校验 / 规范化（导入 JSON 与后端 API 共用）
// ---------------------------------------------------------------------------

export const LIMITS = {
  maxSingers: 500,
  minRadius: 0.05,
  maxRadius: 1.5,
  minStage: 2,
  maxStageWidth: 40,
  maxStageDepth: 30,
  coordAbsMax: 100,
} as const;

export type ValidateResult = { ok: true; scene: Scene } | { ok: false; errors: string[] };

function isFiniteNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

/** 校验并规范化未知输入为 Scene；失败时返回全部错误信息。 */
export function validateScene(raw: unknown): ValidateResult {
  const errors: string[] = [];
  if (typeof raw !== 'object' || raw === null) {
    return { ok: false, errors: ['场景必须是一个 JSON 对象'] };
  }
  const obj = raw as Record<string, unknown>;

  // stage
  const stageRaw = obj.stage as Record<string, unknown> | undefined;
  let stage = { width: 12, depth: 8 };
  if (typeof stageRaw !== 'object' || stageRaw === null) {
    errors.push('缺少 stage 对象（{ width, depth }）');
  } else if (!isFiniteNumber(stageRaw.width) || !isFiniteNumber(stageRaw.depth)) {
    errors.push('stage.width / stage.depth 必须是有限数字');
  } else if (
    stageRaw.width < LIMITS.minStage ||
    stageRaw.width > LIMITS.maxStageWidth ||
    stageRaw.depth < LIMITS.minStage ||
    stageRaw.depth > LIMITS.maxStageDepth
  ) {
    errors.push(
      `舞台尺寸超出范围：宽 ${LIMITS.minStage}~${LIMITS.maxStageWidth} m，深 ${LIMITS.minStage}~${LIMITS.maxStageDepth} m`,
    );
  } else {
    stage = { width: stageRaw.width, depth: stageRaw.depth };
  }

  // conductor
  const condRaw = obj.conductor as Record<string, unknown> | undefined;
  let conductor: Vec = { x: stage.width / 2, y: -1.5 };
  if (typeof condRaw !== 'object' || condRaw === null) {
    errors.push('缺少 conductor 对象（{ x, y }）');
  } else if (!isFiniteNumber(condRaw.x) || !isFiniteNumber(condRaw.y)) {
    errors.push('conductor.x / conductor.y 必须是有限数字');
  } else if (Math.abs(condRaw.x) > LIMITS.coordAbsMax || Math.abs(condRaw.y) > LIMITS.coordAbsMax) {
    errors.push('指挥坐标超出允许范围');
  } else {
    conductor = { x: condRaw.x, y: condRaw.y };
  }

  // singers
  const singersRaw = obj.singers;
  const singers: Singer[] = [];
  if (!Array.isArray(singersRaw)) {
    errors.push('缺少 singers 数组');
  } else if (singersRaw.length > LIMITS.maxSingers) {
    errors.push(`演唱者数量超过上限 ${LIMITS.maxSingers}`);
  } else {
    const seenIds = new Set<string>();
    singersRaw.forEach((item, i) => {
      const prefix = `singers[${i}]`;
      if (typeof item !== 'object' || item === null) {
        errors.push(`${prefix} 必须是对象`);
        return;
      }
      const s = item as Record<string, unknown>;
      const id = typeof s.id === 'string' && s.id.length > 0 ? s.id : `s${i + 1}`;
      if (seenIds.has(id)) {
        errors.push(`${prefix}.id 重复：${id}`);
        return;
      }
      seenIds.add(id);
      const name = typeof s.name === 'string' && s.name.length > 0 ? s.name : id.toUpperCase();
      if (!isFiniteNumber(s.x) || !isFiniteNumber(s.y)) {
        errors.push(`${prefix}.x / .y 必须是有限数字`);
        return;
      }
      if (Math.abs(s.x) > LIMITS.coordAbsMax || Math.abs(s.y) > LIMITS.coordAbsMax) {
        errors.push(`${prefix} 坐标超出允许范围`);
        return;
      }
      if (!isFiniteNumber(s.radius) || s.radius < LIMITS.minRadius || s.radius > LIMITS.maxRadius) {
        errors.push(`${prefix}.radius 必须在 ${LIMITS.minRadius}~${LIMITS.maxRadius} m 之间`);
        return;
      }
      singers.push({ id, name, x: s.x, y: s.y, radius: s.radius });
    });
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, scene: { version: 1, stage, conductor, singers } };
}

/** 序列化为可导入/导出的 JSON 字符串。 */
export function serializeScene(scene: Scene): string {
  return JSON.stringify(scene, null, 2);
}
