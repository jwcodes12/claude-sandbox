'use client';

import Chart from './Chart';
import type { Market, ProbPoint } from '../lib/manifold';

interface DetailViewProps {
  market: Market;
  series: ProbPoint[];
  onBack: () => void;
}

function StatCard({ label, value, color }: { label: string; value: string; color?: string }) {
  return (
    <div
      style={{
        background: '#1C1C1E',
        borderRadius: 12,
        padding: '12px 14px',
      }}
    >
      <div style={{ fontSize: 12, color: '#636366', marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 16, fontWeight: 600, color: color ?? '#fff' }}>{value}</div>
    </div>
  );
}

function fmtDate(ts?: number) {
  if (!ts) return 'N/A';
  return new Date(ts).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export default function DetailView({ market, series, onBack }: DetailViewProps) {
  const prob = Math.round(market.probability * 100);
  const color = prob >= 50 ? '#30D158' : '#FF453A';

  return (
    <div style={{ background: '#000', minHeight: '100vh', color: '#fff' }}>
      {/* Header */}
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          padding: '16px 16px 8px',
          position: 'sticky',
          top: 0,
          background: '#000',
          zIndex: 10,
        }}
      >
        <button
          onClick={onBack}
          style={{
            background: 'none',
            border: 'none',
            color: '#0A84FF',
            fontSize: 16,
            cursor: 'pointer',
            padding: '4px 0',
            fontFamily: 'inherit',
            display: 'flex',
            alignItems: 'center',
            gap: 2,
          }}
        >
          ‹ Markets
        </button>
        <div style={{ flex: 1, textAlign: 'center', fontSize: 13, color: '#636366' }}>
          Manifold
        </div>
        <div style={{ width: 80 }} />
      </div>

      {/* Question */}
      <div style={{ padding: '4px 16px 12px' }}>
        <h2 style={{ fontSize: 18, fontWeight: 700, lineHeight: 1.35, color: '#fff' }}>
          {market.question}
        </h2>
      </div>

      {/* Chart */}
      <Chart data={series} />

      {/* Stats grid */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: '1fr 1fr',
          gap: 10,
          padding: '12px 16px',
        }}
      >
        <StatCard label="Probability" value={`${prob}%`} color={color} />
        <StatCard label="Volume" value={`$${Math.round(market.volume).toLocaleString()}`} />
        <StatCard label="Traders" value={market.uniqueBettorCount.toLocaleString()} />
        <StatCard label="Bets" value={series.length.toLocaleString()} />
        <StatCard label="Closes" value={fmtDate(market.closeTime)} />
        <StatCard label="Created" value={fmtDate(market.createdTime)} />
      </div>

      {/* Trade button */}
      <div style={{ padding: '8px 16px 32px' }}>
        <a
          href={market.url}
          target="_blank"
          rel="noopener noreferrer"
          style={{
            display: 'block',
            textAlign: 'center',
            background: '#0A84FF',
            color: '#fff',
            padding: '14px',
            borderRadius: 12,
            textDecoration: 'none',
            fontSize: 16,
            fontWeight: 600,
          }}
        >
          Trade on Manifold →
        </a>
      </div>
    </div>
  );
}
