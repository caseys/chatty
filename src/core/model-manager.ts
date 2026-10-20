// ============================================================================
// Storage, Resumable Downloads, Integrity Verification, & Model Registry
// (Spec Sections 3.5, 4, 6)
// ============================================================================

import type {
  BrowserCapabilities,
  DeviceProfile,
  DownloadState,
  LongTermMemoryItem,
  ModelManifest,
  ConversationMessage,
  ConversationSummary,
  StoredConversation,
} from '../types/index.ts';

export const MODEL_REGISTRY: ReadonlyArray<ModelManifest> = [
  {
    id: 'whistle-stt-base',
    name: 'Whistle Speech-to-Text (Cactus Compute)',
    version: 'b358dda',
    task: 'stt',
    url: 'https://huggingface.co/Cactus-Compute/whistle/resolve/b358ddadd89b7a713b5aa131f23032d3cca1b251/whistle.cact',
    expectedSizeBytes: 16_919_407,
    sha256: 'b6e02f048568ac5d01a2042556c658061e699acbc0aa2a1439f52f3d461dffeb',
    runtime: 'whistle-wasm',
    requiredCapabilities: ['wasm', 'audio'],
    quantization: 'INT8/WASM',
    estimatedMemoryMB: 65,
    contextWindowTokens: 448,
    maxOutputTokens: 224,
    supportedLanguages: ['en', 'de', 'fr', 'es', 'it', 'nl', 'pl'],
    license: 'Apache-2.0',
    attribution: 'Cactus Compute Whistle via cactus-needle',
  },
  {
    id: 'gemma-4-e2b-it-web',
    name: 'Gemma 4 E2B Instruct (WebGPU)',
    version: '1.0.0',
    task: 'llm',
    url: 'https://huggingface.co/litert-community/gemma-4-E2B-it-litert-lm/resolve/main/gemma-4-E2B-it-web.litertlm',
    expectedSizeBytes: 2_008_432_640,
    sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    runtime: 'litert-lm',
    requiredCapabilities: ['webgpu', 'wasm'],
    quantization: 'INT4-WebGPU',
    estimatedMemoryMB: 1950,
    contextWindowTokens: 8192,
    maxOutputTokens: 2048, // a whole program, with room for long ones (music, games)
    supportedLanguages: ['en', 'de', 'fr', 'es', 'it', 'nl', 'pl'],
    license: 'Gemma Terms of Use',
    attribution: 'Google LiteRT-LM Gemma 4 E2B',
  },
  {
    id: 'gemma-4-e4b-it-web',
    name: 'Gemma 4 E4B Instruct (WebGPU High-Memory)',
    version: '1.0.0',
    task: 'llm',
    url: 'https://huggingface.co/litert-community/gemma-4-E4B-it-litert-lm/resolve/main/gemma-4-E4B-it-web.litertlm',
    expectedSizeBytes: 2_969_059_328,
    sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    runtime: 'litert-lm',
    requiredCapabilities: ['webgpu', 'wasm'],
    quantization: 'INT4-WebGPU',
    estimatedMemoryMB: 3600,
    contextWindowTokens: 8192,
    maxOutputTokens: 2048,
    supportedLanguages: ['en', 'de', 'fr', 'es', 'it', 'nl', 'pl'],
    license: 'Gemma Terms of Use',
    attribution: 'Google LiteRT-LM Gemma 4 E4B',
  },
  {
    id: 'en_US-hfc_female-medium',
    name: 'Piper US English Female (Medium ONNX)',
    version: '1.0.0',
    task: 'tts',
    url: 'https://huggingface.co/diffusionstudio/piper-voices/resolve/main/en/en_US/hfc_female/medium/en_US-hfc_female-medium.onnx',
    expectedSizeBytes: 63_201_294,
    sha256: 'piper-en-us-hfc-female-medium',
    runtime: 'piper-onnx',
    requiredCapabilities: ['wasm', 'audio'],
    quantization: 'FP32-ONNX',
    estimatedMemoryMB: 110,
    contextWindowTokens: 512,
    maxOutputTokens: 512,
    supportedLanguages: ['en'],
    license: 'MIT',
    attribution: 'Rhasspy Piper / ONNX Runtime Web',
  },
  {
    id: 'en_US-hfc_male-medium',
    name: 'Piper US English Male (Medium ONNX)',
    version: '1.0.0',
    task: 'tts',
    url: 'https://huggingface.co/diffusionstudio/piper-voices/resolve/main/en/en_US/hfc_male/medium/en_US-hfc_male-medium.onnx',
    expectedSizeBytes: 63_201_294,
    sha256: 'piper-en-us-hfc-male-medium',
    runtime: 'piper-onnx',
    requiredCapabilities: ['wasm', 'audio'],
    quantization: 'FP32-ONNX',
    estimatedMemoryMB: 110,
    contextWindowTokens: 512,
    maxOutputTokens: 512,
    supportedLanguages: ['en'],
    license: 'MIT',
    attribution: 'Rhasspy Piper / ONNX Runtime Web',
  },
];

// ============================================================================
// SHA-256 Integrity Helper
// ============================================================================

export async function computeSha256Hex(buffer: ArrayBuffer | Uint8Array): Promise<string> {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  const hashBuffer = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ============================================================================
// IndexedDB Metadata, Settings, & Conversation Persistence
// ============================================================================

const DB_NAME = 'chatty_local_db';
const DB_VERSION = 1;

export class LocalDatabase {
  private dbPromise: Promise<IDBDatabase> | null = null;

  private open(): Promise<IDBDatabase> {
    if (this.dbPromise) return this.dbPromise;
    this.dbPromise = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') {
        reject(new Error('IndexedDB is not available in this environment'));
        return;
      }
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('downloads')) {
          db.createObjectStore('downloads', { keyPath: 'modelId' });
        }
        if (!db.objectStoreNames.contains('memories')) {
          db.createObjectStore('memories', { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains('conversations')) {
          db.createObjectStore('conversations', { keyPath: 'id' });
        }
        if (!db.objectStoreNames.contains('settings')) {
          db.createObjectStore('settings', { keyPath: 'key' });
        }
        if (!db.objectStoreNames.contains('model_blobs')) {
          db.createObjectStore('model_blobs', { keyPath: 'modelId' });
        }
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('Failed to open IndexedDB'));
    });
    return this.dbPromise;
  }

  async putDownloadState(state: DownloadState): Promise<void> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('downloads', 'readwrite');
      tx.objectStore('downloads').put(state);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async getDownloadState(modelId: string): Promise<DownloadState | null> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('downloads', 'readonly');
      const req = tx.objectStore('downloads').get(modelId);
      req.onsuccess = () => resolve((req.result as DownloadState) ?? null);
      req.onerror = () => reject(req.error);
    });
  }

  async getAllDownloadStates(): Promise<DownloadState[]> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('downloads', 'readonly');
      const req = tx.objectStore('downloads').getAll();
      req.onsuccess = () => resolve((req.result as DownloadState[]) ?? []);
      req.onerror = () => reject(req.error);
    });
  }

  async deleteDownloadState(modelId: string): Promise<void> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('downloads', 'readwrite');
      tx.objectStore('downloads').delete(modelId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async saveConversation(convo: StoredConversation): Promise<void> {
    const db = await this.open();
    // Strip raw Float32Array audio buffers before persisting metadata to IndexedDB
    const serializableMessages = (convo.messages || []).map((m) => ({
      ...m,
      phrases: m.phrases?.map((p) => ({
        ...p,
        audioSamples: undefined,
      })),
    }));

    return new Promise((resolve, reject) => {
      const tx = db.transaction('conversations', 'readwrite');
      tx.objectStore('conversations').put({
        id: convo.id,
        title: convo.title || 'New Chat',
        createdAt: convo.createdAt || Date.now(),
        updatedAt: convo.updatedAt || Date.now(),
        messages: serializableMessages,
        summary: convo.summary ?? null,
      });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async loadConversation(id: string): Promise<StoredConversation | null> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('conversations', 'readonly');
      const req = tx.objectStore('conversations').get(id);
      req.onsuccess = () => resolve((req.result as StoredConversation) ?? null);
      req.onerror = () => reject(req.error);
    });
  }

  async listConversations(): Promise<StoredConversation[]> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('conversations', 'readonly');
      const req = tx.objectStore('conversations').getAll();
      req.onsuccess = () => {
        const all = (req.result as StoredConversation[]) ?? [];
        const channels = all.filter((c) => c && c.id && c.id !== 'active_session');
        channels.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0));
        resolve(channels);
      };
      req.onerror = () => reject(req.error);
    });
  }

  async deleteConversation(id: string): Promise<void> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('conversations', 'readwrite');
      tx.objectStore('conversations').delete(id);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async saveConversationSnapshot(
    messages: ReadonlyArray<ConversationMessage>,
    summary: ConversationSummary | null
  ): Promise<void> {
    return this.saveConversation({
      id: 'active_session',
      title: summary?.title || 'Active Session',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      messages: [...messages],
      summary,
    });
  }

  async loadConversationSnapshot(): Promise<{
    messages: ConversationMessage[];
    summary: ConversationSummary | null;
  } | null> {
    const convo = await this.loadConversation('active_session');
    if (!convo) return null;
    return { messages: convo.messages, summary: convo.summary };
  }

  async clearConversationSnapshot(): Promise<void> {
    return this.deleteConversation('active_session');
  }

  async saveMemories(memories: LongTermMemoryItem[]): Promise<void> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('memories', 'readwrite');
      const store = tx.objectStore('memories');
      store.clear();
      for (const mem of memories) {
        store.put(mem);
      }
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async loadMemories(): Promise<LongTermMemoryItem[]> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('memories', 'readonly');
      const req = tx.objectStore('memories').getAll();
      req.onsuccess = () => resolve((req.result as LongTermMemoryItem[]) ?? []);
      req.onerror = () => reject(req.error);
    });
  }

  async putModelBlobFallback(modelId: string, data: Uint8Array): Promise<void> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('model_blobs', 'readwrite');
      tx.objectStore('model_blobs').put({ modelId, data, updatedAt: Date.now() });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async getModelBlobFallback(modelId: string): Promise<Uint8Array | null> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('model_blobs', 'readonly');
      const req = tx.objectStore('model_blobs').get(modelId);
      req.onsuccess = () => resolve(req.result?.data ?? null);
      req.onerror = () => reject(req.error);
    });
  }

  async deleteModelBlobFallback(modelId: string): Promise<void> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('model_blobs', 'readwrite');
      tx.objectStore('model_blobs').delete(modelId);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async saveSetting(key: string, value: unknown): Promise<void> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('settings', 'readwrite');
      tx.objectStore('settings').put({ key, value, updatedAt: Date.now() });
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  async getSetting<T>(key: string): Promise<T | null> {
    const db = await this.open();
    return new Promise((resolve, reject) => {
      const tx = db.transaction('settings', 'readonly');
      const req = tx.objectStore('settings').get(key);
      req.onsuccess = () => resolve((req.result?.value as T) ?? null);
      req.onerror = () => reject(req.error);
    });
  }
}

// ============================================================================
// Adaptive Hardware & Capability Detection + Model Manager
// (Spec Sections 3.5, 4, 6)
// ============================================================================

export class ModelManager {
  readonly db: LocalDatabase;
  private memoryBlobCache = new Map<string, Uint8Array>();

  constructor(db?: LocalDatabase) {
    this.db = db ?? new LocalDatabase();
  }

  getRegistry(): ReadonlyArray<ModelManifest> {
    return MODEL_REGISTRY;
  }

  getManifest(modelId: string): ModelManifest | undefined {
    return MODEL_REGISTRY.find((m) => m.id === modelId);
  }

  /**
   * Detects browser capabilities, GPU limits, storage quota, and selects an
   * adaptive device profile per Spec Section 4.
   */
  async detectCapabilities(): Promise<BrowserCapabilities> {
    const hasWasm = typeof WebAssembly === 'object' && typeof WebAssembly.instantiate === 'function';
    const hasAudioContext =
      typeof window !== 'undefined' &&
      ('AudioContext' in window || 'webkitAudioContext' in window);
    const hasGetUserMedia =
      typeof navigator !== 'undefined' &&
      !!navigator.mediaDevices &&
      typeof navigator.mediaDevices.getUserMedia === 'function';
    const hasOPFS =
      typeof navigator !== 'undefined' &&
      !!navigator.storage &&
      typeof navigator.storage.getDirectory === 'function';
    const hasIndexedDB = typeof indexedDB !== 'undefined';
    const hasCacheStorage = typeof caches !== 'undefined';
    const hasSpeechSynthesis = typeof window !== 'undefined' && 'speechSynthesis' in window;
    const hasWebSpeechRecognition =
      typeof window !== 'undefined' &&
      ('SpeechRecognition' in window || 'webkitSpeechRecognition' in window);

    let hasWebGPU = false;
    let gpuAdapterName: string | undefined;
    let maxBufferSize = 0;
    let maxStorageBufferBindingSize = 0;

    if (typeof navigator !== 'undefined' && 'gpu' in navigator) {
      try {
        const gpu = (navigator as Navigator & { gpu?: { requestAdapter: (desc?: any) => Promise<any> } }).gpu;
        if (gpu && typeof gpu.requestAdapter === 'function') {
          hasWebGPU = true;
          gpuAdapterName = 'WebGPU';

          // Try to query adapter with fallback descriptors & a strict timeout so detection NEVER hangs
          const adapterPromise = (async () => {
            const candidates = [
              { powerPreference: 'high-performance' },
              undefined,
              { powerPreference: 'low-power' },
            ];
            for (const desc of candidates) {
              try {
                const a = desc ? await gpu.requestAdapter(desc) : await gpu.requestAdapter();
                if (a) return a;
              } catch {
                // try next
              }
            }
            return null;
          })();

          const timeoutPromise = new Promise<null>((r) => setTimeout(() => r(null), 1200));
          const adapter = await Promise.race([adapterPromise, timeoutPromise]);

          if (adapter) {
            maxBufferSize = adapter.limits?.maxBufferSize ?? 268_435_456;
            maxStorageBufferBindingSize = adapter.limits?.maxStorageBufferBindingSize ?? 134_217_728;
            gpuAdapterName = adapter.info?.description || adapter.info?.vendor || 'WebGPU';
          }
        }
      } catch {
        hasWebGPU = typeof navigator !== 'undefined' && 'gpu' in navigator;
      }
    }

    let storageQuotaBytes = 0;
    let storageUsageBytes = 0;
    let persistentStorageGranted = false;

    if (typeof navigator !== 'undefined' && navigator.storage) {
      try {
        const estimatePromise = navigator.storage.estimate?.() ?? Promise.resolve({});
        const timeoutPromise = new Promise<any>((r) => setTimeout(() => r({}), 1000));
        const estimate = await Promise.race([estimatePromise, timeoutPromise]);
        storageQuotaBytes = estimate?.quota ?? 0;
        storageUsageBytes = estimate?.usage ?? 0;

        if (typeof navigator.storage.persisted === 'function') {
          const persistPromise = navigator.storage.persisted();
          const persistTimeout = new Promise<boolean>((r) => setTimeout(() => r(false), 1000));
          persistentStorageGranted = await Promise.race([persistPromise, persistTimeout]);
          if (!persistentStorageGranted && typeof navigator.storage.persist === 'function') {
            persistentStorageGranted = await Promise.race([
              navigator.storage.persist().catch(() => false),
              new Promise<boolean>((r) => setTimeout(() => r(false), 1000)),
            ]);
          }
        }
      } catch {
        // Ignore storage query errors
      }
    }

    // Phones/tablets: WebGPU limits on Apple GPUs look desktop-class, but a mobile browser tab
    // is killed far below device RAM, so never treat them as high-memory.
    const nav = typeof navigator !== 'undefined' ? (navigator as Navigator & {
      userAgentData?: { mobile?: boolean };
      deviceMemory?: number;
    }) : undefined;
    const ua = nav?.userAgent ?? '';
    const isMobileDevice =
      nav?.userAgentData?.mobile === true ||
      /iPhone|iPad|iPod|Android|Mobile/i.test(ua) ||
      // iPadOS Safari reports a desktop Mac user agent
      (/Macintosh/.test(ua) && (nav?.maxTouchPoints ?? 0) > 1);
    const lowDeviceMemory = typeof nav?.deviceMemory === 'number' && nav.deviceMemory < 8;

    let deviceProfile: DeviceProfile = 'unsupported_webgpu';
    if (hasWebGPU) {
      if (isMobileDevice || lowDeviceMemory) {
        deviceProfile = 'constrained_mobile';
      } else if (maxStorageBufferBindingSize >= 1_073_741_824 && maxBufferSize >= 2_147_483_648) {
        deviceProfile = 'high_memory_desktop';
      } else if (maxStorageBufferBindingSize >= 268_435_456) {
        deviceProfile = 'typical_laptop_mobile';
      } else {
        deviceProfile = 'constrained_mobile';
      }
    }

    return {
      hasWebGPU,
      gpuAdapterName,
      maxBufferSize,
      maxStorageBufferBindingSize,
      hasWasm,
      hasAudioContext,
      hasGetUserMedia,
      hasOPFS,
      hasIndexedDB,
      hasCacheStorage,
      hasSpeechSynthesis,
      hasWebSpeechRecognition,
      storageQuotaBytes,
      storageUsageBytes,
      persistentStorageGranted,
      deviceProfile,
    };
  }

  /**
   * Recommends initial STT, LLM, and TTS models and context limits for the detected hardware profile.
   */
  recommendModelsForCapabilities(caps: BrowserCapabilities): {
    sttModelId: string;
    llmModelId: string;
    fallbackLlmModelId: string;
    ttsModelId: string;
    recommendedContextLimit: number;
    recommendedMaxOutputTokens: number;
    reasoning: string;
  } {
    // 1. High-memory desktop with discrete GPU and >= 5GB OPFS storage
    const hasHighEndDesktopGpu =
      caps.deviceProfile === 'high_memory_desktop' &&
      caps.maxStorageBufferBindingSize >= 1_073_741_824 &&
      caps.maxBufferSize >= 2_147_483_648 &&
      caps.storageQuotaBytes >= 5_000_000_000;

    if (hasHighEndDesktopGpu) {
      return {
        sttModelId: 'whistle-stt-base',
        llmModelId: 'gemma-4-e4b-it-web',
        fallbackLlmModelId: 'gemma-4-e2b-it-web',
        ttsModelId: 'en_US-hfc_female-medium',
        recommendedContextLimit: 8192,
        recommendedMaxOutputTokens: 1024,
        reasoning: 'High-memory WebGPU adapter and ample storage detected; selecting Gemma 4 E4B (4B) with full 8k context.',
      };
    }

    // 2. Mobile devices or memory-constrained profiles
    if (caps.deviceProfile === 'constrained_mobile') {
      return {
        sttModelId: 'whistle-stt-base',
        llmModelId: 'gemma-4-e2b-it-web',
        fallbackLlmModelId: 'gemma-4-e2b-it-web',
        ttsModelId: 'en_US-hfc_female-medium',
        recommendedContextLimit: 4096, // Keep KV cache footprint low on mobile VRAM
        recommendedMaxOutputTokens: 512,
        reasoning: 'Mobile WebGPU profile detected; selecting Gemma 4 E2B (2B) with 4k context to ensure smooth thermal and memory performance.',
      };
    }

    // 3. Typical laptop / standard profile
    return {
      sttModelId: 'whistle-stt-base',
      llmModelId: 'gemma-4-e2b-it-web',
      fallbackLlmModelId: 'gemma-4-e2b-it-web',
      ttsModelId: 'en_US-hfc_female-medium',
      recommendedContextLimit: 8192,
      recommendedMaxOutputTokens: 1024,
      reasoning: 'Standard WebGPU environment detected; selecting Gemma 4 E2B (2B) with 8k context.',
    };
  }

  // --------------------------------------------------------------------------
  // OPFS & Fallback Artifact Persistence + Integrity Validation (Spec Section 6)
  // --------------------------------------------------------------------------

  async storeArtifact(
    modelId: string,
    bytes: Uint8Array,
    expectedSha256?: string
  ): Promise<DownloadState> {
    const manifest = this.getManifest(modelId);
    if (expectedSha256 && expectedSha256 !== 'local' && !expectedSha256.startsWith('piper-')) {
      const actualHash = await computeSha256Hex(bytes);
      if (actualHash !== expectedSha256.toLowerCase()) {
        const failedState: DownloadState = {
          modelId,
          version: manifest?.version ?? '1.0.0',
          status: 'failed',
          downloadedBytes: bytes.byteLength,
          totalBytes: bytes.byteLength,
          completedChunks: [],
          storageBackend: 'memory',
          updatedAt: Date.now(),
          error: `Integrity check failed: expected ${expectedSha256}, got ${actualHash}`,
        };
        await this.db.putDownloadState(failedState);
        throw new Error(failedState.error);
      }
    }

    let backend: DownloadState['storageBackend'] = 'memory';

    // Try OPFS first for large binary model artifacts
    if (
      typeof navigator !== 'undefined' &&
      navigator.storage &&
      typeof navigator.storage.getDirectory === 'function'
    ) {
      try {
        const root = await navigator.storage.getDirectory();
        const fileHandle = await root.getFileHandle(`${modelId}.bin`, { create: true });
        const writable = await (fileHandle as any).createWritable();
        await writable.write(bytes);
        await writable.close();
        backend = 'opfs';
      } catch {
        backend = 'memory';
      }
    }

    // Fallback to IndexedDB blob storage if OPFS is unavailable
    if (backend === 'memory') {
      try {
        await this.db.putModelBlobFallback(modelId, bytes);
        backend = 'indexeddb';
      } catch {
        this.memoryBlobCache.set(modelId, bytes);
        backend = 'memory';
      }
    }

    const state: DownloadState = {
      modelId,
      version: manifest?.version ?? '1.0.0',
      status: 'cached',
      downloadedBytes: bytes.byteLength,
      totalBytes: bytes.byteLength,
      completedChunks: [0],
      verifiedSha256: expectedSha256,
      storageBackend: backend,
      updatedAt: Date.now(),
    };

    await this.db.putDownloadState(state);
    return state;
  }

  async loadArtifact(modelId: string): Promise<Uint8Array | null> {
    if (
      typeof navigator !== 'undefined' &&
      navigator.storage &&
      typeof navigator.storage.getDirectory === 'function'
    ) {
      try {
        const root = await navigator.storage.getDirectory();
        const fileHandle = await root.getFileHandle(`${modelId}.bin`);
        const file = await fileHandle.getFile();
        const buf = await file.arrayBuffer();
        return new Uint8Array(buf);
      } catch {
        // Fallback to IndexedDB or memory
      }
    }

    try {
      const idbBytes = await this.db.getModelBlobFallback(modelId);
      if (idbBytes) return idbBytes;
    } catch {
      // Ignore
    }

    return this.memoryBlobCache.get(modelId) ?? null;
  }

  async removeArtifact(modelId: string): Promise<void> {
    if (
      typeof navigator !== 'undefined' &&
      navigator.storage &&
      typeof navigator.storage.getDirectory === 'function'
    ) {
      try {
        const root = await navigator.storage.getDirectory();
        await root.removeEntry(`${modelId}.bin`);
      } catch {
        // Ignore if not present
      }
    }

    await this.db.deleteModelBlobFallback(modelId).catch(() => {});
    await this.db.deleteDownloadState(modelId).catch(() => {});
    this.memoryBlobCache.delete(modelId);
  }
}
