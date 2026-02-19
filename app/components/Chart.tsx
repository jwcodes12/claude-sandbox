'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ProbPoint } from '../lib/manifold';

type Range = '1D' | '1W' | '1M' | '3M' | '1Y' | 'ALL';

const RANGE_MS: Record<Range, number> = {
  '1D': 86_400_000,
  '1W': 7 * 86_400_000,
  '1M': 30 * 86_400_000,
  '3M': 90 * 86_400_000,
  '1Y': 365 * 86_400_000,
  'ALL': Infinity,
};

const RANGES: Range[] = ['1D', '1W', '1M', '3M', '1Y', 'ALL'];

const HEIGHT = 200;
const PAD_L = 36;
const PAD_R = 8;
const PAD_T = 12;
const PAD_B = 24;
const CHART_H = HEIGHT - PAD_T - PAD_B;

function downsample(pts: ProbPoint[], max: number): ProbPoint[] {
  if (pts.length <= max) return pts;
  const step = pts.length / max;
  return Array.from({ length: max }, (_, i) => pts[Math.floor(i * step)]);
}

export default function Chart({ data }: { data: ProbPoint[] }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const [width, setWidth] = useState(358);
  const [range, setRange] = useState<Range>('ALL');
  const [hoverIdx, setHoverIdx] = useState<number | null>(null);
  const pinchRef = useRef<{ dist: number; range: Range } | null>(null);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(entries => setWidth(entries[0].contentRect.width));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const chartW = width - PAD_L - PAD_R;

  const filtered = useMemo(() => {
    const ms = RANGE_MS[range];
    const now = Date.now();
    const raw = ms === Infinity ? data : data.filter(p => p.t >= now - ms);
    const src = raw.length >= 2 ? raw : data;
    return downsample(src, 400);
  }, [data, range]);

  const { yMin, yMax } = useMemo(() => {
    if (filtered.length === 0) return { yMin: 0, yMax: 100 };
    const minP = Math.min(...filtered.map(p => p.p));
    const maxP = Math.max(...filtered.map(p => p.p));
    const pad = (maxP - minP) * 0.15 || 10;
    return { yMin: Math.max(0, minP - pad), yMax: Math.min(100, maxP + pad) };
  }, [filtered]);

  const xScale = useCallback(
    (i: number) => PAD_L + (i / Math.max(filtered.length - 1, 1)) * chartW,
    [filtered.length, chartW]
  );

  const yScale = useCallback(
    (p: number) => PAD_T + (1 - (p - yMin) / Math.max(yMax - yMin, 1)) * CHART_H,
    [yMin, yMax]
  );

  const isUp = filtered.length >= 2 && filtered[filtered.length - 1].p >= filtered[0].p;
  const color = isUp ? '#30D158' : '#FF453A';

  const linePath = useMemo(() => {
    if (filtered.length < 2) return '';
    return filtered
      .map((pt, i) => `${i === 0 ? 'M' : 'L'}${xScale(i).toFixed(1)},${yScale(pt.p).toFixed(1)}`)
      .join(' ');
  }, [filtered, xScale, yScale]);

  const areaPath = useMemo(() => {
    if (!linePath || filtered.length === 0) return '';
    const bottom = PAD_T + CHART_H;
    return `${linePath} L${xScale(filtered.length - 1).toFixed(1)},${bottom} L${xScale(0).toFixed(1)},${bottom} Z`;
  }, [linePath, filtered.length, xScale]);

  const gridYs = [0, 25, 50, 75, 100].filter(v => v >= yMin - 5 && v <= yMax + 5);

  const xLabels = useMemo(() => {
    if (filtered.length < 2) return [];
    const indices = [0, Math.floor(filtered.length / 2), filtered.length - 1];
    const anchors = ['start', 'middle', 'end'] as const;
    return indices.map((dataIdx, i) => ({
      x: xScale(dataIdx),
      label: new Date(filtered[dataIdx].t).toLocaleDateString('en-US', {
        month: 'short',
        day: 'numeric',
      }),
      anchor: anchors[i],
    }));
  }, [filtered, xScale]);

  const handlePointerMove = useCallback(
    (e: React.PointerEvent) => {
      const svg = svgRef.current;
      if (!svg || filtered.length === 0) return;
      const rect = svg.getBoundingClientRect();
      const mx = e.clientX - rect.left - PAD_L;
      const idx = Math.round((mx / chartW) * (filtered.length - 1));
      setHoverIdx(Math.max(0, Math.min(idx, filtered.length - 1)));
    },
    [filtered.length, chartW]
  );

  const getPinchDist = (e: React.TouchEvent) => {
    if (e.touches.length < 2) return 0;
    const dx = e.touches[0].clientX - e.touches[1].clientX;
    const dy = e.touches[0].clientY - e.touches[1].clientY;
    return Math.sqrt(dx * dx + dy * dy);
  };

  const handleTouchStart = (e: React.TouchEvent) => {
    if (e.touches.length === 2) {
      pinchRef.current = { dist: getPinchDist(e), range };
    }
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    if (e.touches.length === 2 && pinchRef.current) {
      const newDist = getPinchDist(e);
      const ratio = newDist / pinchRef.current.dist;
      const currentIdx = RANGES.indexOf(range);
      if (ratio > 1.35 && currentIdx > 0) {
        const next = RANGES[currentIdx - 1];
        setRange(next);
        pinchRef.current = { dist: newDist, range: next };
      } else if (ratio < 0.72 && currentIdx < RANGES.length - 1) {
        const next = RANGES[currentIdx + 1];
        setRange(next);
        pinchRef.current = { dist: newDist, range: next };
      }
    }
  };

  const hoverPt = hoverIdx !== null ? filtered[hoverIdx] : null;
  const displayPt = hoverPt ?? (filtered.length > 0 ? filtered[filtered.length - 1] : null);
  const firstPt = filtered.length > 0 ? filtered[0] : null;
  const delta = displayPt && firstPt ? displayPt.p - firstPt.p : 0;

  return (
    <div ref={containerRef} style={{ width: '100%' }}>
      {/* Probability display */}
      <div style={{ padding: '4px 16px 8px' }}>
        <div style={{ fontSize: 44, fontWeight: 700, color, lineHeight: 1 }}>
          {displayPt ? `${displayPt.p}%` : '--'}
        </div>
        <div style={{ fontSize: 14, color: delta >= 0 ? '#30D158' : '#FF453A', marginTop: 4 }}>
          {delta >= 0 ? '+' : ''}
          {delta.toFixed(1)} pp
          {hoverPt
            ? ` · ${new Date(hoverPt.t).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })}`
            : ` · ${range === 'ALL' ? 'all time' : range}`}
        </div>
      </div>

      {/* SVG chart */}
      <svg
        ref={svgRef}
        width={width}
        height={HEIGHT}
        onPointerMove={handlePointerMove}
        onPointerLeave={() => setHoverIdx(null)}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        style={{ touchAction: 'none', display: 'block', userSelect: 'none' }}
      >
        <defs>
          <linearGradient id={`grad-${color.slice(1)}`} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.28" />
            <stop offset="100%" stopColor={color} stopOpacity="0.02" />
          </linearGradient>
        </defs>

        {/* Grid lines */}
        {gridYs.map(v => (
          <line
            key={v}
            x1={PAD_L}
            y1={yScale(v).toFixed(1)}
            x2={width - PAD_R}
            y2={yScale(v).toFixed(1)}
            stroke="#ffffff12"
            strokeWidth="1"
          />
        ))}

        {/* Y-axis labels */}
        {gridYs.map(v => (
          <text
            key={v}
            x={PAD_L - 4}
            y={parseFloat(yScale(v).toFixed(1)) + 4}
            textAnchor="end"
            fontSize="10"
            fill="#636366"
          >
            {v}%
          </text>
        ))}

        {/* X-axis labels */}
        {xLabels.map((l, i) => (
          <text
            key={i}
            x={l.x}
            y={HEIGHT - 4}
            textAnchor={l.anchor}
            fontSize="10"
            fill="#636366"
          >
            {l.label}
          </text>
        ))}

        {/* Area fill */}
        {areaPath && <path d={areaPath} fill={`url(#grad-${color.slice(1)})`} />}

        {/* Line */}
        {linePath && (
          <path
            d={linePath}
            fill="none"
            stroke={color}
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        )}

        {/* Crosshair */}
        {hoverIdx !== null && hoverPt && (
          <>
            <line
              x1={xScale(hoverIdx).toFixed(1)}
              y1={PAD_T}
              x2={xScale(hoverIdx).toFixed(1)}
              y2={PAD_T + CHART_H}
              stroke="#ffffff25"
              strokeWidth="1"
              strokeDasharray="3,3"
            />
            <circle
              cx={xScale(hoverIdx).toFixed(1)}
              cy={yScale(hoverPt.p).toFixed(1)}
              r="4"
              fill={color}
              stroke="#000"
              strokeWidth="2"
            />
          </>
        )}
      </svg>

      {/* Range pills */}
      <div
        style={{
          display: 'flex',
          gap: 2,
          padding: '6px 16px 2px',
          justifyContent: 'center',
        }}
      >
        {RANGES.map(r => (
          <button
            key={r}
            onClick={() => setRange(r)}
            style={{
              padding: '4px 11px',
              borderRadius: 20,
              border: 'none',
              background: range === r ? '#2C2C2E' : 'transparent',
              color: range === r ? '#fff' : '#636366',
              fontSize: 13,
              fontWeight: range === r ? 600 : 400,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            {r}
          </button>
        ))}
      </div>
    </div>
  );
}
