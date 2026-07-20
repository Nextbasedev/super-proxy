import test from 'node:test';
import assert from 'node:assert/strict';
import {
  CATALOG_PROVIDERS,
  KNOWN_MODELS_BY_PROVIDER,
  KNOWN_PROVIDERS,
  MODEL_CATALOG,
  catalogModelIdsWithCapability,
  isKnownModel,
  isKnownProvider,
} from './providers/model-catalog.js';
import { KNOWN_CEREBRAS_MODELS } from './providers/cerebras-pool.js';
import { KNOWN_GROQ_MODELS } from './providers/groq-pool.js';
import { KNOWN_KIMI_MODELS } from './providers/kimi-pool.js';
import { KNOWN_GLM_MODELS } from './providers/glm-pool.js';
import { KNOWN_RUNPOD_MODELS } from './providers/runpod-pool.js';
import {
  KNOWN_GEMINI_CHAT_MODELS,
  KNOWN_GEMINI_EMBEDDING_MODELS,
  KNOWN_GEMINI_LIVE_MODELS,
  KNOWN_GEMINI_MODELS,
  KNOWN_GEMINI_TTS_MODELS,
  KNOWN_GEMINI_VIDEO_MODELS,
} from './providers/gemini-pool.js';
import { KNOWN_XAI_IMAGE_MODELS, KNOWN_XAI_MODELS, KNOWN_XAI_VIDEO_MODELS } from './providers/xai-pool.js';
import { OPENAI_REALTIME_MODELS } from './proxy/openai.js';
import { XAI_REALTIME_MODELS, XAI_VIDEO_EDIT_MODELS, XAI_VIDEO_REFERENCE_MODELS } from './proxy/xai.js';

function entry(provider: string, id: string) {
  const found = MODEL_CATALOG.find((model) => model.provider === provider && model.id === id);
  assert.ok(found, `missing ${provider}/${id}`);
  return found;
}

function sorted(values: Iterable<string>) {
  return [...values].sort();
}

test('canonical model catalog has unique provider/model IDs and complete metadata', () => {
  const catalogIds = MODEL_CATALOG.map((model) => `${model.provider}/${model.id}`);
  assert.equal(new Set(catalogIds).size, catalogIds.length);

  for (const model of MODEL_CATALOG) {
    assert.ok(model.id);
    assert.ok(model.endpoint.startsWith('/v1/'));
    assert.ok(model.api);
    assert.equal(typeof model.streaming, 'boolean');
    assert.equal(typeof model.non_streaming, 'boolean');
    assert.ok(model.input_modalities.length > 0);
    assert.ok(model.output_modalities.length > 0);
    assert.ok(model.capabilities.length > 0);
    assert.ok(model.streaming || model.non_streaming);
    assert.equal(typeof model.direct_runtime_support, 'boolean');
    if (!model.direct_runtime_support) assert.ok(model.runtime_model, `${model.provider}/${model.id} needs a runtime_model`);
    assert.ok(model.interfaces.length > 0);
    const primary = model.interfaces[0];
    assert.equal(model.endpoint, primary.path);
    assert.equal(model.api, primary.api);
    assert.equal(model.streaming, primary.response_modes.includes('streaming'));
    assert.equal(model.non_streaming, primary.response_modes.includes('non_streaming'));
    for (const iface of model.interfaces) {
      assert.ok(['GET', 'POST'].includes(iface.method));
      assert.ok(['http', 'websocket'].includes(iface.transport));
      assert.ok(iface.path.startsWith('/v1/'));
      assert.ok(iface.api);
      assert.ok(iface.response_modes.length > 0);
    }
    for (const capability of model.capabilities) {
      assert.ok(model.interfaces.some((iface) => iface.operation === capability), `${model.provider}/${model.id} lacks an interface for ${capability}`);
    }
  }
});

test('known-model compatibility exports are derived from every catalog entry', () => {
  assert.deepEqual(KNOWN_PROVIDERS, CATALOG_PROVIDERS);
  for (const provider of CATALOG_PROVIDERS) {
    const expected = MODEL_CATALOG.filter((model) => model.provider === provider).map((model) => model.id);
    assert.deepEqual(KNOWN_MODELS_BY_PROVIDER[provider], expected);
    assert.equal(isKnownProvider(provider), true);
    for (const model of expected) assert.equal(isKnownModel(provider, model), true);
  }
  assert.equal(isKnownProvider('not-a-provider'), false);
  assert.equal(isKnownModel('gemini', 'not-a-model'), false);
});

test('representative chat, embedding, realtime, image, and video metadata is explicit', () => {
  const chat = entry('anthropic', 'claude-sonnet-4-6');
  assert.equal(chat.api, 'anthropic-messages');
  assert.deepEqual(chat.capabilities, ['chat']);
  assert.equal(chat.streaming, true);
  assert.equal(chat.non_streaming, true);

  const embedding = entry('gemini', 'gemini-embedding-2-preview');
  assert.equal(embedding.endpoint, '/v1/gemini/embeddings');
  assert.deepEqual(embedding.output_modalities, ['embedding']);
  assert.deepEqual(embedding.capabilities, ['embeddings']);

  const realtime = entry('gemini', 'gemini-3.1-flash-live-preview');
  assert.equal(realtime.endpoint, '/v1/gemini/realtime');
  assert.equal(realtime.api, 'gemini-live');
  assert.equal(realtime.streaming, true);
  assert.equal(realtime.non_streaming, false);
  assert.ok(realtime.input_modalities.includes('audio'));

  const openaiRealtime = entry('openai_codex', 'gpt-realtime-2');
  assert.deepEqual(openaiRealtime.interfaces[0].response_modes, ['non_streaming']);
  assert.equal(openaiRealtime.streaming, false);
  assert.equal(openaiRealtime.non_streaming, true);

  const xaiRealtime = entry('xai', 'grok-realtime-voice');
  assert.deepEqual(xaiRealtime.interfaces[0].response_modes, ['non_streaming']);
  assert.equal(xaiRealtime.streaming, false);
  assert.equal(xaiRealtime.non_streaming, true);
  assert.deepEqual(realtime.interfaces, [
    {
      operation: 'realtime',
      method: 'GET',
      transport: 'websocket',
      path: '/v1/gemini/realtime',
      api: 'gemini-live',
      response_modes: ['streaming'],
    },
    {
      operation: 'realtime',
      method: 'POST',
      transport: 'http',
      path: '/v1/gemini/realtime/client_secrets',
      api: 'gemini-live',
      response_modes: ['non_streaming'],
    },
  ]);

  const geminiChat = entry('gemini', 'gemini-3.5-flash');
  assert.equal(geminiChat.streaming, false);
  assert.equal(geminiChat.non_streaming, true);

  const image = entry('xai', 'grok-imagine-image-quality');
  assert.ok(image.capabilities.includes('image-generation'));
  assert.ok(image.capabilities.includes('image-editing'));
  assert.equal(image.max_reference_images, 3);
  assert.equal(image.interfaces.find((iface) => iface.operation === 'image-generation')?.path, '/v1/xai/images/generations');
  assert.equal(image.interfaces.find((iface) => iface.operation === 'image-editing')?.path, '/v1/xai/images/edits');

  const video = entry('xai', 'grok-imagine-video');
  assert.ok(video.capabilities.includes('video-generation'));
  assert.ok(video.capabilities.includes('reference-to-video'));
  assert.ok(video.capabilities.includes('video-editing'));
  assert.ok(video.capabilities.includes('video-extension'));
  assert.equal(video.max_reference_images, 7);
  assert.equal(video.interfaces.find((iface) => iface.operation === 'video-generation')?.path, '/v1/xai/videos/generations');
  assert.equal(video.interfaces.find((iface) => iface.operation === 'reference-to-video')?.path, '/v1/xai/videos/generations');
  assert.equal(video.interfaces.find((iface) => iface.operation === 'video-editing')?.path, '/v1/xai/videos/edits');
  assert.equal(video.interfaces.find((iface) => iface.operation === 'video-extension')?.path, '/v1/xai/videos/extensions');

  const previewVideo = entry('xai', 'grok-imagine-video-1.5-preview');
  assert.deepEqual(previewVideo.capabilities, ['video-generation']);
  assert.deepEqual(previewVideo.interfaces.map((iface) => iface.operation), ['video-generation']);

  for (const provider of ['openai', 'openai_codex']) {
    const openAiImage = entry(provider, 'gpt-image-2');
    assert.equal(openAiImage.interfaces.find((iface) => iface.operation === 'image-generation')?.path, '/v1/images/generations');
    assert.equal(openAiImage.interfaces.find((iface) => iface.operation === 'image-editing')?.path, '/v1/images/edits');
  }

  const kimi = entry('kimi', 'kimi-k2.6');
  assert.deepEqual(kimi.capabilities, ['chat', 'messages']);
  assert.equal(kimi.interfaces.find((iface) => iface.operation === 'chat')?.path, '/v1/kimi/chat/completions');
  assert.equal(kimi.interfaces.find((iface) => iface.operation === 'messages')?.path, '/v1/kimi/messages');

  const groqAudio = entry('groq', 'whisper-large-v3');
  assert.equal(groqAudio.interfaces.find((iface) => iface.operation === 'speech-to-text')?.path, '/v1/groq/audio/transcriptions');
  assert.equal(groqAudio.interfaces.find((iface) => iface.operation === 'speech-translation')?.path, '/v1/groq/audio/translations');
});

test('Cerebras and Runpod fallback metadata preserve runtime behavior', () => {
  assert.deepEqual(sorted(KNOWN_CEREBRAS_MODELS), ['gpt-oss-120b', 'zai-glm-4.7']);
  for (const id of ['qwen-3-235b-a22b-instruct-2507', 'llama3.1-8b']) {
    const model = entry('cerebras', id);
    assert.equal(model.direct_runtime_support, false);
    assert.equal(model.runtime_model, 'gpt-oss-120b');
  }

  const runpodFast = entry('runpod', 'qwen36-27b-fast');
  assert.equal(runpodFast.direct_runtime_support, false);
  assert.equal(runpodFast.runtime_model, 'qwen36-27b');
});

test('provider pool and specialized sets stay aligned with catalog metadata', () => {
  const ids = (provider: string, predicate: (model: (typeof MODEL_CATALOG)[number]) => boolean) =>
    MODEL_CATALOG.filter((model) => model.provider === provider && predicate(model)).map((model) => model.id);

  assert.deepEqual(sorted(KNOWN_CEREBRAS_MODELS), sorted(ids('cerebras', (model) => model.capabilities.includes('chat') && model.direct_runtime_support)));
  assert.deepEqual(sorted(KNOWN_GROQ_MODELS), sorted(ids('groq', (model) => model.capabilities.includes('chat'))));
  assert.deepEqual(sorted(KNOWN_KIMI_MODELS), sorted(ids('kimi', (model) => model.capabilities.includes('chat'))));
  assert.deepEqual(sorted(KNOWN_GLM_MODELS), sorted(ids('glm', (model) => model.capabilities.includes('chat'))));
  assert.deepEqual(sorted(KNOWN_RUNPOD_MODELS), sorted(ids('runpod', (model) => model.capabilities.includes('chat'))));

  assert.deepEqual(sorted(KNOWN_GEMINI_EMBEDDING_MODELS), sorted(ids('gemini', (model) => model.capabilities.includes('embeddings'))));
  assert.deepEqual(sorted(KNOWN_GEMINI_TTS_MODELS), sorted(ids('gemini', (model) => model.capabilities.includes('text-to-speech'))));
  assert.deepEqual(sorted(KNOWN_GEMINI_LIVE_MODELS), sorted(ids('gemini', (model) => model.capabilities.includes('realtime'))));
  assert.deepEqual(sorted(KNOWN_GEMINI_VIDEO_MODELS), sorted(ids('gemini', (model) => model.capabilities.includes('chat') && model.input_modalities.includes('video'))));
  assert.deepEqual(sorted(KNOWN_GEMINI_CHAT_MODELS), sorted(ids('gemini', (model) => model.capabilities.includes('chat') && !model.input_modalities.includes('video'))));
  assert.deepEqual(sorted(KNOWN_GEMINI_MODELS), sorted(KNOWN_MODELS_BY_PROVIDER.gemini));

  assert.deepEqual(sorted(KNOWN_XAI_MODELS), sorted(KNOWN_MODELS_BY_PROVIDER.xai));
  assert.deepEqual(sorted(KNOWN_XAI_IMAGE_MODELS), sorted(ids('xai', (model) => model.capabilities.includes('image-generation'))));
  assert.deepEqual(sorted(KNOWN_XAI_VIDEO_MODELS), sorted(ids('xai', (model) => model.capabilities.includes('video-generation'))));

  assert.deepEqual(sorted(OPENAI_REALTIME_MODELS), sorted(catalogModelIdsWithCapability('openai_codex', 'realtime')));
  assert.deepEqual(sorted(XAI_REALTIME_MODELS), sorted(catalogModelIdsWithCapability('xai', 'realtime')));
  assert.deepEqual(sorted(XAI_VIDEO_REFERENCE_MODELS), sorted(catalogModelIdsWithCapability('xai', 'reference-to-video')));
  assert.deepEqual(
    sorted(XAI_VIDEO_EDIT_MODELS),
    sorted(new Set([
      ...catalogModelIdsWithCapability('xai', 'video-editing'),
      ...catalogModelIdsWithCapability('xai', 'video-extension'),
    ])),
  );
});
