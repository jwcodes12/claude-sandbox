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
  const lane = topic.lane ?? topicLane(topic.items);
  const lead = topic.items[0];
  const summary = digestSummary(lead, topic, sourceNames);
  return {
    id: topic.id,
    slug: topic.slug,
    title: topic.title,
    lane,
    hotness: topic.hotness,
    updatedAt: new Date().toISOString(),
    mode: 'digest',
    summary,
    // shortTake / whyHot kept for the topic-list preview in build-site.js.
    shortTake: summary,
    whyHot: summary,
    body: digestBody(topic, sourceNames),
    keywords: topic.keywords,
    sources: topic.items.map((item) => ({
      id: item.id,
      title: readableTitle(item),
      source: item.sourceTitle,
      sourceKind: item.sourceKind,
      author: item.author,
      url: item.url,
      publishedAt: item.publishedAt,
      text: sourceFullText(item),
      excerpt: excerpt(item.summary || item.contentText, 520),
    })),
  };
}

// One or two sentences framing the topic for the list preview and body intro.
function digestSummary(lead, topic, sourceNames) {
  const leadRaw = cleanFeedTitle(lead?.contentText || lead?.summary || lead?.title || topic.title);
  const leadText = weakTitle(leadRaw) ? (readableTitle(lead) || topic.title) : leadRaw;
  const who = sourceNames.length > 1
    ? `${sourceNames.slice(0, 3).join(', ')} are converging on this.`
    : `${sourceNames[0] ?? 'One source'} surfaced this.`;
  return `${who} ${excerpt(leadText, 240)}`.replace(/\s+/g, ' ').trim();
}

// Deterministic Zvi-style roundup: framing line, then each source quoted verbatim
// as an attributed blockquote.
function digestBody(topic, sourceNames) {
  const intro = sourceNames.length > 1
    ? `${sourceNames.slice(0, 3).join(', ')} are converging on this.`
    : `${sourceNames[0] ?? 'One source'} surfaced this.`;
  const blocks = [intro];
  for (const item of topic.items.slice(0, 8)) {
    const quote = quoteText(item);
    if (!quote) continue;
    const who = String(item.author || item.sourceTitle || 'source').trim();
    const quoted = quote.split('\n').map((line) => `> ${line}`.replace(/\s+$/, '')).join('\n');
    blocks.push(`${quoted}\n>\n> \u2014 [${mdEscape(who)}](${item.url})`);
  }
  return blocks.join('\n\n');
}

// Tweets are quoted in full (the point is to see the whole take); long blog/article
// bodies are trimmed.
function quoteText(item) {
  const raw = sourceTextCandidate(item);
  if (!raw) return '';
  if (item.sourceKind === 'twitter') return raw.replace(/\n{3,}/g, '\n\n');
  return excerpt(raw, 700);
}

function sourceFullText(item) {
  const raw = sourceTextCandidate(item);
  if (item.sourceKind === 'twitter') return raw;
  return excerpt(raw, 1200);
}

function sourceTextCandidate(item) {
  const raw = stripHtml(item.contentText || item.summary || item.title || '').trim();
  const cleaned = cleanFeedTitle(raw);
  if (!weakTitle(cleaned)) return raw;
  return readableTitle(item) || cleaned || raw;
}

function mdEscape(text) {
  return String(text).replace(/[\[\]()]/g, '\\$&');
}
