/**
 * Models WebLLM doesn't ship: public fine-tunes and LoRA adapters of models it does, converted to
 * MLC's format (q4f16_1) by us and hosted in Chatty's R2 bucket. Each keeps its base model's
 * architecture, quantization and vocabulary, so it runs on the base's compiled WebGPU library.
 */

/** Where the converted weights are served from (a public R2 bucket) */
export const CUSTOM_MODEL_HOST = 'https://pub-2f0eea461d774d24861d400d343458bf.r2.dev';

export interface CustomModel {
  /** WebLLM's id for it (its folder in the bucket) */
  mlcId: string;
  /** The WebLLM model it was made from, whose compiled library it uses */
  base: string;
}

export const CUSTOM_MODELS: ReadonlyArray<CustomModel> = [
  // CodeAtCMU/Qwen3-0.6B_full_sft_JavaScript_data_12K: Qwen3 0.6B fine-tuned on 12K JavaScript examples. First
  // replies on 16 requests, 4-5 passes: 27 of 74 against plain Qwen3's 26 of 76, better at drawing, worse at music.
  // (Tried and left out: LoRAs for MBPP and p5.js on Qwen3, Atlas-Coder on Qwen2.5-Coder; all did worse than their base)
  { mlcId: 'Qwen3-0.6B-JS12K-q4f16_1-MLC', base: 'Qwen3-0.6B-q4f16_1-MLC' },
];

/** WebLLM model records for them, from the base models' records (whose library each one uses) */
export function customModelRecords<R extends { model: string; model_id: string; model_lib: string }>(prebuilt: ReadonlyArray<R>): R[] {
  const records: R[] = [];
  for (const custom of CUSTOM_MODELS) {
    const base = prebuilt.find((record) => record.model_id === custom.base);
    if (base) records.push({ ...base, model_id: custom.mlcId, model: `${CUSTOM_MODEL_HOST}/${custom.mlcId}/` });
  }
  return records;
}
