const state = {
  topics: [],
  selectedSlug: null,
  lane: 'takes',
};

const topicList = document.querySelector('#topic-list');
const laneTabs = document.querySelector('#lane-tabs');
const article = document.querySelector('#article');
const generatedAt = document.querySelector('#generated-at');

const LANES = [
  { id: 'takes', label: 'Takes' },
  { id: 'news', label: 'Newswire' },
  { id: 'research', label: 'Research' },
  { id: 'all', label: 'All' },
];

async function boot() {
  const data = await fetch('/data/topics.json', { cache: 'no-cache' }).then((response) => response.json());
  state.topics = data.topics ?? [];
  const params = new URL(location.href).searchParams;
  const requestedLane = params.get('lane');
  const requestedTopic = params.get('topic');
  if (LANES.some((lane) => lane.id === requestedLane)) state.lane = requestedLane;
  if (!requestedLane && requestedTopic) {
    state.lane = state.topics.find((topic) => topic.slug === requestedTopic)?.lane ?? state.lane;
  }
  if (!requestedLane && !requestedTopic) state.lane = defaultLane();
  const visible = visibleTopics();
  state.selectedSlug = requestedTopic || visible[0]?.slug || state.topics[0]?.slug || null;
  generatedAt.textContent = data.generatedAt ? `Updated ${formatTime(data.generatedAt)}` : 'No run yet';
  renderLaneTabs();
  renderTopics();
  await renderArticle();
}

function visibleTopics() {
  if (state.lane === 'all') return state.topics;
  return state.topics.filter((topic) => (topic.lane ?? 'news') === state.lane);
}

function defaultLane() {
  for (const lane of ['takes', 'news', 'research']) {
    if (state.topics.some((topic) => (topic.lane ?? 'news') === lane)) return lane;
  }
  return 'all';
}

function renderLaneTabs() {
  const counts = state.topics.reduce((acc, topic) => {
    const lane = topic.lane ?? 'news';
    acc[lane] = (acc[lane] ?? 0) + 1;
    acc.all += 1;
    return acc;
  }, { all: 0 });

  laneTabs.innerHTML = LANES.map((lane) => `
    <button class="lane-tab" data-lane="${lane.id}" aria-current="${lane.id === state.lane}">
      <span>${lane.label}</span>
      <span>${counts[lane.id] ?? 0}</span>
    </button>
  `).join('');

  for (const button of laneTabs.querySelectorAll('button')) {
    button.addEventListener('click', async () => {
      state.lane = button.dataset.lane;
      const visible = visibleTopics();
      if (!visible.some((topic) => topic.slug === state.selectedSlug)) {
        state.selectedSlug = visible[0]?.slug || state.topics[0]?.slug || null;
      }
      replaceUrl();
      renderLaneTabs();
      renderTopics();
      await renderArticle();
    });
  }
}

function renderTopics() {
  const topics = visibleTopics();
  if (topics.length === 0) {
    topicList.innerHTML = `<p class="empty">No ${escapeHtml(laneLabel(state.lane).toLowerCase())} topics in this run.</p>`;
    return;
  }
  topicList.innerHTML = topics.map((topic) => `
    <button class="topic-button" data-slug="${escapeHtml(topic.slug)}" aria-current="${topic.slug === state.selectedSlug}">
      <p class="topic-title">${escapeHtml(topic.title)}</p>
      <div class="topic-meta">
        <span class="heat">Heat ${topic.hotness}</span>
        <span>${escapeHtml(modeLabel(topic.mode))}</span>
        <span>${topic.sourceCount} sources</span>
        <span>${escapeHtml((topic.sources ?? []).slice(0, 2).join(', '))}</span>
      </div>
    </button>
  `).join('');

  for (const button of topicList.querySelectorAll('button')) {
    button.addEventListener('click', async () => {
      state.selectedSlug = button.dataset.slug;
      replaceUrl();
      renderTopics();
      await renderArticle();
    });
  }
}

async function renderArticle() {
  if (!state.selectedSlug) {
    article.innerHTML = '<p class="empty">No topic selected.</p>';
    return;
  }
  const topic = await fetch(`/data/articles/${state.selectedSlug}.json`, { cache: 'no-cache' })
    .then((response) => response.json());

  const bodyHtml = topic.body
    ? `<div class="body">${renderMarkdown(topic.body)}</div>`
    : renderLegacyBody(topic);

  article.innerHTML = `
    <h2>${escapeHtml(topic.title)}</h2>
    <div class="topic-meta">
      <span class="heat">Heat ${topic.hotness}</span>
      <span>${escapeHtml(laneLabel(topic.lane))}</span>
      <span>${escapeHtml(modeLabel(topic.mode))}</span>
      <span>${formatTime(topic.updatedAt)}</span>
    </div>

    ${bodyHtml}

    <section class="article-section sources-section">
      <h3>Sources</h3>
      <div class="sources">
        ${(topic.sources ?? []).map(renderSource).join('')}
      </div>
    </section>
  `;
}

// Back-compat for any cached article saved before the roundup `body` field existed.
function renderLegacyBody(topic) {
  const parts = [topic.whyHot, topic.shortTake, topic.balancedTake].filter(Boolean);
  if (!parts.length) return '';
  return `<div class="body">${parts.map((text) => `<p>${escapeHtml(text)}</p>`).join('')}</div>`;
}

function renderSource(source) {
  const text = source.text ?? source.excerpt ?? '';
  return `
    <div class="source">
      <a href="${escapeAttribute(source.url)}" target="_blank" rel="noreferrer">${escapeHtml(source.title)}</a>
      <div class="source-meta">${escapeHtml(source.source)}${source.author ? ` / ${escapeHtml(source.author)}` : ''}${source.publishedAt ? ` / ${formatTime(source.publishedAt)}` : ''}</div>
      <p class="source-text">${escapeHtml(text).replaceAll('\n', '<br>')}</p>
    </div>
  `;
}

// --- Minimal, safe markdown renderer (escape first, then a small subset). ---

function renderMarkdown(md) {
  return String(md)
    .replace(/\r\n/g, '\n')
    .split(/\n{2,}/)
    .map(renderBlock)
    .filter(Boolean)
    .join('\n');
}

function renderBlock(block) {
  const trimmed = block.trim();
  if (!trimmed) return '';
  const lines = block.split('\n');
  if (lines.every((line) => /^\s*>/.test(line))) {
    const inner = lines.map((line) => line.replace(/^\s*>\s?/, '')).join('\n');
    return `<blockquote>${renderInlineMultiline(inner)}</blockquote>`;
  }
  if (lines.length === 1 && /^#{1,4}\s+/.test(trimmed)) {
    return `<h3>${renderInline(trimmed.replace(/^#{1,4}\s+/, ''))}</h3>`;
  }
  if (lines.every((line) => /^\s*[-*]\s+/.test(line))) {
    return `<ul>${lines.map((line) => `<li>${renderInline(line.replace(/^\s*[-*]\s+/, ''))}</li>`).join('')}</ul>`;
  }
  return `<p>${renderInlineMultiline(block)}</p>`;
}

function renderInlineMultiline(text) {
  return text.split('\n').map(renderInline).join('<br>');
}

function renderInline(text) {
  let out = escapeHtml(text);
  out = out.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, (match, label, url) =>
    `<a href="${url}" target="_blank" rel="noreferrer">${label}</a>`);
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  return out;
}

function replaceUrl() {
  const params = new URLSearchParams();
  if (state.lane !== 'takes') params.set('lane', state.lane);
  if (state.selectedSlug) params.set('topic', state.selectedSlug);
  const query = params.toString();
  history.replaceState(null, '', query ? `?${query}` : location.pathname);
}

function laneLabel(lane = 'news') {
  return LANES.find((item) => item.id === lane)?.label ?? 'Newswire';
}

function modeLabel(mode = 'digest') {
  if (mode === 'model') return 'Brief';
  if (mode === 'digest' || mode === 'deterministic') return 'Digest';
  return mode;
}

function formatTime(input) {
  if (!input) return '';
  return new Intl.DateTimeFormat(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(input));
}

function escapeHtml(input = '') {
  return String(input)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function escapeAttribute(input = '') {
  return escapeHtml(input).replaceAll('`', '&#96;');
}

boot().catch((error) => {
  article.innerHTML = `<p class="empty">${escapeHtml(error.message)}</p>`;
});
