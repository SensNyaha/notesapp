import {
  AutoProcessor,
  AutoTokenizer,
  env as transformersEnv,
  type RawImage,
} from "@huggingface/transformers";
import * as ort from "onnxruntime-web/all";
import { HTR_LOCAL_MODEL_ROOT, HTR_MODEL_IDS } from "./modelAssets.ts";

type Language = "ru" | "en";
type TokenizerInstance = Awaited<
  ReturnType<typeof AutoTokenizer.from_pretrained>
>;
type ProcessorInstance = Awaited<
  ReturnType<typeof AutoProcessor.from_pretrained>
>;

interface GenerationConfig {
  decoder_start_token_id?: number;
  eos_token_id?: number;
  pad_token_id?: number;
  max_length?: number;
  no_repeat_ngram_size?: number;
}

interface SessionPair {
  encoder: ort.InferenceSession;
  decoder: ort.InferenceSession;
  backend: "webgpu" | "wasm";
}
function configureOfflineRuntime() {
  transformersEnv.allowRemoteModels = false;
  transformersEnv.allowLocalModels = true;
  transformersEnv.localModelPath = HTR_LOCAL_MODEL_ROOT;
  transformersEnv.useBrowserCache = true;
  if (transformersEnv.backends.onnx?.wasm) {
    transformersEnv.backends.onnx.wasm.wasmPaths = "/ocr-runtime/htr/";
    transformersEnv.backends.onnx.wasm.numThreads = 1;
  }
  ort.env.wasm.wasmPaths = "/ocr-runtime/htr/";
  ort.env.wasm.numThreads = 1;
}

async function localJson<T>(language: Language, file: string): Promise<T> {
  const url = `${HTR_LOCAL_MODEL_ROOT}${HTR_MODEL_IDS[language]}/${file}`;
  const response = await fetch(url, {
    cache: "force-cache",
    credentials: "same-origin",
  });
  if (!response.ok)
    throw new Error(`Локальный OCR-файл недоступен: ${file}`);
  return await response.json() as T;
}
async function createSessionPair(language: Language): Promise<SessionPair> {
  const root = `${HTR_LOCAL_MODEL_ROOT}${HTR_MODEL_IDS[language]}/onnx/`;
  const encoderUrl = root + "encoder_model_quantized.onnx";
  const decoderUrl = root + "decoder_model_quantized.onnx";
  const webgpuAvailable = Boolean(
    (navigator as Navigator & { gpu?: unknown }).gpu,
  );

  if (webgpuAvailable) {
    try {
      const options: ort.InferenceSession.SessionOptions = {
        executionProviders: ["webgpu"],
        graphOptimizationLevel: "all",
      };
      const [encoder, decoder] = await Promise.all([
        ort.InferenceSession.create(encoderUrl, options),
        ort.InferenceSession.create(decoderUrl, options),
      ]);
      return { encoder, decoder, backend: "webgpu" };
    } catch {
      // Quantized operators are not supported by every WebGPU implementation.
    }
  }
  const options: ort.InferenceSession.SessionOptions = {
    executionProviders: ["wasm"],
    graphOptimizationLevel: "all",
  };
  const [encoder, decoder] = await Promise.all([
    ort.InferenceSession.create(encoderUrl, options),
    ort.InferenceSession.create(decoderUrl, options),
  ]);
  return { encoder, decoder, backend: "wasm" };
}

function int64Tensor(values: number[], dims: readonly number[]) {
  return new ort.Tensor(
    "int64",
    BigInt64Array.from(values, (value) => BigInt(value)),
    [...dims],
  );
}

function onesInt64(dims: readonly number[]) {
  const size = dims.reduce((product, value) => product * value, 1);
  return new ort.Tensor(
    "int64",
    BigInt64Array.from({ length: size }, () => 1n),
    [...dims],
  );
}
function bannedByNoRepeat(tokens: number[], ngramSize: number) {
  const banned = new Set<number>();
  if (ngramSize <= 1 || tokens.length < ngramSize - 1) return banned;
  const prefix = tokens.slice(tokens.length - (ngramSize - 1));
  for (let index = 0; index + ngramSize <= tokens.length; index++) {
    let matches = true;
    for (let offset = 0; offset < prefix.length; offset++) {
      if (tokens[index + offset] !== prefix[offset]) {
        matches = false;
        break;
      }
    }
    if (matches) banned.add(tokens[index + prefix.length]);
  }
  return banned;
}

function argmaxLastToken(
  logits: ort.Tensor,
  banned: ReadonlySet<number>,
) {
  const dims = logits.dims.map(Number);
  const vocab = dims[dims.length - 1];
  const sequence = dims.length >= 2 ? dims[dims.length - 2] : 1;
  const offset = (sequence - 1) * vocab;
  const values = logits.data as Float32Array;
  let bestId = 0;
  let bestValue = Number.NEGATIVE_INFINITY;
  for (let token = 0; token < vocab; token++) {
    if (banned.has(token)) continue;
    const value = Number(values[offset + token]);
    if (value > bestValue) {
      bestValue = value;
      bestId = token;
    }
  }
  return bestId;
}

function firstTensor(
  outputs: Record<string, ort.Tensor>,
  preferred: string[],
) {
  for (const name of preferred) {
    const value = outputs[name];
    if (value) return value;
  }
  const fallback = Object.values(outputs)[0];
  if (!fallback) throw new Error("ONNX-модель не вернула тензор.");
  return fallback;
}
export class LocalTrocr {
  readonly language: Language;
  readonly backend: "webgpu" | "wasm";
  private tokenizer: TokenizerInstance;
  private processor: ProcessorInstance;
  private encoder: ort.InferenceSession;
  private decoder: ort.InferenceSession;
  private generation: Required<Pick<
    GenerationConfig,
    "decoder_start_token_id" | "eos_token_id" | "pad_token_id"
  >> & Pick<GenerationConfig, "max_length" | "no_repeat_ngram_size">;

  private constructor(
    language: Language,
    tokenizer: TokenizerInstance,
    processor: ProcessorInstance,
    sessions: SessionPair,
    generation: LocalTrocr["generation"],
  ) {
    this.language = language;
    this.tokenizer = tokenizer;
    this.processor = processor;
    this.encoder = sessions.encoder;
    this.decoder = sessions.decoder;
    this.backend = sessions.backend;
    this.generation = generation;
  }
  static async create(language: Language) {
    configureOfflineRuntime();
    const modelId = HTR_MODEL_IDS[language];
    const [tokenizer, processor, generationRaw, config, sessions] =
      await Promise.all([
        AutoTokenizer.from_pretrained(modelId, { local_files_only: true }),
        AutoProcessor.from_pretrained(modelId, { local_files_only: true }),
        localJson<GenerationConfig>(language, "generation_config.json"),
        localJson<{
          decoder_start_token_id?: number;
          eos_token_id?: number;
          pad_token_id?: number;
          decoder?: GenerationConfig;
        }>(language, "config.json"),
        createSessionPair(language),
      ]);

    const decoder = config.decoder ?? {};
    return new LocalTrocr(
      language,
      tokenizer,
      processor,
      sessions,
      {
        decoder_start_token_id:
          generationRaw.decoder_start_token_id ??
          config.decoder_start_token_id ??
          decoder.decoder_start_token_id ??
          0,
        eos_token_id:
          generationRaw.eos_token_id ??
          config.eos_token_id ??
          decoder.eos_token_id ??
          2,
        pad_token_id:
          generationRaw.pad_token_id ??
          config.pad_token_id ??
          decoder.pad_token_id ??
          1,
        max_length:
          Math.min(96, generationRaw.max_length ?? decoder.max_length ?? 64),
        no_repeat_ngram_size:
          generationRaw.no_repeat_ngram_size ??
          decoder.no_repeat_ngram_size ??
          0,
      },
    );
  }

  async recognize(image: RawImage) {
    const processed = await this.processor(image) as {
      pixel_values: {
        type: string;
        data: Float32Array;
        dims: number[];
      };
    };
    const pixels = processed.pixel_values;
    if (pixels.type !== "float32")
      throw new Error("Неожиданный формат входа TrOCR.");
    const pixelTensor = new ort.Tensor(
      "float32",
      pixels.data,
      pixels.dims,
    );
    const encoderFeeds: Record<string, ort.Tensor> = {};
    for (const inputName of this.encoder.inputNames) {
      if (inputName === "pixel_values") encoderFeeds[inputName] = pixelTensor;
      else
        throw new Error(
          `Неизвестный вход encoder TrOCR: ${inputName}`,
        );
    }

    const encoderOutput = await this.encoder.run(encoderFeeds);
    const hidden = firstTensor(encoderOutput, [
      "last_hidden_state",
      "encoder_hidden_states",
    ]);
    const tokens = [this.generation.decoder_start_token_id];
    const maxLength = this.generation.max_length ?? 64;
    for (let step = 1; step < maxLength; step++) {
      const feeds: Record<string, ort.Tensor> = {};
      for (const inputName of this.decoder.inputNames) {
        if (inputName === "input_ids") {
          feeds[inputName] = int64Tensor(tokens, [1, tokens.length]);
        } else if (inputName === "encoder_hidden_states") {
          feeds[inputName] = hidden;
        } else if (
          inputName === "attention_mask" ||
          inputName === "decoder_attention_mask"
        ) {
          feeds[inputName] = onesInt64([1, tokens.length]);
        } else if (inputName === "encoder_attention_mask") {
          feeds[inputName] = onesInt64([1, Number(hidden.dims[1])]);
        } else {
          throw new Error(
            `Неизвестный вход decoder TrOCR: ${inputName}`,
          );
        }
      }

      const decoded = await this.decoder.run(feeds);
      const logits = firstTensor(decoded, ["logits"]);
      const banned = bannedByNoRepeat(
        tokens,
        this.generation.no_repeat_ngram_size ?? 0,
      );
      const next = argmaxLastToken(logits, banned);
      tokens.push(next);
      if (next === this.generation.eos_token_id) break;
    }

    return this.tokenizer.decode(tokens, {
      skip_special_tokens: true,
      clean_up_tokenization_spaces: true,
    }).trim();
  }

  async dispose() {
    await Promise.all([
      this.encoder.release(),
      this.decoder.release(),
    ]);
  }
}
