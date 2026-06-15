import fs from 'node:fs';
import YAML from 'yaml';
import { defaultDataDir, resolveFromRoot } from './paths.js';

function expandEnvString(value) {
  return value.replace(/\$\{([^}:]+)(?::-([^}]*))?\}/g, (_match, key, fallback = '') => {
    return process.env[key] ?? fallback;
  });
}

function expandEnv(value) {
  if (typeof value === 'string') {
    const expanded = expandEnvString(value);
    if (expanded === 'true') return true;
    if (expanded === 'false') return false;
    if (/^-?\d+(\.\d+)?$/.test(expanded)) return Number(expanded);
    return expanded;
  }
  if (Array.isArray(value)) return value.map(expandEnv);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, expandEnv(nested)]));
  }
  return value;
}

export function loadConfig() {
  const file = resolveFromRoot('feeds.yaml');
  const parsed = expandEnv(YAML.parse(fs.readFileSync(file, 'utf8')));
  const settings = parsed.settings ?? {};
  const sources = (parsed.sources ?? [])
    .map((source) => {
      const base = { enabled: true, weight: 1, tags: [], ...source };
      const url = String(base.url ?? '').trim();
      // Newsboat-backed sources read from the local sqlite cache and have no
      // HTTP url; give them a synthetic, descriptive url so they still satisfy
      // the sources table and pass the enabled/url filter below.
      base.url = url || (base.newsboat ? `newsboat:${newsboatLabel(base.newsboat)}` : '');
      return base;
    })
    .filter((source) => source.enabled && source.url.length > 0);

  return {
    ...parsed,
    settings: {
      title: 'Tech Radar',
      lookbackHours: 96,
      maxItemsPerFeed: 40,
      maxTopics: 24,
      maxTopicItems: 14,
      dataDir: defaultDataDir(),
      ...settings,
      schedule: {
        timezone: 'America/New_York',
        peakStartHour: 8,
        peakEndHour: 23,
        offPeakMinimumMinutes: 60,
        ...(settings.schedule ?? {}),
      },
      ranking: {
        clusterSimilarity: 0.22,
        minHotnessForBrief: 24,
        minItemsForBrief: 2,
        ...(settings.ranking ?? {}),
      },
      models: {
        enabled: false,
        provider: 'anthropic',
        smallModel: 'claude-3-5-haiku-latest',
        largeModel: 'claude-opus-4-1',
        ...(settings.models ?? {}),
      },
      newsboat: {
        cacheDb: '',
        ...(settings.newsboat ?? {}),
      },
      deploy: {
        provider: 'netlify',
        ...(settings.deploy ?? {}),
      },
    },
    sources,
  };
}

function newsboatLabel(spec) {
  if (spec.match) return spec.match;
  if (Array.isArray(spec.feeds) && spec.feeds.length > 0) return spec.feeds.join(',');
  return 'all';
}
