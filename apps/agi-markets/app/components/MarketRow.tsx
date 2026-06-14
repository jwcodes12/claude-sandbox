'use client';

import Sparkline from './Sparkline';
import type { Market, ProbPoint } from '../lib/manifold';

interface MarketRowProps {
  market: Market;
  series: ProbPoint[];
  index: number;
  onClick: () => void;
}

export default function MarketRow({ market, series, index, onClick }: MarketRowProps) {
  const prob = Math.round(market.probability * 100);
  const color = prob >= 50 ? '#30D158' : '#FF453A';
  const delta = series.length >= 2 ? series[series.length - 1].p - series[0].p : 0;

  return (
    <div
      onClick={onClick}
      className="market-row"
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        padding: '11px 16px',
        borderBottom: '1px solid #1C1C1E',
        cursor: 'pointer',
        animationDelay: `${index * 55}ms`,
      }}
    >
      {/* Icon */}
      <div
        style={{
          width: 42,
          height: 42,
          borderRadius: 10,
          background: '#1C1C1E',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontSize: 22,
          flexShrink: 0,
        }}
      >
        🤖
      </div>

      {/* Text */}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div
          style={{
            fontSize: 14,
            fontWeight: 500,
            color: '#fff',
            display: '-webkit-box',
            WebkitLineClamp: 2,
            WebkitBoxOrient: 'vertical',
            overflow: 'hidden',
            lineHeight: 1.35,
          }}
        >
          {market.question}
        </div>
        <div style={{ fontSize: 12, color: '#636366', marginTop: 3 }}>
          ${Math.round(market.volume).toLocaleString()} · {market.uniqueBettorCount} traders
        </div>
      </div>

      {/* Sparkline */}
      <div style={{ flexShrink: 0 }}>
        <Sparkline data={series} />
      </div>

      {/* Probability */}
      <div style={{ textAlign: 'right', flexShrink: 0, minWidth: 46 }}>
        <div style={{ fontSize: 20, fontWeight: 700, color, lineHeight: 1 }}>{prob}%</div>
        <div style={{ fontSize: 12, color: delta >= 0 ? '#30D158' : '#FF453A', marginTop: 2 }}>
          {delta >= 0 ? '+' : ''}
          {delta.toFixed(1)}
        </div>
      </div>
    </div>
  );
}
