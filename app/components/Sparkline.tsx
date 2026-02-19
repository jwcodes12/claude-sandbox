'use client';

import { useMemo } from 'react';
import type { ProbPoint } from '../lib/manifold';

interface SparklineProps {
  data: ProbPoint[];
  width?: number;
  height?: number;
}

export default function Sparkline({ data, width = 64, height = 26 }: SparklineProps) {
  const { path, color } = useMemo(() => {
    const pts = data.slice(-30);
    if (pts.length < 2) return { path: '', color: '#30D158' };

    const minP = Math.min(...pts.map(p => p.p));
    const maxP = Math.max(...pts.map(p => p.p));
    const range = maxP - minP || 1;

    const xScale = (i: number) => (i / (pts.length - 1)) * width;
    const yScale = (p: number) => height - ((p - minP) / range) * (height - 2) - 1;

    const path = pts
      .map((pt, i) => `${i === 0 ? 'M' : 'L'}${xScale(i).toFixed(1)},${yScale(pt.p).toFixed(1)}`)
      .join(' ');

    const isUp = pts[pts.length - 1].p >= pts[0].p;
    return { path, color: isUp ? '#30D158' : '#FF453A' };
  }, [data, width, height]);

  if (!path) return <div style={{ width, height }} />;

  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`}>
      <path
        d={path}
        fill="none"
        stroke={color}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
