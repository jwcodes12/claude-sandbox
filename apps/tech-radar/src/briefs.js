import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { resolveFromRoot } from './paths.js';
import { storyDigestArticle, storyTopicView } from './stories.js';

// Regenerate articles only for stories that gained discourse this run (or have
// no article yet). Unchanged stories keep their existing article verbatim, so
// model briefs are only paid for when a story actually moved. Changed stories
// hand the model their previous brief so it updates the piece instead of
// rewriting it blind.
export async function attachStoryBriefs(stories, config) {
  const shouldUseModel = Boolean(config.settings.models.enabled) && process.env.TECH_RADAR_ENABLE_LLM === '1';
  const pipelineKey = briefPipelineKey(config);
  const ranking = config.settings.ranking;
  const maxBriefs = Number(ranking.maxModelBriefs ?? 12);

  let promptTemplate = null;
  let editTemplate = null;
  let generated = 0;

  // Hottest stories first, so the per-run model budget is spent on the
  // stories most likely to lead the digest page.
  const candidates = stories
    .filter((story) => story.changed || !story.article)
    .sort((a, b) => b.hotness - a.hotness);

  for (const story of candidates) {
    const digest = storyDigestArticle(story, config);
    const previousArticle = story.article;
    story.article = digest;

    if (!shouldUseModel) continue;
    if (story.hotness < ranking.minHotnessForBrief || story.items.length < ranking.minItemsForBrief) continue;
    if (generated >= maxBriefs) continue;

    promptTemplate ??= fs.readFileSync(resolveFromRoot('prompts/topic-brief.md'), 'utf8');
    editTemplate ??= fs.readFileSync(resolveFromRoot('prompts/topic-edit.md'), 'utf8');

    try {
      const article = await generateBrief(storyTopicView(story, config), config, promptTemplate, editTemplate, {
        previousArticle: previousArticle?.mode === 'model'
          ? { summary: previousArticle.summary, body: previousArticle.body }
          : null,
        freshItemIds: new Set(story.freshItemIds ?? []),
      });
      generated += 1;
      const merged = { ...digest, ...article, mode: 'model', pipelineKey, updatedAt: story.updatedAt };
      merged.shortTake = article.summary ?? merged.shortTake;
      merged.whyHot = article.summary ?? merged.whyHot;
      story.article = merged;
    } catch (error) {
      console.warn(`[brief] ${story.slug}: ${error.message}`);
      story.article = { ...digest, modelError: error.message };
    }
  }
  return generated;
}

async function generateBrief(topic, config, promptTemplate, editTemplate, context = {}) {
  const sourcePayload = topicSourcePayload(topic, context);
  const input = promptTemplate
    .replace('{{TOPIC_JSON}}', JSON.stringify(sourcePayload, null, 2));

  const writerProvider = modelProvider(config, 'writer');
  const editorProvider = modelProvider(config, 'editor');

  let writerDraft;
  let actualWriterProvider = writerProvider;
  try {
    writerDraft = await generateWithProvider(writerProvider, input, config, 'writer');
  } catch (error) {
    console.warn(`[brief] Writer ${writerProvider} failed: ${error.message}. Trying backup 'agy'...`);
    actualWriterProvider = 'agy';
    writerDraft = await generateWithProvider('agy', input, config, 'writer');
  }

  if (!shouldEdit(config, editorProvider)) {
    return {
      ...writerDraft,
      writerDraft,
      writerProvider: actualWriterProvider,
      editorProvider: null,
      editorStatus: 'skipped',
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
      title: source.title,
      source: source.source,
      sourceKind: source.sourceKind,
      author: source.author,
      url: source.url,
      publishedAt: source.publishedAt,
    })),
  }, null, 2));

  let edited;
  let actualEditorProvider = editorProvider;
  try {
    edited = await generateWithProvider(editorProvider, editInput, config, 'editor');
  } catch (error) {
    console.warn(`[brief] Editor ${editorProvider} failed: ${error.message}. Trying backup 'agy'...`);
    try {
      actualEditorProvider = 'agy';
      edited = await generateWithProvider('agy', editInput, config, 'editor');
    } catch (backupError) {
      return {
        ...writerDraft,
        writerDraft,
        writerProvider: actualWriterProvider,
        editorProvider: actualEditorProvider,
        editorStatus: 'failed',
        editorError: `${error.message}; backup failed: ${backupError.message}`,
      };
    }
  }

  return {
    ...edited,
    writerDraft,
    writerProvider: actualWriterProvider,
    editorProvider: actualEditorProvider,
    editorStatus: 'edited',
  };
}

function topicSourcePayload(topic, { previousArticle = null, freshItemIds = new Set() } = {}) {
  return {
    title: topic.title,
    hotness: topic.hotness,
    keywords: topic.keywords,
    previousArticle,
    sources: topic.items.map((item) => ({
      title: item.title,
      source: item.sourceTitle,
      sourceKind: item.sourceKind,
      author: item.author,
      url: item.url,
      publishedAt: item.publishedAt,
      isNew: freshItemIds.has(item.id) || undefined,
      text: item.contentText || item.summary,
    })),
  };
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

function briefPipelineKey(config) {
  const models = config.settings.models;
  const writerProvider = modelProvider(config, 'writer');
  const editorProvider = shouldEdit(config, modelProvider(config, 'editor')) ? modelProvider(config, 'editor') : 'none';
  return [
    'v3',
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
    model = models.agyWriterModel || 'Gemini 3.5 Flash (Medium)';
  }
  
  if (model) {
    const modelLower = String(model).toLowerCase();
    if (modelLower === 'medium' || modelLower === 'flash-medium' || modelLower === 'gemini-3.5-flash-medium') {
      model = 'Gemini 3.5 Flash (Medium)';
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
  const args = ['-p', '--output-format', 'text'];
  const model = cliModel(config, 'claude');
  if (model) args.push('--model', String(model));
  const fallbackModel = config.settings.models.claudeFallbackModel;
  if (fallbackModel) args.push('--fallback-model', String(fallbackModel));
  const text = await runCli('claude', args, input, cliTimeout(config));
  return parseJson(text);
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

function parseJson(text) {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) throw new Error('model did not return JSON');
  return JSON.parse(text.slice(start, end + 1));
}
