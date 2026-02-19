export interface Market {
  id: string;
  question: string;
  slug: string;
  probability: number;
  volume: number;
  uniqueBettorCount: number;
  closeTime?: number;
  createdTime: number;
  url: string;
  outcomeType: string;
}

export interface Bet {
  createdTime: number;
  probAfter: number;
}

export type ProbPoint = { t: number; p: number };

const BASE = 'https://api.manifold.markets/v0';

export async function fetchMarketBySlug(slug: string): Promise<Market> {
  const res = await fetch(`${BASE}/slug/${slug}`);
  if (!res.ok) throw new Error(`Failed to fetch ${slug}`);
  return res.json();
}

export async function searchMarkets(): Promise<Market[]> {
  const res = await fetch(
    `${BASE}/search-markets?term=AGI+artificial+general+intelligence&sort=liquidity&filter=open&limit=14`
  );
  if (!res.ok) throw new Error('Search failed');
  return res.json();
}

export async function fetchBets(contractId: string): Promise<Bet[]> {
  const res = await fetch(`${BASE}/bets?contractId=${contractId}&limit=2000`);
  if (!res.ok) throw new Error(`Failed to fetch bets for ${contractId}`);
  return res.json();
}

export function betsToSeries(bets: Bet[]): ProbPoint[] {
  return [...bets]
    .sort((a, b) => a.createdTime - b.createdTime)
    .map(b => ({ t: b.createdTime, p: Math.round(b.probAfter * 100) }));
}
