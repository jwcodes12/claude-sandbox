'use client';

import { useEffect, useState } from 'react';
import MarketRow from './components/MarketRow';
import DetailView from './components/DetailView';
import {
  fetchMarketBySlug,
  searchMarkets,
  fetchBets,
  betsToSeries,
  type Market,
  type ProbPoint,
} from './lib/manifold';

const PINNED_SLUGS = [
  'will-we-get-agi-before-2030',
  'will-we-develop-leopolds-dropin-rem',
];

export default function Home() {
  const [markets, setMarkets] = useState<Market[]>([]);
  const [series, setSeries] = useState<Record<string, ProbPoint[]>>({});
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Market | null>(null);

  useEffect(() => {
    async function load() {
      try {
        const [pinnedResults, searched] = await Promise.all([
          Promise.all(PINNED_SLUGS.map(s => fetchMarketBySlug(s).catch(() => null))),
          searchMarkets().catch(() => [] as Market[]),
        ]);

        const pinnedMarkets = pinnedResults.filter((m): m is Market => m !== null);
        const pinnedIds = new Set(pinnedMarkets.map(m => m.id));

        const extras = (searched as Market[])
          .filter(m => m.outcomeType === 'BINARY' && !pinnedIds.has(m.id))
          .slice(0, 12 - pinnedMarkets.length);

        const allMarkets = [...pinnedMarkets, ...extras];
        setMarkets(allMarkets);

        const betsAll = await Promise.all(
          allMarkets.map(m => fetchBets(m.id).catch(() => []))
        );

        const seriesMap: Record<string, ProbPoint[]> = {};
        allMarkets.forEach((m, i) => {
          seriesMap[m.id] = betsToSeries(betsAll[i]);
        });
        setSeries(seriesMap);
      } finally {
        setLoading(false);
      }
    }
    load();
  }, []);

  const avgProb =
    markets.length > 0
      ? Math.round(markets.reduce((s, m) => s + m.probability * 100, 0) / markets.length)
      : null;

  const avgColor = avgProb !== null && avgProb >= 50 ? '#30D158' : '#FF453A';

  if (selected) {
    return (
      <div style={{ maxWidth: 430, margin: '0 auto' }}>
        <DetailView
          market={selected}
          series={series[selected.id] ?? []}
          onBack={() => setSelected(null)}
        />
      </div>
    );
  }

  return (
    <div
      style={{
        background: '#000',
        minHeight: '100vh',
        color: '#fff',
        maxWidth: 430,
        margin: '0 auto',
      }}
    >
      {/* Header */}
      <div style={{ padding: '28px 16px 12px' }}>
        <h1 style={{ fontSize: 34, fontWeight: 700, letterSpacing: -0.5 }}>AGI Markets</h1>
        <div style={{ display: 'flex', alignItems: 'center', gap: 7, marginTop: 5 }}>
          <div className="pulse-dot" />
          <span style={{ fontSize: 13, color: '#636366' }}>Live · Manifold Markets</span>
        </div>
      </div>

      {/* Summary bar */}
      <div
        style={{
          margin: '0 16px 12px',
          background: '#1C1C1E',
          borderRadius: 14,
          padding: '14px 8px',
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-around', alignItems: 'center' }}>
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 22, fontWeight: 700, color: avgColor }}>
              {avgProb !== null ? `${avgProb}%` : '—'}
            </div>
            <div style={{ fontSize: 11, color: '#636366', marginTop: 3 }}>Avg Probability</div>
          </div>
          <div style={{ width: 1, height: 36, background: '#2C2C2E' }} />
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 22, fontWeight: 700 }}>
              {loading ? '—' : markets.length}
            </div>
            <div style={{ fontSize: 11, color: '#636366', marginTop: 3 }}>Markets</div>
          </div>
          <div style={{ width: 1, height: 36, background: '#2C2C2E' }} />
          <div style={{ textAlign: 'center' }}>
            <div style={{ fontSize: 22, fontWeight: 700, color: '#636366' }}>~2027</div>
            <div style={{ fontSize: 11, color: '#636366', marginTop: 3 }}>Consensus</div>
          </div>
        </div>
      </div>

      {/* Market list */}
      {loading ? (
        <div
          style={{
            textAlign: 'center',
            color: '#636366',
            padding: '48px 16px',
            fontSize: 15,
          }}
        >
          Loading markets…
        </div>
      ) : (
        markets.map((m, i) => (
          <MarketRow
            key={m.id}
            market={m}
            series={series[m.id] ?? []}
            index={i}
            onClick={() => setSelected(m)}
          />
        ))
      )}
    </div>
  );
}
