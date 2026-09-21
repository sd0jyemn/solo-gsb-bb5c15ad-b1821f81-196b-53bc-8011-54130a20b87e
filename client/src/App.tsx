import { useEffect, useMemo, useRef, useState } from 'react';
import {
  analyzeScene,
  serializeScene,
  validateScene,
  type Analysis,
  type Scene,
} from '../../shared/geometry';
import {
  findUnblockPositions,
  type UnblockCandidate,
  type UnblockSearchResult,
} from '../../shared/unblock';
import { PRESETS, defaultScene } from './presets';
import { Stage, CONDUCTOR_ID } from './Stage';
import { Sidebar } from './Sidebar';

interface Notice {
  kind: 'info' | 'error' | 'success';
  text: string;
}

/** 解遮挡面板的预览状态：某演唱者的候选新位置 */
interface UnblockPreview {
  singerId: string;
  x: number;
  y: number;
}

function nextSingerIndex(scene: Scene): number {
  let max = 0;
  for (const s of scene.singers) {
    const m = /^S(\d+)$/i.exec(s.name);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

export default function App() {
  const [scene, setScene] = useState<Scene>(() => defaultScene());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [checking, setChecking] = useState(false);
  // 自动解遮挡：搜索结果与预览位置（均绑定具体演唱者，场景/选中变化即作废）
  const [unblock, setUnblock] = useState<{ singerId: string; result: UnblockSearchResult } | null>(
    null,
  );
  const [preview, setPreview] = useState<UnblockPreview | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const analysis: Analysis = useMemo(() => analyzeScene(scene), [scene]);

  // 场景或选中对象变化后，旧的搜索结果与预览不再可信，立即作废
  useEffect(() => {
    setUnblock(null);
    setPreview(null);
  }, [scene, selectedId]);

  // ---- 场景编辑 ----
  const updateSingers = (fn: (s: Scene['singers']) => Scene['singers']) =>
    setScene((sc) => ({ ...sc, singers: fn(sc.singers) }));

  const addSingerAt = (x: number, y: number) => {
    const n = nextSingerIndex(scene);
    const id = `s${Date.now().toString(36)}${n}`;
    updateSingers((list) => [...list, { id, name: `S${n}`, x, y, radius: 0.3 }]);
    setSelectedId(id);
  };

  const addSingerAuto = () => {
    // 依次尝试舞台中部空位
    const { width, depth } = scene.stage;
    const candidates = [
      { x: width / 2, y: depth / 2 },
      { x: width / 3, y: depth / 2 },
      { x: (2 * width) / 3, y: depth / 2 },
      { x: width / 2, y: depth / 3 },
      { x: width / 2, y: (2 * depth) / 3 },
    ];
    const spot =
      candidates.find(
        (c) => !scene.singers.some((s) => Math.hypot(s.x - c.x, s.y - c.y) < 0.8),
      ) ?? { x: width / 2, y: depth / 2 };
    addSingerAt(Number(spot.x.toFixed(2)), Number(spot.y.toFixed(2)));
  };

  const moveSinger = (id: string, x: number, y: number) =>
    updateSingers((list) => list.map((s) => (s.id === id ? { ...s, x, y } : s)));

  const moveConductor = (x: number, y: number) =>
    setScene((sc) => ({ ...sc, conductor: { x, y } }));

  const changeRadius = (id: string, radius: number) =>
    updateSingers((list) => list.map((s) => (s.id === id ? { ...s, radius } : s)));

  const rename = (id: string, name: string) =>
    updateSingers((list) => list.map((s) => (s.id === id ? { ...s, name } : s)));

  const removeSinger = (id: string) => {
    updateSingers((list) => list.filter((s) => s.id !== id));
    setSelectedId((sel) => (sel === id ? null : sel));
  };

  const loadPreset = (key: string) => {
    const preset = PRESETS.find((p) => p.key === key);
    if (!preset) return;
    setScene(preset.build());
    setSelectedId(null);
    setNotice({ kind: 'info', text: `已载入预设：${preset.label}` });
  };

  // ---- 自动解遮挡 ----
  const runUnblockSearch = () => {
    const singer = scene.singers.find((s) => s.id === selectedId);
    if (!singer) return;
    const result = findUnblockPositions(scene, singer.id);
    if (!result) return;
    setUnblock({ singerId: singer.id, result });
    setPreview(null);
    if (result.candidates.length === 0) {
      setNotice({
        kind: 'error',
        text: `未找到 ${singer.name} 的可行解遮挡位置，请调整场景后重试。`,
      });
    }
  };

  const previewCandidate = (c: UnblockCandidate) => {
    if (!unblock) return;
    setPreview({ singerId: unblock.singerId, x: c.x, y: c.y });
  };

  const applyPreview = () => {
    if (!preview) return;
    const singer = scene.singers.find((s) => s.id === preview.singerId);
    // 只移动被选中的演唱者；场景更新后 analysis 自动重算，遮挡统计实时刷新
    moveSinger(preview.singerId, preview.x, preview.y);
    setNotice({
      kind: 'success',
      text: `已应用解遮挡位移：${singer?.name ?? preview.singerId} → (${preview.x.toFixed(2)}, ${preview.y.toFixed(2)})`,
    });
  };

  // ---- 导出 / 导入 ----
  const exportJSON = () => {
    const blob = new Blob([serializeScene(scene)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'choir-scene.json';
    a.click();
    URL.revokeObjectURL(url);
    setNotice({ kind: 'success', text: '已导出场景 JSON 文件。' });
  };

  const importJSON = async (file: File) => {
    try {
      const text = await file.text();
      const raw: unknown = JSON.parse(text);
      const v = validateScene(raw);
      if (!v.ok) {
        setNotice({ kind: 'error', text: `导入失败：${v.errors.join('；')}` });
        return;
      }
      setScene(v.scene);
      setSelectedId(null);
      setNotice({ kind: 'success', text: `导入成功：${v.scene.singers.length} 名演唱者。` });
    } catch (err) {
      setNotice({ kind: 'error', text: `导入失败：${err instanceof Error ? err.message : String(err)}` });
    }
  };

  // ---- 服务器校验（POST /api/analyze，与本地结果对比）----
  const serverCheck = async () => {
    setChecking(true);
    try {
      const res = await fetch('/api/analyze', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: serializeScene(scene),
      });
      const data = (await res.json()) as
        | { ok: true; analysis: Analysis }
        | { ok: false; errors: string[] };
      if (!data.ok) {
        setNotice({ kind: 'error', text: `服务器拒绝场景：${data.errors.join('；')}` });
        return;
      }
      const local = analysis.summary;
      const remote = data.analysis.summary;
      const same =
        local.clear === remote.clear &&
        local.tangent === remote.tangent &&
        local.blocked === remote.blocked &&
        local.degenerate === remote.degenerate &&
        local.total === remote.total;
      setNotice(
        same
          ? { kind: 'success', text: `服务器校验一致 ✓（遮挡 ${remote.blocked} / 相切 ${remote.tangent} / 通畅 ${remote.clear}）` }
          : { kind: 'error', text: `服务器结果不一致：${JSON.stringify(remote)}` },
      );
    } catch {
      setNotice({ kind: 'error', text: '无法连接服务器（开发模式请先启动 server）。' });
    } finally {
      setChecking(false);
    }
  };

  return (
    <div className="app">
      <header className="toolbar">
        <h1>合唱视线遮挡检查台</h1>
        <div className="actions">
          <button onClick={addSingerAuto}>＋ 添加演唱者</button>
          <select defaultValue="" onChange={(e) => e.target.value && loadPreset(e.target.value)}>
            <option value="" disabled>
              载入预设…
            </option>
            {PRESETS.map((p) => (
              <option key={p.key} value={p.key}>
                {p.label}
              </option>
            ))}
          </select>
          <button onClick={exportJSON}>导出 JSON</button>
          <button onClick={() => fileInputRef.current?.click()}>导入 JSON</button>
          <input
            ref={fileInputRef}
            type="file"
            accept="application/json,.json"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) void importJSON(f);
              e.target.value = '';
            }}
          />
          <button onClick={() => void serverCheck()} disabled={checking}>
            {checking ? '校验中…' : '服务器校验'}
          </button>
        </div>
      </header>

      {notice && (
        <div className={`notice ${notice.kind}`} onClick={() => setNotice(null)}>
          {notice.text}
          <span className="dismiss">✕</span>
        </div>
      )}

      <main className="main">
        <div className="stage-wrap">
          <Stage
            scene={scene}
            analysis={analysis}
            selectedId={selectedId}
            preview={preview}
            onSelect={setSelectedId}
            onMoveSinger={moveSinger}
            onMoveConductor={moveConductor}
            onAddSingerAt={addSingerAt}
            onRadiusChange={changeRadius}
          />
          {selectedId === CONDUCTOR_ID && (
            <div className="conductor-hint">已选中指挥：拖动调整位置，点击空白处取消选择。</div>
          )}
        </div>
        <Sidebar
          scene={scene}
          analysis={analysis}
          selectedId={selectedId}
          unblockResult={unblock && unblock.singerId === selectedId ? unblock.result : null}
          unblockPreview={preview}
          onSelect={setSelectedId}
          onRadiusChange={changeRadius}
          onRename={rename}
          onRemove={removeSinger}
          onUnblockSearch={runUnblockSearch}
          onUnblockPreview={previewCandidate}
          onUnblockCancelPreview={() => setPreview(null)}
          onUnblockApply={applyPreview}
        />
      </main>
    </div>
  );
}
