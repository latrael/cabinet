import { createOpenAICompatible } from '@ai-sdk/openai-compatible';
import { createAnthropic } from '@ai-sdk/anthropic';
import { createOpenAI } from '@ai-sdk/openai';
import type { EmbeddingModel, LanguageModel } from 'ai';
import type { LibraryConfig, LibrarySecrets } from '@cabinet/core';

export interface ProviderStatus {
  provider: string;
  chat: boolean;
  embeddings: boolean;
  chatModel?: string;
  embedModel?: string;
  reason?: string;
}

interface OllamaTags {
  models?: Array<{ name: string; model?: string }>;
}

/**
 * Resolves the configured chat + embedding models and checks they are reachable.
 * Embeddings come from Ollama (local) when available, else OpenAI if a key is set.
 */
export class Providers {
  private cfg: () => LibraryConfig;
  private secrets: () => LibrarySecrets;
  private cache: { at: number; tags: string[] | null; error?: string } = { at: 0, tags: null };

  constructor(cfg: () => LibraryConfig, secrets: () => LibrarySecrets) {
    this.cfg = cfg;
    this.secrets = secrets;
  }

  private get ai() {
    return this.cfg().ai;
  }

  private ollama() {
    return createOpenAICompatible({ name: 'ollama', baseURL: this.ai.ollamaUrl.replace(/\/$/, '') + '/v1', supportsStructuredOutputs: true });
  }

  /** Installed Ollama models, cached for 15 s. Null when Ollama is unreachable. */
  async ollamaModels(force = false): Promise<string[] | null> {
    if (!force && Date.now() - this.cache.at < 15_000) return this.cache.tags;
    try {
      const r = await fetch(this.ai.ollamaUrl.replace(/\/$/, '') + '/api/tags', { signal: AbortSignal.timeout(1500) });
      const j = (await r.json()) as OllamaTags;
      this.cache = { at: Date.now(), tags: (j.models ?? []).map((m) => m.name) };
    } catch (e) {
      this.cache = { at: Date.now(), tags: null, error: (e as Error).message };
    }
    return this.cache.tags;
  }

  private has(tags: string[] | null, model: string): boolean {
    if (!tags) return false;
    const want = model.includes(':') ? model : model + ':latest';
    return tags.some((t) => t === model || t === want);
  }

  async status(): Promise<ProviderStatus> {
    const ai = this.ai;
    const s = this.secrets();
    const tags = await this.ollamaModels();
    const embeddings = this.has(tags, ai.embedModel) || !!s.openaiKey;
    const embedModel = this.has(tags, ai.embedModel) ? ai.embedModel : s.openaiKey ? ai.openaiEmbedModel : ai.embedModel;
    let chat = false;
    let chatModel: string | undefined;
    let reason: string | undefined;
    switch (ai.provider) {
      case 'none':
        reason = 'AI is turned off in Settings.';
        break;
      case 'anthropic':
        chat = !!s.anthropicKey;
        chatModel = ai.anthropicModel;
        if (!chat) reason = 'Add an Anthropic API key to use Claude.';
        break;
      case 'openai':
        chat = !!s.openaiKey;
        chatModel = ai.openaiModel;
        if (!chat) reason = 'Add an OpenAI API key.';
        break;
      default:
        chatModel = ai.chatModel;
        chat = this.has(tags, ai.chatModel);
        if (!tags) reason = `Ollama isn't reachable at ${ai.ollamaUrl}. Start it with \`ollama serve\`; search falls back to keywords.`;
        else if (!chat) reason = `Pull the chat model with \`ollama pull ${ai.chatModel}\`.`;
    }
    if (!embeddings && !reason) reason = `Pull the embedding model with \`ollama pull ${ai.embedModel}\` for meaning search.`;
    return { provider: ai.provider, chat, embeddings: ai.provider !== 'none' && embeddings, chatModel, embedModel, reason };
  }

  chatModel(): LanguageModel | null {
    const ai = this.ai;
    const s = this.secrets();
    if (ai.provider === 'anthropic' && s.anthropicKey) return createAnthropic({ apiKey: s.anthropicKey })(ai.anthropicModel);
    if (ai.provider === 'openai' && s.openaiKey) return createOpenAI({ apiKey: s.openaiKey })(ai.openaiModel);
    if (ai.provider === 'ollama') return this.ollama().chatModel(ai.chatModel);
    return null;
  }

  /** Whether the chat model is local (Ollama) – affects prompting (qwen3 /no_think). */
  get isLocalChat(): boolean {
    return this.ai.provider === 'ollama';
  }

  async embeddingModel(): Promise<{ model: EmbeddingModel; id: string; prefix: boolean } | null> {
    if (this.ai.provider === 'none') return null;
    const tags = await this.ollamaModels();
    if (this.has(tags, this.ai.embedModel)) {
      return { model: this.ollama().embeddingModel(this.ai.embedModel), id: `ollama:${this.ai.embedModel}`, prefix: this.ai.embedModel.includes('nomic') };
    }
    const s = this.secrets();
    if (s.openaiKey) return { model: createOpenAI({ apiKey: s.openaiKey }).embeddingModel(this.ai.openaiEmbedModel), id: `openai:${this.ai.openaiEmbedModel}`, prefix: false };
    return null;
  }
}
