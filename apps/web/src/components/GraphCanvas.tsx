import { useEffect, useRef } from 'react';
import { forceCenter, forceCollide, forceLink, forceManyBody, forceSimulation, type SimulationLinkDatum, type SimulationNodeDatum } from 'd3-force';
import type { ItemSummary } from '../lib/api.ts';

export interface GraphData {
  center: string;
  nodes: ItemSummary[];
  edges: Array<{ source: string; target: string; kind: string }>;
}

interface N extends SimulationNodeDatum {
  id: string;
  item: ItemSummary;
  r: number;
}
type L = SimulationLinkDatum<N> & { kind: string };

const COLORS = {
  note: '#2b2823',
  source: '#2e5b4e',
  project: '#a8843a',
  memory: '#8a7f6e',
  collection: '#a8843a',
};
function colorFor(t: string) {
  if (t === 'note') return COLORS.note;
  if (t === 'project' || t === 'collection') return COLORS.project;
  if (t === 'memory') return COLORS.memory;
  return COLORS.source;
}

/**
 * Force-directed neighbourhood graph on a canvas. Positions persist across data updates so
 * expanding a node grows the graph outward instead of reshuffling it.
 */
export function GraphCanvas({
  data,
  height = 520,
  onSelect,
  onOpen,
  labels = true,
  selected,
}: {
  data: GraphData | undefined;
  height?: number;
  onSelect?: (id: string) => void;
  onOpen?: (id: string) => void;
  labels?: boolean;
  selected?: string;
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const positions = useRef(new Map<string, { x: number; y: number }>());
  const view = useRef({ x: 0, y: 0, k: 1 });
  const userMoved = useRef(false);
  const cbs = useRef({ onSelect, onOpen });
  cbs.current = { onSelect, onOpen };

  useEffect(() => {
    const el = canvas.current;
    if (!el || !data) return;
    const ctx = el.getContext('2d')!;
    const dpr = window.devicePixelRatio || 1;
    let width = el.clientWidth;
    const resize = () => {
      width = el.clientWidth;
      el.width = width * dpr;
      el.height = height * dpr;
    };
    resize();
    const degree = new Map<string, number>();
    for (const e of data.edges) {
      degree.set(e.source, (degree.get(e.source) ?? 0) + 1);
      degree.set(e.target, (degree.get(e.target) ?? 0) + 1);
    }
    const nodes: N[] = data.nodes.map((item) => {
      const p = positions.current.get(item.id);
      return {
        id: item.id,
        item,
        r: item.id === data.center ? 9 : 4.5 + Math.min(5, Math.sqrt(degree.get(item.id) ?? 0) * 1.4),
        x: p?.x ?? (Math.random() - 0.5) * 60,
        y: p?.y ?? (Math.random() - 0.5) * 60,
      };
    });
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const links: L[] = data.edges.filter((e) => byId.has(e.source) && byId.has(e.target)).map((e) => ({ source: e.source, target: e.target, kind: e.kind }));
    const centerNode = byId.get(data.center);
    if (centerNode && !positions.current.has(data.center)) {
      centerNode.fx = 0;
      centerNode.fy = 0;
    }
    let hover: N | null = null;
    let fitted = !!userMoved.current;
    /** Zoom so the whole neighbourhood is visible, once, unless the user already panned/zoomed. */
    const fit = () => {
      if (fitted || !nodes.length) return;
      fitted = true;
      const xs = nodes.map((n) => n.x!);
      const ys = nodes.map((n) => n.y!);
      const pad = labels ? 90 : 24;
      const w = Math.max(...xs) - Math.min(...xs) + pad * 2;
      const h = Math.max(...ys) - Math.min(...ys) + pad * 2;
      const k = Math.max(0.35, Math.min(1.6, Math.min(width / w, height / h)));
      view.current = { k, x: -((Math.max(...xs) + Math.min(...xs)) / 2) * k, y: -((Math.max(...ys) + Math.min(...ys)) / 2) * k };
    };

    const draw = () => {
      const { x: tx, y: ty, k } = view.current;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, width, height);
      ctx.translate(width / 2 + tx, height / 2 + ty);
      ctx.scale(k, k);
      for (const l of links) {
        const s = l.source as N;
        const t = l.target as N;
        ctx.beginPath();
        ctx.moveTo(s.x!, s.y!);
        ctx.lineTo(t.x!, t.y!);
        ctx.strokeStyle = l.kind === 'material' ? 'rgba(168,132,58,0.55)' : 'rgba(74,69,61,0.28)';
        ctx.lineWidth = l.kind === 'material' ? 1.4 / k : 1 / k;
        ctx.stroke();
      }
      for (const n of nodes) {
        ctx.beginPath();
        ctx.arc(n.x!, n.y!, n.r, 0, Math.PI * 2);
        const c = colorFor(n.item.type);
        ctx.fillStyle = n.item.type === 'note' || n.item.type === 'memory' ? '#fbf7ec' : c;
        ctx.fill();
        ctx.lineWidth = (n.id === data.center || n.id === selected ? 2.4 : 1.4) / k;
        ctx.strokeStyle = n.id === selected ? '#a8843a' : c;
        ctx.stroke();
      }
      if (labels) {
        ctx.font = `${12 / k}px "Literata Variable", Georgia, serif`;
        ctx.textAlign = 'center';
        for (const n of nodes) {
          const important = n.id === data.center || n === hover || n.id === selected || nodes.length < 40;
          if (!important && k < 1.2) continue;
          const label = n.item.title.length > 34 ? n.item.title.slice(0, 32) + '…' : n.item.title;
          ctx.fillStyle = 'rgba(240,233,216,0.85)';
          const w = ctx.measureText(label).width;
          ctx.fillRect(n.x! - w / 2 - 2 / k, n.y! + n.r + 3 / k, w + 4 / k, 15 / k);
          ctx.fillStyle = n.id === data.center ? '#2b2823' : '#4a453d';
          ctx.fillText(label, n.x!, n.y! + n.r + 14 / k);
        }
      }
    };

    const sim = forceSimulation<N>(nodes)
      .force('link', forceLink<N, L>(links).id((d) => d.id).distance(labels ? (nodes.length > 60 ? 70 : 125) : 50).strength(0.5))
      .force('charge', forceManyBody().strength(labels ? (nodes.length > 60 ? -200 : -520) : -160))
      .force('collide', forceCollide<N>().radius((d) => d.r + (labels ? 30 : 8)))
      .force('center', forceCenter(0, 0).strength(0.05))
      .alpha(positions.current.size ? 0.4 : 1)
      .on('tick', () => {
        for (const n of nodes) positions.current.set(n.id, { x: n.x!, y: n.y! });
        if (!fitted && sim.alpha() < 0.25) fit();
        draw();
      })
      .on('end', () => fit());
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      sim.stop();
      for (let i = 0; i < 200; i++) sim.tick();
      draw();
    }

    const toWorld = (ev: { clientX: number; clientY: number }) => {
      const rect = el.getBoundingClientRect();
      const { x: tx, y: ty, k } = view.current;
      return { x: (ev.clientX - rect.left - width / 2 - tx) / k, y: (ev.clientY - rect.top - height / 2 - ty) / k };
    };
    const hit = (ev: { clientX: number; clientY: number }) => {
      const p = toWorld(ev);
      let best: N | null = null;
      let bestD = Infinity;
      for (const n of nodes) {
        const d = Math.hypot(n.x! - p.x, n.y! - p.y);
        if (d < n.r + 6 / view.current.k && d < bestD) {
          best = n;
          bestD = d;
        }
      }
      return best;
    };
    let drag: { node: N | null; startX: number; startY: number; moved: boolean; vx: number; vy: number } | null = null;
    const down = (ev: PointerEvent) => {
      const n = hit(ev);
      drag = { node: n, startX: ev.clientX, startY: ev.clientY, moved: false, vx: view.current.x, vy: view.current.y };
      el.setPointerCapture(ev.pointerId);
    };
    const move = (ev: PointerEvent) => {
      if (!drag) {
        const n = hit(ev);
        if (n !== hover) {
          hover = n;
          el.style.cursor = n ? 'pointer' : 'grab';
          el.title = n ? n.item.title : '';
          draw();
        }
        return;
      }
      const dx = ev.clientX - drag.startX;
      const dy = ev.clientY - drag.startY;
      if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
      if (drag.node) {
        const p = toWorld(ev);
        drag.node.fx = p.x;
        drag.node.fy = p.y;
        sim.alphaTarget(0.2).restart();
      } else {
        view.current.x = drag.vx + dx;
        view.current.y = drag.vy + dy;
        userMoved.current = true;
        draw();
      }
    };
    const up = (ev: PointerEvent) => {
      if (drag?.node) {
        if (drag.node.id !== data.center) {
          drag.node.fx = null;
          drag.node.fy = null;
        }
        sim.alphaTarget(0);
        if (!drag.moved) cbs.current.onSelect?.(drag.node.id);
      }
      drag = null;
      el.releasePointerCapture(ev.pointerId);
    };
    const dbl = (ev: MouseEvent) => {
      const n = hit(ev);
      if (n) cbs.current.onOpen?.(n.id);
    };
    const wheel = (ev: WheelEvent) => {
      ev.preventDefault();
      const k = Math.max(0.3, Math.min(3, view.current.k * (ev.deltaY < 0 ? 1.1 : 0.9)));
      view.current.k = k;
      userMoved.current = true;
      draw();
    };
    el.addEventListener('pointerdown', down);
    el.addEventListener('pointermove', move);
    el.addEventListener('pointerup', up);
    el.addEventListener('dblclick', dbl);
    el.addEventListener('wheel', wheel, { passive: false });
    const ro = new ResizeObserver(() => {
      resize();
      draw();
    });
    ro.observe(el);
    return () => {
      sim.stop();
      ro.disconnect();
      el.removeEventListener('pointerdown', down);
      el.removeEventListener('pointermove', move);
      el.removeEventListener('pointerup', up);
      el.removeEventListener('dblclick', dbl);
      el.removeEventListener('wheel', wheel);
    };
  }, [data, height, labels, selected]);

  return (
    <canvas
      ref={canvas}
      style={{ width: '100%', height, touchAction: 'none', cursor: 'grab' }}
      className="block rounded-[3px]"
      role="img"
      aria-label={data ? `Graph of ${data.nodes.length} connected items` : 'Graph'}
      data-testid="graph-canvas"
      data-nodes={data?.nodes.length ?? 0}
    />
  );
}

export const GRAPH_LEGEND = [
  { label: 'notes', color: COLORS.note, hollow: true },
  { label: 'sources', color: COLORS.source },
  { label: 'projects', color: COLORS.project },
  { label: 'memories', color: COLORS.memory, hollow: true },
];
