import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { fallbackArticle } from './cluster.js';
import { getPriorCoverage } from './db.js';
import { resolveFromRoot } from './paths.js';
import { enrichTopicSources } from './source-enrichment.js';
import { stripHtml } from './text.js';

// `cache` maps topic.id -> previous article, so unchanged topic clusters reuse
// their existing model brief instead of paying for a fresh generation each run.
// `db` is passed to look up prior coverage from topic_archive for threading.
export async function attachBriefs(topics, config, cache = new Map(), db = null) {
  const shouldUseModel = Boolean(config.settings.models.enabled) && process.env.TECH_RADAR_ENABLE_LLM === '1';
  const pipelineKey = briefPipelineKey(config);
  const eligibleTopics = topics.map((topic) => ({
    ...topic,
    needsModel: topic.hotness >= config.settings.ranking.minHotnessForBrief &&
      topic.items.length >= config.settings.ranking.minItemsForBrief &&
      substantiveSourceCount(topic) >= config.settings.ranking.minItemsForBrief,
  }));

  if (!shouldUseModel) {
    return eligibleTopics.map((topic) => ({
      ...topic,
      article: fallbackArticle(topic),
    }));
  }

  const promptTemplate = fs.readFileSync(resolveFromRoot('prompts/topic-brief.md'), 'utf8');
  const editTemplate = fs.readFileSync(resolveFromRoot('prompts/topic-edit.md'), 'utf8');
  const maxBriefs = Number(config.settings.ranking.maxModelBriefs ?? 12);
  const output = [];
  let generated = 0;

  for (const topic of eligibleTopics) {
    if (!topic.needsModel) {
      output.push({ ...topic, article: fallbackArticle(topic) });
      continue;
    }

    // Reuse a cached model brief when the cluster (and thus topic.id) is unchanged.
    const cached = cache.get(topic.id);
    if (cached && cached.mode === 'model' && cached.pipelineKey === pipelineKey) {
      const digest = fallbackArticle(topic);
      output.push({
        ...topic,
        article: {
          ...digest,
          ...cached,
          lane: cached.lane ?? digest.lane,
          sources: digest.sources,
          updatedAt: cached.updatedAt,
        },
      });
      continue;
    }

    // Stay within the per-run generation budget; overflow uses the source digest.
    if (generated >= maxBriefs) {
      output.push({ ...topic, article: fallbackArticle(topic) });
      continue;
    }

    try {
      const article = await generateBrief(topic, config, promptTemplate, editTemplate, db);
      generated += 1;
      const digest = fallbackArticle(topic);
      if (shouldRejectModelArticle(article)) {
        output.push({
          ...topic,
          article: {
            ...digest,
            mode: 'digest',
            pipelineKey,
            modelRejected: true,
            coherence: normalizeCoherence(article.coherence),
            titleStatus: normalizeTitleStatus(article.titleStatus),
            rejectionReason: modelRejectionReason(article),
            outlierSourceIds: normalizeStringArray(article.outlierSourceIds),
            writerDraft: article.writerDraft,
            writerProvider: article.writerProvider,
            editorProvider: article.editorProvider,
            editorStatus: article.editorStatus,
          },
        });
        continue;
      }

      const merged = { ...digest, ...article, sources: digest.sources, mode: 'model', pipelineKey };
      // Use model-generated display title (display-only; never changes the slug-generating title).
      // Compare against the ORIGINAL fallback title, not merged.title — merged already has
      // article.title spread in, so rawDisplayTitle === merged.title when the model returns
      // a good title field but omits displayTitle, incorrectly suppressing the improvement.
      const originalTitle = digest.title;
      const rawDisplayTitle = article.displayTitle ?? article.title;
      if (
        normalizeTitleStatus(article.titleStatus) !== 'weak' &&
        rawDisplayTitle &&
        rawDisplayTitle !== originalTitle &&
        isValidDisplayTitle(rawDisplayTitle)
      ) {
        merged.displayTitle = rawDisplayTitle;
        // Prevent the model's title field from overwriting the stable article.title.
        merged.title = originalTitle;
      } else {
        delete merged.displayTitle;
        merged.title = originalTitle;
      }
      merged.shortTake = article.summary ?? merged.shortTake;
      merged.whyHot = article.summary ?? merged.whyHot;
      output.push({ ...topic, article: merged });
    } catch (error) {
      console.warn(`[brief] ${topic.slug}: ${error.message}`);
      output.push({ ...topic, article: { ...fallbackArticle(topic), modelError: error.message } });
    }
  }
  const runStats = output.flatMap((t) => t.article?.briefStats ?? []);
  printStatsSummary(runStats, config);
  appendStatsLog(runStats, config);
  return output;
}

async function generateBrief(topic, config, promptTemplate, editTemplate, db) {
  const priorCoverage = db ? getPriorCoverage(db, topic.keywords, 7) : [];
  const sourcePayload = {
    ...topicSourcePayload(topic),
    linkedSources: await enrichTopicSources(topic),
    ...(priorCoverage.length > 0 ? { priorCoverage } : {}),
  };
  const input = promptTemplate
    .replace('{{TOPIC_JSON}}', JSON.stringify(sourcePayload, null, 2));

  const writerProvider = modelProvider(config, 'writer');
  const editorProvider = modelProvider(config, 'editor');

  let writerDraft;
  let actualWriterProvider = writerProvider;
  let writerStat;
  try {
    ({ result: writerDraft, stat: writerStat } = await timedProvider(writerProvider, input, config, 'writer'));
  } catch (error) {
    console.warn(`[brief] Writer ${writerProvider} failed: ${error.message}. Trying backup 'gemini'...`);
    actualWriterProvider = 'gemini';
    ({ result: writerDraft, stat: writerStat } = await timedProvider('gemini', input, config, 'writer'));
  }
  writerDraft = normalizeModelArticle(writerDraft);

  if (shouldRejectModelArticle(writerDraft)) {
    return {
      ...writerDraft,
      writerDraft,
      writerProvider: actualWriterProvider,
      editorProvider: null,
      editorStatus: 'writer-rejected',
      briefStats: [writerStat],
    };
  }

  if (!shouldEdit(config, editorProvider)) {
    return {
      ...writerDraft,
      writerDraft,
      writerProvider: actualWriterProvider,
      editorProvider: null,
      editorStatus: 'skipped',
      briefStats: [writerStat],
    };
  }

  const editInput = editTemplate.replace('{{EDIT_JSON}}', JSON.stringify({
    topic: {
      title: topic.title,
      hotness: topic.hotness,
      keywords: topic.keywords,
    },
    draft: writerDraft,
    sources: sourcePayload.sources.map((source) => ({
      id: source.id,
      title: source.title,
      source: source.source,
      sourceKind: source.sourceKind,
      author: source.author,
      url: source.url,
      publishedAt: source.publishedAt,
      text: source.text,
    })),
    linkedSources: sourcePayload.linkedSources.map((source) => ({
      url: source.url,
      sourceTitle: source.sourceTitle,
      status: source.status,
      method: source.method,
      title: source.title,
      text: source.text,
    })),
  }, null, 2));

  let edited;
  let actualEditorProvider = editorProvider;
  let editorStat;
  try {
    ({ result: edited, stat: editorStat } = await timedProvider(editorProvider, editInput, config, 'editor'));
  } catch (error) {
    console.warn(`[brief] Editor ${editorProvider} failed: ${error.message}. Trying backup 'agy'...`);
    try {
      actualEditorProvider = 'agy';
      ({ result: edited, stat: editorStat } = await timedProvider('agy', editInput, config, 'editor'));
    } catch (backupError) {
      return {
        ...writerDraft,
        writerDraft,
        writerProvider: actualWriterProvider,
        editorProvider: actualEditorProvider,
        editorStatus: 'failed',
        editorError: `${error.message}; backup failed: ${backupError.message}`,
        briefStats: [writerStat],
      };
    }
  }

  return {
    ...normalizeModelArticle(edited),
    displayTitle: edited.displayTitle ?? writerDraft.displayTitle,
    coherence: edited.coherence ?? writerDraft.coherence,
    titleStatus: edited.titleStatus ?? writerDraft.titleStatus,
    outlierSourceIds: edited.outlierSourceIds ?? writerDraft.outlierSourceIds,
    rejectionReason: edited.rejectionReason ?? writerDraft.rejectionReason,
    writerDraft,
    writerProvider: actualWriterProvider,
    editorProvider: actualEditorProvider,
    editorStatus: 'edited',
    briefStats: [writerStat, editorStat].filter(Boolean),
  };
}

function topicSourcePayload(topic) {
  return {
    title: topic.title,
    hotness: topic.hotness,
    keywords: topic.keywords,
    sources: topic.items.map((item) => ({
      id: item.id,
      title: item.title,
      source: item.sourceTitle,
      sourceKind: item.sourceKind,
      author: item.author,
      url: item.url,
      publishedAt: item.publishedAt,
      text: item.contentText || item.summary,
    })),
  };
}

function substantiveSourceCount(topic) {
  return topic.items.filter((item) => substantiveSourceText(item)).length;
}

function substantiveSourceText(item) {
  const text = stripHtml(item.contentText || item.summary || '');
  const title = stripHtml(item.title || '');
  if (!text) return false;
  const clean = text.toLowerCase();
  if (clean === 'comments') return false;
  if (/^link from [a-z0-9.-]+\.[a-z]{2,}$/i.test(text)) return false;
  if (text === title && text.length < 24) return false;
  return text.length >= 18;
}

function modelProvider(config, stage) {
  const models = config.settings.models;
  const provider = stage === 'editor' ? models.editorProvider : models.writerProvider;
  return String(provider || models.provider || (stage === 'editor' ? 'claude' : 'codex')).toLowerCase();
}

function shouldEdit(config, editorProvider) {
  if (!config.settings.models.enableEditor) return false;
  return editorProvider && editorProvider !== 'none' && editorProvider !== 'off' && editorProvider !== 'false';
}

function isValidDisplayTitle(title) {
  if (!title || typeof title !== 'string') return false;
  const t = title.trim();
  if (t.length < 15 || t.length > 90) return false;
  if (/^https?:\/\//i.test(t)) return false;
  if (/^(How |Why |What |Is |Are |Will )/i.test(t)) return false;
  return true;
}

function normalizeModelArticle(article) {
  return {
    ...article,
    coherence: normalizeCoherence(article?.coherence),
    titleStatus: normalizeTitleStatus(article?.titleStatus),
    outlierSourceIds: normalizeStringArray(article?.outlierSourceIds),
    rejectionReason: typeof article?.rejectionReason === 'string' ? article.rejectionReason.trim() : '',
  };
}

function normalizeCoherence(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'mixed' || normalized === 'thin') return normalized;
  return 'coherent';
}

function normalizeTitleStatus(value) {
  const normalized = String(value ?? '').trim().toLowerCase();
  return normalized === 'weak' ? 'weak' : 'good';
}

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item).trim()).filter(Boolean).slice(0, 24);
}

function shouldRejectModelArticle(article) {
  const coherence = normalizeCoherence(article?.coherence);
  return coherence === 'mixed' || coherence === 'thin';
}

function modelRejectionReason(article) {
  const reason = typeof article?.rejectionReason === 'string' ? article.rejectionReason.trim() : '';
  if (reason) return reason;
  if (normalizeCoherence(article?.coherence) === 'thin') return 'The model found too little substantive source text for a grounded brief.';
  return 'The model found that the sources do not describe one specific story.';
}

function briefPipelineKey(config) {
  const models = config.settings.models;
  const writerProvider = modelProvider(config, 'writer');
  const editorProvider = shouldEdit(config, modelProvider(config, 'editor')) ? modelProvider(config, 'editor') : 'none';
  return [
    'v8', // bumped: gemini provider + stats tracking
    `writer=${writerProvider}`,
    `editor=${editorProvider}`,
    `cliModel=${models.cliModel || ''}`,
    `codexModel=${models.codexModel || ''}`,
    `claudeModel=${models.claudeModel || ''}`,
    `claudeFallbackModel=${models.claudeFallbackModel || ''}`,
    `small=${models.smallModel || ''}`,
    `large=${models.largeModel || ''}`,
    `agyWriterModel=${models.agyWriterModel || ''}`,
    `agyEditorModel=${models.agyEditorModel || ''}`,
    `geminiWriterModel=${models.geminiWriterModel || ''}`,
    `geminiEditorModel=${models.geminiEditorModel || ''}`,
    'sourceEnrichment=v1',
  ].join('|');
}

async function generateWithProvider(provider, input, config, stage) {
  switch (provider) {
    case 'openai':
      return generateOpenAI(input, config);
    case 'claude':
    case 'claude-cli':
      return generateClaudeCli(input, config);
    case 'codex':
    case 'codex-cli':
      return generateCodexCli(input, config);
    case 'agy':
    case 'agy-cli':
      return generateAgyCli(input, config, stage);
    case 'gemini':
    case 'gemini-api':
      return generateGemini(input, config, stage);
    case 'anthropic':
    case '':
      return generateAnthropic(input, config);
    default:
      throw new Error(`unknown model provider: ${provider}`);
  }
}

async function generateAgyCli(input, config, stage) {
  const args = ['-p', '--dangerously-skip-permissions'];
  const models = config.settings.models;
  let model = '';
  
  if (stage === 'editor') {
    model = models.agyEditorModel || 'Gemini 3.5 Flash (High)';
  } else {
    model = models.agyWriterModel || 'Gemini 3.5 Flash (High)';
  }
  
  if (model) {
    const modelLower = String(model).toLowerCase();
    if (modelLower === 'medium' || modelLower === 'flash-medium' || modelLower === 'gemini-3.5-flash-medium') {
      model = 'Gemini 3.5 Flash (High)';
    } else if (modelLower === 'high' || modelLower === 'flash-high' || modelLower === 'gemini-3.5-flash-high') {
      model = 'Gemini 3.5 Flash (High)';
    } else if (modelLower === 'low' || modelLower === 'flash-low' || modelLower === 'gemini-3.5-flash-low') {
      model = 'Gemini 3.5 Flash (Low)';
    }
    args.push('--model', String(model));
  }
  const finalInput = input + '\n\nIMPORTANT: Do NOT use any tools. Return the JSON response directly without any additional explanation or wrapper.';
  const text = await runCli('agy', args, finalInput, cliTimeout(config));
  return parseJson(text);
}

// --- CLI providers: use the locally logged-in claude / codex CLIs (subscription
// auth, no API key needed). ---

function cliTimeout(config) {
  return Number(config.settings.models.cliTimeoutMs ?? 180_000);
}

function cliModel(config, provider) {
  const models = config.settings.models;
  if (provider === 'claude') return models.claudeModel || models.cliModel || '';
  if (provider === 'codex') return models.codexModel || models.cliModel || '';
  return models.cliModel || '';
}

async function generateClaudeCli(input, config) {
  const args = ['-p', '--output-format', 'json', '--effort', 'medium'];
  const model = cliModel(config, 'claude');
  if (model) args.push('--model', String(model));
  const fallbackModel = config.settings.models.claudeFallbackModel;
  if (fallbackModel) args.push('--fallback-model', String(fallbackModel));
  const raw = await runCli('claude', args, input, cliTimeout(config));
  const envelope = JSON.parse(raw);
  const resultText = typeof envelope.result === 'string' ? envelope.result : raw;
  const usage = envelope.usage ?? {};
  const parsed = parseJson(resultText);
  parsed._usage = {
    model: model || 'claude',
    inputTokens: (usage.input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0),
    outputTokens: usage.output_tokens ?? 0,
    cacheCreationTokens: usage.cache_creation_input_tokens ?? 0,
    isSubscription: true,
  };
  return parsed;
}

async function generateCodexCli(input, config) {
  const outFile = path.join(os.tmpdir(), `tech-radar-brief-${crypto.randomUUID()}.txt`);
  const args = ['exec', '--skip-git-repo-check', '-o', outFile];
  const model = cliModel(config, 'codex');
  if (model) args.push('-m', String(model));
  try {
    await runCli('codex', args, input, cliTimeout(config));
    return parseJson(fs.readFileSync(outFile, 'utf8'));
  } finally {
    fs.rmSync(outFile, { force: true });
  }
}

function runCli(command, args, input, timeoutMs) {
  return new Promise((resolve, reject) => {
    const options = { stdio: ['pipe', 'pipe', 'pipe'] };
    if (command === 'agy') {
      options.cwd = os.tmpdir();
    }
    const child = spawn(command, args, options);
    let stdout = '';
    let stderr = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${command} timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(new Error(`${command} failed to start: ${error.message}`));
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) resolve(stdout);
      else reject(new Error(`${command} exited ${code}: ${stderr.slice(0, 300).trim()}`));
    });
    child.stdin.end(input);
  });
}

// --- HTTP API providers (require API keys). ---

async function generateAnthropic(input, config) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');
  const response = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: config.settings.models.largeModel,
      max_tokens: 1800,
      temperature: 0.2,
      messages: [{ role: 'user', content: input }],
    }),
  });
  if (!response.ok) throw new Error(`Anthropic HTTP ${response.status}: ${await response.text()}`);
  const json = await response.json();
  return parseJson(json.content?.map((part) => part.text ?? '').join('\n') ?? '');
}

async function generateOpenAI(input, config) {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error('OPENAI_API_KEY is not set');
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: config.settings.models.largeModel,
      input,
      temperature: 0.2,
    }),
  });
  if (!response.ok) throw new Error(`OpenAI HTTP ${response.status}: ${await response.text()}`);
  const json = await response.json();
  return parseJson(json.output_text ?? JSON.stringify(json));
}

async function generateGemini(input, config, stage) {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not set');
  const models = config.settings.models;
  const model = stage === 'editor'
    ? (models.geminiEditorModel || 'gemini-2.5-pro')
    : (models.geminiWriterModel || 'gemini-3.1-flash-lite');
  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: input }] }],
        generationConfig: { temperature: 0.2 },
      }),
    },
  );
  if (!response.ok) throw new Error(`Gemini HTTP ${response.status}: ${await response.text()}`);
  const json = await response.json();
  const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
  const parsed = parseJson(text);
  parsed._usage = {
    model,
    inputTokens: json.usageMetadata?.promptTokenCount ?? 0,
    outputTokens: json.usageMetadata?.candidatesTokenCount ?? 0,
  };
  return parsed;
}

async function timedProvider(provider, input, config, stage) {
  const start = Date.now();
  const result = await generateWithProvider(provider, input, config, stage);
  const ms = Date.now() - start;
  const usage = result._usage ?? {};
  delete result._usage;
  const isSubscription = usage.isSubscription ?? (provider === 'agy' || provider === 'agy-cli');
  const costUsd = isSubscription ? 0 : estimateCostUsd(provider, usage.model, usage.inputTokens ?? 0, usage.outputTokens ?? 0);
  return {
    result,
    stat: {
      ts: new Date().toISOString(),
      stage,
      provider,
      model: usage.model ?? resolveModelLabel(provider, stage, config),
      inputTokens: usage.inputTokens ?? null,
      outputTokens: usage.outputTokens ?? null,
      cacheCreationTokens: usage.cacheCreationTokens ?? null,
      costUsd,
      isSubscription,
      latencyMs: ms,
      success: true,
    },
  };
}

function resolveModelLabel(provider, stage, config) {
  const models = config.settings.models;
  if (provider === 'gemini') return stage === 'editor' ? (models.geminiEditorModel || 'gemini-2.5-pro') : (models.geminiWriterModel || 'gemini-3.1-flash-lite');
  if (provider === 'claude' || provider === 'claude-cli') return models.claudeModel || 'claude';
  if (provider === 'agy') return stage === 'editor' ? (models.agyEditorModel || 'agy-editor') : (models.agyWriterModel || 'agy-writer');
  if (provider === 'codex' || provider === 'codex-cli') return models.codexModel || 'codex';
  return provider;
}

function estimateCostUsd(provider, model, inputTokens, outputTokens) {
  if (provider !== 'gemini') return 0; // subscription = $0 marginal cost
  const rates = {
    'gemini-3.1-flash-lite': { input: 0.10, output: 0.40 },
    'gemini-3.1-flash-lite-preview': { input: 0.10, output: 0.40 },
    'gemini-2.5-flash': { input: 0.15, output: 0.60 },
    'gemini-2.5-flash-lite': { input: 0.10, output: 0.40 },
    'gemini-2.5-pro': { input: 1.25, output: 10.00 },
    'gemini-3.1-pro-preview': { input: 1.25, output: 10.00 },
  };
  const r = rates[model] ?? { input: 0.10, output: 0.40 };
  return (inputTokens * r.input + outputTokens * r.output) / 1_000_000;
}

function printStatsSummary(stats, _config) {
  if (!stats.length) return;
  const byProvider = {};
  for (const s of stats) {
    const key = `${s.provider}/${s.model}`;
    if (!byProvider[key]) byProvider[key] = { calls: 0, totalMs: 0, totalIn: 0, totalOut: 0, totalCost: 0, isSub: s.isSubscription };
    const b = byProvider[key];
    b.calls += 1;
    b.totalMs += s.latencyMs;
    b.totalIn += s.inputTokens ?? 0;
    b.totalOut += s.outputTokens ?? 0;
    b.totalCost += s.costUsd;
  }
  console.log('[briefs] model stats:');
  for (const [key, b] of Object.entries(byProvider)) {
    const avgMs = Math.round(b.totalMs / b.calls);
    const tokStr = b.totalIn ? ` | ${b.totalIn.toLocaleString()}in / ${b.totalOut.toLocaleString()}out tok` : ' | tokens: n/a';
    const costStr = b.isSub
      ? ` | subscription (weekly usage: ${(b.totalIn + b.totalOut).toLocaleString()} tok)`
      : (b.totalCost > 0 ? ` | $${b.totalCost.toFixed(5)}` : ' | $0 (free tier)');
    console.log(`  ${key}: ${b.calls} calls, avg ${avgMs}ms${tokStr}${costStr}`);
  }
}

function appendStatsLog(stats, config) {
  if (!stats.length) return;
  try {
    const dataDir = config.settings.dataDir;
    const logPath = `${dataDir}/model-stats.jsonl`;
    const lines = stats.map((s) => JSON.stringify(s) + String.fromCharCode(10)).join('');
    import('node:fs').then(({ appendFileSync }) => appendFileSync(logPath, lines));
  } catch { /* non-fatal */ }
}

function parseJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) throw new Error('model did not return JSON');
  return JSON.parse(text.slice(start, end + 1));
}
