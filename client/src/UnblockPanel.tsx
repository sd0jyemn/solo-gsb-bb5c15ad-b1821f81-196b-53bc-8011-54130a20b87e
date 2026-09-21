import { analyzeSinger, type Scene, type Singer, type SingerLOS } from '../../shared/geometry';
import type { UnblockCandidate, UnblockSearchResult } from '../../shared/unblock';

interface UnblockPanelProps {
  scene: Scene;
  /** 当前选中的演唱者 */
  singer: Singer;
  /** 最近一次搜索结果（属于该演唱者时才有意义） */
  result: UnblockSearchResult | null;
  /** 正在预览的候选位置 */
  preview: { x: number; y: number } | null;
  onSearch: () => void;
  onPreview: (c: UnblockCandidate) => void;
  onCancelPreview: () => void;
  onApply: () => void;
}

const STATUS_LABEL: Record<SingerLOS['status'], string> = {
  clear: '通畅',
  tangent: '相切',
  blocked: '被遮挡',
  degenerate: '退化',
};

function fmt(n: number): string {
  return n.toFixed(2);
}

/** 不可行原因统计 → 中文片段（仅列出非零项；同一采样点可命中多种原因） */
function failureReasons(r: UnblockSearchResult): string[] {
  const s = r.stats;
  const parts: string[] = [];
  if (s.losBlocked > 0) parts.push(`视线被挡 ${s.losBlocked}`);
  if (s.tooClose > 0) parts.push(`间距不足 ${s.tooClose}`);
  if (s.outOfStage > 0) parts.push(`超出舞台 ${s.outOfStage}`);
  if (s.degenerate > 0) parts.push(`与指挥重合 ${s.degenerate}`);
  return parts;
}

export function UnblockPanel(props: UnblockPanelProps) {
  const { scene, singer, result, preview } = props;

  // 候选位置的视线状态（应为通畅/相切，用于预览前确认效果）
  const candidateLOS = (c: UnblockCandidate): SingerLOS =>
    analyzeSinger(scene.conductor, { ...singer, x: c.x, y: c.y }, scene.singers);

  const isPreviewing = (c: UnblockCandidate) =>
    preview !== null && Math.hypot(preview.x - c.x, preview.y - c.y) < 1e-9;

  return (
    <section className="panel unblock">
      <h3>自动解遮挡</h3>
      <p className="hint">
        为 <b>{singer.name}</b>{' '}
        搜索最小位移的新站位：视线不被侵入、与其他站位保持半径和间距、留在舞台内。只移动该演唱者，不修改其他人。
      </p>
      <button className="primary" onClick={props.onSearch}>
        🔍 搜索可行位置
      </button>

      {result && (
        <div className="unblock-result">
          {result.originFeasible && (
            <p className="unblock-note ok">✓ 当前位置已满足全部条件，无需移动；以下为备选位置。</p>
          )}

          {result.candidates.length === 0 ? (
            <div className="unblock-empty">
              <b>未找到可行位置。</b>
              <p>
                在 {result.stats.sampled} 个网格采样点及细化邻域内，没有同时满足全部约束的位置。
              </p>
              {failureReasons(result).length > 0 && (
                <p>不可行原因（可叠加）：{failureReasons(result).join('、')}。</p>
              )}
              <p>建议：缩小人体半径、调整其他站位或指挥位置后重试。</p>
            </div>
          ) : (
            <>
              <h4>候选位置（按位移升序，前 {result.candidates.length} 个）</h4>
              <ul className="candidate-list">
                {result.candidates.map((c, i) => {
                  const los = candidateLOS(c);
                  const active = isPreviewing(c);
                  return (
                    <li key={i} className={active ? 'previewing' : ''}>
                      <div className="candidate-info">
                        <b>#{i + 1}</b> 位移 {fmt(c.distance)} m → ({fmt(c.x)}, {fmt(c.y)})
                        <span className={`badge ${los.status}`}>{STATUS_LABEL[los.status]}</span>
                      </div>
                      <div className="candidate-actions">
                        {active ? (
                          <>
                            <button className="primary" onClick={props.onApply}>
                              确认应用
                            </button>
                            <button onClick={props.onCancelPreview}>取消</button>
                          </>
                        ) : (
                          <button onClick={() => props.onPreview(c)}>预览</button>
                        )}
                      </div>
                    </li>
                  );
                })}
              </ul>
              {preview && <p className="hint">预览中：舞台上蓝色虚线圈为新站位，确认后生效。</p>}
            </>
          )}

          <p className="unblock-stats">
            采样 {result.stats.sampled} 点 · 可行 {result.stats.feasible}
            {failureReasons(result).length > 0 &&
              ` · 不可行：${failureReasons(result).join('、')}`}
          </p>
        </div>
      )}
    </section>
  );
}
