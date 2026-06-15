import { excerpt, hashText, jaccard, keywordSet, slugify, stripHtml, topKeywords } from './text.js';

export function buildTopics(items, config) {
  const threshold = config.settings.ranking.clusterSimilarity;
  const clusters = [];

  for (const item of items) {
    const text = `${item.title} ${item.summary} ${(item.tags ?? []).join(' ')}`;
    const keywords = keywordSet(text);
    let best = null;
    let bestScore = 0;

    for (const cluster of clusters) {
      const score = jaccard(keywords, cluster.keywords);
      if (score > bestScore) {
        best = cluster;
        bestScore = score;
      }
    }

    if (best && bestScore >= threshold) {
      best.items.push({ ...item, relevance: bestScore });
      best.keywords = new Set([...best.keywords, ...keywords]);
    } else {
      clusters.push({
        items: [{ ...item, relevance: 1 }],
        keywords,
      });
    }
  }

  return clusters
    .map((cluster) => makeTopic(cluster, config))
    .filter((topic) => topic.items.length > 0)
    .sort((a, b) => b.hotness - a.hotness)
    .slice(0, config.settings.maxTopics);
}

function makeTopic(cluster, config) {
  const sortedItems = cluster.items
    .sort((a, b) => scoreItem(b) - scoreItem(a))
    .slice(0, config.settings.maxTopicItems);
  const lead = sortedItems[0];
  const keywords = topKeywords(sortedItems);
  const title = chooseTitle(sortedItems, keywords);
  const slug = `${slugify(title)}-${hashText(sortedItems.map((item) => item.id).sort().join(':'), 8)}`;
  const hotness = scoreCluster(sortedItems);
  const lane = topicLane(sortedItems);

  return {
    id: hashText(slug),
    slug,
    title,
    lane,
    keywords,
    hotness: Math.round(hotness),
    items: sortedItems,
    lead,
    article: fallbackArticle({
      id: hashText(slug),
      slug,
      title,
      lane,
      hotness: Math.round(hotness),
      keywords,
      items: sortedItems,
    }),
  };
}

function chooseTitle(items, keywords) {
  const weighted = [...items].sort((a, b) => {
    const sourceDelta = Number(b.sourceWeight ?? 1) - Number(a.sourceWeight ?? 1);
    if (sourceDelta !== 0) return sourceDelta;
    return Date.parse(b.publishedAt ?? b.fetchedAt) - Date.parse(a.publishedAt ?? a.fetchedAt);
  });
  const title = weighted.map(readableTitle).find(Boolean) ?? keywords.join(' ');
  return title.replace(/\s+/g, ' ').trim();
}

function readableTitle(item = {}) {
  const cleaned = cleanFeedTitle(item.title);
  if (!weakTitle(cleaned)) return cleaned;

  const fallbackSource = stripHtml(item.contentText || item.summary || '');
  const fallbackText = fallbackSource
    .split(/(?<=[.!?])\s+|\n+/)
    .map(cleanFeedTitle)
    .find((line) => !weakTitle(line));
  return fallbackText || titleFromTextUrl(fallbackSource) || titleFromUrl(item.url) || cleaned || item.sourceTitle;
}

function cleanFeedTitle(title = '') {
  return stripHtml(title)
    .replace(/^(?:r|re|rt|qt)(?:\s+by)?\s+(?:to\s+)?@[A-Za-z0-9_]+:\s*/i, '')
    .replace(/^@[A-Za-z0-9_]+:\s*/i, '')
    .replace(/https?:\/\/\S+/gi, '')
    .replace(/\b[a-z0-9.-]+\.[a-z]{2,}\/\S*/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function weakTitle(title = '') {
  const clean = title.trim();
  if (clean.length < 12) return true;
  if (/^comments$/i.test(clean)) return true;
  if (/^https?:\/\//i.test(clean)) return true;
  if (/^[a-z0-9.-]+\.[a-z]{2,}(?:\/|$)/i.test(clean)) return true;
  return false;
}

function titleFromTextUrl(text = '') {
  const match = stripHtml(text).match(/\b(?:https?:\/\/)?([a-z0-9.-]+\.[a-z]{2,})(\/[^\s]*)?/i);
  if (!match) return '';
  const host = match[1].replace(/^www\./, '');
  if (host.includes('xcancel.com')) return '';
  const pathTitle = bestPathTitle(match[2]);
  return pathTitle ? `${pathTitle} (${host})` : `Link from ${host}`;
}

function titleFromUrl(url = '') {
  try {
    const parsed = new URL(url);
    const host = parsed.hostname.replace(/^www\./, '');
    const pathTitle = bestPathTitle(parsed.pathname);
    return pathTitle ? `${pathTitle} (${host})` : host;
  } catch {
    return '';
  }
}

function bestPathTitle(pathname = '') {
  const generic = new Set(['article', 'blog', 'c', 'news', 'post', 'releases', 'stories', 'story', 'thread', 'writing']);
  return String(pathname)
    .split(/[/?#]/)[0]
    .split('/')
    .filter(Boolean)
    .reverse()
    .map((segment) => segment.replace(/[-_]+/g, ' ').replace(/\s+/g, ' ').trim())
    .find((segment) => segment.length > 8 && !/^\d+$/.test(segment) && !generic.has(segment.toLowerCase())) ?? '';
}

function scoreItem(item) {
  const ageHours = Math.max(0, (Date.now() - Date.parse(item.publishedAt ?? item.fetchedAt)) / 3_600_000);
  const recency = 1 / (1 + ageHours / 18);
  return recency * Number(item.sourceWeight ?? 1);
}

function scoreCluster(items) {
  const now = Date.now();
  const uniqueSources = new Set(items.map((item) => item.sourceId)).size;
  const uniqueKinds = new Set(items.map((item) => item.sourceKind)).size;
  const recentItems = items.filter((item) => now - Date.parse(item.publishedAt ?? item.fetchedAt) < 6 * 3_600_000).length;
  const averageWeight = items.reduce((sum, item) => sum + Number(item.sourceWeight ?? 1), 0) / items.length;
  const recency = items.reduce((sum, item) => {
    const ageHours = Math.max(0, (now - Date.parse(item.publishedAt ?? item.fetchedAt)) / 3_600_000);
    return sum + 28 / (1 + ageHours / 18);
  }, 0);

  return (
    recency +
    Math.log2(items.length + 1) * 13 +
    uniqueSources * 8 +
    uniqueKinds * 5 +
    recentItems * 6 +
    averageWeight * 7
  );
}

function topicLane(items) {
  const kindCounts = items.reduce((counts, item) => {
    counts.set(item.sourceKind, (counts.get(item.sourceKind) ?? 0) + 1);
    return counts;
  }, new Map());
  const twitterCount = kindCounts.get('twitter') ?? 0;
  const researchCount = kindCounts.get('research') ?? 0;
  if (twitterCount > 0 && twitterCount >= Math.max(1, items.length / 2)) return 'takes';
  if (researchCount > 0 && researchCount >= Math.max(1, items.length / 3)) return 'research';
  return 'news';
}

export function fallbackArticle(topic) {
  const sourceNames = [...new Set(topic.items.map((item) => item.sourceTitle))];
  const sourceKinds = [...new Set(topic.items.map((item) => item.sourceKind))];
  const lane = topic.lane ?? topicLane(topic.items);
  const sourceLine = sourceNames.length > 1
    ? `${sourceNames.slice(0, 4).join(', ')} are pointing at the same story.`
    : `${sourceNames[0] ?? 'One source'} surfaced this item.`;
  const lead = topic.items[0];
  const leadSummary = digestLeadText(lead, topic);
  return {
    id: topic.id,
    slug: topic.slug,
    title: topic.title,
    lane,
    hotness: topic.hotness,
    updatedAt: new Date().toISOString(),
    mode: 'digest',
    whyHot: sourceLine,
    shortTake: leadSummary,
    balancedTake: balancedDigestTake(lane, sourceKinds),
    strongestCase: concreteCase(topic.items),
    strongestCountercase: concreteCountercase(topic.items),
    researchQuestions: digestQuestions(lane),
    keywords: topic.keywords,
    sources: topic.items.map((item) => ({
      id: item.id,
      title: readableTitle(item),
      source: item.sourceTitle,
      sourceKind: item.sourceKind,
      author: item.author,
      url: item.url,
      publishedAt: item.publishedAt,
      excerpt: excerpt(item.summary || item.contentText, 520),
    })),
  };
}

function digestLeadText(item, topic) {
  const cleaned = cleanFeedTitle(item?.contentText || item?.summary || item?.title || topic.title);
  if (!weakTitle(cleaned)) return excerpt(cleaned, 520);
  return excerpt(readableTitle(item) || topic.title, 520);
}

function balancedDigestTake(lane, sourceKinds) {
  if (lane === 'takes') {
    return 'This is a take cluster, so treat the post text as signal about what people are reacting to, not proof that the underlying claim is settled.';
  }
  if (lane === 'research') {
    return 'This is a research/source cluster. The useful next step is checking the primary paper, benchmark, or release note before accepting social summaries.';
  }
  const kinds = sourceKinds.includes('community') ? 'community discussion' : 'source coverage';
  return `This is ${kinds}, not a finished analysis. It belongs in the news lane until it draws enough high-quality commentary or primary-source detail.`;
}

function concreteCase(items) {
  const sourceNames = [...new Set(items.map((item) => item.sourceTitle))];
  if (sourceNames.length > 1) return `It appears across ${sourceNames.slice(0, 3).join(', ')}, which makes it less likely to be a single-feed artifact.`;
  return 'The lead item is recent enough and relevant enough to keep on the radar.';
}

function concreteCountercase(items) {
  const twitterCount = items.filter((item) => item.sourceKind === 'twitter').length;
  if (twitterCount === items.length) return 'The cluster is entirely Twitter-sourced, so quote-tweets and repost chains may be inflating it.';
  if (items.length === 1) return 'There is only one item in the cluster, so it may not deserve a full brief yet.';
  return 'The sources may be repeating the same upstream link rather than adding independent reporting or technical detail.';
}

function digestQuestions(lane) {
  if (lane === 'takes') {
    return [
      'What exact claim are people reacting to?',
      'Is there a primary source behind the quote-tweet chain?',
      'Which credible counter-take is missing from the cluster?',
    ];
  }
  if (lane === 'research') {
    return [
      'What does the primary paper or release actually claim?',
      'Are there independent replications, benchmarks, or critiques?',
      'What assumption would change the practical takeaway?',
    ];
  }
  return [
    'What is the original source?',
    'Is there independent reporting or just repeated aggregation?',
    'Does this matter beyond the immediate product or platform news cycle?',
  ];
}
