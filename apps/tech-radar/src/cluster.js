import { excerpt, hashText, jaccard, keywordSet, slugify, topKeywords } from './text.js';

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

  return {
    id: hashText(slug),
    slug,
    title,
    keywords,
    hotness: Math.round(hotness),
    items: sortedItems,
    lead,
    article: fallbackArticle({
      id: hashText(slug),
      slug,
      title,
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
  const title = weighted[0]?.title ?? keywords.join(' ');
  return title.replace(/\s+/g, ' ').trim();
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

export function fallbackArticle(topic) {
  const sourceNames = [...new Set(topic.items.map((item) => item.sourceTitle))];
  const sourceLine = sourceNames.length > 1
    ? `${sourceNames.slice(0, 4).join(', ')} are all touching the same cluster.`
    : `${sourceNames[0] ?? 'One source'} is carrying this cluster.`;
  const leadSummary = excerpt(topic.items[0]?.summary || topic.items[0]?.contentText || topic.title, 420);
  return {
    id: topic.id,
    slug: topic.slug,
    title: topic.title,
    hotness: topic.hotness,
    updatedAt: new Date().toISOString(),
    mode: 'deterministic',
    whyHot: sourceLine,
    shortTake: leadSummary,
    balancedTake: 'This topic is worth watching, but the current evidence is mostly source clustering and recency. Treat it as a prompt for follow-up rather than a settled conclusion.',
    strongestCase: 'Multiple independent sources or communities are discussing adjacent claims.',
    strongestCountercase: 'The cluster may be driven by reposting, a single launch cycle, or repeated commentary around one primary source.',
    researchQuestions: [
      'What is the original primary source?',
      'Are independent technical details available?',
      'Which claim would change the conclusion if false?',
    ],
    keywords: topic.keywords,
    sources: topic.items.map((item) => ({
      id: item.id,
      title: item.title,
      source: item.sourceTitle,
      sourceKind: item.sourceKind,
      author: item.author,
      url: item.url,
      publishedAt: item.publishedAt,
      excerpt: excerpt(item.summary || item.contentText, 520),
    })),
  };
}
