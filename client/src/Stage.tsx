import { useCallback, useEffect, useMemo, useRef } from 'react';
import { analyzeSinger, type Analysis, type Scene, type SingerLOS } from '../../shared/geometry';
import { identityColor } from './colors';

export const CONDUCTOR_ID = '__conductor__';

/** 解遮挡预览：某演唱者的候选新位置 */
interface PreviewPos {
  singerId: string;
  x: number;
  y: number;
}

interface StageProps {
  scene: Scene;
  analysis: Analysis;
  selectedId: string | null;
  preview?: PreviewPos | null;
  onSelect: (id: string | null) => void;
  onMoveSinger: (id: string, x: number, y: number) => void;
  onMoveConductor: (x: number, y: number) => void;
  onAddSingerAt: (x: number, y: number) => void;
  onRadiusChange: (id: string, radius: number) => void;
}

/** 舞台四周留白（米），y 负方向留给指挥活动区 */
const PAD = { left: 1.2, right: 1.2, top: 3.0, bottom: 1.0 };

function statusOf(results: SingerLOS[], id: string): SingerLOS | undefined {
  return results.find((r) => r.singerId === id);
}

export function Stage(props: StageProps) {
  const { scene, analysis, selectedId, preview } = props;
  const svgRef = useRef<SVGSVGElement>(null);
  const dragRef = useRef<{ id: string; dx: number; dy: number } | null>(null);

  const { width: W, depth: D } = scene.stage;
  const vb = useMemo(
    () => ({ x: -PAD.left, y: -PAD.top, w: W + PAD.left + PAD.right, h: D + PAD.top + PAD.bottom }),
    [W, D],
  );

  const toSceneCoords = useCallback(
    (clientX: number, clientY: number) => {
      const svg = svgRef.current;
      if (!svg) return { x: 0, y: 0 };
      const rect = svg.getBoundingClientRect();
      return {
        x: vb.x + ((clientX - rect.left) / rect.width) * vb.w,
        y: vb.y + ((clientY - rect.top) / rect.height) * vb.h,
      };
    },
    [vb],
  );

  const clampSinger = useCallback(
    (x: number, y: number) => ({
      x: Math.min(W, Math.max(0, x)),
      y: Math.min(D, Math.max(0, y)),
    }),
    [W, D],
  );
  const clampConductor = useCallback(
    (x: number, y: number) => ({
      x: Math.min(W + 1, Math.max(-1, x)),
      y: Math.min(D + 0.5, Math.max(-2.8, y)),
    }),
    [W, D],
  );

  // ---- 拖放 ----
  const onPointerDown = (e: React.PointerEvent, id: string) => {
    e.stopPropagation();
    (e.target as Element).setPointerCapture(e.pointerId);
    const p = toSceneCoords(e.clientX, e.clientY);
    const obj =
      id === CONDUCTOR_ID ? scene.conductor : scene.singers.find((s) => s.id === id);
    if (!obj) return;
    dragRef.current = { id, dx: obj.x - p.x, dy: obj.y - p.y };
    props.onSelect(id);
  };

  const onPointerMove = (e: React.PointerEvent) => {
    const drag = dragRef.current;
    if (!drag) return;
    const p = toSceneCoords(e.clientX, e.clientY);
    const x = p.x + drag.dx;
    const y = p.y + drag.dy;
    if (drag.id === CONDUCTOR_ID) {
      const c = clampConductor(x, y);
      props.onMoveConductor(c.x, c.y);
    } else {
      const c = clampSinger(x, y);
      props.onMoveSinger(drag.id, c.x, c.y);
    }
  };

  const onPointerUp = () => {
    dragRef.current = null;
  };

  // ---- 滚轮调整半径（需要非 passive 监听才能 preventDefault）----
  useEffect(() => {
    const svg = svgRef.current;
    if (!svg) return;
    const handler = (e: WheelEvent) => {
      const target = (e.target as Element).closest?.('[data-singer-id]');
      if (!target) return;
      e.preventDefault();
      const id = target.getAttribute('data-singer-id')!;
      const singer = props.scene.singers.find((s) => s.id === id);
      if (!singer) return;
      const delta = e.deltaY < 0 ? 0.02 : -0.02;
      const r = Math.min(1.0, Math.max(0.1, singer.radius + delta));
      props.onRadiusChange(id, Number(r.toFixed(2)));
    };
    svg.addEventListener('wheel', handler, { passive: false });
    return () => svg.removeEventListener('wheel', handler);
  }, [props]);

  const gridLines = useMemo(() => {
    const lines: React.ReactElement[] = [];
    for (let x = 0; x <= W; x += 1) {
      lines.push(<line key={`v${x}`} x1={x} y1={0} x2={x} y2={D} className="grid" />);
    }
    for (let y = 0; y <= D; y += 1) {
      lines.push(<line key={`h${y}`} x1={0} y1={y} x2={W} y2={y} className="grid" />);
    }
    return lines;
  }, [W, D]);

  const colorOf = useCallback(
    (singerId: string) => {
      const idx = scene.singers.findIndex((s) => s.id === singerId);
      return identityColor(idx < 0 ? 0 : idx);
    },
    [scene.singers],
  );

  const conductor = scene.conductor;

  // 解遮挡预览：候选位置的演唱者与视线状态（实时重算，确认前不修改场景）
  const previewSinger = preview
    ? scene.singers.find((s) => s.id === preview.singerId)
    : undefined;
  const previewLOS = useMemo(() => {
    if (!preview || !previewSinger) return null;
    return analyzeSinger(
      conductor,
      { ...previewSinger, x: preview.x, y: preview.y },
      scene.singers,
    );
  }, [preview, previewSinger, conductor, scene.singers]);

  return (
    <svg
      ref={svgRef}
      className="stage"
      viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`}
      onPointerMove={onPointerMove}
      onPointerUp={onPointerUp}
      onPointerLeave={onPointerUp}
      onPointerDown={() => props.onSelect(null)}
      onDoubleClick={(e) => {
        // 双击空白处才添加；落在站位圆/指挥上时忽略
        if ((e.target as Element).closest?.('[data-singer-id], .conductor')) return;
        const p = toSceneCoords(e.clientX, e.clientY);
        const c = clampSinger(p.x, p.y);
        props.onAddSingerAt(Number(c.x.toFixed(2)), Number(c.y.toFixed(2)));
      }}
    >
      {/* 舞台区域与网格 */}
      <defs>
        <marker
          id="preview-arrow"
          viewBox="0 0 10 10"
          refX="8"
          refY="5"
          markerWidth="7"
          markerHeight="7"
          orient="auto-start-reverse"
        >
          <path d="M0,0 L10,5 L0,10 z" className="preview-arrow-head" />
        </marker>
      </defs>
      <rect x={vb.x} y={vb.y} width={vb.w} height={vb.h} className="stage-bg" />
      <rect x={0} y={0} width={W} height={D} className="stage-floor" />
      {gridLines}
      <line x1={0} y1={0} x2={W} y2={0} className="stage-front" />
      <text x={0.1} y={-0.15} className="stage-label">
        舞台前沿（指挥区 y&lt;0）
      </text>
      <text x={W - 0.1} y={D - 0.15} className="stage-label" textAnchor="end">
        {W}m × {D}m · 双击空白处添加演唱者 · 滚轮调整半径
      </text>

      {/* 视线线段 */}
      {scene.singers.map((singer) => {
        const los = statusOf(analysis.results, singer.id);
        if (!los || los.status === 'degenerate') return null;
        const cls =
          los.status === 'blocked' ? 'los los-blocked' : los.status === 'tangent' ? 'los los-tangent' : 'los los-clear';
        const stroke = los.status === 'blocked' && los.nearest ? colorOf(los.nearest.blockerId) : undefined;
        return (
          <g key={`los-${singer.id}`}>
            <line
              x1={singer.x}
              y1={singer.y}
              x2={conductor.x}
              y2={conductor.y}
              className={cls}
              style={stroke ? { stroke } : undefined}
            />
            {/* 最近遮挡者的进入点标记 */}
            {los.nearest && (
              <circle
                cx={singer.x + (conductor.x - singer.x) * los.nearest.tEnter}
                cy={singer.y + (conductor.y - singer.y) * los.nearest.tEnter}
                r={0.07}
                className="los-enter"
                style={{ fill: colorOf(los.nearest.blockerId) }}
              />
            )}
          </g>
        );
      })}

      {/* 指挥 */}
      <g
        className={`conductor ${selectedId === CONDUCTOR_ID ? 'selected' : ''}`}
        transform={`translate(${conductor.x} ${conductor.y})`}
        onPointerDown={(e) => onPointerDown(e, CONDUCTOR_ID)}
      >
        <circle r={0.22} className="conductor-hit" />
        <path d="M0,-0.28 L0.24,0.18 L-0.24,0.18 Z" className="conductor-body" />
        <text y={0.5} textAnchor="middle" className="conductor-label">
          指挥
        </text>
      </g>

      {/* 演唱者站位圆 */}
      {scene.singers.map((singer, idx) => {
        const los = statusOf(analysis.results, singer.id);
        const idColor = identityColor(idx);
        let fill = 'rgba(34,197,94,0.35)'; // clear
        if (los?.status === 'blocked' && los.nearest) fill = colorOf(los.nearest.blockerId);
        else if (los?.status === 'tangent') fill = 'rgba(245,158,11,0.55)';
        else if (los?.status === 'degenerate') fill = 'rgba(148,163,184,0.5)';
        return (
          <g
            key={singer.id}
            data-singer-id={singer.id}
            className={`singer ${selectedId === singer.id ? 'selected' : ''}`}
            onPointerDown={(e) => onPointerDown(e, singer.id)}
          >
            <circle cx={singer.x} cy={singer.y} r={singer.radius} className="singer-hit" />
            <circle
              cx={singer.x}
              cy={singer.y}
              r={singer.radius}
              className="singer-body"
              style={{ fill, stroke: idColor }}
            />
            <text x={singer.x} y={singer.y} textAnchor="middle" dominantBaseline="central" className="singer-label">
              {singer.name}
            </text>
          </g>
        );
      })}

      {/* 解遮挡预览：位移箭头 + 候选站位虚线圈 + 候选视线 */}
      {preview && previewSinger && previewLOS && (
        <g className="unblock-preview">
          {Math.hypot(preview.x - previewSinger.x, preview.y - previewSinger.y) > 1e-9 && (
            <line
              x1={previewSinger.x}
              y1={previewSinger.y}
              x2={preview.x}
              y2={preview.y}
              className="preview-move"
              markerEnd="url(#preview-arrow)"
            />
          )}
          <line
            x1={preview.x}
            y1={preview.y}
            x2={conductor.x}
            y2={conductor.y}
            className={`los ${
              previewLOS.status === 'blocked'
                ? 'los-blocked'
                : previewLOS.status === 'tangent'
                  ? 'los-tangent'
                  : 'los-clear'
            }`}
          />
          <circle cx={preview.x} cy={preview.y} r={previewSinger.radius} className="preview-circle" />
          <text
            x={preview.x}
            y={preview.y}
            textAnchor="middle"
            dominantBaseline="central"
            className="singer-label preview-label"
          >
            {previewSinger.name}
          </text>
        </g>
      )}
    </svg>
  );
}
