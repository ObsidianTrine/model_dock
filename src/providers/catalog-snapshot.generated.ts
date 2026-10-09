// 由 scripts/gen-catalog-snapshot.mjs 生成（数据源 models.dev api.json，2026-10-05T12:56:33.054Z）；勿手改，
// 刷新：node scripts/gen-catalog-snapshot.mjs。运行时以 ~/.modeldock/model-catalog.json 缓存（若存在）为准。
import type { CatalogData } from './catalog.js'

export const CATALOG_SNAPSHOT_FETCHED_AT = '2026-10-05T12:56:33.054Z'
export const CATALOG_SNAPSHOT: CatalogData = {
 "fetchedAt": "2026-10-05T12:56:33.054Z",
 "providers": {
  "deepinfra": {
   "api": null,
   "models": {
    "tencent/Hy3": {
     "context_window": 262144,
     "max_output": 128000
    },
    "tencent/Hy4-preview": {
     "context_window": 1048576,
     "max_output": 64000
    },
    "meta-llama/Llama-3.3-70B-Instruct-Turbo": {
     "context_window": 131072,
     "max_output": 16384
    },
    "meta-llama/Llama-4-Scout-17B-16E-Instruct": {
     "context_window": 327680,
     "max_output": 16384
    },
    "meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8": {
     "context_window": 1048576,
     "max_output": 16384
    },
    "XiaomiMiMo/MiMo-V2.6-Pro": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "XiaomiMiMo/MiMo-V2.5-Pro": {
     "context_window": 1048576,
     "max_output": 16384
    },
    "XiaomiMiMo/MiMo-V2.6-Flash": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "XiaomiMiMo/MiMo-V2.5": {
     "context_window": 262144,
     "max_output": 16384
    },
    "thinkingmachines/Inkling-Small": {
     "context_window": 524288,
     "max_output": 1048576
    },
    "thinkingmachines/Inkling": {
     "context_window": 524288,
     "max_output": 1048576
    },
    "google/gemma-3-27b-it": {
     "context_window": 131072,
     "max_output": 131072
    },
    "google/gemma-3-12b-it": {
     "context_window": 131072,
     "max_output": 131072
    },
    "google/gemma-3-4b-it": {
     "context_window": 131072,
     "max_output": 131072
    },
    "google/gemma-4-31B-it": {
     "context_window": 262144,
     "max_output": 32768
    },
    "google/gemma-4-26B-A4B-it": {
     "context_window": 262144,
     "max_output": 32768
    },
    "google/gemma-4-E4B-it": {
     "context_window": 131072,
     "max_output": 8192
    },
    "Qwen/Qwen3-VL-235B-A22B-Instruct": {
     "context_window": 262144,
     "max_output": 32768
    },
    "Qwen/Qwen3.8-27B": {
     "context_window": 262144,
     "max_output": 32768
    },
    "Qwen/Qwen3-Next-80B-A3B-Instruct": {
     "context_window": 262144,
     "max_output": 32768
    },
    "Qwen/Qwen3.7-Max": {
     "context_window": 256000,
     "max_output": 65536
    },
    "Qwen/Qwen3.8-Max": {
     "context_window": 256000,
     "max_output": 131072
    },
    "Qwen/Qwen3.5-27B": {
     "context_window": 262144,
     "max_output": 65536
    },
    "Qwen/Qwen3.6-35B-A3B": {
     "context_window": 262144,
     "max_output": 81920
    },
    "Qwen/Qwen3-Coder-480B-A35B-Instruct-Turbo": {
     "context_window": 262144,
     "max_output": 66536
    },
    "Qwen/Qwen3-Max": {
     "context_window": 256000,
     "max_output": 65536
    },
    "Qwen/Qwen3-235B-A22B-Instruct-2507": {
     "context_window": 262144,
     "max_output": 16384
    },
    "Qwen/Qwen3.8-Flash": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "Qwen/Qwen3-32B": {
     "context_window": 40960,
     "max_output": 16384
    },
    "Qwen/Qwen3.5-35B-A3B": {
     "context_window": 262144,
     "max_output": 81920
    },
    "Qwen/Qwen3.5-122B-A10B": {
     "context_window": 262144,
     "max_output": 65536
    },
    "Qwen/Qwen3.5-9B": {
     "context_window": 262144,
     "max_output": 65536
    },
    "Qwen/Qwen3.5-397B-A17B": {
     "context_window": 262144,
     "max_output": 81920
    },
    "Qwen/Qwen3.8-2.4T-A95B": {
     "context_window": 262144,
     "max_output": 131072
    },
    "Qwen/Qwen3-30B-A3B": {
     "context_window": 40960,
     "max_output": 16384
    },
    "Qwen/Qwen3.6-27B": {
     "context_window": 262144,
     "max_output": 65536
    },
    "deepseek-ai/DeepSeek-V3.1": {
     "context_window": 163840,
     "max_output": 8192
    },
    "deepseek-ai/DeepSeek-V4-Flash-0731": {
     "context_window": 1048576,
     "max_output": 384000
    },
    "deepseek-ai/DeepSeek-V4-Pro-0813": {
     "context_window": 1048576,
     "max_output": 384000
    },
    "deepseek-ai/DeepSeek-V4.1-Flash": {
     "context_window": 1048576,
     "max_output": 384000
    },
    "deepseek-ai/DeepSeek-V4-Flash": {
     "context_window": 1048576,
     "max_output": 16384
    },
    "deepseek-ai/DeepSeek-V4-Pro": {
     "context_window": 1048576,
     "max_output": 16384
    },
    "deepseek-ai/DeepSeek-V3.2": {
     "context_window": 163840,
     "max_output": 64000
    },
    "deepseek-ai/DeepSeek-R1-0528": {
     "context_window": 163840,
     "max_output": 64000
    },
    "deepseek-ai/DeepSeek-V3": {
     "context_window": 163840,
     "max_output": 8192
    },
    "deepseek-ai/DeepSeek-V3-0324": {
     "context_window": 163840,
     "max_output": 163840
    },
    "deepseek-ai/DeepSeek-V4-Flash-Vision-Exp": {
     "context_window": 1048576,
     "max_output": 384000
    },
    "stepfun-ai/Step-3.7-Flash": {
     "context_window": 262144,
     "max_output": 256000
    },
    "MiniMaxAI/MiniMax-M3": {
     "context_window": 524288,
     "max_output": 512000
    },
    "MiniMaxAI/MiniMax-M2.5": {
     "context_window": 196608,
     "max_output": 131072
    },
    "MiniMaxAI/MiniMax-M2.7": {
     "context_window": 196608,
     "max_output": 131072
    },
    "moonshotai/Kimi-K2.6": {
     "context_window": 262144,
     "max_output": 16384
    },
    "moonshotai/Kimi-K3": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "moonshotai/Kimi-K2.7-Code": {
     "context_window": 262144,
     "max_output": 262144
    },
    "moonshotai/Kimi-K2.5": {
     "context_window": 262144,
     "max_output": 32768
    },
    "zai-org/GLM-5.1": {
     "context_window": 202752,
     "max_output": 16384
    },
    "zai-org/GLM-5.2": {
     "context_window": 1048576,
     "max_output": 32768
    },
    "zai-org/GLM-4.7": {
     "context_window": 202752,
     "max_output": 16384
    },
    "zai-org/GLM-5": {
     "context_window": 202752,
     "max_output": 16384
    },
    "zai-org/GLM-5.3-Flash": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "zai-org/GLM-4.6": {
     "context_window": 202752,
     "max_output": 131072
    },
    "zai-org/GLM-4.7-Flash": {
     "context_window": 202752,
     "max_output": 16384
    },
    "zai-org/GLM-5.3": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "nvidia/Nemotron-3-Nano-30B-A3B": {
     "context_window": 262144,
     "max_output": 262144
    },
    "nvidia/Llama-3.3-Nemotron-Super-49B-v1.5": {
     "context_window": 131072,
     "max_output": 131072
    },
    "nvidia/Nemotron-3-Nano-Omni-30B-A3B-Reasoning": {
     "context_window": 262144,
     "max_output": 65536
    },
    "ByteDance/Seed-2.0-code": {
     "context_window": 256000,
     "max_output": 131072
    },
    "ByteDance/Seed-2.0-pro": {
     "context_window": 256000,
     "max_output": 128000
    },
    "ByteDance/Seed-2.0-mini": {
     "context_window": 256000,
     "max_output": 32000
    },
    "openai/gpt-oss-20b": {
     "context_window": 131072,
     "max_output": 16384
    },
    "openai/gpt-oss-120b": {
     "context_window": 131072,
     "max_output": 16384
    }
   }
  },
  "perplexity-agent": {
   "api": "https://api.perplexity.ai/v1",
   "models": {
    "anthropic/claude-haiku-4-5": {
     "context_window": 200000,
     "max_output": 64000
    },
    "anthropic/claude-opus-4-5": {
     "context_window": 200000,
     "max_output": 64000
    },
    "anthropic/claude-sonnet-4-5": {
     "context_window": 200000,
     "max_output": 64000
    },
    "anthropic/claude-opus-4-6": {
     "context_window": 200000,
     "max_output": 128000
    },
    "anthropic/claude-sonnet-4-6": {
     "context_window": 200000,
     "max_output": 64000
    },
    "anthropic/claude-opus-4-7": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "deepseek/deepseek-v4-flash-0731": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "perplexity/sonar": {
     "context_window": 128000,
     "max_output": 8192
    },
    "google/gemini-3.1-pro-preview": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemini-2.5-pro": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemini-2.5-flash": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemini-3-flash-preview": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "xai/grok-4-1-fast-non-reasoning": {
     "context_window": 2000000,
     "max_output": 30000
    },
    "xai/grok-4.6": {
     "context_window": 500000,
     "max_output": 500000
    },
    "nvidia/nemotron-3-super-120b-a12b": {
     "context_window": 1000000,
     "max_output": 32000
    },
    "moonshot-ai/kimi-k3": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "moonshot-ai/kimi-k2.7-code": {
     "context_window": 262144,
     "max_output": 262144
    },
    "openai/gpt-5.4": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-5-mini": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-5.1": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-5.2": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-5.5": {
     "context_window": 1050000,
     "max_output": 128000
    }
   }
  },
  "bailing": {
   "api": "https://api.tbox.cn/api/llm/v1",
   "models": {
    "Ring-1T": {
     "context_window": 128000,
     "max_output": 32000
    },
    "Ling-1T": {
     "context_window": 128000,
     "max_output": 32000
    }
   }
  },
  "poe": {
   "api": "https://api.poe.com/v1",
   "models": {
    "cerebras/llama-3.1-8b-cs": {
     "context_window": 128000
    },
    "cerebras/gpt-oss-120b-cs": {
     "context_window": 128000
    },
    "empiriolabs/deepseek-v4-pro-el": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "empiriolabs/deepseek-v4-flash-el": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "anthropic/claude-haiku-3.5": {
     "context_window": 189096,
     "max_output": 8192
    },
    "anthropic/claude-opus-4.1": {
     "context_window": 196608,
     "max_output": 32000
    },
    "anthropic/claude-opus-4.5": {
     "context_window": 196608,
     "max_output": 64000
    },
    "anthropic/claude-opus-4.6": {
     "context_window": 983040,
     "max_output": 128000
    },
    "anthropic/claude-sonnet-3.5-june": {
     "context_window": 189096,
     "max_output": 8192
    },
    "anthropic/claude-opus-4.7": {
     "context_window": 1048576,
     "max_output": 128000
    },
    "anthropic/claude-haiku-3": {
     "context_window": 189096,
     "max_output": 8192
    },
    "anthropic/claude-opus-4.8": {
     "context_window": 1048576,
     "max_output": 128000
    },
    "anthropic/claude-sonnet-3.7": {
     "context_window": 196608,
     "max_output": 128000
    },
    "anthropic/claude-haiku-4.5": {
     "context_window": 192000,
     "max_output": 64000
    },
    "anthropic/claude-sonnet-4.5": {
     "context_window": 983040,
     "max_output": 32768
    },
    "anthropic/claude-sonnet-4": {
     "context_window": 983040,
     "max_output": 64000
    },
    "anthropic/claude-sonnet-3.5": {
     "context_window": 189096,
     "max_output": 8192
    },
    "anthropic/claude-sonnet-4.6": {
     "context_window": 983040,
     "max_output": 128000
    },
    "anthropic/claude-opus-4": {
     "context_window": 192512,
     "max_output": 28672
    },
    "elevenlabs/elevenlabs-v2.5-turbo": {
     "context_window": 128000
    },
    "elevenlabs/elevenlabs-v3": {
     "context_window": 128000
    },
    "elevenlabs/elevenlabs-music": {
     "context_window": 2000
    },
    "novita/glm-4.6v": {
     "context_window": 131000,
     "max_output": 32768
    },
    "novita/glm-5": {
     "context_window": 205000,
     "max_output": 131072
    },
    "novita/kimi-k2.6": {
     "context_window": 262144,
     "max_output": 262144
    },
    "novita/kimi-k2-thinking": {
     "context_window": 256000
    },
    "novita/kimi-k2.5": {
     "context_window": 128000,
     "max_output": 262144
    },
    "novita/glm-4.7-flash": {
     "context_window": 200000,
     "max_output": 65500
    },
    "novita/glm-4.7": {
     "context_window": 205000,
     "max_output": 131072
    },
    "novita/glm-4.7-n": {
     "context_window": 205000,
     "max_output": 131072
    },
    "novita/deepseek-v3.2": {
     "context_window": 128000
    },
    "novita/minimax-m2.1": {
     "context_window": 205000,
     "max_output": 131072
    },
    "lumalabs/ray2": {
     "context_window": 5000
    },
    "google/gemini-deep-research": {
     "context_window": 1048576
    },
    "google/nano-banana": {
     "context_window": 65536
    },
    "google/gemini-2.0-flash": {
     "context_window": 990000,
     "max_output": 8192
    },
    "google/nano-banana-pro": {
     "context_window": 65536
    },
    "google/gemini-2.0-flash-lite": {
     "context_window": 990000,
     "max_output": 8192
    },
    "google/gemini-3-flash": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemini-3.5-flash": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemini-2.5-pro": {
     "context_window": 1065535,
     "max_output": 65535
    },
    "google/gemini-2.5-flash": {
     "context_window": 1065535,
     "max_output": 65535
    },
    "google/gemini-3-pro": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemma-4-31b": {
     "context_window": 262144,
     "max_output": 8192
    },
    "google/gemini-2.5-flash-lite": {
     "context_window": 1024000,
     "max_output": 64000
    },
    "google/gemini-3.1-pro": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemini-3.1-flash-lite": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "xai/grok-3": {
     "context_window": 131072,
     "max_output": 8192
    },
    "xai/grok-4.20-multi-agent": {
     "context_window": 128000
    },
    "xai/grok-4": {
     "context_window": 256000,
     "max_output": 128000
    },
    "xai/grok-4-fast-reasoning": {
     "context_window": 2000000,
     "max_output": 128000
    },
    "xai/grok-4.1-fast-reasoning": {
     "context_window": 2000000,
     "max_output": 30000
    },
    "xai/grok-4-fast-non-reasoning": {
     "context_window": 2000000,
     "max_output": 128000
    },
    "xai/grok-3-mini": {
     "context_window": 131072,
     "max_output": 8192
    },
    "xai/grok-code-fast-1": {
     "context_window": 256000,
     "max_output": 128000
    },
    "xai/grok-4.1-fast-non-reasoning": {
     "context_window": 2000000,
     "max_output": 30000
    },
    "fireworks-ai/kimi-k2.5-fw": {
     "context_window": 262144,
     "max_output": 16384
    },
    "trytako/tako": {
     "context_window": 2048
    },
    "openai/gpt-5.4": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-5.4-pro": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-3.5-turbo": {
     "context_window": 16384,
     "max_output": 2048
    },
    "openai/gpt-5.5-pro": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-5.4-nano": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-5.2-codex": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-5.1-codex": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-4o": {
     "context_window": 128000,
     "max_output": 8192
    },
    "openai/gpt-4o-search": {
     "context_window": 128000,
     "max_output": 8192
    },
    "openai/gpt-5-codex": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-5-mini": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-5.2-pro": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/o4-mini": {
     "context_window": 200000,
     "max_output": 100000
    },
    "openai/o3-mini": {
     "context_window": 200000,
     "max_output": 100000
    },
    "openai/gpt-5.3-codex": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-4.1-nano": {
     "context_window": 1047576,
     "max_output": 32768
    },
    "openai/o3-deep-research": {
     "context_window": 200000,
     "max_output": 100000
    },
    "openai/gpt-5-nano": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-5.2-instant": {
     "context_window": 128000,
     "max_output": 16384
    },
    "openai/o1": {
     "context_window": 200000,
     "max_output": 100000
    },
    "openai/chatgpt-4o-latest": {
     "context_window": 128000,
     "max_output": 8192
    },
    "openai/gpt-5-pro": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-3.5-turbo-instruct": {
     "context_window": 3500,
     "max_output": 1024
    },
    "openai/gpt-5.3-codex-spark": {
     "context_window": 128000,
     "max_output": 16384
    },
    "openai/gpt-5.1": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-5-chat": {
     "context_window": 128000,
     "max_output": 16384
    },
    "openai/gpt-4o-mini": {
     "context_window": 124096,
     "max_output": 4096
    },
    "openai/o3-pro": {
     "context_window": 200000,
     "max_output": 100000
    },
    "openai/gpt-5.3-instant": {
     "context_window": 128000,
     "max_output": 16384
    },
    "openai/gpt-4o-aug": {
     "context_window": 128000,
     "max_output": 8192
    },
    "openai/o3-mini-high": {
     "context_window": 200000,
     "max_output": 100000
    },
    "openai/gpt-5.1-instant": {
     "context_window": 128000,
     "max_output": 16384
    },
    "openai/gpt-image-1": {
     "context_window": 128000
    },
    "openai/gpt-5.4-mini": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-5.1-codex-max": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-5.2": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-5.5": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/o4-mini-deep-research": {
     "context_window": 200000,
     "max_output": 100000
    },
    "openai/gpt-4.1": {
     "context_window": 1047576,
     "max_output": 32768
    },
    "openai/gpt-4-classic-0314": {
     "context_window": 8192,
     "max_output": 4096
    },
    "openai/gpt-4-classic": {
     "context_window": 8192,
     "max_output": 4096
    },
    "openai/gpt-4o-mini-search": {
     "context_window": 128000,
     "max_output": 8192
    },
    "openai/gpt-3.5-turbo-raw": {
     "context_window": 4524,
     "max_output": 2048
    },
    "openai/gpt-4.1-mini": {
     "context_window": 1047576,
     "max_output": 32768
    },
    "openai/gpt-image-1.5": {
     "context_window": 128000
    },
    "openai/gpt-4-turbo": {
     "context_window": 128000,
     "max_output": 4096
    },
    "openai/gpt-5.1-codex-mini": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/o3": {
     "context_window": 200000,
     "max_output": 100000
    },
    "openai/gpt-5": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/o1-pro": {
     "context_window": 200000,
     "max_output": 100000
    }
   }
  },
  "cerebras": {
   "api": null,
   "models": {
    "qwen-3.8-27b": {
     "context_window": 131072,
     "max_output": 40960
    },
    "gpt-oss-120b": {
     "context_window": 131072,
     "max_output": 40960
    }
   }
  },
  "groq": {
   "api": null,
   "models": {
    "llama-3.3-70b-versatile": {
     "context_window": 131072,
     "max_output": 32768
    },
    "allam-2-7b": {
     "context_window": 4096,
     "max_output": 4096
    },
    "llama-3.1-8b-instant": {
     "context_window": 131072,
     "max_output": 131072
    },
    "groq/compound-mini": {
     "context_window": 131072,
     "max_output": 8192
    },
    "groq/compound": {
     "context_window": 131072,
     "max_output": 8192
    },
    "meta-llama/llama-prompt-guard-2-86m": {
     "max_output": 512
    },
    "meta-llama/llama-prompt-guard-2-22m": {
     "max_output": 512
    },
    "canopylabs/orpheus-v1-english": {
     "context_window": 4000,
     "max_output": 50000
    },
    "canopylabs/orpheus-arabic-saudi": {
     "context_window": 4000,
     "max_output": 50000
    },
    "qwen/qwen3.8-27b": {
     "context_window": 131042,
     "max_output": 16384
    },
    "qwen/qwen3.6-27b": {
     "context_window": 131072,
     "max_output": 16384
    },
    "openai/gpt-oss-20b": {
     "context_window": 131072,
     "max_output": 65536
    },
    "openai/gpt-oss-safeguard-20b": {
     "context_window": 131072,
     "max_output": 65536
    },
    "openai/gpt-oss-120b": {
     "context_window": 131072,
     "max_output": 65536
    }
   }
  },
  "blueclaw": {
   "api": "https://openai.blueclaw.network/v1",
   "models": {
    "Qwen3.8-27B": {
     "context_window": 131072,
     "max_output": 32768
    }
   }
  },
  "zai": {
   "api": "https://api.z.ai/api/paas/v4",
   "models": {
    "glm-4.6v": {
     "context_window": 128000,
     "max_output": 32768
    },
    "glm-4.5": {
     "context_window": 131072,
     "max_output": 98304
    },
    "glm-5v-turbo": {
     "context_window": 200000,
     "max_output": 131072
    },
    "glm-5.3-flash": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "glm-4.6": {
     "context_window": 204800,
     "max_output": 131072
    },
    "glm-5": {
     "context_window": 204800,
     "max_output": 131072
    },
    "glm-4.6v-flash": {
     "context_window": 128000,
     "max_output": 32768
    },
    "glm-4.5v": {
     "context_window": 64000,
     "max_output": 16384
    },
    "glm-5.3-flashx": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "glm-4.7-flash": {
     "context_window": 200000,
     "max_output": 131072
    },
    "glm-4.7": {
     "context_window": 204800,
     "max_output": 131072
    },
    "glm-4.5-flash": {
     "context_window": 131072,
     "max_output": 98304
    },
    "glm-5.2": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "glm-5.1": {
     "context_window": 200000,
     "max_output": 131072
    },
    "glm-4.7-flashx": {
     "context_window": 200000,
     "max_output": 131072
    },
    "glm-5-turbo": {
     "context_window": 200000,
     "max_output": 131072
    },
    "glm-4.5-air": {
     "context_window": 131072,
     "max_output": 98304
    },
    "glm-5.3": {
     "context_window": 1000000,
     "max_output": 131072
    }
   }
  },
  "empiriolabs": {
   "api": "https://api.empiriolabs.ai/v1",
   "models": {
    "qwen3-8-max-0902": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "qwen3-6-plus": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "qwen3-6-27b": {
     "context_window": 256000,
     "max_output": 64000
    },
    "glm-5-3-flash": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "kimi-k2-7-code": {
     "context_window": 256000,
     "max_output": 131072
    },
    "seed-2-0-lite": {
     "context_window": 256000,
     "max_output": 128000
    },
    "deepseek-v4-flash-0731": {
     "context_window": 1000000,
     "max_output": 393216
    },
    "mimo-v2-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "seed-2-0-mini": {
     "context_window": 256000,
     "max_output": 128000
    },
    "muse-glimmer-30b": {
     "context_window": 131072,
     "max_output": 32768
    },
    "kimi-k3": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "glm-4-7-flash": {
     "context_window": 200000,
     "max_output": 131072
    },
    "mimo-v2-6-pro": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "qwen3-7-max": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "step-3-5-flash": {
     "context_window": 256000,
     "max_output": 131072
    },
    "qwen3-8-max": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "deepseek-v3-2": {
     "context_window": 128000,
     "max_output": 32768
    },
    "minimax-m2-7-highspeed": {
     "context_window": 200000,
     "max_output": 32768
    },
    "mimo-v2-5-pro": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "qwen3-max": {
     "context_window": 256000,
     "max_output": 65536
    },
    "seed-2-0-pro": {
     "context_window": 256000,
     "max_output": 128000
    },
    "qwen3-5-4b": {
     "context_window": 262144,
     "max_output": 32768
    },
    "step-5-preview": {
     "context_window": 1024000,
     "max_output": 131072
    },
    "qwen3-5-27b": {
     "context_window": 256000,
     "max_output": 64000
    },
    "seed-2-1-turbo": {
     "context_window": 256000,
     "max_output": 65536
    },
    "fugu-ultra-v1-0": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "qwen3-5-122b-a10b": {
     "context_window": 256000,
     "max_output": 64000
    },
    "qwen3-5-flash": {
     "context_window": 1000000,
     "max_output": 32768
    },
    "mimo-v2-6-pro-ultraspeed": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "glm-5-2": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "mimo-v2-6-flash": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "muse-spark-1-2": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "qwen3-7-flash": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "minimax-m2-7": {
     "context_window": 200000,
     "max_output": 32768
    },
    "qwen3-6-35b-a3b": {
     "context_window": 131072,
     "max_output": 16384
    },
    "qwen3-5-9b": {
     "context_window": 262144,
     "max_output": 32768
    },
    "step-3-5-flash-2603": {
     "context_window": 256000,
     "max_output": 131072
    },
    "qwen3-5-35b-a3b": {
     "context_window": 256000,
     "max_output": 64000
    },
    "deepseek-v4-pro-0813": {
     "context_window": 1000000,
     "max_output": 393216
    },
    "kimi-k2-6": {
     "context_window": 256000,
     "max_output": 16000
    },
    "minimax-m3": {
     "context_window": 1000000,
     "max_output": 524288
    },
    "glm-5-3": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "fugu-ultra-v1-1": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "kimi-k2-7-code-highspeed": {
     "context_window": 256000,
     "max_output": 131072
    },
    "deepseek-v4-1-flash": {
     "context_window": 1000000,
     "max_output": 393216
    },
    "qwen3-7-plus": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "glm-5-1": {
     "context_window": 202000,
     "max_output": 128000
    },
    "glm-4-6v-flash": {
     "context_window": 128000,
     "max_output": 32768
    },
    "fugu-ultra-v2-0": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "mistral-small-4": {
     "context_window": 256000,
     "max_output": 65536
    },
    "qwen3-8-omni-flash": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "qwen3-5-plus": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "muse-spark-1-3": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "deepseek-v4-pro": {
     "context_window": 1000000,
     "max_output": 393216
    },
    "qwen3-8-flash": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "gemma-3-27b": {
     "context_window": 128000,
     "max_output": 8192
    },
    "qwen3-6-flash": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "seed-2-0-code": {
     "context_window": 256000,
     "max_output": 128000
    },
    "qwen3-8-27b": {
     "context_window": 262144,
     "max_output": 32768
    },
    "muse-spark-1-1": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "qwen3-6-max-preview": {
     "context_window": 256000,
     "max_output": 65536
    },
    "step-3-7-flash": {
     "context_window": 256000,
     "max_output": 131072
    },
    "qwen3-5-397b-a17b": {
     "context_window": 256000,
     "max_output": 64000
    },
    "glm-4-5-flash": {
     "context_window": 200000,
     "max_output": 98304
    },
    "gemma-4-26b-a4b": {
     "context_window": 262144,
     "max_output": 32768
    },
    "deepseek-v4-flash": {
     "context_window": 1000000,
     "max_output": 393216
    }
   }
  },
  "sensenova": {
   "api": "https://token.sensenova.cn/v1",
   "models": {
    "kimi-k3": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "sensenova-6.8-flash-lite": {
     "context_window": 262144,
     "max_output": 65536
    },
    "glm-5.2": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "deepseek-v4-pro": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "deepseek-v4-flash": {
     "context_window": 1000000,
     "max_output": 65536
    }
   }
  },
  "alibaba-token-plan": {
   "api": "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1",
   "models": {
    "qwen3.7-max": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "deepseek-v4-flash-0731": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "qwen3.8-max": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "qwen-image-2.0": {
     "context_window": 8192
    },
    "glm-5": {
     "context_window": 202752,
     "max_output": 16384
    },
    "deepseek-v4.1-flash": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "qwen3.8-max-preview": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "qwen-image-2.0-pro": {
     "context_window": 8192
    },
    "kimi-k2.6": {
     "context_window": 262144,
     "max_output": 262144
    },
    "wan2.7-image": {
     "context_window": 8192
    },
    "wan2.7-image-pro": {
     "context_window": 8192
    },
    "kimi-k2.5": {
     "context_window": 262144,
     "max_output": 98304
    },
    "qwen3.6-flash": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "deepseek-v4-pro-0813": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "MiniMax-M2.5": {
     "context_window": 196608,
     "max_output": 32768
    },
    "qwen3.8-flash": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "glm-5.2": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "glm-5.1": {
     "context_window": 202752,
     "max_output": 128000
    },
    "deepseek-v4-pro": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "qwen3.6-plus": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "deepseek-v3.2": {
     "context_window": 131072,
     "max_output": 65536
    },
    "glm-5.3": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "kimi-k2.7-code": {
     "context_window": 262144,
     "max_output": 262144
    },
    "qwen3.7-plus": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "deepseek-v4-flash": {
     "context_window": 1000000,
     "max_output": 384000
    }
   }
  },
  "cloudflare-workers-ai": {
   "api": "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/ai/v1",
   "models": {
    "@cf/meta/llama-3.3-70b-instruct-fp8-fast": {
     "context_window": 24000,
     "max_output": 24000
    },
    "@cf/meta/llama-guard-3-8b": {
     "context_window": 131072,
     "max_output": 131072
    },
    "@cf/meta/llama-3.1-8b-instruct-fp8": {
     "context_window": 32000,
     "max_output": 32000
    },
    "@cf/meta/llama-3.2-11b-vision-instruct": {
     "context_window": 128000,
     "max_output": 128000
    },
    "@cf/meta/llama-3.2-1b-instruct": {
     "context_window": 60000,
     "max_output": 60000
    },
    "@cf/meta/llama-4-scout-17b-16e-instruct": {
     "context_window": 131000,
     "max_output": 16384
    },
    "@cf/meta/llama-3.2-3b-instruct": {
     "context_window": 80000,
     "max_output": 80000
    },
    "@cf/google/gemma-4-26b-a4b-it": {
     "context_window": 256000,
     "max_output": 16384
    },
    "@cf/aisingapore/gemma-sea-lion-v4-27b-it": {
     "context_window": 128000,
     "max_output": 128000
    },
    "@cf/ibm-granite/granite-4.0-h-micro": {
     "context_window": 131000,
     "max_output": 131000
    },
    "@cf/deepseek-ai/deepseek-v4-flash-0731": {
     "context_window": 1048576,
     "max_output": 1048576
    },
    "@cf/deepseek-ai/deepseek-v4-pro-0813": {
     "context_window": 1048576,
     "max_output": 1048576
    },
    "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b": {
     "context_window": 80000,
     "max_output": 80000
    },
    "@cf/mistralai/mistral-small-3.1-24b-instruct": {
     "context_window": 128000,
     "max_output": 128000
    },
    "@cf/moonshotai/kimi-k2.6": {
     "context_window": 262144,
     "max_output": 256000
    },
    "@cf/moonshotai/kimi-k2.7-code": {
     "context_window": 262144,
     "max_output": 262144
    },
    "@cf/zai-org/glm-5.3-flash": {
     "context_window": 1048576,
     "max_output": 1048576
    },
    "@cf/zai-org/glm-4.7-flash": {
     "context_window": 131072,
     "max_output": 131072
    },
    "@cf/zai-org/glm-5.2": {
     "context_window": 262144,
     "max_output": 256000
    },
    "@cf/zai-org/glm-5.3": {
     "context_window": 1048576,
     "max_output": 1048576
    },
    "@cf/nvidia/nemotron-3-120b-a12b": {
     "context_window": 256000,
     "max_output": 256000
    },
    "@cf/qwen/qwen3.8-27b": {
     "context_window": 262144,
     "max_output": 262144
    },
    "@cf/qwen/qwq-32b": {
     "context_window": 24000,
     "max_output": 24000
    },
    "@cf/qwen/qwen3-30b-a3b-fp8": {
     "context_window": 32768,
     "max_output": 32768
    },
    "@cf/qwen/qwen2.5-coder-32b-instruct": {
     "context_window": 32768,
     "max_output": 32768
    },
    "@cf/openai/gpt-oss-20b": {
     "context_window": 128000,
     "max_output": 16384
    },
    "@cf/openai/gpt-oss-120b": {
     "context_window": 128000,
     "max_output": 16384
    }
   }
  },
  "engy": {
   "api": "https://api.engy.ai/v1",
   "models": {
    "qwen3.8-27b": {
     "context_window": 1001536,
     "max_output": 65536
    },
    "glm-5.3-flash": {
     "context_window": 262144,
     "max_output": 32768
    },
    "deepseek-v4-flash-0731": {
     "context_window": 1048576,
     "max_output": 128000
    },
    "kimi-k3": {
     "context_window": 1113088,
     "max_output": 65536
    },
    "deepseek-v4.1-flash": {
     "context_window": 327680,
     "max_output": 65536
    },
    "qwen3.6-35b-a3b": {
     "context_window": 208192,
     "max_output": 8192
    },
    "glm-5.2": {
     "context_window": 262144,
     "max_output": 32768
    },
    "glm-5.3": {
     "context_window": 327680,
     "max_output": 32768
    }
   }
  },
  "poolside": {
   "api": "https://inference.poolside.ai/v1",
   "models": {
    "poolside/laguna-s-2.1": {
     "context_window": 1048576,
     "max_output": 32768
    },
    "poolside/laguna-xs-2.1": {
     "context_window": 262144,
     "max_output": 32768
    },
    "poolside/laguna-m.1": {
     "context_window": 262144,
     "max_output": 32768
    }
   }
  },
  "nano-gpt": {
   "api": "https://nano-gpt.com/api/v1",
   "models": {
    "deepseek-reasoner-cheaper": {
     "context_window": 128000,
     "max_output": 65536
    },
    "nano-gpt-help": {
     "context_window": 6000,
     "max_output": 512
    },
    "doubao-seed-2-0-lite-260215": {
     "context_window": 256000,
     "max_output": 32000
    },
    "doubao-seed-2-0-mini-260215": {
     "context_window": 256000,
     "max_output": 32000
    },
    "fastgpt": {
     "context_window": 32768,
     "max_output": 32768
    },
    "doubao-seed-2-0-pro-260215": {
     "context_window": 256000,
     "max_output": 128000
    },
    "ernie-5.0-thinking-preview": {
     "context_window": 128000,
     "max_output": 16384
    },
    "gemini-2.5-flash-lite-preview-09-2025-thinking": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "gemma-4-12b-it-station-keeper": {
     "context_window": 131072,
     "max_output": 32768
    },
    "glm-4-air-0111": {
     "context_window": 128000,
     "max_output": 4096
    },
    "glm-4.1v-thinking-flashx": {
     "context_window": 64000,
     "max_output": 8192
    },
    "deepseek-v3-0324": {
     "context_window": 128000,
     "max_output": 8192
    },
    "venice-uncensored": {
     "context_window": 128000,
     "max_output": 8192
    },
    "Gemma-4-31B-MeroMero-v2:thinking": {
     "context_window": 262144,
     "max_output": 32768
    },
    "gemini-2.0-pro-reasoner": {
     "context_window": 128000,
     "max_output": 65536
    },
    "Meta-Llama-3-1-8B-Instruct-FP8": {
     "context_window": 128000,
     "max_output": 16384
    },
    "glm-4-plus-0111": {
     "context_window": 128000,
     "max_output": 4096
    },
    "holo3-35b-a3b:thinking": {
     "context_window": 65536,
     "max_output": 8192
    },
    "gemma-4-26b-a4b-it-moonlight": {
     "context_window": 262144,
     "max_output": 32768
    },
    "phi-4-mini-instruct": {
     "context_window": 128000,
     "max_output": 16384
    },
    "auto-model-premium": {
     "context_window": 1000000,
     "max_output": 1000000
    },
    "gemma-4-31b-it-darkidol": {
     "context_window": 262144,
     "max_output": 32768
    },
    "gemini-2.5-flash-lite-preview-06-17": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "gemini-2.5-flash-preview-09-2025": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "gemma-4-26b-a4b-it-opusdistill": {
     "context_window": 262144,
     "max_output": 32768
    },
    "auto-model-standard": {
     "context_window": 1000000,
     "max_output": 1000000
    },
    "longcat-2.0": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "gemini-2.5-pro-preview-03-25": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "agnes-3.0-flash": {
     "context_window": 524288,
     "max_output": 65536
    },
    "Gemma-4-31B-Queen": {
     "context_window": 262144,
     "max_output": 16384
    },
    "auto-model": {
     "context_window": 1000000,
     "max_output": 1000000
    },
    "qvq-max": {
     "context_window": 128000,
     "max_output": 8192
    },
    "asi1-mini": {
     "context_window": 128000,
     "max_output": 16384
    },
    "gemini-2.5-pro-exp-03-25": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "gemma-4-31b-it-isometry": {
     "context_window": 262144,
     "max_output": 32768
    },
    "celeris-1": {
     "context_window": 8192,
     "max_output": 8192
    },
    "gemini-3-pro-image-preview": {
     "context_window": 65536,
     "max_output": 32768
    },
    "gemma-4-26b-a4b-it-darksoul": {
     "context_window": 262144,
     "max_output": 32768
    },
    "glm-4.1v-thinking-flash": {
     "context_window": 64000,
     "max_output": 8192
    },
    "Gemma-4-31B-GarnetV2": {
     "context_window": 262144,
     "max_output": 16384
    },
    "gemini-2.5-flash-nothinking": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "Gemma-4-31B-MeroMero-v2": {
     "context_window": 262144,
     "max_output": 32768
    },
    "holo3-35b-a3b": {
     "context_window": 65536,
     "max_output": 8192
    },
    "claw-medium": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "gemma-4-26b-a4b-it-shadowsiren": {
     "context_window": 262144,
     "max_output": 32768
    },
    "gemini-2.0-pro-exp-02-05": {
     "context_window": 2097152,
     "max_output": 8192
    },
    "claw-high": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "deepseek-chat": {
     "context_window": 128000,
     "max_output": 8192
    },
    "Gemma-4-26B-A4B-MeroMero:thinking": {
     "context_window": 262144,
     "max_output": 32768
    },
    "claw-low": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "doubao-1.5-pro-32k": {
     "context_window": 32000,
     "max_output": 8192
    },
    "doubao-seed-2-0-code-preview-260215": {
     "context_window": 256000,
     "max_output": 128000
    },
    "hermes-low": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "gemma-4-31b-it-gemsicle": {
     "context_window": 262144,
     "max_output": 32768
    },
    "mercury-coder-small": {
     "context_window": 32768,
     "max_output": 16384
    },
    "gemini-2.5-pro": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "ernie-x1.1-preview": {
     "context_window": 64000,
     "max_output": 8192
    },
    "gemini-2.5-flash": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "hermes-high": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "gemini-2.5-flash-preview-05-20": {
     "context_window": 1048000,
     "max_output": 65536
    },
    "glm-4-long": {
     "context_window": 1000000,
     "max_output": 4096
    },
    "pokee-isaac": {
     "context_window": 10000000,
     "max_output": 60000
    },
    "MiniMax-M1": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "Gemma-4-31B-Claude-4.6-Opus-Reasoning-Distilled": {
     "context_window": 262144,
     "max_output": 16384
    },
    "Qwen3.5-27B-BlueStar-v3-Derestricted": {
     "context_window": 262144,
     "max_output": 16384
    },
    "gemma-4-31b-it-novelist": {
     "context_window": 262144,
     "max_output": 32768
    },
    "ernie-5.1:thinking": {
     "context_window": 119000,
     "max_output": 64000
    },
    "gemma-4-12b-it-semancer": {
     "context_window": 131072,
     "max_output": 32768
    },
    "mistral-code-latest": {
     "context_window": 256000,
     "max_output": 32768
    },
    "Qwen3.5-27B-Queen-Derestricted": {
     "context_window": 262144,
     "max_output": 16384
    },
    "gemma-4-31b-it-fabled": {
     "context_window": 262144,
     "max_output": 32768
    },
    "Gemma-4-26B-A4B-MeroMero": {
     "context_window": 262144,
     "max_output": 32768
    },
    "Gemma-4-31B-Cognitive-Unshackled": {
     "context_window": 262144,
     "max_output": 16384
    },
    "universal-summarizer": {
     "context_window": 32768,
     "max_output": 32768
    },
    "gemma-4-12b-it": {
     "context_window": 131072,
     "max_output": 32768
    },
    "gemini-exp-1206": {
     "context_window": 2097152,
     "max_output": 8192
    },
    "gemini-2.5-flash-preview-09-2025-thinking": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "doubao-1.5-pro-256k": {
     "context_window": 256000,
     "max_output": 16384
    },
    "gemma-4-31b-it-garnet": {
     "context_window": 262144,
     "max_output": 32768
    },
    "gemini-2.5-pro-preview-05-06": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "mercury-2": {
     "context_window": 128000,
     "max_output": 50000
    },
    "command-a-reasoning-08-2025": {
     "context_window": 256000,
     "max_output": 8192
    },
    "longcat-2.0:thinking": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "deepseek-r1-sambanova": {
     "context_window": 128000,
     "max_output": 4096
    },
    "gemini-2.5-flash-preview-04-17": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "deepseek-reasoner": {
     "context_window": 64000,
     "max_output": 65536
    },
    "gemini-2.5-flash-lite-preview-09-2025": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "gemini-2.5-flash-preview-04-17:thinking": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "deepseek-r1": {
     "context_window": 128000,
     "max_output": 8192
    },
    "gemini-2.5-pro-preview-06-05": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "gemini-2.5-flash-lite": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "deepseek-chat-cheaper": {
     "context_window": 128000,
     "max_output": 8192
    },
    "GLM-4.6-Derestricted-v5": {
     "context_window": 131072,
     "max_output": 8192
    },
    "longcat-2.5-preview": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "doubao-1.5-vision-pro-32k": {
     "context_window": 32000,
     "max_output": 8192
    },
    "glm-z1-airx": {
     "context_window": 32000,
     "max_output": 16384
    },
    "auto-model-basic": {
     "context_window": 1000000,
     "max_output": 1000000
    },
    "qwen3-vl-235b-a22b-instruct-original": {
     "context_window": 32768,
     "max_output": 32768
    },
    "gemma-4-26b-a4b-it-luminous": {
     "context_window": 262144,
     "max_output": 32768
    },
    "sarvam-105b": {
     "context_window": 131072,
     "max_output": 4096
    },
    "gemma-4-31b-it-gembrain": {
     "context_window": 262144,
     "max_output": 32768
    },
    "phi-4-multimodal-instruct": {
     "context_window": 128000,
     "max_output": 16384
    },
    "gemini-2.5-flash-preview-05-20:thinking": {
     "context_window": 1048000,
     "max_output": 65536
    },
    "gemma-4-26b-a4b-it-musica": {
     "context_window": 262144,
     "max_output": 32768
    },
    "gemma-4-26b-a4b-it-chimerax": {
     "context_window": 262144,
     "max_output": 32768
    },
    "hermes-medium": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "doubao-seed-1-6-250615": {
     "context_window": 256000,
     "max_output": 16384
    },
    "Gemma-4-31B-DarkIdol": {
     "context_window": 262144,
     "max_output": 16384
    },
    "ernie-5.1": {
     "context_window": 119000,
     "max_output": 64000
    },
    "doubao-seed-1-6-flash-250615": {
     "context_window": 256000,
     "max_output": 16384
    },
    "mistral-code-agent-latest": {
     "context_window": 262144,
     "max_output": 32768
    },
    "kimi-k2-instruct-fast": {
     "context_window": 131072,
     "max_output": 16384
    },
    "featherless-ai/Qwerky-72B": {
     "context_window": 32000,
     "max_output": 8192
    },
    "stealth/space-bunny-alpha": {
     "context_window": 1000000,
     "max_output": 524288
    },
    "unsloth/gemma-3-27b-it": {
     "context_window": 128000,
     "max_output": 96000
    },
    "unsloth/gemma-3-12b-it": {
     "context_window": 131072,
     "max_output": 16384
    },
    "unsloth/gemma-3-4b-it": {
     "context_window": 128000,
     "max_output": 8192
    },
    "bytedance-seed/seed-2.0-lite": {
     "context_window": 262144,
     "max_output": 131072
    },
    "bytedance-seed/seed-2-1-turbo": {
     "context_window": 262144,
     "max_output": 235929
    },
    "bytedance-seed/seed-2.0-code": {
     "context_window": 262144,
     "max_output": 131072
    },
    "poolside/laguna-s-2.1:thinking": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "poolside/laguna-s-2.1": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "abliteration-ai/abliterated-model-large-v2": {
     "context_window": 1000000,
     "max_output": 999990
    },
    "abliteration-ai/abliterated-model": {
     "context_window": 262144,
     "max_output": 262134
    },
    "abliteration-ai/abliterated-model-large": {
     "context_window": 1000000,
     "max_output": 999990
    },
    "prism-ml/ternary-bonsai-2-27b": {
     "context_window": 262144,
     "max_output": 32768
    },
    "anthropic/claude-opus-4.5:thinking": {
     "context_window": 200000,
     "max_output": 64000
    },
    "anthropic/claude-sonnet-4.5:thinking": {
     "context_window": 200000,
     "max_output": 64000
    },
    "anthropic/claude-opus-4.6:thinking:low": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-opus-4.1": {
     "context_window": 200000,
     "max_output": 32000
    },
    "anthropic/claude-opus-4.5": {
     "context_window": 200000,
     "max_output": 64000
    },
    "anthropic/claude-opus-4.6": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-opus-4.7": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-sonnet-4:thinking:64000": {
     "context_window": 1000000,
     "max_output": 64000
    },
    "anthropic/claude-opus-latest": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-opus-4.1:thinking:1024": {
     "context_window": 200000,
     "max_output": 32000
    },
    "anthropic/claude-haiku-latest": {
     "context_window": 200000,
     "max_output": 64000
    },
    "anthropic/claude-opus-4.8": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-sonnet-5.5:thinking": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-sonnet-4:thinking:8192": {
     "context_window": 1000000,
     "max_output": 64000
    },
    "anthropic/claude-sonnet-4:thinking:1024": {
     "context_window": 1000000,
     "max_output": 64000
    },
    "anthropic/claude-opus-4.6:thinking": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-sonnet-latest": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-opus-4.6:thinking:medium": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-haiku-4.5": {
     "context_window": 200000,
     "max_output": 64000
    },
    "anthropic/claude-opus-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-fable-latest": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-sonnet-5.5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-sonnet-4:thinking:32768": {
     "context_window": 1000000,
     "max_output": 64000
    },
    "anthropic/claude-fable-5.1": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-sonnet-4.5": {
     "context_window": 200000,
     "max_output": 64000
    },
    "anthropic/claude-opus-4.1:thinking:8192": {
     "context_window": 200000,
     "max_output": 32000
    },
    "anthropic/claude-haiku-4.5:thinking": {
     "context_window": 200000,
     "max_output": 64000
    },
    "anthropic/claude-fable-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-opus-4.8:thinking": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-sonnet-4": {
     "context_window": 200000,
     "max_output": 64000
    },
    "anthropic/claude-sonnet-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-sonnet-4.6:thinking": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-opus-4.6:thinking:max": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-sonnet-5:thinking": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-sonnet-4.6": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-opus-4.7:thinking": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-opus-5.5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-opus-4.1:thinking": {
     "context_window": 200000,
     "max_output": 32000
    },
    "anthropic/claude-sonnet-4:thinking": {
     "context_window": 1000000,
     "max_output": 64000
    },
    "anthropic/claude-opus-4.1:thinking:32768": {
     "context_window": 200000,
     "max_output": 32000
    },
    "cohere/command-r-plus-08-2024": {
     "context_window": 128000,
     "max_output": 4096
    },
    "deepseek/deepseek-v4-flash:thinking": {
     "context_window": 1048576,
     "max_output": 384000
    },
    "deepseek/deepseek-v4-flash-0731": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "deepseek/deepseek-v4.1-flash": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "deepseek/deepseek-v4.1-flash:thinking": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "deepseek/deepseek-v4-flash-vision-exp": {
     "context_window": 1048576,
     "max_output": 384000
    },
    "deepseek/deepseek-v3.2:thinking": {
     "context_window": 163000,
     "max_output": 65536
    },
    "deepseek/deepseek-latest": {
     "context_window": 1048576,
     "max_output": 384000
    },
    "deepseek/deepseek-v4-pro:thinking": {
     "context_window": 1048576,
     "max_output": 384000
    },
    "deepseek/deepseek-v4-pro-0813:thinking": {
     "context_window": 1048576,
     "max_output": 384000
    },
    "deepseek/deepseek-v4-pro-0813": {
     "context_window": 1048576,
     "max_output": 384000
    },
    "deepseek/deepseek-v4-flash-0731:thinking": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "deepseek/deepseek-v4-pro": {
     "context_window": 1048576,
     "max_output": 384000
    },
    "deepseek/deepseek-v4-flash-latest": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "deepseek/deepseek-v3.2": {
     "context_window": 163000,
     "max_output": 65536
    },
    "deepseek/deepseek-v4-flash": {
     "context_window": 1048576,
     "max_output": 384000
    },
    "baseten/Kimi-K2-Instruct-FP4": {
     "context_window": 131072,
     "max_output": 131072
    },
    "unbiased/pareto-26.10-preview": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "unbiased/pareto": {
     "context_window": 262144,
     "max_output": 131072
    },
    "lightonai/LightOnOCR-2-1B": {
     "context_window": 32768,
     "max_output": 8192
    },
    "abacusai/Dracarys-72B-Instruct": {
     "context_window": 32768,
     "max_output": 8192
    },
    "shisa-ai/shisa-v2.1-llama3.3-70b": {
     "context_window": 32768,
     "max_output": 4096
    },
    "shisa-ai/shisa-v2-llama3.3-70b": {
     "context_window": 128000,
     "max_output": 16384
    },
    "Steelskull/L3.3-MS-Nevoria-70b": {
     "context_window": 32768,
     "max_output": 16384
    },
    "Steelskull/L3.3-Cu-Mai-R1-70b": {
     "context_window": 32768,
     "max_output": 16384
    },
    "Steelskull/L3.3-Nevoria-R1-70b": {
     "context_window": 32768,
     "max_output": 16384
    },
    "Steelskull/L3.3-Electra-R1-70b": {
     "context_window": 32768,
     "max_output": 16384
    },
    "tencent/hy3": {
     "context_window": 262144,
     "max_output": 128000
    },
    "tencent/hy4-preview": {
     "context_window": 1048576,
     "max_output": 64000
    },
    "anthracite-org/magnum-v4-72b": {
     "context_window": 16384,
     "max_output": 8192
    },
    "anthracite-org/magnum-v2-72b": {
     "context_window": 16384,
     "max_output": 8192
    },
    "meta-llama/llama-4-scout": {
     "context_window": 328000,
     "max_output": 65536
    },
    "meta-llama/llama-4-maverick": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "meta-llama/llama-3.3-70b-instruct": {
     "context_window": 131072,
     "max_output": 16384
    },
    "meta-llama/llama-3.1-8b-instruct": {
     "context_window": 131072,
     "max_output": 16384
    },
    "meta-llama/llama-3.2-3b-instruct": {
     "context_window": 131072,
     "max_output": 8192
    },
    "LLM360/K2-Think": {
     "context_window": 128000,
     "max_output": 32768
    },
    "deepcogito/cogito-v1-preview-qwen-32B": {
     "context_window": 128000,
     "max_output": 32768
    },
    "GalrionSoftworks/MN-LooseCannon-12B-v1": {
     "context_window": 16384,
     "max_output": 8192
    },
    "meganova-ai/manta-mini-1.0": {
     "context_window": 8192,
     "max_output": 8192
    },
    "meganova-ai/manta-flash-1.0": {
     "context_window": 16384,
     "max_output": 16384
    },
    "meganova-ai/manta-pro-1.0": {
     "context_window": 65536,
     "max_output": 32768
    },
    "perceptron/perceptron-mk1": {
     "context_window": 32768,
     "max_output": 8192
    },
    "perceptron/perceptron-mk1.5": {
     "context_window": 36864,
     "max_output": 8192
    },
    "z-ai/glm-4.6v": {
     "context_window": 128000,
     "max_output": 24000
    },
    "z-ai/glm-4.6-original": {
     "context_window": 256000,
     "max_output": 65535
    },
    "z-ai/glm-4.5": {
     "context_window": 128000,
     "max_output": 65536
    },
    "z-ai/glm-5.3-flash-apex-abliterated": {
     "context_window": 1048576,
     "max_output": 32768
    },
    "z-ai/glm-5v-turbo": {
     "context_window": 202800,
     "max_output": 131072
    },
    "z-ai/glm-5.3-flash": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "z-ai/glm-5.3-flash-uncensored": {
     "context_window": 1048576,
     "max_output": 32768
    },
    "z-ai/glm-4.6": {
     "context_window": 200000,
     "max_output": 65535
    },
    "z-ai/glm-4.7-flash:thinking": {
     "context_window": 200000,
     "max_output": 128000
    },
    "z-ai/glm-5.3-flash-apex": {
     "context_window": 1048576,
     "max_output": 32768
    },
    "z-ai/glm-5-original:thinking": {
     "context_window": 200000,
     "max_output": 128000
    },
    "z-ai/glm-5.3:thinking": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "z-ai/glm-5": {
     "context_window": 200000,
     "max_output": 128000
    },
    "z-ai/GLM-4.5-Air": {
     "context_window": 128000,
     "max_output": 98304
    },
    "z-ai/glm-4.5v": {
     "context_window": 65536,
     "max_output": 16384
    },
    "z-ai/GLM-4.6-turbo:thinking": {
     "context_window": 204800,
     "max_output": 131072
    },
    "z-ai/glm-4.7:thinking": {
     "context_window": 200000,
     "max_output": 65535
    },
    "z-ai/glm-5.1:thinking": {
     "context_window": 200000,
     "max_output": 131072
    },
    "z-ai/glm-4.6v-original": {
     "context_window": 128000,
     "max_output": 24000
    },
    "z-ai/glm-5v-turbo:thinking": {
     "context_window": 202800,
     "max_output": 131072
    },
    "z-ai/GLM-4.6-turbo": {
     "context_window": 204800,
     "max_output": 131072
    },
    "z-ai/GLM-4.5-Air:thinking": {
     "context_window": 128000,
     "max_output": 98304
    },
    "z-ai/glm-5.2:thinking": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "z-ai/glm-4.7-flash": {
     "context_window": 200000,
     "max_output": 128000
    },
    "z-ai/glm-4.7": {
     "context_window": 200000,
     "max_output": 65535
    },
    "z-ai/glm-5.3-uncensored": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "z-ai/glm-5:thinking": {
     "context_window": 200000,
     "max_output": 128000
    },
    "z-ai/glm-5.2": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "z-ai/GLM-4.5:thinking": {
     "context_window": 128000,
     "max_output": 65536
    },
    "z-ai/glm-5.1": {
     "context_window": 200000,
     "max_output": 131072
    },
    "z-ai/glm-4.6:thinking": {
     "context_window": 200000,
     "max_output": 65535
    },
    "z-ai/glm-4.5v:thinking": {
     "context_window": 65536,
     "max_output": 16384
    },
    "z-ai/glm-4.7-original": {
     "context_window": 200000,
     "max_output": 65535
    },
    "z-ai/glm-5-original": {
     "context_window": 200000,
     "max_output": 128000
    },
    "z-ai/glm-5-turbo": {
     "context_window": 202800,
     "max_output": 131072
    },
    "z-ai/glm-4.7-original:thinking": {
     "context_window": 200000,
     "max_output": 65535
    },
    "z-ai/glm-5.3": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "z-ai/glm-5.3-flash-cybersecurity": {
     "context_window": 1048576,
     "max_output": 32768
    },
    "z-ai/glm-latest": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "inference-net/schematron-v2-small": {
     "context_window": 128000,
     "max_output": 4096
    },
    "inference-net/schematron-v2-turbo": {
     "context_window": 128000,
     "max_output": 8192
    },
    "thinkingmachines/inkling:thinking": {
     "context_window": 1048000,
     "max_output": 32768
    },
    "thinkingmachines/Inkling-Small": {
     "context_window": 524288,
     "max_output": 32768
    },
    "thinkingmachines/inkling": {
     "context_window": 1048000,
     "max_output": 32768
    },
    "thinkingmachines/Inkling-Small:thinking": {
     "context_window": 524288,
     "max_output": 32768
    },
    "meta/muse-spark-1.3": {
     "context_window": 1048576,
     "max_output": 943718
    },
    "meta/muse-glimmer-30b": {
     "context_window": 131072,
     "max_output": 117964
    },
    "meta/muse-spark-1.1": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "meta/muse-spark-1.2": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "meta/muse-spark-1.2-contributor": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "meta/muse-spark-1.3-contributor": {
     "context_window": 1048576,
     "max_output": 943718
    },
    "mlabonne/NeuralDaredevil-8B-abliterated": {
     "context_window": 8192,
     "max_output": 8192
    },
    "NeverSleep/Lumimaid-v0.2-70B": {
     "context_window": 16384,
     "max_output": 8192
    },
    "nanogpt/coding-router:low": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "nanogpt/coding-router:medium": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "nanogpt/coding-router": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "nanogpt/coding-router:max": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "nanogpt/coding-router:high": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "LatitudeGames/Wayfarer-Large-70B-Llama-3.3": {
     "context_window": 32768,
     "max_output": 16384
    },
    "VongolaChouko/Starcannon-Unleashed-12B-v1.0": {
     "context_window": 16384,
     "max_output": 8192
    },
    "arcee-ai/trinity-large-thinking": {
     "context_window": 262144,
     "max_output": 80000
    },
    "x-ai/grok-4.20-multi-agent": {
     "context_window": 2000000,
     "max_output": 131072
    },
    "x-ai/grok-latest": {
     "context_window": 500000,
     "max_output": 450000
    },
    "x-ai/grok-4.7": {
     "context_window": 500000,
     "max_output": 500000
    },
    "x-ai/grok-4.3": {
     "context_window": 1000000,
     "max_output": 900000
    },
    "x-ai/grok-4.5": {
     "context_window": 500000,
     "max_output": 450000
    },
    "x-ai/grok-build-0.1": {
     "context_window": 256000,
     "max_output": 230400
    },
    "x-ai/grok-4.20": {
     "context_window": 2000000,
     "max_output": 131072
    },
    "x-ai/grok-4.6": {
     "context_window": 500000,
     "max_output": 450000
    },
    "Envoid/Llama-3.05-Nemotron-Tenyxchat-Storybreaker-70B": {
     "context_window": 16384,
     "max_output": 8192
    },
    "Envoid/Llama-3.05-NT-Storybreaker-Ministral-70B": {
     "context_window": 16384,
     "max_output": 8192
    },
    "heabsy/cyberheabsy": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "upstage/solar-pro-3": {
     "context_window": 131072,
     "max_output": 117964
    },
    "upstage/solar-pro4": {
     "context_window": 524288,
     "max_output": 131072
    },
    "upstage/solar-mini4:thinking": {
     "context_window": 524288,
     "max_output": 131072
    },
    "upstage/solar-pro4:thinking": {
     "context_window": 524288,
     "max_output": 131072
    },
    "upstage/solar-mini4": {
     "context_window": 524288,
     "max_output": 131072
    },
    "bytedance/doubao-seed-2.1-turbo": {
     "context_window": 256000,
     "max_output": 128000
    },
    "bytedance/doubao-seed-2.1-pro": {
     "context_window": 256000,
     "max_output": 128000
    },
    "bytedance/doubao-seed-character": {
     "context_window": 128000,
     "max_output": 32768
    },
    "liquid/lfm-2.5-2.6b": {
     "context_window": 128000,
     "max_output": 32768
    },
    "google/gemini-flash-latest": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemma-4-31b-it": {
     "context_window": 262144,
     "max_output": 131072
    },
    "google/gemini-3.1-pro-preview-low": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemini-3.5-flash-thinking": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemma-4-26b-a4b-it:thinking": {
     "context_window": 262144,
     "max_output": 131072
    },
    "google/gemini-flash-lite-latest": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemini-3.6-flash": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/diffusiongemma": {
     "context_window": 262144,
     "max_output": 32768
    },
    "google/gemma-4-26b-a4b-it": {
     "context_window": 262144,
     "max_output": 131072
    },
    "google/gemini-3.5-flash-lite": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemma-4-31b-it:thinking": {
     "context_window": 262144,
     "max_output": 131072
    },
    "google/gemini-3.1-pro-preview": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemini-3.1-pro-preview-high": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemma4-31b-splituntied": {
     "context_window": 262144,
     "max_output": 32768
    },
    "google/gemini-3.5-flash": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemma-4-26b-a4b-it-cybersecurity": {
     "context_window": 262144,
     "max_output": 32768
    },
    "google/gemini-3.7-flash": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemini-3.1-pro-preview-customtools": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemini-3-flash-preview": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemini-pro-latest": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemini-3.8-flash": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemini-3-flash-preview-thinking": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemini-3.1-flash-lite": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "TEE/gemma-4-31b-it": {
     "context_window": 262144,
     "max_output": 262144
    },
    "TEE/qwen3.8-27b": {
     "context_window": 262144,
     "max_output": 262144
    },
    "TEE/nemotron-3.5-lightning": {
     "context_window": 262144,
     "max_output": 65536
    },
    "TEE/glm-5.3-flash": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "TEE/qwen3.5-27b": {
     "context_window": 262144,
     "max_output": 65536
    },
    "TEE/muse-glimmer-30b": {
     "context_window": 131072,
     "max_output": 131072
    },
    "TEE/kimi-k3": {
     "context_window": 1048576,
     "max_output": 65535
    },
    "TEE/deepseek-v4.1-flash": {
     "context_window": 1048576,
     "max_output": 384000
    },
    "TEE/llama3-3-70b": {
     "context_window": 128000,
     "max_output": 16384
    },
    "TEE/kimi-k2.6": {
     "context_window": 262144,
     "max_output": 65536
    },
    "TEE/gemma-4-26b-a4b-uncensored": {
     "context_window": 65536,
     "max_output": 65536
    },
    "TEE/gemma4-31b:thinking": {
     "context_window": 262144,
     "max_output": 131072
    },
    "TEE/gemma4-31b": {
     "context_window": 262144,
     "max_output": 131072
    },
    "TEE/qwen3.6-35b-a3b": {
     "context_window": 262144,
     "max_output": 262144
    },
    "TEE/glm-5.2:thinking": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "TEE/qwen3.5-397b-a17b": {
     "context_window": 262144,
     "max_output": 65536
    },
    "TEE/glm-5.2": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "TEE/glm-5.1-thinking": {
     "context_window": 202752,
     "max_output": 65535
    },
    "TEE/glm-5.1": {
     "context_window": 202752,
     "max_output": 65535
    },
    "TEE/qwen2.5-vl-72b-instruct": {
     "context_window": 65536,
     "max_output": 8192
    },
    "TEE/qwen3.6-27b": {
     "context_window": 262144,
     "max_output": 65536
    },
    "TEE/deepseek-v3.2": {
     "context_window": 164000,
     "max_output": 65536
    },
    "TEE/gpt-oss-120b": {
     "context_window": 131072,
     "max_output": 16384
    },
    "TEE/glm-5.3": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "TEE/kimi-k2.7-code": {
     "context_window": 262144,
     "max_output": 65536
    },
    "EVA-UNIT-01/EVA-Qwen2.5-72B-v0.2": {
     "context_window": 16384,
     "max_output": 8192
    },
    "EVA-UNIT-01/EVA-LLaMA-3.33-70B-v0.0": {
     "context_window": 32768,
     "max_output": 16384
    },
    "EVA-UNIT-01/EVA-Qwen2.5-32B-v0.2": {
     "context_window": 16384,
     "max_output": 8192
    },
    "EVA-UNIT-01/EVA-LLaMA-3.33-70B-v0.1": {
     "context_window": 32768,
     "max_output": 16384
    },
    "nothingiisreal/L3.1-70B-Celeste-V0.1-BF16": {
     "context_window": 32768,
     "max_output": 16384
    },
    "MarinaraSpaghetti/NemoMix-Unleashed-12B": {
     "context_window": 32768,
     "max_output": 8192
    },
    "pamanseau/OpenReasoning-Nemotron-32B": {
     "context_window": 32768,
     "max_output": 65536
    },
    "huihui-ai/DeepSeek-R1-Distill-Qwen-32B-abliterated": {
     "context_window": 16384,
     "max_output": 8192
    },
    "huihui-ai/Qwen2.5-32B-Instruct-abliterated": {
     "context_window": 32768,
     "max_output": 8192
    },
    "huihui-ai/Llama-3.3-70B-Instruct-abliterated": {
     "context_window": 32768,
     "max_output": 16384
    },
    "huihui-ai/DeepSeek-R1-Distill-Llama-70B-abliterated": {
     "context_window": 16384,
     "max_output": 8192
    },
    "Gryphe/MythoMax-L2-13b": {
     "context_window": 4096,
     "max_output": 3686
    },
    "ibm-granite/granite-4.2-8b": {
     "context_window": 131072,
     "max_output": 117964
    },
    "TheDrummer/skyfall-36b-v2": {
     "context_window": 32768,
     "max_output": 29491
    },
    "TheDrummer/Artemis-v1.1": {
     "context_window": 262144,
     "max_output": 32768
    },
    "TheDrummer/Anubis-70B-v1": {
     "context_window": 65536,
     "max_output": 16384
    },
    "TheDrummer/Anubis-70B-v1.1": {
     "context_window": 32000,
     "max_output": 16384
    },
    "TheDrummer/Cydonia-24B-v4.3": {
     "context_window": 32768,
     "max_output": 32768
    },
    "TheDrummer/Magidonia-24B-v4.3": {
     "context_window": 32768,
     "max_output": 32768
    },
    "TheDrummer/Cydonia-24B-v4.1": {
     "context_window": 131072,
     "max_output": 117964
    },
    "TheDrummer/UnslopNemo-12B-v4.1": {
     "context_window": 8192,
     "max_output": 26214
    },
    "TheDrummer/Cydonia-24B-v2": {
     "context_window": 32768,
     "max_output": 32768
    },
    "TheDrummer/Rocinante-12B-v1.1": {
     "context_window": 16384,
     "max_output": 8192
    },
    "TheDrummer/Cydonia-24B-v4": {
     "context_window": 32768,
     "max_output": 32768
    },
    "deepseek-ai/DeepSeek-V3.1": {
     "context_window": 128000,
     "max_output": 65536
    },
    "deepseek-ai/deepseek-v3.2-exp-thinking": {
     "context_window": 163840,
     "max_output": 65536
    },
    "deepseek-ai/DeepSeek-R1-0528": {
     "context_window": 163840,
     "max_output": 32768
    },
    "deepseek-ai/DeepSeek-V3.1-Terminus": {
     "context_window": 128000,
     "max_output": 65536
    },
    "deepseek-ai/deepseek-v3.2-exp": {
     "context_window": 163840,
     "max_output": 65536
    },
    "deepseek-ai/DeepSeek-V3.1:thinking": {
     "context_window": 128000,
     "max_output": 65536
    },
    "deepseek-ai/DeepSeek-V3.1-Terminus:thinking": {
     "context_window": 128000,
     "max_output": 65536
    },
    "stepfun-ai/step-3.5-flash-2603": {
     "context_window": 262144,
     "max_output": 65536
    },
    "stepfun-ai/step-3.5-flash": {
     "context_window": 262144,
     "max_output": 65536
    },
    "MiniMaxAI/MiniMax-M1-80k": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "mistralai/ministral-8b-2512": {
     "context_window": 262144,
     "max_output": 32768
    },
    "mistralai/mistral-small-4-119b-2603:thinking": {
     "context_window": 262144,
     "max_output": 16384
    },
    "mistralai/mistral-medium-3.5": {
     "context_window": 256000,
     "max_output": 32768
    },
    "mistralai/mistral-small-24b-instruct-2501": {
     "context_window": 32768,
     "max_output": 8192
    },
    "mistralai/mixtral-8x22b-instruct-v0.1": {
     "context_window": 65536,
     "max_output": 52428
    },
    "mistralai/mistral-saba": {
     "context_window": 32768,
     "max_output": 26214
    },
    "mistralai/mistral-medium-3.1": {
     "context_window": 131072,
     "max_output": 32768
    },
    "mistralai/mistral-small-3.2-24b-instruct": {
     "context_window": 128000,
     "max_output": 16384
    },
    "mistralai/mistral-small-4-119b-2603": {
     "context_window": 262144,
     "max_output": 16384
    },
    "mistralai/mistral-large": {
     "context_window": 128000,
     "max_output": 102400
    },
    "mistralai/mistral-medium-3.5:thinking": {
     "context_window": 256000,
     "max_output": 32768
    },
    "mistralai/devstral-small-2505": {
     "context_window": 32768,
     "max_output": 8192
    },
    "mistralai/devstral-2-123b-instruct-2512": {
     "context_window": 262144,
     "max_output": 65536
    },
    "mistralai/mistral-medium-3": {
     "context_window": 131072,
     "max_output": 32768
    },
    "mistralai/ministral-14b-instruct-2512": {
     "context_window": 262144,
     "max_output": 32768
    },
    "mistralai/ministral-14b-2512": {
     "context_window": 262144,
     "max_output": 32768
    },
    "mistralai/mistral-small-3.1-24b-instruct": {
     "context_window": 128000,
     "max_output": 102400
    },
    "mistralai/ministral-3b-2512": {
     "context_window": 131072,
     "max_output": 32768
    },
    "mistralai/mistral-nemo-instruct-2407": {
     "context_window": 16384,
     "max_output": 8192
    },
    "mistralai/codestral-2508": {
     "context_window": 256000,
     "max_output": 32768
    },
    "sakana/fugu-max": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "sakana/fugu-ultra": {
     "context_window": 1000000,
     "max_output": 16384
    },
    "sakana/sakana-namazu": {
     "context_window": 262144,
     "max_output": 65536
    },
    "sakana/fugu-ultra-v1.1": {
     "context_window": 1000000,
     "max_output": 16384
    },
    "inclusionai/ling-3.0-flash": {
     "context_window": 262144,
     "max_output": 32768
    },
    "inclusionai/ling-3.1-flash": {
     "context_window": 262144,
     "max_output": 32768
    },
    "inclusionai/ling-3.0-flash-vl": {
     "context_window": 262144,
     "max_output": 32768
    },
    "inclusionai/ling-3.0-flash:thinking": {
     "context_window": 262144,
     "max_output": 32768
    },
    "moonshotai/kimi-k3": {
     "context_window": 1048576,
     "max_output": 943718
    },
    "moonshotai/kimi-k2.7-code-highspeed": {
     "context_window": 262144,
     "max_output": 65536
    },
    "moonshotai/kimi-k2.6": {
     "context_window": 256000,
     "max_output": 65536
    },
    "moonshotai/kimi-k2.5:thinking": {
     "context_window": 256000,
     "max_output": 65536
    },
    "moonshotai/kimi-k2-thinking": {
     "context_window": 262144,
     "max_output": 98304
    },
    "moonshotai/kimi-k2.5": {
     "context_window": 256000,
     "max_output": 65536
    },
    "moonshotai/kimi-k2-instruct": {
     "context_window": 256000,
     "max_output": 8192
    },
    "moonshotai/kimi-k2.6:thinking": {
     "context_window": 256000,
     "max_output": 65536
    },
    "moonshotai/kimi-k2-instruct-0711": {
     "context_window": 128000,
     "max_output": 8192
    },
    "moonshotai/kimi-latest": {
     "context_window": 1048576,
     "max_output": 943718
    },
    "moonshotai/kimi-k2.7-code": {
     "context_window": 262144,
     "max_output": 65536
    },
    "moonshotai/Kimi-K2-Instruct-0905": {
     "context_window": 262144,
     "max_output": 100352
    },
    "THUDM/GLM-Z1-9B-0414": {
     "context_window": 32000,
     "max_output": 8000
    },
    "THUDM/GLM-4-9B-0414": {
     "context_window": 32000,
     "max_output": 8000
    },
    "THUDM/GLM-4-32B-0414": {
     "context_window": 128000,
     "max_output": 65536
    },
    "nvidia/nemotron-3-nano-30b-a3b": {
     "context_window": 262144,
     "max_output": 235929
    },
    "nvidia/nemotron-3.5-lightning": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "nvidia/Llama-3.3-Nemotron-Super-49B-v1": {
     "context_window": 128000,
     "max_output": 16384
    },
    "nvidia/nemotron-3-super-120b-a12b": {
     "context_window": 262144,
     "max_output": 16384
    },
    "nvidia/nemotron-3-ultra-550b-a55b": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "nvidia/nemotron-3-super-120b-a12b:thinking": {
     "context_window": 262144,
     "max_output": 16384
    },
    "nvidia/nemotron-3-ultra-550b-a55b:thinking": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "nvidia/nemotron-3.5-content-safety": {
     "context_window": 131072,
     "max_output": 32768
    },
    "nvidia/Llama-3.1-Nemotron-70B-Instruct-HF": {
     "context_window": 16384,
     "max_output": 8192
    },
    "nvidia/nemotron-3.5-lightning:thinking": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "xiaomi/mimo-v2.5-pro:thinking": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "xiaomi/mimo-v2.6-pro": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "xiaomi/mimo-v2.5": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "xiaomi/mimo-v2.6-flash-uncensored:thinking": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "xiaomi/mimo-v2.6-pro-ultraspeed": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "xiaomi/mimo-v2.5:thinking": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "xiaomi/mimo-v2.5-pro": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "xiaomi/mimo-v2.6-flash": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "xiaomi/mimo-v2.6-flash-abliterated": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "xiaomi/mimo-v2.6-flash-uncensored": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "undi95/remm-slerp-l2-13b": {
     "context_window": 6144,
     "max_output": 4096
    },
    "Salesforce/Llama-xLAM-2-70b-fc-r": {
     "context_window": 128000,
     "max_output": 16384
    },
    "minimax/minimax-latest": {
     "context_window": 512000,
     "max_output": 80000
    },
    "minimax/minimax-m2.5": {
     "context_window": 204800,
     "max_output": 131072
    },
    "minimax/minimax-m2.7-turbo": {
     "context_window": 204800,
     "max_output": 131072
    },
    "minimax/minimax-01": {
     "context_window": 1000192,
     "max_output": 16384
    },
    "minimax/minimax-m2-her": {
     "context_window": 65532,
     "max_output": 2048
    },
    "minimax/minimax-m2.7": {
     "context_window": 204800,
     "max_output": 131072
    },
    "minimax/minimax-m3:thinking": {
     "context_window": 512000,
     "max_output": 80000
    },
    "minimax/minimax-m3": {
     "context_window": 512000,
     "max_output": 80000
    },
    "minimax/minimax-m2.1": {
     "context_window": 200000,
     "max_output": 131072
    },
    "minimax/minimax-m2": {
     "context_window": 200000,
     "max_output": 131072
    },
    "inflatebot/MN-12B-Mag-Mell-R1": {
     "context_window": 16384,
     "max_output": 8192
    },
    "soob3123/GrayLine-Qwen3-8B": {
     "context_window": 32768,
     "max_output": 32768
    },
    "soob3123/Veiled-Calla-12B": {
     "context_window": 32768,
     "max_output": 8192
    },
    "soob3123/amoral-gemma3-27B-v2": {
     "context_window": 32768,
     "max_output": 8192
    },
    "stepfun/step-5-preview": {
     "context_window": 1000000,
     "max_output": 1000000
    },
    "stepfun/step-3.7-flash:thinking": {
     "context_window": 262144,
     "max_output": 256000
    },
    "Sao10K/L3.1-70B-Hanami-x1": {
     "context_window": 32768,
     "max_output": 16384
    },
    "Sao10K/L3.1-70B-Euryale-v2.2": {
     "context_window": 20480,
     "max_output": 16384
    },
    "Sao10K/L3.3-70B-Euryale-v2.3": {
     "context_window": 20480,
     "max_output": 16384
    },
    "Sao10K/L3-8B-Stheno-v3.2": {
     "context_window": 16384,
     "max_output": 8192
    },
    "inception/mercury-2.5-preview": {
     "context_window": 260000,
     "max_output": 65536
    },
    "ornith-ai/ornith-1.5-35b-a3b": {
     "context_window": 262144,
     "max_output": 32768
    },
    "ornith-ai/ornith-1.5-35b-a3b:thinking": {
     "context_window": 262144,
     "max_output": 32768
    },
    "amazon/nova-lite-v1": {
     "context_window": 300000,
     "max_output": 5120
    },
    "amazon/nova-2-lite-v1": {
     "context_window": 1000000,
     "max_output": 65535
    },
    "amazon/nova-pro-v1": {
     "context_window": 300000,
     "max_output": 32000
    },
    "Doctor-Shotgun/MS3.2-24B-Magnum-Diamond": {
     "context_window": 32768,
     "max_output": 32768
    },
    "aion-labs/aion-2.0": {
     "context_window": 131072,
     "max_output": 32768
    },
    "aion-labs/aion-rp-llama-3.1-8b": {
     "context_window": 32768,
     "max_output": 16384
    },
    "aion-labs/aion-3.0": {
     "context_window": 131072,
     "max_output": 32768
    },
    "aion-labs/aion-3.5": {
     "context_window": 262144,
     "max_output": 32768
    },
    "aion-labs/aion-3.5-mini": {
     "context_window": 262144,
     "max_output": 32768
    },
    "aion-labs/aion-3.0-mini": {
     "context_window": 131072,
     "max_output": 32768
    },
    "qwen/qwen3.5-flash": {
     "context_window": 991808,
     "max_output": 65536
    },
    "qwen/qwen3.8-max:thinking": {
     "context_window": 991000,
     "max_output": 131072
    },
    "qwen/qwen3-vl-235b-a22b-instruct": {
     "context_window": 131072,
     "max_output": 32768
    },
    "qwen/qwen3.7-max": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "qwen/qwen3.8-27b": {
     "context_window": 262144,
     "max_output": 32768
    },
    "qwen/qwen3-vl-235b-a22b-thinking": {
     "context_window": 131072,
     "max_output": 32768
    },
    "qwen/qwen3.5-27b": {
     "context_window": 260096,
     "max_output": 65536
    },
    "qwen/qwen3.5-omni-plus": {
     "context_window": 983616,
     "max_output": 65536
    },
    "qwen/qwen3.7-flash:thinking": {
     "context_window": 983616,
     "max_output": 65536
    },
    "qwen/qwen3-235b-a22b-instruct-2507": {
     "context_window": 262144,
     "max_output": 16384
    },
    "qwen/qwen-max": {
     "context_window": 32000,
     "max_output": 8192
    },
    "qwen/qwen3-next-80b-a3b-thinking": {
     "context_window": 256000,
     "max_output": 32768
    },
    "qwen/qwen3.8-max": {
     "context_window": 991000,
     "max_output": 65536
    },
    "qwen/qwen3-coder-next": {
     "context_window": 262144,
     "max_output": 65536
    },
    "qwen/qwen3-coder": {
     "context_window": 262000,
     "max_output": 65536
    },
    "qwen/qwen3.5-35b-a3b:thinking": {
     "context_window": 260096,
     "max_output": 65536
    },
    "qwen/qwen3.5-plus": {
     "context_window": 983616,
     "max_output": 65536
    },
    "qwen/qwen3-32b": {
     "context_window": 41000,
     "max_output": 32768
    },
    "qwen/qwen-plus": {
     "context_window": 995904,
     "max_output": 32768
    },
    "qwen/qwen3.7-flash": {
     "context_window": 991808,
     "max_output": 65536
    },
    "qwen/qwen3-max": {
     "context_window": 256000,
     "max_output": 32768
    },
    "qwen/qwen3.8-27b-obliterated:thinking": {
     "context_window": 524288,
     "max_output": 32768
    },
    "qwen/qwen-turbo": {
     "context_window": 1000000,
     "max_output": 8192
    },
    "qwen/qwen3-coder-30b-a3b-instruct": {
     "context_window": 128000,
     "max_output": 65536
    },
    "qwen/qwen3.8-27b:thinking": {
     "context_window": 262144,
     "max_output": 32768
    },
    "qwen/qwen3.8-27b-obliterated": {
     "context_window": 524288,
     "max_output": 32768
    },
    "qwen/qwen3.8-omni-flash": {
     "context_window": 991808,
     "max_output": 131072
    },
    "qwen/qwen3.8-27b-uncensored": {
     "context_window": 524288,
     "max_output": 32768
    },
    "qwen/qwen3.7-max:thinking": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "qwen/qwen3-235b-a22b": {
     "context_window": 262144,
     "max_output": 16384
    },
    "qwen/qwen3.5-122b-a10b": {
     "context_window": 131072,
     "max_output": 32768
    },
    "qwen/qwen3.8-27b-uncensored:thinking": {
     "context_window": 524288,
     "max_output": 32768
    },
    "qwen/qwen3.5-omni-flash": {
     "context_window": 49152,
     "max_output": 16384
    },
    "qwen/qwen3.6-35b-a3b": {
     "context_window": 262144,
     "max_output": 16384
    },
    "qwen/qwen3-next-80b-a3b-instruct": {
     "context_window": 262144,
     "max_output": 32768
    },
    "qwen/qwen3-max-2026-01-23": {
     "context_window": 256000,
     "max_output": 32768
    },
    "qwen/qwen3.8-27b-fable": {
     "context_window": 524288,
     "max_output": 32768
    },
    "qwen/qwen3.8-27b-hemmingway": {
     "context_window": 262144,
     "max_output": 32768
    },
    "qwen/qwen3.6-flash": {
     "context_window": 991808,
     "max_output": 65536
    },
    "qwen/qwen3-coder-flash": {
     "context_window": 128000,
     "max_output": 65536
    },
    "qwen/qwen3.5-plus:thinking": {
     "context_window": 983616,
     "max_output": 65536
    },
    "qwen/qwen3-coder-plus": {
     "context_window": 128000,
     "max_output": 65536
    },
    "qwen/qwen3.5-9b": {
     "context_window": 256000,
     "max_output": 65536
    },
    "qwen/qwen3.5-122b-a10b:thinking": {
     "context_window": 131072,
     "max_output": 32768
    },
    "qwen/qwen3.5-397b-a17b:thinking": {
     "context_window": 258048,
     "max_output": 65536
    },
    "qwen/qwen3.8-max-prime": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "qwen/qwen3.8-flash": {
     "context_window": 991808,
     "max_output": 131072
    },
    "qwen/qwen3.8-27b-cybersecurity": {
     "context_window": 262144,
     "max_output": 32768
    },
    "qwen/qwen-long": {
     "context_window": 10000000,
     "max_output": 8192
    },
    "qwen/qwen3.5-35b-a3b": {
     "context_window": 260096,
     "max_output": 65536
    },
    "qwen/qwen3.6-max-preview": {
     "context_window": 245760,
     "max_output": 65536
    },
    "qwen/qwen3-30b-a3b": {
     "context_window": 41000,
     "max_output": 32768
    },
    "qwen/qwen3.5-397b-a17b": {
     "context_window": 258048,
     "max_output": 65536
    },
    "qwen/qwen3-8b": {
     "context_window": 41000,
     "max_output": 32768
    },
    "qwen/qwen3.5-27b:thinking": {
     "context_window": 260096,
     "max_output": 65536
    },
    "qwen/qwen3.8-27b-queen": {
     "context_window": 524288,
     "max_output": 32768
    },
    "qwen/qwen3-30b-a3b-instruct-2507": {
     "context_window": 256000,
     "max_output": 32768
    },
    "qwen/qwen2.5-coder-32b-instruct": {
     "context_window": 32000,
     "max_output": 8192
    },
    "qwen/qwen3.7-plus:thinking": {
     "context_window": 983616,
     "max_output": 65536
    },
    "qwen/qwen-2.5-72b-instruct": {
     "context_window": 131072,
     "max_output": 8192
    },
    "qwen/qwen3.6-35b-a3b:thinking": {
     "context_window": 262144,
     "max_output": 16384
    },
    "qwen/qwen3.6-27b": {
     "context_window": 260096,
     "max_output": 65536
    },
    "qwen/qwen3.6-plus": {
     "context_window": 991808,
     "max_output": 65536
    },
    "qwen/qwen3.6-27b:thinking": {
     "context_window": 260096,
     "max_output": 65536
    },
    "qwen/qwen3-14b": {
     "context_window": 41000,
     "max_output": 32768
    },
    "qwen/qwen3.7-plus": {
     "context_window": 991808,
     "max_output": 65536
    },
    "qwen/qwen3.5-flash:thinking": {
     "context_window": 991808,
     "max_output": 65536
    },
    "qwen/qwen3.8-max-0902": {
     "context_window": 991808,
     "max_output": 131072
    },
    "failspy/Meta-Llama-3-70B-Instruct-abliterated-v3.5": {
     "context_window": 8192,
     "max_output": 8192
    },
    "openai/gpt-5.4": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-3.5-turbo": {
     "context_window": 16385,
     "max_output": 4096
    },
    "openai/gpt-terra-latest": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-6-astra-pro": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/o3-pro-2025-06-10": {
     "context_window": 200000,
     "max_output": 100000
    },
    "openai/gpt-5.4-nano": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-5.2-codex": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-5.1-codex": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-4o": {
     "context_window": 128000,
     "max_output": 16384
    },
    "openai/gpt-chat-latest": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-5.6-sol-pro": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-5-mini": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/o4-mini": {
     "context_window": 200000,
     "max_output": 100000
    },
    "openai/o3-mini": {
     "context_window": 200000,
     "max_output": 100000
    },
    "openai/gpt-5.3-codex": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-4.1-nano": {
     "context_window": 1047576,
     "max_output": 32768
    },
    "openai/gpt-5-nano": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/o1": {
     "context_window": 200000,
     "max_output": 100000
    },
    "openai/gpt-latest": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-5-pro": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-6.1-sol": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-4o-2024-08-06": {
     "context_window": 128000,
     "max_output": 16384
    },
    "openai/gpt-6-astra": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-luna-latest": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-5.6-luna-pro": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-5.1": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-4o-mini": {
     "context_window": 128000,
     "max_output": 16384
    },
    "openai/gpt-oss-20b": {
     "context_window": 128000,
     "max_output": 16384
    },
    "openai/gpt-oss-safeguard-20b": {
     "context_window": 128000,
     "max_output": 16384
    },
    "openai/o3-mini-high": {
     "context_window": 200000,
     "max_output": 100000
    },
    "openai/gpt-sol-latest": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-6-sol-pro": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-astra-latest": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-5.4-mini": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-5.6-luna": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-5.1-codex-max": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-5.2": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-5.5": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-4.1": {
     "context_window": 1047576,
     "max_output": 32768
    },
    "openai/gpt-4o-2024-11-20": {
     "context_window": 128000,
     "max_output": 16384
    },
    "openai/o3-mini-low": {
     "context_window": 200000,
     "max_output": 100000
    },
    "openai/gpt-4.1-mini": {
     "context_window": 1047576,
     "max_output": 32768
    },
    "openai/gpt-5.6-terra-pro": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-6-luna": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-6.1-sol-pro": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/o4-mini-high": {
     "context_window": 200000,
     "max_output": 100000
    },
    "openai/gpt-6-luna-pro": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-5.6-terra": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-4-turbo": {
     "context_window": 128000,
     "max_output": 4096
    },
    "openai/gpt-oss-120b": {
     "context_window": 128000,
     "max_output": 16384
    },
    "openai/gpt-5.1-codex-mini": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/o3": {
     "context_window": 200000,
     "max_output": 100000
    },
    "openai/gpt-5": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-5.6-sol": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-5.1-2025-11-13": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-6-sol": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/o1-pro": {
     "context_window": 200000,
     "max_output": 100000
    },
    "microsoft/wizardlm-2-8x22b": {
     "context_window": 65536,
     "max_output": 8192
    },
    "NousResearch/hermes-3-llama-3.1-70b": {
     "context_window": 65536,
     "max_output": 8192
    },
    "NousResearch/hermes-4-405b": {
     "context_window": 128000,
     "max_output": 8192
    },
    "NousResearch/hermes-4-405b:thinking": {
     "context_window": 128000,
     "max_output": 8192
    },
    "ReadyArt/MS3.2-The-Omega-Directive-24B-Unslop-v2.0": {
     "context_window": 32768,
     "max_output": 32768
    }
   }
  },
  "abliteration-ai": {
   "api": "https://api.abliteration.ai/v1",
   "models": {
    "abliterated-model-large-v2": {
     "context_window": 1000000,
     "max_output": 999990
    },
    "abliterated-model": {
     "context_window": 150000,
     "max_output": 8192
    },
    "abliterated-model-large": {
     "context_window": 1000000,
     "max_output": 999990
    }
   }
  },
  "crof": {
   "api": "https://crof.ai/v1",
   "models": {
    "gemma-4-31b-it": {
     "context_window": 262144,
     "max_output": 262144
    },
    "qwen3.8-27b": {
     "context_window": 262144,
     "max_output": 262144
    },
    "kimi-k3-eco": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "glm-5.3-flash": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "deepseek-v4-flash-0731": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "kimi-k3": {
     "context_window": 1000000,
     "max_output": 262144
    },
    "deepseek-v4-flash-vision-exp": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "kimi-k2.6": {
     "context_window": 262144,
     "max_output": 262144
    },
    "greg-2-super": {
     "context_window": 229376,
     "max_output": 229376
    },
    "deepseek-v4-pro-0813": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "mimo-v2.5-pro": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "greg-rp": {
     "context_window": 229376,
     "max_output": 229376
    },
    "qwen3.5-9b": {
     "context_window": 262144,
     "max_output": 262144
    },
    "qwen3.5-397b-a17b": {
     "context_window": 262144,
     "max_output": 262144
    },
    "glm-5.2": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "glm-5.1": {
     "context_window": 202752,
     "max_output": 202752
    },
    "deepseek-v4-pro": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "qwen3.6-27b": {
     "context_window": 262144,
     "max_output": 262144
    },
    "greg-2-ultra": {
     "context_window": 229376,
     "max_output": 229376
    },
    "deepseek-v3.2": {
     "context_window": 163840,
     "max_output": 163840
    },
    "glm-5.3": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "kimi-k2.7-code": {
     "context_window": 262144,
     "max_output": 262144
    },
    "greg-1-mini": {
     "context_window": 229376,
     "max_output": 229376
    },
    "deepseek-v4-flash": {
     "context_window": 1000000,
     "max_output": 131072
    }
   }
  },
  "standardcompute": {
   "api": "https://api.stdcmpt.com/v1",
   "models": {
    "standardcompute": {
     "context_window": 1000000,
     "max_output": 24576
    }
   }
  },
  "cloudferro-sherlock": {
   "api": "https://api-sherlock.cloudferro.com/openai/v1/",
   "models": {
    "meta-llama/Llama-3.3-70B-Instruct": {
     "context_window": 70000,
     "max_output": 70000
    },
    "MiniMaxAI/MiniMax-M2.5": {
     "context_window": 196000,
     "max_output": 16000
    },
    "openai/gpt-oss-120b": {
     "context_window": 131000,
     "max_output": 131000
    },
    "speakleash/Bielik-11B-v2.6-Instruct": {
     "context_window": 32000,
     "max_output": 32000
    },
    "speakleash/Bielik-11B-v3.0-Instruct": {
     "context_window": 32000,
     "max_output": 32000
    }
   }
  },
  "anthropic": {
   "api": null,
   "models": {
    "claude-haiku-4-5": {
     "context_window": 200000,
     "max_output": 64000
    },
    "claude-opus-4-5": {
     "context_window": 200000,
     "max_output": 64000
    },
    "claude-sonnet-4-5": {
     "context_window": 1000000,
     "max_output": 64000
    },
    "claude-opus-5-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "claude-fable-5-1": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "claude-opus-4-5-20251101": {
     "context_window": 200000,
     "max_output": 64000
    },
    "claude-opus-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "claude-fable-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "claude-opus-4-8": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "claude-sonnet-4-5-20250929": {
     "context_window": 1000000,
     "max_output": 64000
    },
    "claude-sonnet-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "claude-opus-4-6": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "claude-haiku-4-5-20251001": {
     "context_window": 200000,
     "max_output": 64000
    },
    "claude-sonnet-4-6": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "claude-sonnet-5-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "claude-opus-4-7": {
     "context_window": 1000000,
     "max_output": 128000
    }
   }
  },
  "tinfoil": {
   "api": "https://inference.tinfoil.sh/v1",
   "models": {
    "gpt-oss-safeguard-120b": {
     "context_window": 131072,
     "max_output": 32768
    },
    "glm-5-3-flash": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "kimi-k3": {
     "context_window": 262144,
     "max_output": 131072
    },
    "llama3-3-70b": {
     "context_window": 131072,
     "max_output": 4096
    },
    "gemma4-31b": {
     "context_window": 262144,
     "max_output": 32768
    },
    "glm-5-3": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "deepseek-v4-1-flash": {
     "context_window": 1048576,
     "max_output": 384000
    },
    "nomic-embed-text": {
     "context_window": 8192,
     "max_output": 768
    },
    "gpt-oss-120b": {
     "context_window": 131072,
     "max_output": 32768
    }
   }
  },
  "llama": {
   "api": "https://api.llama.com/compat/v1/",
   "models": {
    "llama-4-maverick-17b-128e-instruct-fp8": {
     "context_window": 128000,
     "max_output": 4096
    },
    "groq-llama-4-maverick-17b-128e-instruct": {
     "context_window": 128000,
     "max_output": 4096
    },
    "llama-4-scout-17b-16e-instruct-fp8": {
     "context_window": 128000,
     "max_output": 4096
    },
    "cerebras-llama-4-maverick-17b-128e-instruct": {
     "context_window": 128000,
     "max_output": 4096
    },
    "llama-3.3-70b-instruct": {
     "context_window": 128000,
     "max_output": 4096
    },
    "llama-3.3-8b-instruct": {
     "context_window": 128000,
     "max_output": 4096
    },
    "cerebras-llama-4-scout-17b-16e-instruct": {
     "context_window": 128000,
     "max_output": 4096
    }
   }
  },
  "cohere": {
   "api": null,
   "models": {
    "command-r-08-2024": {
     "context_window": 128000,
     "max_output": 4000
    },
    "north-mini-code-1-0": {
     "context_window": 256000,
     "max_output": 64000
    },
    "command-a-translate-08-2025": {
     "context_window": 8000,
     "max_output": 8000
    },
    "tiny-aya-fire": {
     "context_window": 8000,
     "max_output": 8000
    },
    "command-r7b-arabic-02-2025": {
     "context_window": 128000,
     "max_output": 4000
    },
    "tiny-aya-earth": {
     "context_window": 8000,
     "max_output": 8000
    },
    "command-a-plus-05-2026": {
     "context_window": 128000,
     "max_output": 64000
    },
    "command-a-03-2025": {
     "context_window": 256000,
     "max_output": 8000
    },
    "c4ai-aya-vision-32b": {
     "context_window": 16000,
     "max_output": 4000
    },
    "tiny-aya-global": {
     "context_window": 8000,
     "max_output": 8000
    },
    "north-small-translate-09-2026": {
     "context_window": 32768,
     "max_output": 16000
    },
    "command-r7b-12-2024": {
     "context_window": 128000,
     "max_output": 4000
    },
    "command-r-plus-08-2024": {
     "context_window": 128000,
     "max_output": 4000
    },
    "command-a-vision-07-2025": {
     "context_window": 128000,
     "max_output": 8000
    },
    "tiny-aya-water": {
     "context_window": 8000,
     "max_output": 8000
    },
    "command-a-reasoning-08-2025": {
     "context_window": 256000,
     "max_output": 32000
    },
    "c4ai-aya-expanse-32b": {
     "context_window": 128000,
     "max_output": 4000
    }
   }
  },
  "deepseek": {
   "api": "https://api.deepseek.com",
   "models": {
    "deepseek-v4-flash-vision-exp": {
     "context_window": 1000000,
     "max_output": 393216
    },
    "deepseek-flash": {
     "context_window": 1000000,
     "max_output": 393216
    },
    "deepseek-v4-pro": {
     "context_window": 1000000,
     "max_output": 393216
    },
    "deepseek-v4-flash": {
     "context_window": 1000000,
     "max_output": 393216
    }
   }
  },
  "baseten": {
   "api": "https://inference.baseten.co/v1",
   "models": {
    "thinkingmachines/inkling-small": {
     "context_window": 1048576,
     "max_output": 32768
    },
    "thinkingmachines/inkling": {
     "context_window": 1048576,
     "max_output": 32768
    },
    "deepseek-ai/DeepSeek-V3.1": {
     "context_window": 164000,
     "max_output": 131000
    },
    "deepseek-ai/DeepSeek-V4-Flash-0731": {
     "context_window": 1048576,
     "max_output": 384000
    },
    "deepseek-ai/DeepSeek-V4-Pro-0813": {
     "context_window": 1048576,
     "max_output": 262144
    },
    "deepseek-ai/DeepSeek-V4.1-Flash": {
     "context_window": 1048576,
     "max_output": 32768
    },
    "deepseek-ai/DeepSeek-V4.1-Flash-Fast": {
     "context_window": 1048576,
     "max_output": 32768
    },
    "deepseek-ai/DeepSeek-V4-Pro": {
     "context_window": 1048576,
     "max_output": 262144
    },
    "MiniMaxAI/MiniMax-M2.5": {
     "context_window": 204000,
     "max_output": 204000
    },
    "moonshotai/Kimi-K2.6": {
     "context_window": 262000,
     "max_output": 262000
    },
    "moonshotai/Kimi-K3": {
     "context_window": 1048576,
     "max_output": 262144
    },
    "moonshotai/Kimi-K2.7-Code": {
     "context_window": 262000,
     "max_output": 262000
    },
    "moonshotai/Kimi-K2.5": {
     "context_window": 262000,
     "max_output": 262000
    },
    "zai-org/GLM-5.1": {
     "context_window": 202800,
     "max_output": 202800
    },
    "zai-org/GLM-5.2": {
     "context_window": 1048576,
     "max_output": 262144
    },
    "zai-org/GLM-4.7": {
     "context_window": 200000,
     "max_output": 200000
    },
    "zai-org/GLM-5.2-Fast": {
     "context_window": 1048576,
     "max_output": 262144
    },
    "zai-org/GLM-5.3-Fast": {
     "context_window": 1048576,
     "max_output": 262144
    },
    "zai-org/GLM-5": {
     "context_window": 202800,
     "max_output": 202800
    },
    "zai-org/GLM-5.3-Flash": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "zai-org/GLM-5.3": {
     "context_window": 1048576,
     "max_output": 262144
    },
    "nvidia/Nemotron-120B-A12B": {
     "context_window": 202800,
     "max_output": 202800
    },
    "nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B": {
     "context_window": 202800,
     "max_output": 202800
    },
    "openai/gpt-oss-120b": {
     "context_window": 128072,
     "max_output": 128072
    }
   }
  },
  "nan": {
   "api": "https://api.nan.builders/v1",
   "models": {
    "qwen-image-2.1": {
     "context_window": 8192
    },
    "glm5.3-flash": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "gemma4": {
     "context_window": 262144,
     "max_output": 32768
    },
    "qwen3.6": {
     "context_window": 262144,
     "max_output": 65536
    },
    "mimo-v2.6-flash": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "qwen3.8-flash": {
     "context_window": 262144,
     "max_output": 131072
    },
    "glm5.3": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "deepseek-v4-flash": {
     "context_window": 1000000,
     "max_output": 384000
    }
   }
  },
  "stepfun-ai-step-plan": {
   "api": "https://api.stepfun.ai/step_plan/v1",
   "models": {
    "step-5-preview": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "step-3.5-flash-2603": {
     "context_window": 256000,
     "max_output": 256000
    },
    "step-3.5-flash": {
     "context_window": 256000,
     "max_output": 256000
    },
    "step-3.7-flash": {
     "context_window": 256000,
     "max_output": 256000
    }
   }
  },
  "nearai": {
   "api": "https://cloud-api.near.ai/v1",
   "models": {
    "anthropic/claude-haiku-4-5": {
     "context_window": 200000,
     "max_output": 64000
    },
    "anthropic/claude-sonnet-4-5": {
     "context_window": 200000,
     "max_output": 64000
    },
    "anthropic/claude-opus-4-6": {
     "context_window": 200000,
     "max_output": 128000
    },
    "anthropic/claude-sonnet-4-6": {
     "context_window": 1000000,
     "max_output": 64000
    },
    "anthropic/claude-opus-4-7": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "black-forest-labs/FLUX.2-klein-4B": {
     "context_window": 128000,
     "max_output": 128000
    },
    "google/gemini-3.5-flash": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemini-2.5-pro": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemini-2.5-flash": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemini-2.5-flash-lite": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemini-3.1-flash-lite": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "Qwen/Qwen3-Reranker-0.6B": {
     "context_window": 40960,
     "max_output": 1024
    },
    "Qwen/Qwen3-VL-30B-A3B-Instruct": {
     "context_window": 16384,
     "max_output": 8192
    },
    "Qwen/Qwen3-Embedding-0.6B": {
     "context_window": 32768,
     "max_output": 1024
    },
    "Qwen/Qwen3.6-35B-A3B-FP8": {
     "context_window": 262144,
     "max_output": 8192
    },
    "zai-org/GLM-5.1-FP8": {
     "context_window": 202752,
     "max_output": 16384
    },
    "openai/gpt-5.4": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-5.4-nano": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/whisper-large-v3": {
     "max_output": 448
    },
    "openai/gpt-5-mini": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/o4-mini": {
     "context_window": 200000,
     "max_output": 100000
    },
    "openai/o3-mini": {
     "context_window": 200000,
     "max_output": 100000
    },
    "openai/gpt-4.1-nano": {
     "context_window": 1047576,
     "max_output": 32768
    },
    "openai/gpt-5-nano": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-5.1": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-5.4-mini": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-5.2": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-5.5": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-4.1": {
     "context_window": 1047576,
     "max_output": 32768
    },
    "openai/gpt-4.1-mini": {
     "context_window": 1047576,
     "max_output": 32768
    },
    "openai/o3": {
     "context_window": 200000,
     "max_output": 100000
    },
    "openai/gpt-5": {
     "context_window": 400000,
     "max_output": 128000
    }
   }
  },
  "wandb": {
   "api": "https://api.inference.wandb.ai/v1",
   "models": {
    "JetBrains/Mellum2-12B-A2.5B-Instruct": {
     "context_window": 131072,
     "max_output": 131072
    },
    "meta-llama/Llama-3.1-70B-Instruct": {
     "context_window": 131072,
     "max_output": 131072
    },
    "meta-llama/Llama-3.1-8B-Instruct": {
     "context_window": 131072,
     "max_output": 131072
    },
    "meta-llama/Llama-3.3-70B-Instruct": {
     "context_window": 128000,
     "max_output": 128000
    },
    "google/gemma-4-31B-it": {
     "context_window": 262144,
     "max_output": 262144
    },
    "google/gemma-4-26B-A4B-it": {
     "context_window": 262144,
     "max_output": 262144
    },
    "Qwen/Qwen3.8-27B": {
     "context_window": 262144,
     "max_output": 262144
    },
    "Qwen/Qwen3-30B-A3B-Instruct-2507": {
     "context_window": 262144,
     "max_output": 262144
    },
    "Qwen/Qwen3.6-35B-A3B": {
     "context_window": 262144,
     "max_output": 262144
    },
    "Qwen/Qwen3.5-35B-A3B": {
     "context_window": 262144,
     "max_output": 262144
    },
    "Qwen/Qwen3.6-27B": {
     "context_window": 262144,
     "max_output": 262144
    },
    "ibm-granite/granite-4.2-8b": {
     "context_window": 131072,
     "max_output": 131072
    },
    "ibm-granite/granite-4.1-8b": {
     "context_window": 131072,
     "max_output": 131072
    },
    "deepseek-ai/DeepSeek-V3.1": {
     "context_window": 161000,
     "max_output": 161000
    },
    "deepseek-ai/DeepSeek-V4-Flash-0731": {
     "context_window": 262144,
     "max_output": 262144
    },
    "deepseek-ai/DeepSeek-V4-Pro-0813": {
     "context_window": 1048576,
     "max_output": 1048576
    },
    "deepseek-ai/DeepSeek-V4.1-Flash": {
     "context_window": 1048576,
     "max_output": 1048576
    },
    "deepseek-ai/DeepSeek-V4-Flash": {
     "context_window": 1048576,
     "max_output": 1048576
    },
    "deepseek-ai/DeepSeek-V4-Pro": {
     "context_window": 1048576,
     "max_output": 1048576
    },
    "MiniMaxAI/MiniMax-M3": {
     "context_window": 262144,
     "max_output": 262144
    },
    "moonshotai/Kimi-K2.6": {
     "context_window": 262144,
     "max_output": 262144
    },
    "moonshotai/Kimi-K2.7-Code": {
     "context_window": 262144,
     "max_output": 262144
    },
    "zai-org/GLM-5.2": {
     "context_window": 1048576,
     "max_output": 1048576
    },
    "zai-org/GLM-5.3-Flash": {
     "context_window": 1048576,
     "max_output": 1048576
    },
    "nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B": {
     "context_window": 262144,
     "max_output": 262144
    },
    "nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B": {
     "context_window": 262144,
     "max_output": 262144
    },
    "openai/gpt-oss-20b": {
     "context_window": 131072,
     "max_output": 131072
    },
    "openai/gpt-oss-120b": {
     "context_window": 131072,
     "max_output": 131072
    },
    "OpenPipe/Qwen3-14B-Instruct": {
     "context_window": 32768,
     "max_output": 32768
    }
   }
  },
  "subconscious": {
   "api": "https://api.subconscious.dev/v1",
   "models": {
    "subconscious/deepseek-v4.1-flash-marathon": {
     "context_window": 5000000,
     "max_output": 384000
    },
    "subconscious/glm-5.3-marathon": {
     "context_window": 5000000,
     "max_output": 131072
    }
   }
  },
  "zeldoc": {
   "api": "https://api.zeldoc.ai/v1",
   "models": {
    "zdev": {
     "context_window": 1000000,
     "max_output": 131072
    }
   }
  },
  "databricks": {
   "api": "https://${DATABRICKS_HOST}/ai-gateway/mlflow/v1",
   "models": {
    "databricks-claude-opus-4-5": {
     "context_window": 200000,
     "max_output": 64000
    },
    "databricks-gpt-5-6-terra": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "databricks-kimi-k2-7-code": {
     "context_window": 262144,
     "max_output": 262144
    },
    "databricks-glm-5-2": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "databricks-gemini-3-1-flash-lite": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "databricks-gpt-5-mini": {
     "context_window": 400000,
     "max_output": 128000
    },
    "databricks-gemini-3-flash": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "databricks-claude-opus-4-7": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "databricks-gpt-oss-20b": {
     "context_window": 131072,
     "max_output": 32768
    },
    "databricks-gpt-5-4-mini": {
     "context_window": 400000,
     "max_output": 128000
    },
    "databricks-gemini-3-pro": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "databricks-gpt-5-2": {
     "context_window": 400000,
     "max_output": 128000
    },
    "databricks-claude-haiku-4-5": {
     "context_window": 200000,
     "max_output": 64000
    },
    "databricks-gemini-3-1-pro": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "databricks-claude-opus-4-6": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "databricks-gpt-5-6-sol": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "databricks-claude-opus-4-1": {
     "context_window": 200000,
     "max_output": 32000
    },
    "databricks-gpt-oss-120b": {
     "context_window": 131072,
     "max_output": 32768
    },
    "databricks-gemini-2-5-pro": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "databricks-gemini-2-5-flash": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "databricks-claude-sonnet-4-5": {
     "context_window": 200000,
     "max_output": 64000
    },
    "databricks-gpt-5-4": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "databricks-gpt-5-4-nano": {
     "context_window": 400000,
     "max_output": 128000
    },
    "databricks-claude-sonnet-4-6": {
     "context_window": 1000000,
     "max_output": 64000
    },
    "databricks-gpt-5-6-luna": {
     "context_window": 400000,
     "max_output": 128000
    },
    "databricks-claude-sonnet-4": {
     "context_window": 200000,
     "max_output": 64000
    },
    "databricks-gpt-5-1": {
     "context_window": 400000,
     "max_output": 128000
    },
    "databricks-gpt-5-nano": {
     "context_window": 400000,
     "max_output": 128000
    },
    "databricks-gpt-5": {
     "context_window": 400000,
     "max_output": 128000
    },
    "databricks-gpt-5-5": {
     "context_window": 1050000,
     "max_output": 128000
    }
   }
  },
  "umans-ai-coding-plan": {
   "api": "https://api.code.umans.ai/v1",
   "models": {
    "umans-deepseek-v4.1-flash": {
     "context_window": 1048576,
     "max_output": 393215
    },
    "umans-glm-5.3-flash": {
     "context_window": 1048576,
     "max_output": 131071
    },
    "umans-flash": {
     "context_window": 262144,
     "max_output": 262144
    },
    "umans-deepseek-v4-flash-0731": {
     "context_window": 1048576,
     "max_output": 393215
    },
    "umans-kimi-k3": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "umans-glm-5.3": {
     "context_window": 1048576,
     "max_output": 131071
    },
    "umans-qwen3.6-35b-a3b": {
     "context_window": 262144,
     "max_output": 262144
    },
    "umans-coder": {
     "context_window": 1048576,
     "max_output": 131071
    }
   }
  },
  "kuae-cloud-coding-plan": {
   "api": "https://coding-plan-endpoint.kuaecloud.net/v1",
   "models": {
    "GLM-4.7": {
     "context_window": 204800,
     "max_output": 131072
    }
   }
  },
  "umans-ai": {
   "api": "https://api.code.umans.ai/v1",
   "models": {
    "umans-deepseek-v4.1-flash": {
     "context_window": 1048576,
     "max_output": 393215
    },
    "umans-glm-5.3-flash": {
     "context_window": 1048576,
     "max_output": 131071
    },
    "umans-flash": {
     "context_window": 262144,
     "max_output": 32768
    },
    "umans-deepseek-v4-flash-0731": {
     "context_window": 1048576,
     "max_output": 393215
    },
    "umans-kimi-k3": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "umans-glm-5.3": {
     "context_window": 1048576,
     "max_output": 131071
    },
    "umans-coder": {
     "context_window": 1048576,
     "max_output": 131071
    }
   }
  },
  "siliconflow": {
   "api": "https://api.siliconflow.com/v1",
   "models": {
    "ByteDance-Seed/Seed-OSS-36B-Instruct": {
     "context_window": 262000,
     "max_output": 262000
    },
    "nex-agi/Nex-N2-Pro": {
     "context_window": 262144,
     "max_output": 256000
    },
    "tencent/Hunyuan-A13B-Instruct": {
     "context_window": 131000,
     "max_output": 131000
    },
    "tencent/Hy3": {
     "context_window": 262144,
     "max_output": 262144
    },
    "meituan-longcat/LongCat-2.0": {
     "context_window": 1049000,
     "max_output": 131072
    },
    "google/gemma-4-12B-it": {
     "context_window": 262144,
     "max_output": 262144
    },
    "google/gemma-4-31B-it": {
     "context_window": 262144,
     "max_output": 262144
    },
    "google/gemma-4-26B-A4B-it": {
     "context_window": 262144,
     "max_output": 262144
    },
    "Qwen/Qwen3-VL-30B-A3B-Instruct": {
     "context_window": 262000,
     "max_output": 262000
    },
    "Qwen/Qwen3-VL-8B-Instruct": {
     "context_window": 262000,
     "max_output": 262000
    },
    "Qwen/Qwen3-VL-32B-Thinking": {
     "context_window": 262000,
     "max_output": 262000
    },
    "Qwen/Qwen3-30B-A3B-Instruct-2507": {
     "context_window": 262000,
     "max_output": 262000
    },
    "Qwen/Qwen3.5-27B": {
     "context_window": 262144,
     "max_output": 262144
    },
    "Qwen/Qwen3.6-35B-A3B": {
     "context_window": 262144,
     "max_output": 262144
    },
    "Qwen/Qwen3-14B": {
     "context_window": 131000,
     "max_output": 131000
    },
    "Qwen/Qwen3-VL-30B-A3B-Thinking": {
     "context_window": 262000,
     "max_output": 262000
    },
    "Qwen/Qwen3-8B": {
     "context_window": 131000,
     "max_output": 131000
    },
    "Qwen/Qwen2.5-72B-Instruct": {
     "context_window": 33000,
     "max_output": 4000
    },
    "Qwen/Qwen3-32B": {
     "context_window": 131000,
     "max_output": 131000
    },
    "Qwen/Qwen3-Coder-30B-A3B-Instruct": {
     "context_window": 262000,
     "max_output": 262000
    },
    "Qwen/Qwen2.5-7B-Instruct": {
     "context_window": 33000,
     "max_output": 4000
    },
    "Qwen/Qwen3.5-35B-A3B": {
     "context_window": 262144,
     "max_output": 262144
    },
    "Qwen/Qwen3.5-122B-A10B": {
     "context_window": 262144,
     "max_output": 262144
    },
    "Qwen/Qwen3.5-9B": {
     "context_window": 262144,
     "max_output": 262144
    },
    "Qwen/Qwen3.5-397B-A17B": {
     "context_window": 262144,
     "max_output": 262144
    },
    "Qwen/Qwen3.8-2.4T-A95B": {
     "context_window": 1049000,
     "max_output": 131000
    },
    "Qwen/Qwen3-VL-32B-Instruct": {
     "context_window": 262000,
     "max_output": 262000
    },
    "Qwen/Qwen3-Coder-480B-A35B-Instruct": {
     "context_window": 262000,
     "max_output": 262000
    },
    "Qwen/Qwen3.6-27B": {
     "context_window": 262144,
     "max_output": 262144
    },
    "deepseek-ai/DeepSeek-V3.1": {
     "context_window": 164000,
     "max_output": 164000
    },
    "deepseek-ai/DeepSeek-V4-Flash-0731": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "deepseek-ai/DeepSeek-R1": {
     "context_window": 164000,
     "max_output": 164000
    },
    "deepseek-ai/DeepSeek-V4-Pro-0813": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "deepseek-ai/DeepSeek-V4-Flash": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "deepseek-ai/DeepSeek-V4-Pro": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "deepseek-ai/DeepSeek-V3.2": {
     "context_window": 164000,
     "max_output": 164000
    },
    "deepseek-ai/DeepSeek-V3": {
     "context_window": 164000,
     "max_output": 164000
    },
    "deepseek-ai/DeepSeek-V3.1-Terminus": {
     "context_window": 164000,
     "max_output": 164000
    },
    "deepseek-ai/DeepSeek-V3.2-Exp": {
     "context_window": 164000,
     "max_output": 164000
    },
    "deepseek-ai/DeepSeek-V4-Flash-Vision-Exp": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "stepfun-ai/Step-3.5-Flash": {
     "context_window": 262000,
     "max_output": 262000
    },
    "MiniMaxAI/MiniMax-M3": {
     "context_window": 1048576,
     "max_output": 131000
    },
    "MiniMaxAI/MiniMax-M2.5": {
     "context_window": 197000,
     "max_output": 131000
    },
    "inclusionAI/Ling-flash-2.0": {
     "context_window": 131000,
     "max_output": 131000
    },
    "moonshotai/Kimi-K2.6": {
     "context_window": 262000,
     "max_output": 262000
    },
    "moonshotai/Kimi-K3": {
     "context_window": 1048576,
     "max_output": 262000
    },
    "moonshotai/Kimi-K2.7-Code": {
     "context_window": 262144,
     "max_output": 262144
    },
    "moonshotai/Kimi-K2.5": {
     "context_window": 262000,
     "max_output": 262000
    },
    "zai-org/GLM-5.1": {
     "context_window": 205000,
     "max_output": 131000
    },
    "zai-org/GLM-5.2": {
     "context_window": 1049000,
     "max_output": 262000
    },
    "zai-org/GLM-4.5-Air": {
     "context_window": 131000,
     "max_output": 131000
    },
    "zai-org/GLM-5": {
     "context_window": 205000,
     "max_output": 205000
    },
    "zai-org/GLM-5.3-Flash": {
     "context_window": 1049000,
     "max_output": 262000
    },
    "zai-org/GLM-5V-Turbo": {
     "context_window": 200000,
     "max_output": 131072
    },
    "zai-org/GLM-5.3": {
     "context_window": 1049000,
     "max_output": 262000
    },
    "openai/gpt-oss-20b": {
     "context_window": 131000,
     "max_output": 8000
    },
    "openai/gpt-oss-120b": {
     "context_window": 131000,
     "max_output": 8000
    }
   }
  },
  "minimax-coding-plan": {
   "api": "https://api.minimax.io/anthropic/v1",
   "models": {
    "MiniMax-M3": {
     "context_window": 1048576,
     "max_output": 512000
    },
    "MiniMax-M2.1": {
     "context_window": 204800,
     "max_output": 131072
    },
    "MiniMax-M3.1-Flash-Preview": {
     "context_window": 1000000,
     "max_output": 512000
    },
    "MiniMax-M2.5": {
     "context_window": 204800,
     "max_output": 131072
    },
    "MiniMax-M2.7": {
     "context_window": 204800,
     "max_output": 131072
    },
    "MiniMax-M2.7-highspeed": {
     "context_window": 204800,
     "max_output": 131072
    },
    "MiniMax-M2": {
     "context_window": 204800,
     "max_output": 131072
    },
    "MiniMax-M2.5-highspeed": {
     "context_window": 204800,
     "max_output": 131072
    }
   }
  },
  "alibaba-coding-plan": {
   "api": "https://coding-intl.dashscope.aliyuncs.com/v1",
   "models": {
    "qwen3-coder-next": {
     "context_window": 262144,
     "max_output": 65536
    },
    "qwen3.5-plus": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "glm-5": {
     "context_window": 202752,
     "max_output": 16384
    },
    "kimi-k2.5": {
     "context_window": 262144,
     "max_output": 32768
    },
    "qwen3-max-2026-01-23": {
     "context_window": 262144,
     "max_output": 32768
    },
    "qwen3-coder-plus": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "MiniMax-M2.5": {
     "context_window": 196608,
     "max_output": 24576
    },
    "glm-4.7": {
     "context_window": 202752,
     "max_output": 16384
    },
    "qwen3.6-plus": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "qwen3.7-plus": {
     "context_window": 1000000,
     "max_output": 64000
    }
   }
  },
  "lilac": {
   "api": "https://api.getlilac.com/v1",
   "models": {
    "google/gemma-4-31b-it": {
     "context_window": 262100,
     "max_output": 262100
    },
    "minimaxai/minimax-m3": {
     "context_window": 1048576,
     "max_output": 1048576
    },
    "moonshotai/kimi-k2.6": {
     "context_window": 262144,
     "max_output": 262144
    },
    "zai-org/glm-5.2": {
     "context_window": 524288,
     "max_output": 524288
    }
   }
  },
  "moonshotai-cn": {
   "api": "https://api.moonshot.cn/v1",
   "models": {
    "kimi-k2.7-code": {
     "context_window": 262144,
     "max_output": 262144
    },
    "kimi-k2.6": {
     "context_window": 262144,
     "max_output": 262144
    },
    "kimi-k2.7-code-highspeed": {
     "context_window": 262144,
     "max_output": 262144
    },
    "kimi-k3": {
     "context_window": 1048576,
     "max_output": 1048576
    }
   }
  },
  "bothub": {
   "api": "https://openai.bothub.ru/v1",
   "models": {
    "gemma-4-31b-it:free": {
     "context_window": 262144,
     "max_output": 32768
    },
    "glm-5.3-flash": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "deepseek-v4-flash-0731": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "nemotron-3-ultra-550b-a55b:free": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "deepseek-v4-pro-0813": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "gpt-5.6-luna": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "muse-spark-1.3-contributor": {
     "context_window": 1048576,
     "max_output": 943718
    },
    "glm-5.3": {
     "context_window": 1000000,
     "max_output": 131072
    }
   }
  },
  "xiaomi-token-plan-cn": {
   "api": "https://token-plan-cn.xiaomimimo.com/v1",
   "models": {
    "mimo-v2.6-pro": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "mimo-v2.5": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "mimo-v2.5-tts-voicedesign": {
     "context_window": 8192,
     "max_output": 8192
    },
    "mimo-v2.5-tts": {
     "context_window": 8192,
     "max_output": 8192
    },
    "mimo-v2-pro": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "mimo-v2-tts": {
     "context_window": 8192,
     "max_output": 8192
    },
    "mimo-v2.5-pro": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "mimo-v2.6-flash": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "mimo-v2.5-tts-voiceclone": {
     "context_window": 8192,
     "max_output": 8192
    }
   }
  },
  "privatemode-ai": {
   "api": "http://localhost:8080/v1",
   "models": {
    "glm-flash-latest": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "glm-5.3-flash": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "whisper-large-v3": {
     "max_output": 4096
    },
    "kimi-k2.6": {
     "context_window": 256000,
     "max_output": 262144
    },
    "deepseek-ocr-2": {
     "context_window": 8192,
     "max_output": 8192
    },
    "qwen3-embedding-4b": {
     "context_window": 32000,
     "max_output": 2560
    },
    "voxtral-mini-3b": {
     "context_window": 32000,
     "max_output": 32000
    },
    "kimi-latest": {
     "context_window": 256000,
     "max_output": 262144
    },
    "gpt-oss-120b": {
     "context_window": 128000,
     "max_output": 32768
    },
    "glm-5.3": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "glm-latest": {
     "context_window": 1000000,
     "max_output": 131072
    }
   }
  },
  "llmgateway-providers": {
   "api": "https://api.llmgateway.io/v1",
   "models": {
    "consensusprotocol/gemma-4-31b-it": {
     "context_window": 262144,
     "max_output": 32768
    },
    "consensusprotocol/Qwen3.8-27B": {
     "context_window": 262000,
     "max_output": 32768
    },
    "consensusprotocol/glm-5.3-flash": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "consensusprotocol/deepseek-v4.1-flash": {
     "context_window": 1048576,
     "max_output": 384000
    },
    "consensusprotocol/gpt-oss-20b": {
     "context_window": 128000,
     "max_output": 32768
    },
    "consensusprotocol/deepseek-v4-flash": {
     "context_window": 524288,
     "max_output": 384000
    },
    "deepinfra/mimo-v2.6-pro": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "deepinfra/gemma-4-31b-it": {
     "context_window": 262144,
     "max_output": 32768
    },
    "deepinfra/qwen3-vl-235b-a22b-instruct": {
     "context_window": 262144,
     "max_output": 32768
    },
    "deepinfra/qwen3.8-2.4t-a95b": {
     "context_window": 262144,
     "max_output": 131072
    },
    "deepinfra/muse-glimmer-30b": {
     "context_window": 131072,
     "max_output": 16384
    },
    "deepinfra/deepseek-v4.1-flash": {
     "context_window": 1048576,
     "max_output": 393216
    },
    "deepinfra/ling-3.0-flash": {
     "context_window": 262144,
     "max_output": 32768
    },
    "deepinfra/qwen3-vl-30b-a3b-instruct": {
     "context_window": 262144,
     "max_output": 32768
    },
    "deepinfra/gemma-4-26b-a4b-it": {
     "context_window": 262144,
     "max_output": 32768
    },
    "deepinfra/ling-3.0-flash-vl": {
     "context_window": 131072,
     "max_output": 32768
    },
    "deepinfra/granite-4.2-8b": {
     "context_window": 131072,
     "max_output": 117964
    },
    "deepinfra/nemotron-3-ultra-550b": {
     "context_window": 262144,
     "max_output": 262144
    },
    "deepinfra/qwen3.5-9b": {
     "context_window": 262144,
     "max_output": 32768
    },
    "deepinfra/inkling": {
     "context_window": 524288,
     "max_output": 262144
    },
    "deepinfra/mimo-v2.6-flash": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "deepinfra/hy3": {
     "context_window": 262144,
     "max_output": 131072
    },
    "deepinfra/deepseek-v4-pro": {
     "context_window": 1048576,
     "max_output": 64000
    },
    "deepinfra/deepseek-v3.2": {
     "context_window": 160000,
     "max_output": 65536
    },
    "deepinfra/deepseek-v4-flash": {
     "context_window": 1000000,
     "max_output": 393216
    },
    "cerebras/gemma-4-31b-it": {
     "context_window": 131072,
     "max_output": 32768
    },
    "cerebras/qwen3-235b-a22b-instruct-2507": {
     "context_window": 262000,
     "max_output": 8192
    },
    "cerebras/llama-3.3-70b-instruct": {
     "context_window": 128000,
     "max_output": 4096
    },
    "cerebras/glm-4.7": {
     "context_window": 200000,
     "max_output": 128000
    },
    "cerebras/gpt-oss-120b": {
     "context_window": 131072,
     "max_output": 32768
    },
    "groq/gpt-oss-20b": {
     "context_window": 131072,
     "max_output": 32766
    },
    "groq/gpt-oss-120b": {
     "context_window": 131072,
     "max_output": 32766
    },
    "scx-ai-gp/glm-5.3-flash": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "scx-ai-gp/glm-5.2-fast": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "scx-ai-gp/qwen3.8-max": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "scx-ai-gp/kimi-k3": {
     "context_window": 1048576,
     "max_output": 1048576
    },
    "scx-ai-gp/deepseek-v4.1-flash": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "scx-ai-gp/glm-5.2": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "scx-ai-gp/glm-5.3": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "scx-ai-gp/kimi-k2.7-code": {
     "context_window": 262144,
     "max_output": 262144
    },
    "zai/glm-4.6v": {
     "context_window": 128000,
     "max_output": 16000
    },
    "zai/glm-4.5": {
     "context_window": 128000,
     "max_output": 98304
    },
    "zai/glm-5.3-flash": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "zai/glm-4.6": {
     "context_window": 200000,
     "max_output": 131072
    },
    "zai/glm-4.5-x": {
     "context_window": 128000,
     "max_output": 128000
    },
    "zai/glm-5": {
     "context_window": 202800,
     "max_output": 131100
    },
    "zai/glm-4.5-airx": {
     "context_window": 128000,
     "max_output": 128000
    },
    "zai/glm-4.5v": {
     "context_window": 128000,
     "max_output": 16000
    },
    "zai/glm-4-32b-0414-128k": {
     "context_window": 128000,
     "max_output": 128000
    },
    "zai/glm-4.6v-flashx": {
     "context_window": 128000,
     "max_output": 16000
    },
    "zai/glm-4.7": {
     "context_window": 200000,
     "max_output": 128000
    },
    "zai/glm-5.2": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "zai/glm-5.1": {
     "context_window": 200000,
     "max_output": 128000
    },
    "zai/glm-4.7-flashx": {
     "context_window": 200000,
     "max_output": 128000
    },
    "zai/glm-4.5-air": {
     "context_window": 128000,
     "max_output": 98304
    },
    "zai/glm-5.3": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "luminal/deepseek-v4.1-flash": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "aws-bedrock/claude-haiku-4-5": {
     "context_window": 200000,
     "max_output": 64000
    },
    "aws-bedrock/kimi-k3": {
     "context_window": 1048576,
     "max_output": 1048576
    },
    "aws-bedrock/llama-4-maverick-17b-instruct": {
     "context_window": 8192,
     "max_output": 2048
    },
    "aws-bedrock/claude-sonnet-4-5": {
     "context_window": 200000,
     "max_output": 8192
    },
    "aws-bedrock/claude-opus-5-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "aws-bedrock/claude-fable-5-1": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "aws-bedrock/llama-4-scout-17b-instruct": {
     "context_window": 8192,
     "max_output": 2048
    },
    "aws-bedrock/claude-opus-4-1-20250805": {
     "context_window": 200000,
     "max_output": 32000
    },
    "aws-bedrock/claude-opus-4-5-20251101": {
     "context_window": 200000,
     "max_output": 32000
    },
    "aws-bedrock/claude-opus-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "aws-bedrock/claude-fable-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "aws-bedrock/claude-opus-4-8": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "aws-bedrock/claude-sonnet-4-5-20250929": {
     "context_window": 200000,
     "max_output": 8192
    },
    "aws-bedrock/claude-sonnet-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "aws-bedrock/claude-opus-4-6": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "aws-bedrock/grok-4-3": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "aws-bedrock/claude-haiku-4-5-20251001": {
     "context_window": 200000,
     "max_output": 64000
    },
    "aws-bedrock/grok-4-6": {
     "context_window": 500000,
     "max_output": 500000
    },
    "aws-bedrock/claude-sonnet-4-6": {
     "context_window": 1000000,
     "max_output": 64000
    },
    "aws-bedrock/claude-sonnet-5-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "aws-bedrock/grok-4-7": {
     "context_window": 524288,
     "max_output": 524288
    },
    "aws-bedrock/claude-opus-4-7": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "aws-bedrock/llama-3.1-70b-instruct": {
     "context_window": 128000,
     "max_output": 2048
    },
    "google-ai-studio/gemini-3.6-flash": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google-ai-studio/gemini-3.5-flash-lite": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google-ai-studio/gemini-3.1-pro-preview": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google-ai-studio/gemini-3.5-flash": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google-ai-studio/gemini-2.5-pro": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google-ai-studio/gemini-2.5-flash": {
     "context_window": 1048576,
     "max_output": 65535
    },
    "google-ai-studio/gemini-3.7-flash": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google-ai-studio/gemini-3-flash-preview": {
     "context_window": 1048576,
     "max_output": 65535
    },
    "google-ai-studio/gemini-pro-latest": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google-ai-studio/gemini-3.8-flash": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google-ai-studio/gemini-2.5-flash-lite": {
     "context_window": 1048576,
     "max_output": 65535
    },
    "google-ai-studio/gemini-3.1-flash-lite": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "anthropic/claude-haiku-4-5": {
     "context_window": 200000,
     "max_output": 64000
    },
    "anthropic/claude-sonnet-4-5": {
     "context_window": 200000,
     "max_output": 64000
    },
    "anthropic/claude-opus-5-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-fable-5-1": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-opus-4-5-20251101": {
     "context_window": 200000,
     "max_output": 32000
    },
    "anthropic/claude-opus-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-fable-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-opus-4-8": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-sonnet-4-5-20250929": {
     "context_window": 200000,
     "max_output": 64000
    },
    "anthropic/claude-sonnet-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-opus-4-6": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-haiku-4-5-20251001": {
     "context_window": 200000,
     "max_output": 64000
    },
    "anthropic/claude-sonnet-4-6": {
     "context_window": 1000000,
     "max_output": 64000
    },
    "anthropic/claude-sonnet-5-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-opus-4-7": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "deepseek/deepseek-v4.1-flash": {
     "context_window": 1050000,
     "max_output": 393216
    },
    "deepseek/deepseek-v4-pro": {
     "context_window": 1050000,
     "max_output": 393216
    },
    "runpod/kimi-k3": {
     "context_window": 1048576,
     "max_output": 1048576
    },
    "runware/gemma-4-31b-it": {
     "context_window": 262144,
     "max_output": 65536
    },
    "runware/glm-5.3-flash": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "runware/kimi-k3": {
     "context_window": 1048576,
     "max_output": 1048576
    },
    "runware/deepseek-v4.1-flash": {
     "context_window": 1048576,
     "max_output": 384000
    },
    "runware/kimi-k2.6": {
     "context_window": 262144,
     "max_output": 131072
    },
    "runware/glm-5.2": {
     "context_window": 1024000,
     "max_output": 128000
    },
    "runware/deepseek-v4-pro": {
     "context_window": 1048576,
     "max_output": 384000
    },
    "runware/gpt-oss-120b": {
     "context_window": 131072,
     "max_output": 32768
    },
    "runware/glm-5.3": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "runware/deepseek-v4-flash": {
     "context_window": 1048576,
     "max_output": 384000
    },
    "tencent/glm-5v-turbo": {
     "context_window": 200000,
     "max_output": 128000
    },
    "tencent/kimi-k3": {
     "context_window": 1048576,
     "max_output": 1048576
    },
    "tencent/glm-5": {
     "context_window": 200000,
     "max_output": 128000
    },
    "tencent/kimi-k2.7-code-highspeed": {
     "context_window": 262144,
     "max_output": 262144
    },
    "tencent/kimi-k2.6": {
     "context_window": 262144,
     "max_output": 262144
    },
    "tencent/minimax-m2.7": {
     "context_window": 200000,
     "max_output": 128000
    },
    "tencent/mimo-v2.5-pro": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "tencent/minimax-m3": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "tencent/glm-5.2": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "tencent/hy3": {
     "context_window": 262144,
     "max_output": 131072
    },
    "tencent/hy-mt2-plus": {
     "context_window": 8192,
     "max_output": 4096
    },
    "tencent/glm-5.1": {
     "context_window": 200000,
     "max_output": 128000
    },
    "tencent/glm-5-turbo": {
     "context_window": 200000,
     "max_output": 128000
    },
    "tencent/deepseek-v4-pro": {
     "context_window": 1000000,
     "max_output": 393216
    },
    "tencent/hy4-preview": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "tencent/kimi-k2.7-code": {
     "context_window": 262144,
     "max_output": 262144
    },
    "tencent/deepseek-v4-flash": {
     "context_window": 1000000,
     "max_output": 393216
    },
    "meta-contributor/muse-spark-1.2-contributor": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "meta-contributor/muse-spark-1.3-contributor": {
     "context_window": 1048576,
     "max_output": 1048576
    },
    "novita/glm-4.6v": {
     "context_window": 131072,
     "max_output": 16000
    },
    "novita/gemma-4-31b-it": {
     "context_window": 262144,
     "max_output": 32768
    },
    "novita/qwen3-vl-235b-a22b-instruct": {
     "context_window": 131072,
     "max_output": 32768
    },
    "novita/qwen3.7-max": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "novita/mimo-v2.5": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "novita/qwen3.8-27b": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "novita/qwen3-vl-235b-a22b-thinking": {
     "context_window": 131072,
     "max_output": 32768
    },
    "novita/qwen3.8-2.4t-a95b": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "novita/glm-5.3-flash": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "novita/glm-4.6": {
     "context_window": 204800,
     "max_output": 131072
    },
    "novita/qwen3-235b-a22b-instruct-2507": {
     "context_window": 131072,
     "max_output": 16384
    },
    "novita/qwen3.8-max": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "novita/kimi-k3": {
     "context_window": 1048576,
     "max_output": 1048576
    },
    "novita/llama-4-maverick-17b-instruct": {
     "context_window": 1048576,
     "max_output": 8192
    },
    "novita/glm-5": {
     "context_window": 202800,
     "max_output": 131072
    },
    "novita/deepseek-v4.1-flash": {
     "context_window": 1048576,
     "max_output": 393216
    },
    "novita/minimax-m2.5": {
     "context_window": 204800,
     "max_output": 131100
    },
    "novita/kimi-k2.6": {
     "context_window": 262144,
     "max_output": 262144
    },
    "novita/qwen3-max": {
     "context_window": 262144,
     "max_output": 65536
    },
    "novita/glm-4.5v": {
     "context_window": 65536,
     "max_output": 16000
    },
    "novita/llama-4-scout-17b-instruct": {
     "context_window": 131072,
     "max_output": 131072
    },
    "novita/qwen3-235b-a22b-fp8": {
     "context_window": 40960,
     "max_output": 20000
    },
    "novita/qwen3-coder-480b-a35b-instruct": {
     "context_window": 262144,
     "max_output": 65536
    },
    "novita/qwen3-coder-30b-a3b-instruct": {
     "context_window": 160000,
     "max_output": 32768
    },
    "novita/ling-3.0-flash": {
     "context_window": 262144,
     "max_output": 32768
    },
    "novita/qwen3-vl-30b-a3b-instruct": {
     "context_window": 131072,
     "max_output": 32768
    },
    "novita/gemma-4-26b-a4b-it": {
     "context_window": 262144,
     "max_output": 32768
    },
    "novita/llama-3-70b-instruct": {
     "context_window": 8192,
     "max_output": 8000
    },
    "novita/qwen3-235b-a22b-thinking-2507": {
     "context_window": 131072,
     "max_output": 32768
    },
    "novita/qwen3.5-122b-a10b": {
     "context_window": 262144,
     "max_output": 65536
    },
    "novita/llama-3.3-70b-instruct": {
     "context_window": 131072,
     "max_output": 120000
    },
    "novita/qwen3.6-35b-a3b": {
     "context_window": 262144,
     "max_output": 64000
    },
    "novita/qwen3-next-80b-a3b-instruct": {
     "context_window": 131072,
     "max_output": 32768
    },
    "novita/minimax-m2.7": {
     "context_window": 204800,
     "max_output": 131100
    },
    "novita/mimo-v2.5-pro": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "novita/glm-4.7": {
     "context_window": 204800,
     "max_output": 128000
    },
    "novita/qwen3.8-flash": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "novita/qwen35-397b-a17b": {
     "context_window": 262144,
     "max_output": 64000
    },
    "novita/glm-5.2": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "novita/ernie-4.5-vl-424b-a47b": {
     "context_window": 123000,
     "max_output": 16000
    },
    "novita/hy3": {
     "context_window": 262144,
     "max_output": 262144
    },
    "novita/kimi-k2": {
     "context_window": 131072,
     "max_output": 131072
    },
    "novita/glm-5.1": {
     "context_window": 204800,
     "max_output": 131072
    },
    "novita/step-3.7-flash": {
     "context_window": 262144,
     "max_output": 256000
    },
    "novita/llama-3.2-3b-instruct": {
     "context_window": 32768,
     "max_output": 32000
    },
    "novita/deepseek-v3.2": {
     "context_window": 163840,
     "max_output": 65536
    },
    "novita/glm-5.3": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "novita/kimi-k2.7-code": {
     "context_window": 262144,
     "max_output": 262144
    },
    "novita/minimax-m2.1": {
     "context_window": 204800,
     "max_output": 131072
    },
    "novita/deepseek-v4-flash": {
     "context_window": 1050000,
     "max_output": 393216
    },
    "embercloud/glm-4.5": {
     "context_window": 131000,
     "max_output": 96000
    },
    "embercloud/qwen3-coder-next": {
     "context_window": 262144,
     "max_output": 262144
    },
    "embercloud/glm-5": {
     "context_window": 203000,
     "max_output": 131000
    },
    "embercloud/kimi-k2.5": {
     "context_window": 262144,
     "max_output": 262144
    },
    "embercloud/glm-4.7-flash": {
     "context_window": 200000,
     "max_output": 131000
    },
    "embercloud/glm-4.7": {
     "context_window": 200000,
     "max_output": 131000
    },
    "embercloud/glm-5.2": {
     "context_window": 203000,
     "max_output": 131000
    },
    "embercloud/glm-5.1": {
     "context_window": 203000,
     "max_output": 131000
    },
    "embercloud/glm-4.5-air": {
     "context_window": 131000,
     "max_output": 96000
    },
    "perplexity/sonar": {
     "context_window": 130000,
     "max_output": 4096
    },
    "azure-ai-foundry/grok-4-1-fast-reasoning": {
     "context_window": 2000000,
     "max_output": 30000
    },
    "azure-ai-foundry/grok-4-1-fast-non-reasoning": {
     "context_window": 2000000,
     "max_output": 30000
    },
    "azure-ai-foundry/grok-4-3": {
     "context_window": 20000,
     "max_output": 8192
    },
    "meta/muse-spark-1.3": {
     "context_window": 1048576,
     "max_output": 1048576
    },
    "meta/muse-spark-1.1": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "meta/muse-spark-1.2": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "azure/gpt-5.4": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "azure/gpt-5.4-pro": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "azure/gpt-5.4-nano": {
     "context_window": 400000,
     "max_output": 128000
    },
    "azure/gpt-5.2-codex": {
     "context_window": 400000,
     "max_output": 128000
    },
    "azure/gpt-5.1-codex": {
     "context_window": 400000,
     "max_output": 272000
    },
    "azure/gpt-4o": {
     "context_window": 128000,
     "max_output": 16384
    },
    "azure/gpt-5-mini": {
     "context_window": 400000,
     "max_output": 128000
    },
    "azure/gpt-5.3-codex": {
     "context_window": 400000,
     "max_output": 128000
    },
    "azure/gpt-4.1-nano": {
     "context_window": 1000000,
     "max_output": 32768
    },
    "azure/gpt-5-nano": {
     "context_window": 400000,
     "max_output": 128000
    },
    "azure/gpt-6.1-sol": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "azure/gpt-6-astra": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "azure/gpt-5.1": {
     "context_window": 400000,
     "max_output": 128000
    },
    "azure/gpt-5.4-mini": {
     "context_window": 400000,
     "max_output": 128000
    },
    "azure/gpt-5.6-luna": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "azure/gpt-5.2": {
     "context_window": 400000,
     "max_output": 128000
    },
    "azure/gpt-5.5": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "azure/gpt-4.1": {
     "context_window": 1000000,
     "max_output": 32768
    },
    "azure/gpt-4.1-mini": {
     "context_window": 1000000,
     "max_output": 32768
    },
    "azure/gpt-6-luna": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "azure/gpt-5.6-terra": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "azure/gpt-oss-120b": {
     "context_window": 131072,
     "max_output": 32768
    },
    "azure/gpt-5.1-codex-mini": {
     "context_window": 400000,
     "max_output": 128000
    },
    "azure/gpt-5": {
     "context_window": 400000,
     "max_output": 128000
    },
    "azure/gpt-5.6-sol": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "azure/gpt-6-sol": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "alibaba/qwen-flash": {
     "context_window": 1000000,
     "max_output": 32000
    },
    "alibaba/qwen3.7-max": {
     "context_window": 983616,
     "max_output": 65536
    },
    "alibaba/qwen-coder-plus": {
     "context_window": 131072,
     "max_output": 8192
    },
    "alibaba/qwen3-vl-plus": {
     "context_window": 262144,
     "max_output": 32768
    },
    "alibaba/qwen3.5-27b": {
     "context_window": 262144,
     "max_output": 65536
    },
    "alibaba/qwen-max": {
     "context_window": 32768,
     "max_output": 8192
    },
    "alibaba/qwen3.8-max": {
     "context_window": 983616,
     "max_output": 131072
    },
    "alibaba/kimi-k3": {
     "context_window": 1048576,
     "max_output": 1048576
    },
    "alibaba/glm-5": {
     "context_window": 202752,
     "max_output": 16384
    },
    "alibaba/deepseek-v4.1-flash": {
     "context_window": 1000000,
     "max_output": 393216
    },
    "alibaba/qwen-plus": {
     "context_window": 131072,
     "max_output": 32000
    },
    "alibaba/qwen3.7-flash": {
     "context_window": 983616,
     "max_output": 65536
    },
    "alibaba/qwen3-max": {
     "context_window": 256000,
     "max_output": 32800
    },
    "alibaba/qwen3-vl-flash": {
     "context_window": 262144,
     "max_output": 32768
    },
    "alibaba/qwen3.5-122b-a10b": {
     "context_window": 262144,
     "max_output": 65536
    },
    "alibaba/kimi-k2.5": {
     "context_window": 262144,
     "max_output": 98304
    },
    "alibaba/qwen3.6-35b-a3b": {
     "context_window": 262144,
     "max_output": 65536
    },
    "alibaba/qwen3.6-flash": {
     "context_window": 983616,
     "max_output": 65536
    },
    "alibaba/qwen3-coder-flash": {
     "context_window": 997952,
     "max_output": 65536
    },
    "alibaba/qwen3-coder-plus": {
     "context_window": 1000000,
     "max_output": 66000
    },
    "alibaba/qwen3.8-flash": {
     "context_window": 983616,
     "max_output": 131072
    },
    "alibaba/qwen35-397b-a17b": {
     "context_window": 262144,
     "max_output": 65536
    },
    "alibaba/qwen3.5-35b-a3b": {
     "context_window": 262144,
     "max_output": 65536
    },
    "alibaba/qwen3.6-max-preview": {
     "context_window": 262144,
     "max_output": 65536
    },
    "alibaba/glm-5.2": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "alibaba/qwen-omni-turbo": {
     "context_window": 32768,
     "max_output": 8192
    },
    "alibaba/deepseek-v4-pro": {
     "context_window": 1000000,
     "max_output": 393216
    },
    "alibaba/qwen3.6-plus": {
     "context_window": 983616,
     "max_output": 65536
    },
    "alibaba/qwen-plus-latest": {
     "context_window": 1000000,
     "max_output": 32000
    },
    "alibaba/glm-5.3": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "alibaba/qwen3.7-plus": {
     "context_window": 983616,
     "max_output": 65536
    },
    "alibaba/deepseek-v4-flash": {
     "context_window": 1000000,
     "max_output": 393216
    },
    "baidu/glm-5": {
     "context_window": 202752,
     "max_output": 131072
    },
    "baidu/deepseek-v4.1-flash": {
     "context_window": 1048576,
     "max_output": 393216
    },
    "baidu/kimi-k2.6": {
     "context_window": 262144,
     "max_output": 262144
    },
    "baidu/glm-5.2": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "baidu/glm-5.1": {
     "context_window": 202752,
     "max_output": 131072
    },
    "baidu/deepseek-v4-pro": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "baidu/glm-5.3": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "baidu/deepseek-v4-flash": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "gonka24/glm-5.3-flash": {
     "context_window": 200000,
     "max_output": 16384
    },
    "gonka24/minimax-m2.7": {
     "context_window": 204800,
     "max_output": 131100
    },
    "gonka24/deepseek-v4-flash": {
     "context_window": 390000,
     "max_output": 16384
    },
    "bytedance/seed-1-6-flash-250715": {
     "context_window": 256000,
     "max_output": 256000
    },
    "bytedance/seed-2-0-code-preview-260328": {
     "context_window": 262144,
     "max_output": 131072
    },
    "bytedance/seed-1-6-250915": {
     "context_window": 256000,
     "max_output": 256000
    },
    "bytedance/seed-2-0-mini-260428": {
     "context_window": 262144,
     "max_output": 131072
    },
    "bytedance/seed-2-0-pro-260328": {
     "context_window": 262144,
     "max_output": 131072
    },
    "bytedance/seed-1-8-251228": {
     "context_window": 256000,
     "max_output": 256000
    },
    "bytedance/glm-4.7": {
     "context_window": 200000,
     "max_output": 128000
    },
    "bytedance/seed-1-6-250615": {
     "context_window": 256000,
     "max_output": 256000
    },
    "bytedance/glm-5.2": {
     "context_window": 1024000,
     "max_output": 128000
    },
    "bytedance/seed-2-0-lite-260428": {
     "context_window": 262144,
     "max_output": 131072
    },
    "bytedance/deepseek-v4-pro": {
     "context_window": 1048576,
     "max_output": 393216
    },
    "bytedance/deepseek-v3.2": {
     "context_window": 131072,
     "max_output": 32768
    },
    "bytedance/gpt-oss-120b": {
     "context_window": 128000,
     "max_output": 32000
    },
    "bytedance/deepseek-v4-flash": {
     "context_window": 1048576,
     "max_output": 393216
    },
    "xai/grok-4-5": {
     "context_window": 500000,
     "max_output": 500000
    },
    "xai/grok-build-0-1": {
     "context_window": 256000,
     "max_output": 256000
    },
    "xai/grok-4": {
     "context_window": 256000,
     "max_output": 256000
    },
    "xai/grok-4-20-beta-0309-non-reasoning": {
     "context_window": 2000000,
     "max_output": 30000
    },
    "xai/grok-4-3": {
     "context_window": 1000000,
     "max_output": 1000000
    },
    "xai/grok-4-20-beta-0309-reasoning": {
     "context_window": 2000000,
     "max_output": 30000
    },
    "xai/grok-4-6": {
     "context_window": 500000,
     "max_output": 500000
    },
    "xai/grok-4-7": {
     "context_window": 500000,
     "max_output": 500000
    },
    "ranoai/deepseek-v4-flash": {
     "context_window": 1000000,
     "max_output": 393216
    },
    "canopywave/kimi-k3": {
     "context_window": 1048576,
     "max_output": 1048576
    },
    "canopywave/kimi-k2.6": {
     "context_window": 262144,
     "max_output": 32768
    },
    "canopywave/glm-5.2": {
     "context_window": 200000,
     "max_output": 32768
    },
    "canopywave/deepseek-v4-pro": {
     "context_window": 1000000,
     "max_output": 393216
    },
    "canopywave/deepseek-v4-flash": {
     "context_window": 1000000,
     "max_output": 393216
    },
    "fireworks/glm-5.3-flash": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "fireworks/kimi-k3": {
     "context_window": 1040384,
     "max_output": 1040384
    },
    "fireworks/deepseek-v4.1-flash": {
     "context_window": 1048576,
     "max_output": 393216
    },
    "fireworks/kimi-k3-fast": {
     "context_window": 1040384,
     "max_output": 1040384
    },
    "fireworks/deepseek-v4-pro": {
     "context_window": 1048576,
     "max_output": 393216
    },
    "fireworks/glm-5.3": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "fireworks/deepseek-v4-flash": {
     "context_window": 1048576,
     "max_output": 393216
    },
    "sakana/fugu-max": {
     "context_window": 1000000,
     "max_output": 1000000
    },
    "sakana/fugu-ultra-v2.0": {
     "context_window": 1000000,
     "max_output": 1000000
    },
    "sakana/fugu-ultra": {
     "context_window": 1000000,
     "max_output": 1000000
    },
    "scx-ai/gemma-4-31b-it": {
     "context_window": 131072,
     "max_output": 8192
    },
    "scx-ai/llama-4-maverick-17b-instruct": {
     "context_window": 131072,
     "max_output": 8192
    },
    "scx-ai/qwen3-32b": {
     "context_window": 32768,
     "max_output": 8192
    },
    "scx-ai/minimax-m2.7": {
     "context_window": 196608,
     "max_output": 196608
    },
    "scx-ai/gpt-oss-120b": {
     "context_window": 131072,
     "max_output": 32768
    },
    "together-ai/qwen3.8-2.4t-a95b": {
     "context_window": 1010000,
     "max_output": 909000
    },
    "together-ai/glm-5.3-flash": {
     "context_window": 1048576,
     "max_output": 943717
    },
    "together-ai/muse-glimmer-30b": {
     "context_window": 131072,
     "max_output": 117964
    },
    "together-ai/kimi-k3": {
     "context_window": 1000000,
     "max_output": 1000000
    },
    "together-ai/deepseek-v4.1-flash": {
     "context_window": 1048576,
     "max_output": 393216
    },
    "together-ai/glm-4.7": {
     "context_window": 202752,
     "max_output": 128000
    },
    "together-ai/minimax-m3": {
     "context_window": 524288,
     "max_output": 131072
    },
    "together-ai/deepseek-v4-pro": {
     "context_window": 1048576,
     "max_output": 163840
    },
    "together-ai/gpt-oss-120b": {
     "context_window": 131072,
     "max_output": 32768
    },
    "together-ai/glm-5.3": {
     "context_window": 1048576,
     "max_output": 943717
    },
    "together-ai/deepseek-v4-flash": {
     "context_window": 163840,
     "max_output": 163840
    },
    "xiaomi/mimo-v2.6-pro": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "xiaomi/mimo-v2.5": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "xiaomi/mimo-v2.5-pro": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "xiaomi/mimo-v2.6-flash": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "quartz/gemini-3.1-pro-preview": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "minimax/minimax-m2.5": {
     "context_window": 204800,
     "max_output": 131100
    },
    "minimax/minimax-m2.1-lightning": {
     "context_window": 196608,
     "max_output": 131072
    },
    "minimax/minimax-text-01": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "minimax/minimax-m2.7": {
     "context_window": 204800,
     "max_output": 131100
    },
    "minimax/minimax-m3": {
     "context_window": 512000,
     "max_output": 131072
    },
    "minimax/minimax-m2.7-highspeed": {
     "context_window": 204800,
     "max_output": 131100
    },
    "minimax/minimax-m2.5-highspeed": {
     "context_window": 204800,
     "max_output": 131100
    },
    "minimax/minimax-m2.1": {
     "context_window": 196608,
     "max_output": 131072
    },
    "minimax/minimax-m2": {
     "context_window": 196608,
     "max_output": 131072
    },
    "inference.net/glm-5.3-flash": {
     "context_window": 1048576,
     "max_output": 128000
    },
    "inference.net/llama-3.2-11b-instruct": {
     "context_window": 128000,
     "max_output": 128000
    },
    "inference.net/glm-5.3": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "azure-anthropic/claude-opus-5-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "azure-anthropic/claude-fable-5-1": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "azure-anthropic/claude-opus-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "azure-anthropic/claude-fable-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "azure-anthropic/claude-opus-4-8": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "azure-anthropic/claude-sonnet-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "azure-anthropic/claude-opus-4-6": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "azure-anthropic/claude-sonnet-5-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "azure-anthropic/claude-opus-4-7": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "atria/atria-dawn-preview": {
     "context_window": 262144,
     "max_output": 65536
    },
    "mistral/mistral-large-latest": {
     "context_window": 128000,
     "max_output": 262144
    },
    "mistral/ministral-8b-2512": {
     "context_window": 262144,
     "max_output": 262144
    },
    "mistral/devstral-2512": {
     "context_window": 262144,
     "max_output": 262144
    },
    "mistral/mistral-medium-3-5": {
     "context_window": 262144,
     "max_output": 262144
    },
    "mistral/mistral-small-2603": {
     "context_window": 262144,
     "max_output": 256000
    },
    "mistral/mistral-large-2512": {
     "context_window": 262144,
     "max_output": 262144
    },
    "mistral/ministral-14b-2512": {
     "context_window": 262144,
     "max_output": 262144
    },
    "mistral/mistral-small-2506": {
     "context_window": 128000,
     "max_output": 16384
    },
    "mistral/ministral-3b-2512": {
     "context_window": 131072,
     "max_output": 131072
    },
    "mistral/glm-5.3": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "mistral/codestral-2508": {
     "context_window": 256000,
     "max_output": 256000
    },
    "vertex-anthropic/claude-haiku-4-5": {
     "context_window": 200000,
     "max_output": 64000
    },
    "vertex-anthropic/claude-sonnet-4-5": {
     "context_window": 200000,
     "max_output": 64000
    },
    "vertex-anthropic/claude-opus-4-5-20251101": {
     "context_window": 200000,
     "max_output": 32000
    },
    "vertex-anthropic/claude-sonnet-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "vertex-anthropic/claude-opus-4-6": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "vertex-anthropic/claude-sonnet-4-6": {
     "context_window": 1000000,
     "max_output": 64000
    },
    "vertex-anthropic/claude-opus-4-7": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "vertex-openai/qwen3-235b-a22b-instruct-2507": {
     "context_window": 262144,
     "max_output": 32768
    },
    "vertex-openai/qwen3-next-80b-a3b-thinking": {
     "context_window": 131072,
     "max_output": 32768
    },
    "vertex-openai/glm-5": {
     "context_window": 202752,
     "max_output": 32768
    },
    "vertex-openai/qwen3-coder-480b-a35b-instruct": {
     "context_window": 262144,
     "max_output": 65536
    },
    "vertex-openai/kimi-k2-thinking": {
     "context_window": 262144,
     "max_output": 32768
    },
    "vertex-openai/qwen3-next-80b-a3b-instruct": {
     "context_window": 131072,
     "max_output": 32768
    },
    "vertex-openai/glm-4.7": {
     "context_window": 202752,
     "max_output": 128000
    },
    "vertex-openai/grok-4-20-non-reasoning": {
     "context_window": 2000000,
     "max_output": 30000
    },
    "vertex-openai/grok-4-6": {
     "context_window": 500000,
     "max_output": 500000
    },
    "vertex-openai/grok-4-20-reasoning": {
     "context_window": 2000000,
     "max_output": 30000
    },
    "vertex-openai/deepseek-v3.2": {
     "context_window": 163840,
     "max_output": 65536
    },
    "google-vertex/gemini-3.6-flash": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google-vertex/gemini-3.5-flash-lite": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google-vertex/gemini-3.1-pro-preview": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google-vertex/gemini-3.5-flash": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google-vertex/gemini-2.5-pro": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google-vertex/gemini-2.5-flash": {
     "context_window": 1048576,
     "max_output": 65535
    },
    "google-vertex/gemini-3.7-flash": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google-vertex/gemini-3-flash-preview": {
     "context_window": 1048576,
     "max_output": 65535
    },
    "google-vertex/gemini-3.8-flash": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google-vertex/gemini-2.5-flash-lite": {
     "context_window": 1048576,
     "max_output": 65535
    },
    "google-vertex/gemini-3.1-flash-lite": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "aws-mantle/gpt-6-astra": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "aws-mantle/gpt-5.6-luna": {
     "context_window": 921600,
     "max_output": 128000
    },
    "aws-mantle/gpt-5.6-terra": {
     "context_window": 921600,
     "max_output": 128000
    },
    "aws-mantle/gpt-5.6-sol": {
     "context_window": 921600,
     "max_output": 128000
    },
    "openai/gpt-5.4": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-5.4-pro": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-3.5-turbo": {
     "context_window": 16385,
     "max_output": 4096
    },
    "openai/gpt-4o-transcribe": {
     "context_window": 16000,
     "max_output": 2000
    },
    "openai/gpt-5.5-pro": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-5.4-nano": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-4o": {
     "context_window": 128000,
     "max_output": 16384
    },
    "openai/gpt-5-mini": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-5.2-pro": {
     "context_window": 400000,
     "max_output": 272000
    },
    "openai/o4-mini": {
     "context_window": 200000,
     "max_output": 100000
    },
    "openai/o3-mini": {
     "context_window": 200000,
     "max_output": 100000
    },
    "openai/gpt-4": {
     "context_window": 8192,
     "max_output": 8192
    },
    "openai/gpt-5.3-codex": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-4.1-nano": {
     "context_window": 1000000,
     "max_output": 32768
    },
    "openai/gpt-5-nano": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/o1": {
     "context_window": 200000,
     "max_output": 100000
    },
    "openai/gpt-5-pro": {
     "context_window": 400000,
     "max_output": 272000
    },
    "openai/gpt-6.1-sol": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-6-astra": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-5.1": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-4o-mini": {
     "context_window": 128000,
     "max_output": 16384
    },
    "openai/gpt-5.4-mini": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-5.6-luna": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-5.2": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-5.5": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-4.1": {
     "context_window": 1000000,
     "max_output": 32768
    },
    "openai/gpt-4.1-mini": {
     "context_window": 1000000,
     "max_output": 32768
    },
    "openai/gpt-6-luna": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-4o-mini-transcribe": {
     "context_window": 16000,
     "max_output": 2000
    },
    "openai/gpt-5.6-terra": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-4-turbo": {
     "context_window": 128000,
     "max_output": 4096
    },
    "openai/o3": {
     "context_window": 200000,
     "max_output": 100000
    },
    "openai/gpt-5": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-5.6-sol": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-6-sol": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "moonshot/kimi-k3": {
     "context_window": 1048576,
     "max_output": 1048576
    },
    "moonshot/kimi-k2.7-code-highspeed": {
     "context_window": 262144,
     "max_output": 262144
    },
    "moonshot/kimi-k2.6": {
     "context_window": 262144,
     "max_output": 262144
    },
    "moonshot/kimi-k2.5": {
     "context_window": 262144,
     "max_output": 32768
    },
    "moonshot/kimi-k2.7-code": {
     "context_window": 262144,
     "max_output": 262144
    }
   }
  },
  "above": {
   "api": "https://api.above.dev/v1",
   "models": {
    "mimo-v2.6-pro": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "glm-5.3-flash": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "glm-5.2-fast": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "qwen3.8-max": {
     "context_window": 1000000,
     "max_output": 32768
    },
    "deepseek-v4.1-flash": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "mimo-v2.6-pro-ultraspeed": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "mimo-v2.6-flash": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "glm-5.2": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "deepseek-v4-pro": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "deepseek-v4-flash": {
     "context_window": 1000000,
     "max_output": 384000
    }
   }
  },
  "kilo": {
   "api": "https://api.kilo.ai/api/gateway",
   "models": {
    "sao10k/l3-lunaris-8b": {
     "context_window": 8192,
     "max_output": 7372
    },
    "sao10k/l3.3-euryale-70b": {
     "context_window": 131072,
     "max_output": 16384
    },
    "sao10k/l3.1-euryale-70b": {
     "context_window": 131072,
     "max_output": 16384
    },
    "kwaipilot/kat-coder-pro-v2.5": {
     "context_window": 262144,
     "max_output": 235929
    },
    "stealth/claude-opus-4.6": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "stealth/claude-opus-4.7": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "stealth/claude-opus-4.8": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "stealth/space-bunny-alpha": {
     "context_window": 1000000,
     "max_output": 524288
    },
    "stealth/claude-sonnet-4.6": {
     "context_window": 1000000,
     "max_output": 64000
    },
    "stealth/qwen3.6-plus": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "bytedance-seed/seed-1.6-flash": {
     "context_window": 262144,
     "max_output": 32768
    },
    "bytedance-seed/seed-2.0-lite": {
     "context_window": 262144,
     "max_output": 131072
    },
    "bytedance-seed/seed-2-1-turbo": {
     "context_window": 262144,
     "max_output": 235929
    },
    "bytedance-seed/seed-2.0-mini": {
     "context_window": 262144,
     "max_output": 131072
    },
    "bytedance-seed/seed-2.0-code": {
     "context_window": 262144,
     "max_output": 131072
    },
    "bytedance-seed/seed-1.6": {
     "context_window": 262144,
     "max_output": 32768
    },
    "~moonshotai/kimi-latest": {
     "context_window": 1048576,
     "max_output": 943718
    },
    "poolside/laguna-s-2.1:free": {
     "context_window": 262144,
     "max_output": 32768
    },
    "poolside/laguna-s-2.1": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "poolside/laguna-xs-2.1:free": {
     "context_window": 262144,
     "max_output": 32768
    },
    "poolside/laguna-xs-2.1": {
     "context_window": 262144,
     "max_output": 32768
    },
    "prism-ml/ternary-bonsai-2-27b": {
     "context_window": 262144,
     "max_output": 32768
    },
    "anthropic/claude-opus-4.1": {
     "context_window": 200000,
     "max_output": 32000
    },
    "anthropic/claude-opus-4.5": {
     "context_window": 200000,
     "max_output": 64000
    },
    "anthropic/claude-opus-4.6": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-opus-4.7": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-opus-4.8": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-haiku-4.5": {
     "context_window": 200000,
     "max_output": 64000
    },
    "anthropic/claude-opus-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-sonnet-5.5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-fable-5.1": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-sonnet-4.5": {
     "context_window": 1000000,
     "max_output": 64000
    },
    "anthropic/claude-fable-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-sonnet-4": {
     "context_window": 200000,
     "max_output": 64000
    },
    "anthropic/claude-sonnet-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-sonnet-4.6": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-opus-5.5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "nex-agi/nex-n2.5-mini": {
     "context_window": 262144,
     "max_output": 235929
    },
    "nex-agi/nex-n2.5-pro": {
     "context_window": 262144,
     "max_output": 235929
    },
    "cohere/command-r-08-2024": {
     "context_window": 128000,
     "max_output": 4000
    },
    "cohere/command-a-plus": {
     "context_window": 192000,
     "max_output": 64000
    },
    "cohere/command-a": {
     "context_window": 256000,
     "max_output": 8192
    },
    "cohere/north-mini-code:free": {
     "context_window": 256000,
     "max_output": 64000
    },
    "cohere/command-r7b-12-2024": {
     "context_window": 128000,
     "max_output": 4000
    },
    "cohere/command-r-plus-08-2024": {
     "context_window": 128000,
     "max_output": 4000
    },
    "deepseek/deepseek-chat-v3.1": {
     "context_window": 163840,
     "max_output": 32768
    },
    "deepseek/deepseek-v4-flash-0731": {
     "context_window": 1048576,
     "max_output": 943718
    },
    "deepseek/deepseek-v4.1-flash": {
     "context_window": 1048576,
     "max_output": 943718
    },
    "deepseek/deepseek-v4-flash-vision-exp": {
     "context_window": 1048576,
     "max_output": 262144
    },
    "deepseek/deepseek-v3.1-terminus": {
     "context_window": 163840,
     "max_output": 147456
    },
    "deepseek/deepseek-chat": {
     "context_window": 128000,
     "max_output": 16000
    },
    "deepseek/deepseek-v4-pro-0813": {
     "context_window": 1048576,
     "max_output": 943718
    },
    "deepseek/deepseek-v3.2-exp": {
     "context_window": 163840,
     "max_output": 147456
    },
    "deepseek/deepseek-chat-v3-0324": {
     "context_window": 128000,
     "max_output": 115200
    },
    "deepseek/deepseek-r1": {
     "context_window": 64000,
     "max_output": 16000
    },
    "deepseek/deepseek-v4-pro": {
     "context_window": 1024000,
     "max_output": 384000
    },
    "deepseek/deepseek-r1-0528": {
     "context_window": 163840,
     "max_output": 32768
    },
    "deepseek/deepseek-v3.2": {
     "context_window": 131072,
     "max_output": 65536
    },
    "deepseek/deepseek-v4-flash": {
     "context_window": 1048576,
     "max_output": 943718
    },
    "unbiased/pareto-26.10-preview": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "unbiased/pareto": {
     "context_window": 262144,
     "max_output": 131072
    },
    "tencent/hy3-preview": {
     "context_window": 262144,
     "max_output": 235929
    },
    "tencent/hunyuan-a13b-instruct": {
     "context_window": 131072,
     "max_output": 117964
    },
    "tencent/hy-mt2-30b-a3b": {
     "context_window": 8192,
     "max_output": 4096
    },
    "tencent/hy-mt2-1.8b": {
     "context_window": 8192,
     "max_output": 4096
    },
    "tencent/hy3": {
     "context_window": 262144,
     "max_output": 128000
    },
    "tencent/hy-mt2-7b": {
     "context_window": 8192,
     "max_output": 4096
    },
    "tencent/hy4-preview": {
     "context_window": 1048576,
     "max_output": 64000
    },
    "anthracite-org/magnum-v4-72b": {
     "context_window": 32768,
     "max_output": 4096
    },
    "meta-llama/llama-4-scout": {
     "context_window": 327680,
     "max_output": 16384
    },
    "meta-llama/llama-guard-4-12b": {
     "context_window": 163840,
     "max_output": 16384
    },
    "meta-llama/llama-4-maverick": {
     "context_window": 128000,
     "max_output": 16384
    },
    "meta-llama/llama-3.3-70b-instruct": {
     "context_window": 131072,
     "max_output": 16384
    },
    "meta-llama/llama-3.1-8b-instruct": {
     "context_window": 131072,
     "max_output": 117964
    },
    "meta-llama/llama-3.2-1b-instruct": {
     "context_window": 60000,
     "max_output": 54000
    },
    "meta-llama/llama-3.2-3b-instruct": {
     "context_window": 131072,
     "max_output": 117964
    },
    "meta-llama/llama-3.1-70b-instruct": {
     "context_window": 131072,
     "max_output": 16384
    },
    "~google/gemini-flash-latest": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "~google/gemini-pro-latest": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "perceptron/perceptron-mk1": {
     "context_window": 32768,
     "max_output": 8192
    },
    "perceptron/perceptron-mk1.5": {
     "context_window": 36864,
     "max_output": 8192
    },
    "z-ai/glm-4.6v": {
     "context_window": 131072,
     "max_output": 32768
    },
    "z-ai/glm-4.5": {
     "context_window": 131072,
     "max_output": 98304
    },
    "z-ai/glm-5.3-prime": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "z-ai/glm-5v-turbo": {
     "context_window": 202752,
     "max_output": 131072
    },
    "z-ai/glm-5.3-flash": {
     "context_window": 1048575,
     "max_output": 943717
    },
    "z-ai/glm-4.6": {
     "context_window": 198000,
     "max_output": 16384
    },
    "z-ai/glm-5": {
     "context_window": 198000,
     "max_output": 128000
    },
    "z-ai/glm-4.5v": {
     "context_window": 65536,
     "max_output": 16384
    },
    "z-ai/glm-5.3-flashx": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "z-ai/glm-4.7-flash": {
     "context_window": 131072,
     "max_output": 117964
    },
    "z-ai/glm-4.7": {
     "context_window": 202752,
     "max_output": 131072
    },
    "z-ai/glm-5.2": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "z-ai/glm-5.1": {
     "context_window": 202752,
     "max_output": 131072
    },
    "z-ai/glm-5-turbo": {
     "context_window": 202752,
     "max_output": 131072
    },
    "z-ai/glm-4.5-air": {
     "context_window": 131072,
     "max_output": 98304
    },
    "z-ai/glm-5.3": {
     "context_window": 1048576,
     "max_output": 943718
    },
    "inference-net/schematron-v2-small": {
     "context_window": 128000,
     "max_output": 4096
    },
    "inference-net/schematron-v2-turbo": {
     "context_window": 128000,
     "max_output": 8192
    },
    "thinkingmachines/inkling-small:free": {
     "context_window": 1048576,
     "max_output": 262144
    },
    "thinkingmachines/inkling-small": {
     "context_window": 524288,
     "max_output": 262144
    },
    "thinkingmachines/inkling": {
     "context_window": 524288,
     "max_output": 262144
    },
    "meituan/longcat-2.0": {
     "context_window": 1048756,
     "max_output": 262144
    },
    "openrouter/bodybuilder": {
     "context_window": 128000,
     "max_output": 32768
    },
    "openrouter/free": {
     "context_window": 200000,
     "max_output": 32768
    },
    "openrouter/pareto-code": {
     "context_window": 200000,
     "max_output": 65536
    },
    "openrouter/auto": {
     "context_window": 2000000,
     "max_output": 32768
    },
    "perplexity/sonar-pro": {
     "context_window": 200000,
     "max_output": 8000
    },
    "perplexity/sonar-deep-research": {
     "context_window": 128000,
     "max_output": 115200
    },
    "perplexity/sonar": {
     "context_window": 127072,
     "max_output": 114364
    },
    "perplexity/sonar-reasoning-pro": {
     "context_window": 128000,
     "max_output": 115200
    },
    "perplexity/sonar-pro-search": {
     "context_window": 200000,
     "max_output": 8000
    },
    "meta/muse-spark-1.3": {
     "context_window": 1048576,
     "max_output": 943718
    },
    "meta/muse-glimmer-30b": {
     "context_window": 131072,
     "max_output": 117964
    },
    "meta/muse-spark-1.1": {
     "context_window": 1048576,
     "max_output": 943718
    },
    "meta/muse-spark-1.2": {
     "context_window": 1048576,
     "max_output": 943718
    },
    "meta/muse-spark-1.2-contributor": {
     "context_window": 1048576,
     "max_output": 943718
    },
    "meta/muse-spark-1.3-contributor": {
     "context_window": 1048576,
     "max_output": 943718
    },
    "nousresearch/hermes-3-llama-3.1-70b": {
     "context_window": 131072,
     "max_output": 16384
    },
    "nousresearch/hermes-3-llama-3.1-405b": {
     "context_window": 131072,
     "max_output": 16384
    },
    "nousresearch/hermes-4-405b": {
     "context_window": 131072,
     "max_output": 117964
    },
    "~z-ai/glm-flash-latest": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "~z-ai/glm-latest": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "arcee-ai/trinity-large-thinking": {
     "context_window": 262144,
     "max_output": 80000
    },
    "~openai/gpt-terra-latest": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "~openai/gpt-luna-latest": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "~openai/gpt-sol-latest": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "~openai/gpt-astra-latest": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "~openai/gpt-mini-latest": {
     "context_window": 400000,
     "max_output": 128000
    },
    "cognitivecomputations/dolphin-mistral-24b-venice-edition": {
     "context_window": 128000,
     "max_output": 8192
    },
    "thedrummer/skyfall-36b-v2": {
     "context_window": 32768,
     "max_output": 29491
    },
    "thedrummer/unslopnemo-12b": {
     "context_window": 1024000,
     "max_output": 819200
    },
    "thedrummer/cydonia-24b-v4.1": {
     "context_window": 131072,
     "max_output": 117964
    },
    "baidu/ernie-4.5-vl-424b-a47b": {
     "context_window": 123000,
     "max_output": 16000
    },
    "x-ai/grok-4.20-multi-agent": {
     "context_window": 2000000,
     "max_output": 1800000
    },
    "x-ai/grok-4.7": {
     "context_window": 500000,
     "max_output": 450000
    },
    "x-ai/grok-4.3": {
     "context_window": 1000000,
     "max_output": 900000
    },
    "x-ai/grok-4.5": {
     "context_window": 500000,
     "max_output": 450000
    },
    "x-ai/grok-build-0.1": {
     "context_window": 256000,
     "max_output": 230400
    },
    "x-ai/grok-4.20": {
     "context_window": 2000000,
     "max_output": 1800000
    },
    "x-ai/grok-4.6": {
     "context_window": 500000,
     "max_output": 450000
    },
    "~anthropic/claude-opus-latest": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "~anthropic/claude-haiku-latest": {
     "context_window": 200000,
     "max_output": 64000
    },
    "~anthropic/claude-sonnet-latest": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "~anthropic/claude-fable-latest": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "upstage/solar-pro-3": {
     "context_window": 131072,
     "max_output": 117964
    },
    "upstage/solar-pro4": {
     "context_window": 524288,
     "max_output": 131072
    },
    "upstage/solar-mini4": {
     "context_window": 524288,
     "max_output": 131072
    },
    "~deepseek/deepseek-flash-latest": {
     "context_window": 1048576,
     "max_output": 943718
    },
    "~deepseek/deepseek-pro-latest": {
     "context_window": 1048576,
     "max_output": 393216
    },
    "~deepseek/deepseek-v4-flash-latest": {
     "context_window": 1048576,
     "max_output": 943718
    },
    "~x-ai/grok-latest": {
     "context_window": 500000,
     "max_output": 450000
    },
    "bytedance/ui-tars-1.5-7b": {
     "context_window": 128000,
     "max_output": 2048
    },
    "liquid/lfm-2.5-2.6b:free": {
     "context_window": 65536,
     "max_output": 8192
    },
    "google/gemma-4-31b-it": {
     "context_window": 262144,
     "max_output": 16384
    },
    "google/gemini-3.1-flash-image-preview": {
     "context_window": 65536,
     "max_output": 58982
    },
    "google/lyria-3-pro-preview": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemma-3-27b-it": {
     "context_window": 131072,
     "max_output": 117964
    },
    "google/gemini-2.5-flash-image": {
     "context_window": 32768,
     "max_output": 8192
    },
    "google/gemma-2-27b-it": {
     "context_window": 8192,
     "max_output": 2048
    },
    "google/gemini-3.6-flash": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemma-4-26b-a4b-it": {
     "context_window": 262144,
     "max_output": 235929
    },
    "google/gemini-3-pro-image-preview": {
     "context_window": 65536,
     "max_output": 32768
    },
    "google/gemini-3.5-flash-lite": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemini-3.1-flash-image": {
     "context_window": 131072,
     "max_output": 32768
    },
    "google/lyria-3-clip-preview": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemini-3.1-pro-preview": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemma-3-12b-it": {
     "context_window": 131072,
     "max_output": 16384
    },
    "google/gemini-3.5-flash": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemini-2.5-pro": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemini-3-pro-image": {
     "context_window": 65536,
     "max_output": 32768
    },
    "google/gemini-2.5-flash": {
     "context_window": 1048576,
     "max_output": 65535
    },
    "google/gemini-3.1-flash-lite-image": {
     "context_window": 65536,
     "max_output": 58982
    },
    "google/gemini-3.7-flash": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemini-3.1-pro-preview-customtools": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemini-3-flash-preview": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemini-3.8-flash": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemma-3-4b-it": {
     "context_window": 131072,
     "max_output": 16384
    },
    "google/gemini-2.5-flash-lite": {
     "context_window": 1048576,
     "max_output": 65535
    },
    "google/gemini-2.5-pro-preview": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemini-3.1-flash-lite-preview": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemini-3.1-flash-lite": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "writer/palmyra-x5": {
     "context_window": 1040000,
     "max_output": 8192
    },
    "ibm-granite/granite-4.0-h-micro": {
     "context_window": 131000,
     "max_output": 117900
    },
    "ibm-granite/granite-4.2-8b": {
     "context_window": 131072,
     "max_output": 117964
    },
    "fireworks/ember-1": {
     "context_window": 1048576,
     "max_output": 943718
    },
    "mistralai/mistral-nemo": {
     "context_window": 131072,
     "max_output": 16384
    },
    "mistralai/ministral-8b-2512": {
     "context_window": 262144,
     "max_output": 209715
    },
    "mistralai/mistral-small-24b-instruct-2501": {
     "context_window": 32768,
     "max_output": 16384
    },
    "mistralai/devstral-2512": {
     "context_window": 262144,
     "max_output": 209715
    },
    "mistralai/mistral-saba": {
     "context_window": 32768,
     "max_output": 26214
    },
    "mistralai/mistral-medium-3-5": {
     "context_window": 262144,
     "max_output": 209715
    },
    "mistralai/mistral-medium-3.1": {
     "context_window": 131072,
     "max_output": 104857
    },
    "mistralai/mistral-small-3.2-24b-instruct": {
     "context_window": 256000,
     "max_output": 16384
    },
    "mistralai/mistral-large": {
     "context_window": 128000,
     "max_output": 102400
    },
    "mistralai/mistral-small-2603": {
     "context_window": 262144,
     "max_output": 209715
    },
    "mistralai/mistral-medium-3": {
     "context_window": 131072,
     "max_output": 104857
    },
    "mistralai/voxtral-small-24b-2507": {
     "context_window": 32768,
     "max_output": 26214
    },
    "mistralai/mistral-large-2512": {
     "context_window": 262144,
     "max_output": 209715
    },
    "mistralai/mistral-large-2407": {
     "context_window": 131072,
     "max_output": 104857
    },
    "mistralai/ministral-14b-2512": {
     "context_window": 262144,
     "max_output": 209715
    },
    "mistralai/mistral-small-3.1-24b-instruct": {
     "context_window": 128000,
     "max_output": 102400
    },
    "mistralai/ministral-3b-2512": {
     "context_window": 131072,
     "max_output": 104857
    },
    "mistralai/mixtral-8x22b-instruct": {
     "context_window": 65536,
     "max_output": 52428
    },
    "mistralai/codestral-2508": {
     "context_window": 256000,
     "max_output": 204800
    },
    "sakana/fugu-max": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "sakana/fugu-ultra-v2": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "sakana/fugu-ultra": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "sakana/sakana-namazu": {
     "context_window": 262144,
     "max_output": 65536
    },
    "inclusionai/ling-3.0-flash-sante:free": {
     "context_window": 262144,
     "max_output": 32768
    },
    "inclusionai/ling-3.0-flash": {
     "context_window": 262144,
     "max_output": 32768
    },
    "inclusionai/ling-3.1-flash": {
     "context_window": 262144,
     "max_output": 32768
    },
    "inclusionai/ling-3.0-flash-vl": {
     "context_window": 262144,
     "max_output": 32768
    },
    "inclusionai/ling-3.0-flash-fin": {
     "context_window": 262144,
     "max_output": 32768
    },
    "moonshotai/kimi-k3": {
     "context_window": 1048576,
     "max_output": 943718
    },
    "moonshotai/kimi-k2.6": {
     "context_window": 262144,
     "max_output": 235929
    },
    "moonshotai/kimi-k2-thinking": {
     "context_window": 262144,
     "max_output": 235929
    },
    "moonshotai/kimi-k2.5": {
     "context_window": 262144,
     "max_output": 235929
    },
    "moonshotai/kimi-k2-0905": {
     "context_window": 262144,
     "max_output": 98304
    },
    "moonshotai/kimi-k2": {
     "context_window": 131072,
     "max_output": 98304
    },
    "moonshotai/kimi-k2.7-code": {
     "context_window": 262144,
     "max_output": 235929
    },
    "kilo-auto/small": {
     "context_window": 262144,
     "max_output": 32768
    },
    "kilo-auto/efficient": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "kilo-auto/free": {
     "context_window": 256000,
     "max_output": 32768
    },
    "kilo-auto/frontier": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "kilo-auto/balanced": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "rekaai/reka-flash-3": {
     "context_window": 65536,
     "max_output": 58982
    },
    "rekaai/reka-edge": {
     "context_window": 16384,
     "max_output": 14745
    },
    "apodex/apodex-1.1-mini:free": {
     "context_window": 262144,
     "max_output": 235929
    },
    "nvidia/nemotron-3-nano-30b-a3b": {
     "context_window": 262144,
     "max_output": 235929
    },
    "nvidia/nemotron-3.5-content-safety:free": {
     "context_window": 128000,
     "max_output": 8192
    },
    "nvidia/nemotron-3.5-lightning": {
     "context_window": 262144,
     "max_output": 32768
    },
    "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free": {
     "context_window": 256000,
     "max_output": 65536
    },
    "nvidia/nemotron-3-super-120b-a12b": {
     "context_window": 262144,
     "max_output": 235929
    },
    "nvidia/nemotron-3-ultra-550b-a55b:free": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "nvidia/nemotron-3-ultra-550b-a55b": {
     "context_window": 262144,
     "max_output": 16384
    },
    "nvidia/nemotron-3-super-120b-a12b:free": {
     "context_window": 262144,
     "max_output": 235929
    },
    "nvidia/nemotron-3.5-content-safety": {
     "context_window": 131072,
     "max_output": 117964
    },
    "nvidia/nemotron-3.5-lightning:free": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "xiaomi/mimo-v2.6-pro": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "xiaomi/mimo-v2.5": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "xiaomi/mimo-v2.6-pro-ultraspeed": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "xiaomi/mimo-v2.5-pro": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "xiaomi/mimo-v2.6-flash": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "undi95/remm-slerp-l2-13b": {
     "context_window": 6144,
     "max_output": 5529
    },
    "gryphe/mythomax-l2-13b": {
     "context_window": 4096,
     "max_output": 3686
    },
    "minimax/minimax-m2.5": {
     "context_window": 200000,
     "max_output": 128000
    },
    "minimax/minimax-01": {
     "context_window": 1000192,
     "max_output": 900172
    },
    "minimax/minimax-m2-her": {
     "context_window": 65536,
     "max_output": 2048
    },
    "minimax/minimax-m2.7": {
     "context_window": 196608,
     "max_output": 176947
    },
    "minimax/minimax-m1": {
     "context_window": 1000000,
     "max_output": 40000
    },
    "minimax/minimax-m3": {
     "context_window": 524288,
     "max_output": 512000
    },
    "minimax/minimax-m2.1": {
     "context_window": 204800,
     "max_output": 131072
    },
    "minimax/minimax-m2": {
     "context_window": 196608,
     "max_output": 176947
    },
    "mancer/weaver": {
     "context_window": 8000,
     "max_output": 6000
    },
    "stepfun/step-3.7-flash:free": {
     "context_window": 262144,
     "max_output": 262144
    },
    "stepfun/step-3.5-flash": {
     "context_window": 262144,
     "max_output": 65536
    },
    "stepfun/step-3.7-flash": {
     "context_window": 256000,
     "max_output": 230400
    },
    "dots-studio/dots-3-note-preview:free": {
     "context_window": 512000,
     "max_output": 460800
    },
    "inception/mercury-2.5": {
     "context_window": 260000,
     "max_output": 65536
    },
    "inception/mercury-2": {
     "context_window": 128000,
     "max_output": 50000
    },
    "amazon/nova-lite-v1": {
     "context_window": 300000,
     "max_output": 5120
    },
    "amazon/nova-2-lite-v1": {
     "context_window": 1000000,
     "max_output": 65535
    },
    "amazon/nova-pro-v1": {
     "context_window": 300000,
     "max_output": 5120
    },
    "amazon/nova-premier-v1": {
     "context_window": 1000000,
     "max_output": 32000
    },
    "amazon/nova-micro-v1": {
     "context_window": 128000,
     "max_output": 5120
    },
    "relace/relace-search": {
     "context_window": 256000,
     "max_output": 128000
    },
    "relace/relace-apply-3": {
     "context_window": 256000,
     "max_output": 128000
    },
    "aion-labs/aion-2.0": {
     "context_window": 131072,
     "max_output": 32768
    },
    "aion-labs/aion-rp-llama-3.1-8b": {
     "context_window": 32768,
     "max_output": 29491
    },
    "aion-labs/aion-3.0": {
     "context_window": 131072,
     "max_output": 32768
    },
    "aion-labs/aion-3.5": {
     "context_window": 262144,
     "max_output": 32768
    },
    "aion-labs/aion-3.5-mini": {
     "context_window": 262144,
     "max_output": 32768
    },
    "aion-labs/aion-3.0-mini": {
     "context_window": 131072,
     "max_output": 32768
    },
    "qwen/qwen3-235b-a22b-2507": {
     "context_window": 262144,
     "max_output": 235929
    },
    "qwen/qwen3-vl-235b-a22b-instruct": {
     "context_window": 131072,
     "max_output": 32768
    },
    "qwen/qwen3.7-max": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "qwen/qwen3.8-27b": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "qwen/qwen3-vl-235b-a22b-thinking": {
     "context_window": 131072,
     "max_output": 32768
    },
    "qwen/qwen3.8-2.4t-a95b": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "qwen/qwen3.5-27b": {
     "context_window": 262144,
     "max_output": 65536
    },
    "qwen/qwen3-next-80b-a3b-thinking": {
     "context_window": 131072,
     "max_output": 32768
    },
    "qwen/qwen3-coder-next": {
     "context_window": 262144,
     "max_output": 235929
    },
    "qwen/qwen3-coder": {
     "context_window": 262144,
     "max_output": 65536
    },
    "qwen/qwen3-32b": {
     "context_window": 40960,
     "max_output": 16384
    },
    "qwen/qwen-plus": {
     "context_window": 1000000,
     "max_output": 32768
    },
    "qwen/qwen3.7-flash": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "qwen/qwen3-max": {
     "context_window": 262144,
     "max_output": 65536
    },
    "qwen/qwen3-coder-30b-a3b-instruct": {
     "context_window": 262144,
     "max_output": 235929
    },
    "qwen/qwen3.8-omni-flash": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "qwen/qwen3-vl-30b-a3b-instruct": {
     "context_window": 262144,
     "max_output": 16384
    },
    "qwen/qwen3-235b-a22b-thinking-2507": {
     "context_window": 131072,
     "max_output": 117964
    },
    "qwen/qwen3-235b-a22b": {
     "context_window": 131072,
     "max_output": 8192
    },
    "qwen/qwen3.5-122b-a10b": {
     "context_window": 262144,
     "max_output": 65536
    },
    "qwen/qwen-plus-2025-07-28": {
     "context_window": 1000000,
     "max_output": 32768
    },
    "qwen/qwen3.6-35b-a3b": {
     "context_window": 262144,
     "max_output": 235929
    },
    "qwen/qwen3-next-80b-a3b-instruct": {
     "context_window": 262144,
     "max_output": 235929
    },
    "qwen/qwen3-vl-30b-a3b-thinking": {
     "context_window": 131072,
     "max_output": 32768
    },
    "qwen/qwen3.6-flash": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "qwen/qwen3-coder-flash": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "qwen/qwen-2.5-coder-32b-instruct": {
     "context_window": 32768,
     "max_output": 29491
    },
    "qwen/qwen3.5-flash-02-23": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "qwen/qwen3-max-thinking": {
     "context_window": 262144,
     "max_output": 65536
    },
    "qwen/qwen3-coder-plus": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "qwen/qwen3.5-9b": {
     "context_window": 256000,
     "max_output": 32768
    },
    "qwen/qwen3.8-max-prime": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "qwen/qwen3.5-plus-20260420": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "qwen/qwen3.8-flash": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "qwen/qwen3.5-35b-a3b": {
     "context_window": 262144,
     "max_output": 235929
    },
    "qwen/qwen3.6-max-preview": {
     "context_window": 262144,
     "max_output": 65536
    },
    "qwen/qwen3-30b-a3b": {
     "context_window": 40960,
     "max_output": 16384
    },
    "qwen/qwen3.5-397b-a17b": {
     "context_window": 262144,
     "max_output": 235929
    },
    "qwen/qwen3-8b": {
     "context_window": 131072,
     "max_output": 8192
    },
    "qwen/qwen3-vl-32b-instruct": {
     "context_window": 131072,
     "max_output": 32768
    },
    "qwen/qwen3-vl-8b-instruct": {
     "context_window": 131072,
     "max_output": 32768
    },
    "qwen/qwen3-30b-a3b-instruct-2507": {
     "context_window": 128000,
     "max_output": 32000
    },
    "qwen/qwen2.5-vl-72b-instruct": {
     "context_window": 128000,
     "max_output": 115200
    },
    "qwen/qwen-2.5-7b-instruct": {
     "context_window": 32768,
     "max_output": 29491
    },
    "qwen/qwen3.5-plus-02-15": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "qwen/qwen-2.5-72b-instruct": {
     "context_window": 32768,
     "max_output": 16384
    },
    "qwen/qwen3-30b-a3b-thinking-2507": {
     "context_window": 81920,
     "max_output": 32768
    },
    "qwen/qwen3.6-27b": {
     "context_window": 262144,
     "max_output": 262140
    },
    "qwen/qwen3.6-plus": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "qwen/qwen3-14b": {
     "context_window": 40960,
     "max_output": 16384
    },
    "qwen/qwen3-vl-8b-thinking": {
     "context_window": 131072,
     "max_output": 32768
    },
    "qwen/qwen3.7-plus": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "qwen/qwen3.8-27b:free": {
     "context_window": 262144,
     "max_output": 235929
    },
    "qwen/qwen3.8-max-0902": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "morph/morph-v3-large": {
     "context_window": 262144,
     "max_output": 131072
    },
    "morph/morph-v3-fast": {
     "context_window": 81920,
     "max_output": 38000
    },
    "openai/gpt-5.4": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-5.4-image-2": {
     "context_window": 272000,
     "max_output": 128000
    },
    "openai/gpt-5.4-pro": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-audio": {
     "context_window": 128000,
     "max_output": 16384
    },
    "openai/gpt-3.5-turbo": {
     "context_window": 16385,
     "max_output": 4096
    },
    "openai/gpt-6-astra-pro": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-5.5-pro": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-5.4-nano": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-4o-2024-05-13": {
     "context_window": 128000,
     "max_output": 4096
    },
    "openai/gpt-4o-mini-2024-07-18": {
     "context_window": 128000,
     "max_output": 16384
    },
    "openai/gpt-5.2-codex": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-5.1-codex": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-4o": {
     "context_window": 128000,
     "max_output": 16384
    },
    "openai/gpt-chat-latest": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-audio-mini": {
     "context_window": 128000,
     "max_output": 16384
    },
    "openai/gpt-5.6-sol-pro": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-5-mini": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-5.2-pro": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/o4-mini": {
     "context_window": 200000,
     "max_output": 100000
    },
    "openai/o3-mini": {
     "context_window": 200000,
     "max_output": 100000
    },
    "openai/gpt-4": {
     "context_window": 8191,
     "max_output": 4096
    },
    "openai/gpt-5.3-codex": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-4.1-nano": {
     "context_window": 1047576,
     "max_output": 32768
    },
    "openai/gpt-5-nano": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/o1": {
     "context_window": 200000,
     "max_output": 100000
    },
    "openai/gpt-5-pro": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-3.5-turbo-instruct": {
     "context_window": 4095,
     "max_output": 3685
    },
    "openai/gpt-6.1-sol": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-4o-2024-08-06": {
     "context_window": 128000,
     "max_output": 16384
    },
    "openai/gpt-6-astra": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-5.6-luna-pro": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-5.1": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-5-image-mini": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-4o-mini": {
     "context_window": 128000,
     "max_output": 16384
    },
    "openai/o3-pro": {
     "context_window": 200000,
     "max_output": 100000
    },
    "openai/gpt-oss-20b": {
     "context_window": 131072,
     "max_output": 32768
    },
    "openai/gpt-oss-safeguard-20b": {
     "context_window": 131072,
     "max_output": 65536
    },
    "openai/o3-mini-high": {
     "context_window": 200000,
     "max_output": 100000
    },
    "openai/gpt-3.5-turbo-16k": {
     "context_window": 16385,
     "max_output": 4096
    },
    "openai/gpt-5.2-chat": {
     "context_window": 128000,
     "max_output": 32000
    },
    "openai/gpt-6-sol-pro": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-5-image": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-5.4-mini": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-5.6-luna": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-5.1-codex-max": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-5.2": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-5.5": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-4.1": {
     "context_window": 1047576,
     "max_output": 32768
    },
    "openai/gpt-4o-2024-11-20": {
     "context_window": 128000,
     "max_output": 16384
    },
    "openai/gpt-3.5-turbo-0613": {
     "context_window": 4095,
     "max_output": 3685
    },
    "openai/gpt-4.1-mini": {
     "context_window": 1047576,
     "max_output": 32768
    },
    "openai/gpt-5.6-terra-pro": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-6-luna": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-6.1-sol-pro": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/o4-mini-high": {
     "context_window": 200000,
     "max_output": 100000
    },
    "openai/gpt-6-luna-pro": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-5.6-terra": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-4-turbo": {
     "context_window": 128000,
     "max_output": 4096
    },
    "openai/gpt-oss-120b": {
     "context_window": 131072,
     "max_output": 117964
    },
    "openai/gpt-5.1-codex-mini": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/o3": {
     "context_window": 200000,
     "max_output": 100000
    },
    "openai/gpt-5": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-5.6-sol": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-6-sol": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/o1-pro": {
     "context_window": 200000,
     "max_output": 100000
    },
    "microsoft/phi-4": {
     "context_window": 16384,
     "max_output": 14745
    },
    "microsoft/wizardlm-2-8x22b": {
     "context_window": 65535,
     "max_output": 8000
    }
   }
  },
  "venice": {
   "api": null,
   "models": {
    "qwen-3-8-2-4t-a95b": {
     "context_window": 262144,
     "max_output": 65536
    },
    "openai-gpt-56-luna": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "grok-4-5": {
     "context_window": 500000,
     "max_output": 32000
    },
    "aion-labs-aion-3-5": {
     "context_window": 262144,
     "max_output": 32768
    },
    "kimi-k3-fast-api": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "qwen3-6-27b": {
     "context_window": 256000,
     "max_output": 65536
    },
    "hermes-3-llama-3.1-405b": {
     "context_window": 128000,
     "max_output": 16384
    },
    "claude-opus-5-5-fast": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "kimi-k2-7-code": {
     "context_window": 256000,
     "max_output": 65536
    },
    "google-gemma-3-27b-it": {
     "context_window": 198000,
     "max_output": 16384
    },
    "qwen-3-7-max": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "qwen-3-8-max": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "deepseek-v4-flash-0731": {
     "context_window": 1000000,
     "max_output": 32768
    },
    "venice-uncensored-role-play": {
     "context_window": 128000,
     "max_output": 4096
    },
    "grok-build-0-1": {
     "context_window": 256000,
     "max_output": 65536
    },
    "qwen3-235b-a22b-instruct-2507": {
     "context_window": 128000,
     "max_output": 16384
    },
    "openai-gpt-6-luna": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "kimi-k3": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "openai-gpt-54-mini": {
     "context_window": 400000,
     "max_output": 128000
    },
    "qwen-3-8-flash": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "olafangensan-glm-4.7-flash-heretic": {
     "context_window": 200000,
     "max_output": 24000
    },
    "xiaomi-mimo-v2-6-flash": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "deepseek-v4-flash-0731-fast": {
     "context_window": 1000000,
     "max_output": 32768
    },
    "claude-opus-4-5": {
     "context_window": 198000,
     "max_output": 32768
    },
    "zai-org-glm-5-2": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "claude-opus-4-8-fast": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "z-ai-glm-5-turbo": {
     "context_window": 200000,
     "max_output": 32768
    },
    "zai-org-glm-4.6": {
     "context_window": 198000,
     "max_output": 16384
    },
    "openai-gpt-54-pro": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "aion-labs-aion-3-0": {
     "context_window": 128000,
     "max_output": 32768
    },
    "claude-sonnet-4-5": {
     "context_window": 198000,
     "max_output": 64000
    },
    "claude-opus-5-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "kimi-k2-5": {
     "context_window": 256000,
     "max_output": 65536
    },
    "claude-fable-5-1": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "gemini-3-7-flash": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "grok-4-20": {
     "context_window": 2000000,
     "max_output": 128000
    },
    "openai-gpt-56-sol-pro": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "seed-2-1-turbo": {
     "context_window": 256000,
     "max_output": 65536
    },
    "z-ai-glm-5v-turbo": {
     "context_window": 200000,
     "max_output": 32768
    },
    "openai-gpt-55-pro": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "qwen-3-7-plus": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "qwen3-235b-a22b-thinking-2507": {
     "context_window": 128000,
     "max_output": 16384
    },
    "openai-gpt-61-sol": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "zai-org-glm-4.7-flash": {
     "context_window": 128000,
     "max_output": 16384
    },
    "claude-opus-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "openai-gpt-6-astra": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "minimax-m27": {
     "context_window": 198000,
     "max_output": 32768
    },
    "mercury-2-5": {
     "context_window": 260000,
     "max_output": 65536
    },
    "qwen3-next-80b": {
     "context_window": 256000,
     "max_output": 16384
    },
    "minimax-m25": {
     "context_window": 198000,
     "max_output": 32768
    },
    "qwen3-6-35b-a3b": {
     "context_window": 256000,
     "max_output": 65536
    },
    "grok-4-20-multi-agent": {
     "context_window": 2000000,
     "max_output": 128000
    },
    "zai-org-glm-4.7": {
     "context_window": 198000,
     "max_output": 16384
    },
    "qwen3-5-9b": {
     "context_window": 256000,
     "max_output": 32768
    },
    "qwen3-vl-235b-a22b": {
     "context_window": 128000,
     "max_output": 16384
    },
    "claude-fable-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "qwen3-5-35b-a3b": {
     "context_window": 256000,
     "max_output": 16384
    },
    "deepseek-v4-pro-0813": {
     "context_window": 1000000,
     "max_output": 32768
    },
    "openai-gpt-56-terra": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "llama-3.3-70b": {
     "context_window": 128000,
     "max_output": 4096
    },
    "openai-gpt-4o-mini-2024-07-18": {
     "context_window": 128000,
     "max_output": 16384
    },
    "mistral-small-3-2-24b-instruct": {
     "context_window": 256000,
     "max_output": 16384
    },
    "inkling": {
     "context_window": 524288,
     "max_output": 65536
    },
    "z-ai-glm-5-3": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "google-gemma-4-26b-a4b-it": {
     "context_window": 256000,
     "max_output": 8192
    },
    "kimi-k2-6": {
     "context_window": 256000,
     "max_output": 65536
    },
    "openai-gpt-6-astra-pro": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai-gpt-54": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "gemma-4-uncensored": {
     "context_window": 256000,
     "max_output": 8192
    },
    "claude-opus-4-8": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "abliteration-abliterated-model-large-v2": {
     "context_window": 1000000,
     "max_output": 32768
    },
    "minimax-m3-preview": {
     "context_window": 524288,
     "max_output": 65536
    },
    "openai-gpt-oss-120b": {
     "context_window": 128000,
     "max_output": 16384
    },
    "claude-sonnet-5": {
     "context_window": 1000000,
     "max_output": 64000
    },
    "deepseek-v4-1-flash": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "gemini-3-8-flash": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "qwen-3-6-plus": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "claude-opus-4-6": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "openai-gpt-6-sol": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "qwen-3-8-27b": {
     "context_window": 262144,
     "max_output": 65536
    },
    "openai-gpt-53-codex": {
     "context_window": 400000,
     "max_output": 128000
    },
    "aion-labs-aion-3-0-mini": {
     "context_window": 128000,
     "max_output": 32768
    },
    "grok-4-3": {
     "context_window": 1000000,
     "max_output": 32000
    },
    "aion-labs-aion-3-5-mini": {
     "context_window": 262144,
     "max_output": 32768
    },
    "openai-gpt-56-terra-pro": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "gemini-3-flash-preview": {
     "context_window": 256000,
     "max_output": 65536
    },
    "mercury-2": {
     "context_window": 128000,
     "max_output": 50000
    },
    "grok-4-6": {
     "context_window": 500000,
     "max_output": 200000
    },
    "zai-org-glm-5-1": {
     "context_window": 200000,
     "max_output": 80000
    },
    "xiaomi-mimo-v2-5": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "openai-gpt-4o-2024-11-20": {
     "context_window": 128000,
     "max_output": 16384
    },
    "openai-gpt-52": {
     "context_window": 256000,
     "max_output": 65536
    },
    "gemini-3-6-flash": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "gemini-3-1-pro-preview": {
     "context_window": 1000000,
     "max_output": 32768
    },
    "deepseek-v4-pro": {
     "context_window": 1000000,
     "max_output": 32768
    },
    "claude-sonnet-4-6": {
     "context_window": 1000000,
     "max_output": 64000
    },
    "claude-opus-5-fast": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "openai-gpt-55": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "openai-gpt-56-sol": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "qwen3-coder-480b-a35b-instruct-turbo": {
     "context_window": 256000,
     "max_output": 65536
    },
    "z-ai-glm-5-3-flash": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "claude-sonnet-5-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "zai-org-glm-5": {
     "context_window": 198000,
     "max_output": 32000
    },
    "grok-4-7": {
     "context_window": 500000,
     "max_output": 200000
    },
    "deepseek-v3.2": {
     "context_window": 160000,
     "max_output": 32768
    },
    "gemini-3-5-flash-lite": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "gemini-3-5-flash": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "google-gemma-4-31b-it": {
     "context_window": 256000,
     "max_output": 8192
    },
    "claude-opus-4-7": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "venice-uncensored-1-2": {
     "context_window": 128000,
     "max_output": 8192
    },
    "qwen3-5-397b-a17b": {
     "context_window": 128000,
     "max_output": 32768
    },
    "llama-3.2-3b": {
     "context_window": 128000,
     "max_output": 4096
    },
    "openai-gpt-56-luna-pro": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "nvidia-nemotron-3-ultra-550b-a55b": {
     "context_window": 256000,
     "max_output": 32768
    },
    "deepseek-v4-flash": {
     "context_window": 1000000,
     "max_output": 32768
    },
    "nvidia-nemotron-3-nano-30b-a3b": {
     "context_window": 128000,
     "max_output": 16384
    }
   }
  },
  "alibaba-token-plan-cn": {
   "api": "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1",
   "models": {
    "qwen3.7-max": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "deepseek-v4-flash-0731": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "qwen3.8-max": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "qwen-image-2.0": {
     "context_window": 8192
    },
    "glm-5": {
     "context_window": 202752,
     "max_output": 16384
    },
    "deepseek-v4.1-flash": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "qwen3.8-max-preview": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "qwen-image-2.0-pro": {
     "context_window": 8192
    },
    "kimi-k2.6": {
     "context_window": 262144,
     "max_output": 262144
    },
    "wan2.7-image": {
     "context_window": 8192
    },
    "wan2.7-image-pro": {
     "context_window": 8192
    },
    "kimi-k2.5": {
     "context_window": 262144,
     "max_output": 98304
    },
    "qwen3.6-flash": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "deepseek-v4-pro-0813": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "MiniMax-M2.5": {
     "context_window": 196608,
     "max_output": 32768
    },
    "qwen3.8-flash": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "glm-5.2": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "glm-5.1": {
     "context_window": 202752,
     "max_output": 128000
    },
    "deepseek-v4-pro": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "qwen3.6-plus": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "deepseek-v3.2": {
     "context_window": 131072,
     "max_output": 65536
    },
    "glm-5.3": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "kimi-k2.7-code": {
     "context_window": 262144,
     "max_output": 262144
    },
    "qwen3.7-plus": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "deepseek-v4-flash": {
     "context_window": 1000000,
     "max_output": 384000
    }
   }
  },
  "ai21": {
   "api": "https://api.ai21.com/studio/v1",
   "models": {
    "jamba-large": {
     "context_window": 256000,
     "max_output": 4096
    },
    "jamba-mini": {
     "context_window": 256000,
     "max_output": 4096
    }
   }
  },
  "inference": {
   "api": "https://inference.net/v1",
   "models": {
    "meta/llama-3.1-8b-instruct": {
     "context_window": 16000,
     "max_output": 4096
    },
    "meta/llama-3.2-11b-vision-instruct": {
     "context_window": 16000,
     "max_output": 4096
    },
    "meta/llama-3.2-1b-instruct": {
     "context_window": 16000,
     "max_output": 4096
    },
    "meta/llama-3.2-3b-instruct": {
     "context_window": 16000,
     "max_output": 4096
    },
    "google/gemma-3": {
     "context_window": 125000,
     "max_output": 4096
    },
    "osmosis/osmosis-structure-0.6b": {
     "context_window": 4000,
     "max_output": 2048
    },
    "mistral/mistral-nemo-12b-instruct": {
     "context_window": 16000,
     "max_output": 4096
    },
    "qwen/qwen3-embedding-4b": {
     "context_window": 32000,
     "max_output": 2048
    },
    "qwen/qwen-2.5-7b-vision-instruct": {
     "context_window": 125000,
     "max_output": 4096
    }
   }
  },
  "iflowcn": {
   "api": "https://apis.iflow.cn/v1",
   "models": {
    "qwen3-vl-plus": {
     "context_window": 256000,
     "max_output": 32000
    },
    "glm-4.6": {
     "context_window": 200000,
     "max_output": 128000
    },
    "qwen3-32b": {
     "context_window": 128000,
     "max_output": 32000
    },
    "qwen3-max": {
     "context_window": 256000,
     "max_output": 32000
    },
    "deepseek-v3": {
     "context_window": 128000,
     "max_output": 32000
    },
    "qwen3-235b-a22b-thinking-2507": {
     "context_window": 256000,
     "max_output": 64000
    },
    "qwen3-max-preview": {
     "context_window": 256000,
     "max_output": 32000
    },
    "qwen3-coder-plus": {
     "context_window": 256000,
     "max_output": 64000
    },
    "qwen3-235b-a22b-instruct": {
     "context_window": 256000,
     "max_output": 64000
    },
    "kimi-k2-0905": {
     "context_window": 256000,
     "max_output": 64000
    },
    "kimi-k2": {
     "context_window": 128000,
     "max_output": 64000
    },
    "qwen3-235b": {
     "context_window": 128000,
     "max_output": 32000
    },
    "deepseek-r1": {
     "context_window": 128000,
     "max_output": 32000
    },
    "deepseek-v3.2": {
     "context_window": 128000,
     "max_output": 64000
    }
   }
  },
  "minimax-cn-coding-plan": {
   "api": "https://api.minimax.cn/anthropic/v1",
   "models": {
    "MiniMax-M3": {
     "context_window": 1048576,
     "max_output": 512000
    },
    "MiniMax-M2.1": {
     "context_window": 204800,
     "max_output": 131072
    },
    "MiniMax-M3.1-Flash-Preview": {
     "context_window": 1000000,
     "max_output": 512000
    },
    "MiniMax-M2.5": {
     "context_window": 204800,
     "max_output": 131072
    },
    "MiniMax-M2.7": {
     "context_window": 204800,
     "max_output": 131072
    },
    "MiniMax-M2.7-highspeed": {
     "context_window": 204800,
     "max_output": 131072
    },
    "MiniMax-M2": {
     "context_window": 204800,
     "max_output": 131072
    },
    "MiniMax-M2.5-highspeed": {
     "context_window": 204800,
     "max_output": 131072
    }
   }
  },
  "thinkingmachines": {
   "api": "https://tinker.thinkingmachines.dev/services/tinker-prod/anthropic/api/v1",
   "models": {
    "thinkingmachines/Inkling:peft:262144": {
     "context_window": 262144,
     "max_output": 262144
    },
    "thinkingmachines/Inkling": {
     "context_window": 65536,
     "max_output": 65536
    }
   }
  },
  "stepfun-step-plan": {
   "api": "https://api.stepfun.com/step_plan/v1",
   "models": {
    "step-5-preview": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "step-router-v1": {
     "context_window": 256000,
     "max_output": 256000
    },
    "step-3.5-flash-2603": {
     "context_window": 256000,
     "max_output": 256000
    },
    "step-3.5-flash": {
     "context_window": 256000,
     "max_output": 256000
    },
    "step-3.7-flash": {
     "context_window": 256000,
     "max_output": 256000
    }
   }
  },
  "melious": {
   "api": "https://api.melious.ai/v1",
   "models": {
    "glm-5.3-flash": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "deepseek-v4-flash-0731": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "kimi-k3": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "glm-5": {
     "context_window": 203000,
     "max_output": 131072
    },
    "deepseek-v4.1-flash": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "kimi-k2.6": {
     "context_window": 256000,
     "max_output": 256000
    },
    "kimi-k2.5": {
     "context_window": 262000,
     "max_output": 262000
    },
    "glm-5.1": {
     "context_window": 203000,
     "max_output": 131072
    },
    "deepseek-r1-0528": {
     "context_window": 164000,
     "max_output": 32768
    },
    "deepseek-v3.2": {
     "context_window": 164000,
     "max_output": 64000
    },
    "glm-5.3": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "kimi-k2.7-code": {
     "context_window": 262144,
     "max_output": 262144
    }
   }
  },
  "berget": {
   "api": "https://api.berget.ai/v1",
   "models": {
    "google/gemma-4-31B-it": {
     "context_window": 128000,
     "max_output": 8192
    },
    "Qwen/Qwen3.8-27B-FP8": {
     "context_window": 262144,
     "max_output": 65536
    },
    "mistralai/Mistral-Small-3.2-24B-Instruct-2506": {
     "context_window": 32000,
     "max_output": 8192
    },
    "moonshotai/Kimi-K3": {
     "context_window": 327680,
     "max_output": 32768
    },
    "zai-org/GLM-5.2": {
     "context_window": 524288,
     "max_output": 32768
    },
    "zai-org/GLM-5.3-Flash": {
     "context_window": 524288,
     "max_output": 16384
    }
   }
  },
  "snowflake-cortex": {
   "api": "https://${SNOWFLAKE_ACCOUNT}.snowflakecomputing.com/api/v2/cortex/v1",
   "models": {
    "claude-haiku-4-5": {
     "context_window": 200000,
     "max_output": 16384
    },
    "openai-gpt-5.5": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "claude-opus-4-5": {
     "context_window": 200000,
     "max_output": 64000
    },
    "claude-sonnet-4-5": {
     "context_window": 200000,
     "max_output": 16384
    },
    "openai-gpt-5-nano": {
     "context_window": 272000,
     "max_output": 8192
    },
    "openai-gpt-5": {
     "context_window": 272000,
     "max_output": 8192
    },
    "openai-gpt-4.1": {
     "context_window": 128000,
     "max_output": 32000
    },
    "claude-opus-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "mistral-large2": {
     "context_window": 262144,
     "max_output": 262144
    },
    "openai-gpt-5.2": {
     "context_window": 400000,
     "max_output": 128000
    },
    "claude-fable-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "claude-opus-4-8": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "claude-sonnet-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "openai-gpt-5.6-luna": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "claude-opus-4-6": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "openai-gpt-5.6-sol": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai-gpt-5-mini": {
     "context_window": 272000,
     "max_output": 8192
    },
    "deepseek-r1": {
     "context_window": 128000,
     "max_output": 32768
    },
    "claude-sonnet-4-6": {
     "context_window": 1000000,
     "max_output": 16384
    },
    "openai-gpt-5.1": {
     "context_window": 272000,
     "max_output": 8192
    },
    "snowflake-llama3.3-70b": {
     "context_window": 128000,
     "max_output": 4096
    },
    "openai-gpt-5.6-terra": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "claude-opus-4-7": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "gemini-3.1-pro": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "openai-gpt-5.4": {
     "context_window": 1050000,
     "max_output": 128000
    }
   }
  },
  "sarvam": {
   "api": "https://api.sarvam.ai/v1",
   "models": {
    "sarvam-30b": {
     "context_window": 65536,
     "max_output": 65536
    },
    "sarvam-105b": {
     "context_window": 131072,
     "max_output": 131072
    }
   }
  },
  "nova": {
   "api": "https://api.nova.amazon.com/v1",
   "models": {
    "nova-2-pro-v1": {
     "context_window": 1000000,
     "max_output": 64000
    },
    "nova-2-lite-v1": {
     "context_window": 1000000,
     "max_output": 64000
    }
   }
  },
  "abacus": {
   "api": "https://routellm.abacus.ai/v1",
   "models": {
    "gpt-5.4": {
     "context_window": 400000,
     "max_output": 128000
    },
    "grok-4-1-fast-non-reasoning": {
     "context_window": 2000000,
     "max_output": 16384
    },
    "qwen3.7-max": {
     "context_window": 1000000,
     "max_output": 64000
    },
    "gemini-3.1-flash-image-preview": {
     "context_window": 1048576,
     "max_output": 32768
    },
    "gpt-5.4-nano": {
     "context_window": 400000,
     "max_output": 128000
    },
    "gpt-5.2-codex": {
     "context_window": 400000,
     "max_output": 128000
    },
    "gpt-5.1-codex": {
     "context_window": 400000,
     "max_output": 128000
    },
    "gemini-2.5-flash-image": {
     "context_window": 32768,
     "max_output": 32768
    },
    "gpt-4o": {
     "context_window": 128000,
     "max_output": 16384
    },
    "qwen3.8-max": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "gpt-5-codex": {
     "context_window": 400000,
     "max_output": 128000
    },
    "gpt-5-mini": {
     "context_window": 400000,
     "max_output": 128000
    },
    "claude-3-7-sonnet-20250219": {
     "context_window": 200000,
     "max_output": 64000
    },
    "qwen-2.5-coder-32b": {
     "context_window": 128000,
     "max_output": 8192
    },
    "o4-mini": {
     "context_window": 200000,
     "max_output": 100000
    },
    "o3-mini": {
     "context_window": 200000,
     "max_output": 100000
    },
    "gpt-5.3-codex": {
     "context_window": 400000,
     "max_output": 128000
    },
    "gpt-4.1-nano": {
     "context_window": 1047576,
     "max_output": 32768
    },
    "muse-spark-1.1": {
     "context_window": 1000000,
     "max_output": 32000
    },
    "gpt-5-nano": {
     "context_window": 400000,
     "max_output": 128000
    },
    "gpt-5.2-chat-latest": {
     "context_window": 400000,
     "max_output": 128000
    },
    "gpt-5.1-chat-latest": {
     "context_window": 400000,
     "max_output": 128000
    },
    "qwen3-max": {
     "context_window": 131072,
     "max_output": 16384
    },
    "claude-opus-4-20250514": {
     "context_window": 200000,
     "max_output": 32000
    },
    "gemini-3.6-flash": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "kimi-k2-turbo-preview": {
     "context_window": 256000,
     "max_output": 8192
    },
    "grok-4.3": {
     "context_window": 1000000,
     "max_output": 32768
    },
    "grok-4-fast-non-reasoning": {
     "context_window": 2000000,
     "max_output": 16384
    },
    "claude-opus-4-1-20250805": {
     "context_window": 200000,
     "max_output": 32000
    },
    "claude-opus-4-5-20251101": {
     "context_window": 200000,
     "max_output": 64000
    },
    "gemini-3-pro-image-preview": {
     "context_window": 65536,
     "max_output": 32768
    },
    "gemini-3.5-flash-lite": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "gemini-3.1-flash-image": {
     "context_window": 1048576,
     "max_output": 32768
    },
    "gemini-3.1-pro-preview": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "grok-4.5": {
     "context_window": 500000,
     "max_output": 32768
    },
    "kimi-k2.5": {
     "context_window": 262144,
     "max_output": 32768
    },
    "gpt-5.1": {
     "context_window": 400000,
     "max_output": 128000
    },
    "llama-3.3-70b-versatile": {
     "context_window": 128000,
     "max_output": 32768
    },
    "claude-opus-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "mimo-v2-pro": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "gpt-4o-mini": {
     "context_window": 128000,
     "max_output": 16384
    },
    "o3-pro": {
     "context_window": 200000,
     "max_output": 100000
    },
    "gemini-3.5-flash": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "gemini-2.5-pro": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "gemini-3-pro-image": {
     "context_window": 65536,
     "max_output": 32768
    },
    "gemini-2.5-flash": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "claude-fable-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "muse-spark-1.2": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "gpt-5.4-mini": {
     "context_window": 400000,
     "max_output": 128000
    },
    "gpt-5.6-luna": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "gpt-5.1-codex-max": {
     "context_window": 400000,
     "max_output": 128000
    },
    "gpt-5.2": {
     "context_window": 400000,
     "max_output": 128000
    },
    "claude-opus-4-8": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "grok-code-fast-1": {
     "context_window": 256000,
     "max_output": 16384
    },
    "gpt-5.5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "claude-sonnet-4-5-20250929": {
     "context_window": 200000,
     "max_output": 64000
    },
    "gpt-4.1": {
     "context_window": 1047576,
     "max_output": 32768
    },
    "claude-sonnet-5": {
     "context_window": 1000000,
     "max_output": 64000
    },
    "claude-opus-4-6": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "gemini-3.7-flash": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "gpt-5.3-codex-xhigh": {
     "context_window": 400000,
     "max_output": 128000
    },
    "gemini-3-flash-preview": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "gpt-4o-2024-11-20": {
     "context_window": 128000,
     "max_output": 16384
    },
    "claude-haiku-4-5-20251001": {
     "context_window": 200000,
     "max_output": 64000
    },
    "gpt-4.1-mini": {
     "context_window": 1047576,
     "max_output": 32768
    },
    "claude-sonnet-4-6": {
     "context_window": 1000000,
     "max_output": 64000
    },
    "gpt-5.3-chat-latest": {
     "context_window": 400000,
     "max_output": 128000
    },
    "claude-sonnet-4-20250514": {
     "context_window": 200000,
     "max_output": 64000
    },
    "gpt-5.6-terra": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "o3": {
     "context_window": 200000,
     "max_output": 100000
    },
    "claude-opus-4-7": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "gpt-5": {
     "context_window": 400000,
     "max_output": 128000
    },
    "grok-4.6": {
     "context_window": 500000,
     "max_output": 32768
    },
    "gemini-3.1-flash-lite-preview": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "route-llm": {
     "context_window": 128000,
     "max_output": 64000
    },
    "grok-4-0709": {
     "context_window": 256000,
     "max_output": 16384
    },
    "gpt-5.6-sol": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "gemini-3.1-flash-lite": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "deepseek/deepseek-v3.1": {
     "context_window": 128000,
     "max_output": 8192
    },
    "meta-llama/Meta-Llama-3.3-70B-Instruct": {
     "context_window": 131072,
     "max_output": 8192
    },
    "meta-llama/Meta-Llama-3.1-8B-Instruct": {
     "context_window": 128000,
     "max_output": 4096
    },
    "meta-llama/Meta-Llama-3.1-405B-Instruct-Turbo": {
     "context_window": 128000,
     "max_output": 4096
    },
    "meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8": {
     "context_window": 1048576,
     "max_output": 8192
    },
    "thinkingmachines/Inkling": {
     "context_window": 262144,
     "max_output": 131072
    },
    "google/gemma-4-31b-it": {
     "context_window": 262144,
     "max_output": 131072
    },
    "Qwen/QwQ-32B": {
     "context_window": 32768,
     "max_output": 32768
    },
    "Qwen/Qwen3-235B-A22B-Instruct-2507": {
     "context_window": 262144,
     "max_output": 8192
    },
    "Qwen/Qwen2.5-72B-Instruct": {
     "context_window": 128000,
     "max_output": 8192
    },
    "Qwen/Qwen3-32B": {
     "context_window": 131072,
     "max_output": 8192
    },
    "Qwen/Qwen3-Coder-480B-A35B-Instruct": {
     "context_window": 262144,
     "max_output": 16384
    },
    "Qwen/Qwen3.6-27B": {
     "context_window": 262144,
     "max_output": 8192
    },
    "deepseek-ai/DeepSeek-R1": {
     "context_window": 128000,
     "max_output": 8192
    },
    "deepseek-ai/DeepSeek-V4-Flash": {
     "context_window": 1000000,
     "max_output": 32768
    },
    "deepseek-ai/DeepSeek-V4-Pro": {
     "context_window": 1000000,
     "max_output": 32768
    },
    "deepseek-ai/DeepSeek-V3.2": {
     "context_window": 128000,
     "max_output": 8192
    },
    "deepseek-ai/DeepSeek-V3.1-Terminus": {
     "context_window": 128000,
     "max_output": 8192
    },
    "MiniMaxAI/MiniMax-M3": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "MiniMaxAI/MiniMax-M2.7": {
     "context_window": 204800,
     "max_output": 131072
    },
    "moonshotai/Kimi-K2.6": {
     "context_window": 262144,
     "max_output": 262144
    },
    "moonshotai/Kimi-K3": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "moonshotai/Kimi-K2.7-Code": {
     "context_window": 262144,
     "max_output": 262144
    },
    "zai-org/GLM-5.1": {
     "context_window": 204800,
     "max_output": 131072
    },
    "zai-org/GLM-5.2": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "zai-org/GLM-4.7": {
     "context_window": 204800,
     "max_output": 131072
    },
    "zai-org/GLM-5": {
     "context_window": 204800,
     "max_output": 131072
    },
    "zai-org/GLM-4.6": {
     "context_window": 202752,
     "max_output": 131072
    },
    "zai-org/GLM-4.5": {
     "context_window": 131072,
     "max_output": 96000
    },
    "openai/gpt-oss-120b": {
     "context_window": 128000,
     "max_output": 16384
    }
   }
  },
  "novita-ai": {
   "api": "https://api.novita.ai/openai",
   "models": {
    "kwaipilot/kat-coder-pro": {
     "context_window": 256000,
     "max_output": 128000
    },
    "deepseek/deepseek-prover-v2-671b": {
     "context_window": 160000,
     "max_output": 160000
    },
    "deepseek/deepseek-r1-distill-qwen-14b": {
     "context_window": 32768,
     "max_output": 16384
    },
    "deepseek/deepseek-v3-0324": {
     "context_window": 163840,
     "max_output": 163840
    },
    "deepseek/deepseek-r1-distill-llama-70b": {
     "context_window": 8192,
     "max_output": 8192
    },
    "deepseek/deepseek-v3-turbo": {
     "context_window": 64000,
     "max_output": 16000
    },
    "deepseek/deepseek-r1-0528-qwen3-8b": {
     "context_window": 128000,
     "max_output": 32000
    },
    "deepseek/deepseek-v3.1-terminus": {
     "context_window": 131072,
     "max_output": 32768
    },
    "deepseek/deepseek-ocr-2": {
     "context_window": 8192,
     "max_output": 8192
    },
    "deepseek/deepseek-ocr": {
     "context_window": 8192,
     "max_output": 8192
    },
    "deepseek/deepseek-r1-turbo": {
     "context_window": 64000,
     "max_output": 16000
    },
    "deepseek/deepseek-v3.2-exp": {
     "context_window": 163840,
     "max_output": 65536
    },
    "deepseek/deepseek-r1-distill-qwen-32b": {
     "context_window": 64000,
     "max_output": 32000
    },
    "deepseek/deepseek-v3.1": {
     "context_window": 131072,
     "max_output": 32768
    },
    "deepseek/deepseek-v4-pro": {
     "context_window": 1048576,
     "max_output": 393216
    },
    "deepseek/deepseek-r1-0528": {
     "context_window": 163840,
     "max_output": 32768
    },
    "deepseek/deepseek-v3.2": {
     "context_window": 163840,
     "max_output": 65536
    },
    "deepseek/deepseek-v4-flash": {
     "context_window": 1048576,
     "max_output": 393216
    },
    "meta-llama/llama-4-maverick-17b-128e-instruct-fp8": {
     "context_window": 1048576,
     "max_output": 8192
    },
    "meta-llama/llama-3-70b-instruct": {
     "context_window": 8192,
     "max_output": 8000
    },
    "meta-llama/llama-3.3-70b-instruct": {
     "context_window": 131072,
     "max_output": 120000
    },
    "meta-llama/llama-3.1-8b-instruct": {
     "context_window": 16384,
     "max_output": 16384
    },
    "meta-llama/llama-4-scout-17b-16e-instruct": {
     "context_window": 131072,
     "max_output": 131072
    },
    "meta-llama/llama-3.2-3b-instruct": {
     "context_window": 32768,
     "max_output": 32000
    },
    "meta-llama/llama-3-8b-instruct": {
     "context_window": 8192,
     "max_output": 8192
    },
    "nousresearch/hermes-2-pro-llama-3-8b": {
     "context_window": 8192,
     "max_output": 8192
    },
    "xiaomimimo/mimo-v2-flash": {
     "context_window": 262144,
     "max_output": 32000
    },
    "xiaomimimo/mimo-v2-pro": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "xiaomimimo/mimo-v2.5-pro": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "baidu/ernie-4.5-vl-28b-a3b": {
     "context_window": 30000,
     "max_output": 8000
    },
    "baidu/ernie-4.5-vl-28b-a3b-thinking": {
     "context_window": 131072,
     "max_output": 65536
    },
    "baidu/ernie-4.5-21B-a3b-thinking": {
     "context_window": 131072,
     "max_output": 65536
    },
    "baidu/ernie-4.5-21B-a3b": {
     "context_window": 120000,
     "max_output": 8000
    },
    "baidu/ernie-4.5-vl-424b-a47b": {
     "context_window": 123000,
     "max_output": 16000
    },
    "baidu/ernie-4.5-300b-a47b-paddle": {
     "context_window": 123000,
     "max_output": 12000
    },
    "google/gemma-4-31b-it": {
     "context_window": 262144,
     "max_output": 131072
    },
    "google/gemma-3-27b-it": {
     "context_window": 98304,
     "max_output": 16384
    },
    "google/gemma-4-26b-a4b-it": {
     "context_window": 262144,
     "max_output": 131072
    },
    "google/gemma-3-12b-it": {
     "context_window": 131072,
     "max_output": 8192
    },
    "minimaxai/minimax-m1-80k": {
     "context_window": 1000000,
     "max_output": 40000
    },
    "mistralai/mistral-nemo": {
     "context_window": 60288,
     "max_output": 16000
    },
    "inclusionai/ring-2.6-1t": {
     "context_window": 262144,
     "max_output": 65536
    },
    "inclusionai/ling-2.6-1t": {
     "context_window": 262144,
     "max_output": 32768
    },
    "inclusionai/ling-2.6-flash": {
     "context_window": 262144,
     "max_output": 32768
    },
    "moonshotai/kimi-k3": {
     "context_window": 1048576,
     "max_output": 1048576
    },
    "moonshotai/kimi-k2.6": {
     "context_window": 262144,
     "max_output": 262144
    },
    "moonshotai/kimi-k2-thinking": {
     "context_window": 262144,
     "max_output": 98304
    },
    "moonshotai/kimi-k2.5": {
     "context_window": 262144,
     "max_output": 262144
    },
    "moonshotai/kimi-k2-instruct": {
     "context_window": 131072,
     "max_output": 32768
    },
    "moonshotai/kimi-k2-0905": {
     "context_window": 262144,
     "max_output": 98304
    },
    "moonshotai/kimi-k2.7-code": {
     "context_window": 262144,
     "max_output": 262144
    },
    "zai-org/glm-4.6v": {
     "context_window": 131072,
     "max_output": 32768
    },
    "zai-org/glm-4.5": {
     "context_window": 131072,
     "max_output": 98304
    },
    "zai-org/glm-4.6": {
     "context_window": 204800,
     "max_output": 131072
    },
    "zai-org/glm-5": {
     "context_window": 202800,
     "max_output": 131072
    },
    "zai-org/glm-4.5v": {
     "context_window": 65536,
     "max_output": 16384
    },
    "zai-org/glm-4.7-flash": {
     "context_window": 200000,
     "max_output": 128000
    },
    "zai-org/glm-4.7": {
     "context_window": 204800,
     "max_output": 131072
    },
    "zai-org/glm-5.2": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "zai-org/glm-5.1": {
     "context_window": 204800,
     "max_output": 131072
    },
    "zai-org/autoglm-phone-9b-multilingual": {
     "context_window": 65536,
     "max_output": 65536
    },
    "zai-org/glm-4.5-air": {
     "context_window": 131072,
     "max_output": 98304
    },
    "gryphe/mythomax-l2-13b": {
     "context_window": 4096,
     "max_output": 3200
    },
    "minimax/minimax-m2.5": {
     "context_window": 204800,
     "max_output": 131072
    },
    "minimax/minimax-m2.7": {
     "context_window": 204800,
     "max_output": 131072
    },
    "minimax/minimax-m2.7-highspeed": {
     "context_window": 204800,
     "max_output": 131072
    },
    "minimax/minimax-m2.5-highspeed": {
     "context_window": 204800,
     "max_output": 131072
    },
    "minimax/minimax-m2.1": {
     "context_window": 204800,
     "max_output": 131072
    },
    "minimax/minimax-m2": {
     "context_window": 204800,
     "max_output": 131072
    },
    "paddlepaddle/paddleocr-vl": {
     "context_window": 16384,
     "max_output": 16384
    },
    "qwen/qwen3-vl-235b-a22b-instruct": {
     "context_window": 131072,
     "max_output": 32768
    },
    "qwen/qwen3.7-max": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "qwen/qwen3-vl-235b-a22b-thinking": {
     "context_window": 131072,
     "max_output": 32768
    },
    "qwen/qwen3.5-27b": {
     "context_window": 262144,
     "max_output": 65536
    },
    "qwen/qwen3-235b-a22b-instruct-2507": {
     "context_window": 131072,
     "max_output": 16384
    },
    "qwen/qwen3-next-80b-a3b-thinking": {
     "context_window": 131072,
     "max_output": 32768
    },
    "qwen/qwen3-coder-next": {
     "context_window": 262144,
     "max_output": 65536
    },
    "qwen/qwen3-omni-30b-a3b-instruct": {
     "context_window": 65536,
     "max_output": 16384
    },
    "qwen/qwen3-omni-30b-a3b-thinking": {
     "context_window": 65536,
     "max_output": 16384
    },
    "qwen/qwen3-max": {
     "context_window": 262144,
     "max_output": 65536
    },
    "qwen/qwen3-235b-a22b-fp8": {
     "context_window": 40960,
     "max_output": 20000
    },
    "qwen/qwen3-coder-480b-a35b-instruct": {
     "context_window": 262144,
     "max_output": 65536
    },
    "qwen/qwen3-coder-30b-a3b-instruct": {
     "context_window": 160000,
     "max_output": 32768
    },
    "qwen/qwen3-vl-30b-a3b-instruct": {
     "context_window": 131072,
     "max_output": 32768
    },
    "qwen/qwen3-235b-a22b-thinking-2507": {
     "context_window": 131072,
     "max_output": 32768
    },
    "qwen/qwen2.5-7b-instruct": {
     "context_window": 32000,
     "max_output": 32000
    },
    "qwen/qwen3.5-122b-a10b": {
     "context_window": 262144,
     "max_output": 65536
    },
    "qwen/qwen3-30b-a3b-fp8": {
     "context_window": 40960,
     "max_output": 20000
    },
    "qwen/qwen3-next-80b-a3b-instruct": {
     "context_window": 131072,
     "max_output": 32768
    },
    "qwen/qwen3-vl-30b-a3b-thinking": {
     "context_window": 131072,
     "max_output": 32768
    },
    "qwen/qwen-mt-plus": {
     "context_window": 16384,
     "max_output": 8192
    },
    "qwen/qwen3-32b-fp8": {
     "context_window": 40960,
     "max_output": 20000
    },
    "qwen/qwen3-8b-fp8": {
     "context_window": 128000,
     "max_output": 20000
    },
    "qwen/qwen3.5-35b-a3b": {
     "context_window": 262144,
     "max_output": 65536
    },
    "qwen/qwen3.5-397b-a17b": {
     "context_window": 262144,
     "max_output": 64000
    },
    "qwen/qwen3-vl-8b-instruct": {
     "context_window": 131072,
     "max_output": 32768
    },
    "qwen/qwen2.5-vl-72b-instruct": {
     "context_window": 32768,
     "max_output": 32768
    },
    "qwen/qwen-2.5-72b-instruct": {
     "context_window": 32000,
     "max_output": 8192
    },
    "qwen/qwen3-4b-fp8": {
     "context_window": 128000,
     "max_output": 20000
    },
    "baichuan/baichuan-m2-32b": {
     "context_window": 131072,
     "max_output": 131072
    },
    "openai/gpt-oss-20b": {
     "context_window": 131072,
     "max_output": 32768
    },
    "openai/gpt-oss-120b": {
     "context_window": 131072,
     "max_output": 32768
    },
    "microsoft/wizardlm-2-8x22b": {
     "context_window": 65535,
     "max_output": 8000
    },
    "sao10K/l3-70b-euryale-v2.1": {
     "context_window": 8192,
     "max_output": 8192
    },
    "sao10K/L3-8B-stheno-v3.2": {
     "context_window": 8192,
     "max_output": 32000
    },
    "sao10K/l3-8b-lunaris": {
     "context_window": 8192,
     "max_output": 8192
    },
    "sao10K/l31-70b-euryale-v2.2": {
     "context_window": 8192,
     "max_output": 8192
    }
   }
  },
  "302ai": {
   "api": "https://api.302.ai/v1",
   "models": {
    "grok-4-1-fast-reasoning": {
     "context_window": 2000000,
     "max_output": 30000
    },
    "glm-4.6v": {
     "context_window": 128000,
     "max_output": 32768
    },
    "gpt-5.4": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "glm-4.5": {
     "context_window": 131072,
     "max_output": 98304
    },
    "claude-haiku-4-5": {
     "context_window": 200000,
     "max_output": 64000
    },
    "qwen3.7-max": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "gemini-3.1-flash-image-preview": {
     "context_window": 131072,
     "max_output": 32768
    },
    "grok-4.7": {
     "context_window": 500000,
     "max_output": 500000
    },
    "MiniMax-M3": {
     "context_window": 1048576,
     "max_output": 512000
    },
    "gpt-5.4-nano": {
     "context_window": 400000,
     "max_output": 128000
    },
    "gemini-3.5-flash-thinking": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "gemini-3-pro-preview": {
     "context_window": 1000000,
     "max_output": 64000
    },
    "glm-5v-turbo": {
     "context_window": 200000,
     "max_output": 131072
    },
    "gemini-2.5-flash-image": {
     "context_window": 32768,
     "max_output": 32768
    },
    "gpt-4o": {
     "context_window": 128000,
     "max_output": 16384
    },
    "glm-5.3-flash": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "glm-4.6": {
     "context_window": 204800,
     "max_output": 131072
    },
    "qwen3-235b-a22b-instruct-2507": {
     "context_window": 128000,
     "max_output": 65536
    },
    "qwen3.8-max": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "kimi-k3": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "gpt-5.6-sol-pro": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "gpt-5-mini": {
     "context_window": 400000,
     "max_output": 128000
    },
    "qwen3.5-plus": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "claude-sonnet-4-6-thinking": {
     "context_window": 1000000,
     "max_output": 64000
    },
    "glm-5": {
     "context_window": 204800,
     "max_output": 131072
    },
    "gpt-4.1-nano": {
     "context_window": 1047576,
     "max_output": 32768
    },
    "grok-4-fast-reasoning": {
     "context_window": 2000000,
     "max_output": 30000
    },
    "kimi-k2.6": {
     "context_window": 262144,
     "max_output": 262144
    },
    "gpt-5.2-chat-latest": {
     "context_window": 128000,
     "max_output": 16384
    },
    "gpt-5.1-chat-latest": {
     "context_window": 128000,
     "max_output": 16384
    },
    "claude-opus-5-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "MiniMax-M2.1": {
     "context_window": 204800,
     "max_output": 131072
    },
    "gemini-2.5-flash-preview-09-2025": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "glm-4.5v": {
     "context_window": 64000,
     "max_output": 16384
    },
    "claude-fable-5-1": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "gemini-3.6-flash": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "claude-opus-5-thinking": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "qwen3-coder-480b-a35b-instruct": {
     "context_window": 262144,
     "max_output": 65536
    },
    "doubao-seed-1-6-vision-250815": {
     "context_window": 256000,
     "max_output": 32000
    },
    "claude-sonnet-4-5-20250929-thinking": {
     "context_window": 200000,
     "max_output": 64000
    },
    "grok-4.3": {
     "context_window": 1000000,
     "max_output": 30000
    },
    "kimi-k2-thinking": {
     "context_window": 262144,
     "max_output": 262144
    },
    "grok-4-fast-non-reasoning": {
     "context_window": 2000000,
     "max_output": 30000
    },
    "grok-4.20-beta-0309-reasoning": {
     "context_window": 2000000,
     "max_output": 30000
    },
    "claude-opus-4-1-20250805": {
     "context_window": 200000,
     "max_output": 32000
    },
    "gpt-5-pro": {
     "context_window": 400000,
     "max_output": 272000
    },
    "claude-opus-4-5-20251101": {
     "context_window": 200000,
     "max_output": 64000
    },
    "gemini-3-pro-image-preview": {
     "context_window": 32768,
     "max_output": 64000
    },
    "gemini-3.5-flash-lite": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "gemini-2.0-flash-lite": {
     "context_window": 2000000,
     "max_output": 8192
    },
    "qwen3-235b-a22b": {
     "context_window": 128000,
     "max_output": 16384
    },
    "gpt-6-astra": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "gemini-3.1-pro-preview": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "grok-4.5": {
     "context_window": 500000,
     "max_output": 500000
    },
    "gpt-5.6-luna-pro": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "kimi-k2.5": {
     "context_window": 262144,
     "max_output": 262144
    },
    "gpt-5.1": {
     "context_window": 400000,
     "max_output": 128000
    },
    "claude-opus-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "qwen3.7-max-2026-06-08": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "qwen3.6-35b-a3b": {
     "context_window": 262144,
     "max_output": 65536
    },
    "kimi-k2-0905-preview": {
     "context_window": 262144,
     "max_output": 262144
    },
    "deepseek-flash": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "gemini-3.5-flash": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "gemini-2.5-pro": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "qwen3.6-flash": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "gemini-2.5-flash": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "claude-fable-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "doubao-seed-1-6-thinking-250715": {
     "context_window": 256000,
     "max_output": 16000
    },
    "gpt-5-thinking": {
     "context_window": 400000,
     "max_output": 128000
    },
    "MiniMax-M1": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "MiniMax-M2.5": {
     "context_window": 204800,
     "max_output": 131072
    },
    "gpt-5.4-mini": {
     "context_window": 400000,
     "max_output": 128000
    },
    "glm-4.7": {
     "context_window": 204800,
     "max_output": 131072
    },
    "gpt-5.6-luna": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "MiniMax-M2.7": {
     "context_window": 204800,
     "max_output": 131072
    },
    "qwen3.8-flash": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "gpt-5.2": {
     "context_window": 400000,
     "max_output": 128000
    },
    "deepseek-v3.2-thinking": {
     "context_window": 128000,
     "max_output": 128000
    },
    "claude-opus-4-8": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "gpt-5.5": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "claude-sonnet-4-5-20250929": {
     "context_window": 200000,
     "max_output": 64000
    },
    "gpt-4.1": {
     "context_window": 1047576,
     "max_output": 32768
    },
    "claude-sonnet-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "qwen3.5-35b-a3b": {
     "context_window": 262144,
     "max_output": 65536
    },
    "qwen3-30b-a3b": {
     "context_window": 128000,
     "max_output": 8192
    },
    "gemini-3.7-flash": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "glm-5.2": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "gemini-2.5-flash-nothink": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "doubao-seed-1-8-251215": {
     "context_window": 224000,
     "max_output": 64000
    },
    "claude-opus-4-1-20250805-thinking": {
     "context_window": 200000,
     "max_output": 32000
    },
    "glm-5.1": {
     "context_window": 200000,
     "max_output": 131072
    },
    "gemini-3-flash-preview": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "claude-haiku-4-5-20251001": {
     "context_window": 200000,
     "max_output": 64000
    },
    "mistral-large-2512": {
     "context_window": 128000,
     "max_output": 262144
    },
    "MiniMax-M2": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "gemini-2.5-flash-lite-preview-09-2025": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "gpt-4.1-mini": {
     "context_window": 1047576,
     "max_output": 32768
    },
    "gpt-5.6-terra-pro": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "gemini-3.8-flash": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "ministral-14b-2512": {
     "context_window": 128000,
     "max_output": 128000
    },
    "glm-5-turbo": {
     "context_window": 200000,
     "max_output": 131072
    },
    "gpt-6-luna": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "grok-4.1": {
     "context_window": 200000,
     "max_output": 64000
    },
    "claude-sonnet-4-6": {
     "context_window": 1000000,
     "max_output": 64000
    },
    "gpt-5.3-chat-latest": {
     "context_window": 128000,
     "max_output": 16384
    },
    "claude-sonnet-5-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "qwen3.6-plus": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "gpt-5.6-terra": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "deepseek-v3.2": {
     "context_window": 128000,
     "max_output": 8192
    },
    "claude-opus-4-7-thinking": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "o3": {
     "context_window": 200000,
     "max_output": 100000
    },
    "glm-5.3": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "claude-opus-4-7": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "kimi-k2.7-code": {
     "context_window": 262144,
     "max_output": 262144
    },
    "gpt-5": {
     "context_window": 400000,
     "max_output": 128000
    },
    "grok-4.6": {
     "context_window": 500000,
     "max_output": 500000
    },
    "gemini-3.1-flash-lite-preview": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "qwen3-max-2025-09-23": {
     "context_window": 258048,
     "max_output": 65536
    },
    "qwen3.7-plus": {
     "context_window": 1000000,
     "max_output": 64000
    },
    "gpt-5.6-sol": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "gpt-6-sol": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "gemini-3.1-flash-lite": {
     "context_window": 1048576,
     "max_output": 65536
    }
   }
  },
  "openrouter": {
   "api": "https://openrouter.ai/api/v1",
   "models": {
    "sao10k/l3-lunaris-8b": {
     "context_window": 8192,
     "max_output": 7372
    },
    "sao10k/l3.3-euryale-70b": {
     "context_window": 131072,
     "max_output": 16384
    },
    "sao10k/l3.1-euryale-70b": {
     "context_window": 131072,
     "max_output": 16384
    },
    "kwaipilot/kat-coder-pro-v2.5": {
     "context_window": 262144,
     "max_output": 235929
    },
    "stealth/space-bunny-alpha": {
     "context_window": 1000000,
     "max_output": 524288
    },
    "bytedance-seed/seed-1.6-flash": {
     "context_window": 262144,
     "max_output": 32768
    },
    "bytedance-seed/seed-2.0-lite": {
     "context_window": 262144,
     "max_output": 131072
    },
    "bytedance-seed/seed-2-1-turbo": {
     "context_window": 262144,
     "max_output": 235929
    },
    "bytedance-seed/seed-2.0-mini": {
     "context_window": 262144,
     "max_output": 131072
    },
    "bytedance-seed/seed-2.0-code": {
     "context_window": 262144,
     "max_output": 131072
    },
    "bytedance-seed/seed-1.6": {
     "context_window": 262144,
     "max_output": 32768
    },
    "~moonshotai/kimi-latest": {
     "context_window": 1048576,
     "max_output": 943718
    },
    "poolside/laguna-s-2.1:free": {
     "context_window": 262144,
     "max_output": 32768
    },
    "poolside/laguna-s-2.1": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "poolside/laguna-xs-2.1:free": {
     "context_window": 262144,
     "max_output": 32768
    },
    "poolside/laguna-xs-2.1": {
     "context_window": 262144,
     "max_output": 32768
    },
    "prism-ml/ternary-bonsai-2-27b": {
     "context_window": 262144,
     "max_output": 32768
    },
    "anthropic/claude-opus-4.1": {
     "context_window": 200000,
     "max_output": 32000
    },
    "anthropic/claude-opus-4.5": {
     "context_window": 200000,
     "max_output": 64000
    },
    "anthropic/claude-opus-4.6": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-opus-4.7": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-opus-4.8": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-haiku-4.5": {
     "context_window": 200000,
     "max_output": 64000
    },
    "anthropic/claude-opus-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-sonnet-5.5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-fable-5.1": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-sonnet-4.5": {
     "context_window": 1000000,
     "max_output": 64000
    },
    "anthropic/claude-fable-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-sonnet-4": {
     "context_window": 200000,
     "max_output": 64000
    },
    "anthropic/claude-sonnet-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-sonnet-4.6": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-opus-5.5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "nex-agi/nex-n2.5-mini": {
     "context_window": 262144,
     "max_output": 235929
    },
    "nex-agi/nex-n2.5-pro": {
     "context_window": 262144,
     "max_output": 235929
    },
    "cohere/command-r-08-2024": {
     "context_window": 128000,
     "max_output": 4000
    },
    "cohere/command-a-plus": {
     "context_window": 192000,
     "max_output": 64000
    },
    "cohere/command-a": {
     "context_window": 256000,
     "max_output": 8192
    },
    "cohere/north-mini-code:free": {
     "context_window": 256000,
     "max_output": 64000
    },
    "cohere/command-r7b-12-2024": {
     "context_window": 128000,
     "max_output": 4000
    },
    "cohere/command-r-plus-08-2024": {
     "context_window": 128000,
     "max_output": 4000
    },
    "deepseek/deepseek-chat-v3.1": {
     "context_window": 163840,
     "max_output": 32768
    },
    "deepseek/deepseek-v4-flash-0731": {
     "context_window": 1048576,
     "max_output": 943718
    },
    "deepseek/deepseek-v4.1-flash": {
     "context_window": 1048576,
     "max_output": 943718
    },
    "deepseek/deepseek-v4-flash-vision-exp": {
     "context_window": 1048576,
     "max_output": 262144
    },
    "deepseek/deepseek-v3.1-terminus": {
     "context_window": 163840,
     "max_output": 147456
    },
    "deepseek/deepseek-chat": {
     "context_window": 163840,
     "max_output": 16000
    },
    "deepseek/deepseek-v4-pro-0813": {
     "context_window": 1048576,
     "max_output": 943718
    },
    "deepseek/deepseek-v3.2-exp": {
     "context_window": 163840,
     "max_output": 147456
    },
    "deepseek/deepseek-chat-v3-0324": {
     "context_window": 163840,
     "max_output": 115200
    },
    "deepseek/deepseek-r1": {
     "context_window": 64000,
     "max_output": 16000
    },
    "deepseek/deepseek-v4-pro": {
     "context_window": 1048576,
     "max_output": 384000
    },
    "deepseek/deepseek-r1-0528": {
     "context_window": 163840,
     "max_output": 32768
    },
    "deepseek/deepseek-v3.2": {
     "context_window": 163840,
     "max_output": 65536
    },
    "deepseek/deepseek-v4-flash": {
     "context_window": 1048576,
     "max_output": 943718
    },
    "unbiased/pareto-26.10-preview": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "unbiased/pareto": {
     "context_window": 262144,
     "max_output": 131072
    },
    "tencent/hy3-preview": {
     "context_window": 262144,
     "max_output": 235929
    },
    "tencent/hunyuan-a13b-instruct": {
     "context_window": 131072,
     "max_output": 117964
    },
    "tencent/hy-mt2-30b-a3b": {
     "context_window": 8192,
     "max_output": 4096
    },
    "tencent/hy-mt2-1.8b": {
     "context_window": 8192,
     "max_output": 4096
    },
    "tencent/hy3": {
     "context_window": 262144,
     "max_output": 128000
    },
    "tencent/hy-mt2-7b": {
     "context_window": 8192,
     "max_output": 4096
    },
    "tencent/hy4-preview": {
     "context_window": 1048576,
     "max_output": 64000
    },
    "anthracite-org/magnum-v4-72b": {
     "context_window": 32768,
     "max_output": 4096
    },
    "meta-llama/llama-4-scout": {
     "context_window": 1310720,
     "max_output": 16384
    },
    "meta-llama/llama-guard-4-12b": {
     "context_window": 163840,
     "max_output": 16384
    },
    "meta-llama/llama-4-maverick": {
     "context_window": 1048576,
     "max_output": 16384
    },
    "meta-llama/llama-3.3-70b-instruct": {
     "context_window": 131072,
     "max_output": 16384
    },
    "meta-llama/llama-3.1-8b-instruct": {
     "context_window": 131072,
     "max_output": 117964
    },
    "meta-llama/llama-3.2-1b-instruct": {
     "context_window": 60000,
     "max_output": 54000
    },
    "meta-llama/llama-3.2-3b-instruct": {
     "context_window": 131072,
     "max_output": 117964
    },
    "meta-llama/llama-3.1-70b-instruct": {
     "context_window": 131072,
     "max_output": 16384
    },
    "~google/gemini-flash-latest": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "~google/gemini-pro-latest": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "perceptron/perceptron-mk1": {
     "context_window": 32768,
     "max_output": 8192
    },
    "perceptron/perceptron-mk1.5": {
     "context_window": 36864,
     "max_output": 8192
    },
    "z-ai/glm-4.6v": {
     "context_window": 131072,
     "max_output": 32768
    },
    "z-ai/glm-4.5": {
     "context_window": 131072,
     "max_output": 98304
    },
    "z-ai/glm-5.3-prime": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "z-ai/glm-5v-turbo": {
     "context_window": 202752,
     "max_output": 131072
    },
    "z-ai/glm-5.3-flash": {
     "context_window": 1048576,
     "max_output": 943717
    },
    "z-ai/glm-4.6": {
     "context_window": 204800,
     "max_output": 16384
    },
    "z-ai/glm-5": {
     "context_window": 204800,
     "max_output": 128000
    },
    "z-ai/glm-4.5v": {
     "context_window": 65536,
     "max_output": 16384
    },
    "z-ai/glm-5.3-flashx": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "z-ai/glm-4.7-flash": {
     "context_window": 200000,
     "max_output": 117964
    },
    "z-ai/glm-4.7": {
     "context_window": 204800,
     "max_output": 131072
    },
    "z-ai/glm-5.2": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "z-ai/glm-5.1": {
     "context_window": 204800,
     "max_output": 131072
    },
    "z-ai/glm-5-turbo": {
     "context_window": 202752,
     "max_output": 131072
    },
    "z-ai/glm-4.5-air": {
     "context_window": 131072,
     "max_output": 98304
    },
    "z-ai/glm-5.3": {
     "context_window": 1048576,
     "max_output": 943718
    },
    "inference-net/schematron-v2-small": {
     "context_window": 128000,
     "max_output": 4096
    },
    "inference-net/schematron-v2-turbo": {
     "context_window": 128000,
     "max_output": 8192
    },
    "thinkingmachines/inkling-small:free": {
     "context_window": 1048576,
     "max_output": 262144
    },
    "thinkingmachines/inkling-small": {
     "context_window": 524288,
     "max_output": 262144
    },
    "thinkingmachines/inkling:free": {
     "context_window": 1048576,
     "max_output": 262144
    },
    "thinkingmachines/inkling": {
     "context_window": 524288,
     "max_output": 262144
    },
    "meituan/longcat-2.0": {
     "context_window": 1048756,
     "max_output": 262144
    },
    "openrouter/bodybuilder": {
     "context_window": 128000,
     "max_output": 128000
    },
    "openrouter/free": {
     "context_window": 200000,
     "max_output": 8000
    },
    "openrouter/pareto-code": {
     "context_window": 2000000,
     "max_output": 200000
    },
    "openrouter/fusion": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "openrouter/auto": {
     "context_window": 2000000,
     "max_output": 2000000
    },
    "perplexity/sonar-pro": {
     "context_window": 200000,
     "max_output": 8000
    },
    "perplexity/sonar-deep-research": {
     "context_window": 128000,
     "max_output": 115200
    },
    "perplexity/sonar": {
     "context_window": 127072,
     "max_output": 114364
    },
    "perplexity/sonar-reasoning-pro": {
     "context_window": 128000,
     "max_output": 115200
    },
    "perplexity/sonar-pro-search": {
     "context_window": 200000,
     "max_output": 8000
    },
    "meta/muse-spark-1.3": {
     "context_window": 1048576,
     "max_output": 943718
    },
    "meta/muse-glimmer-30b": {
     "context_window": 131072,
     "max_output": 117964
    },
    "meta/muse-spark-1.1": {
     "context_window": 1048576,
     "max_output": 943718
    },
    "meta/muse-spark-1.2": {
     "context_window": 1048576,
     "max_output": 943718
    },
    "meta/muse-spark-1.2-contributor": {
     "context_window": 1048576,
     "max_output": 943718
    },
    "meta/muse-spark-1.3-contributor": {
     "context_window": 1048576,
     "max_output": 943718
    },
    "nousresearch/hermes-3-llama-3.1-70b": {
     "context_window": 131072,
     "max_output": 16384
    },
    "nousresearch/hermes-3-llama-3.1-405b": {
     "context_window": 131072,
     "max_output": 16384
    },
    "nousresearch/hermes-4-405b": {
     "context_window": 131072,
     "max_output": 117964
    },
    "~z-ai/glm-flash-latest": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "~z-ai/glm-latest": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "arcee-ai/trinity-large-thinking": {
     "context_window": 262144,
     "max_output": 80000
    },
    "~openai/gpt-terra-latest": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "~openai/gpt-luna-latest": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "~openai/gpt-sol-latest": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "~openai/gpt-astra-latest": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "~openai/gpt-mini-latest": {
     "context_window": 400000,
     "max_output": 128000
    },
    "cognitivecomputations/dolphin-mistral-24b-venice-edition": {
     "context_window": 128000,
     "max_output": 8192
    },
    "thedrummer/skyfall-36b-v2": {
     "context_window": 32768,
     "max_output": 29491
    },
    "thedrummer/unslopnemo-12b": {
     "context_window": 1024000,
     "max_output": 819200
    },
    "thedrummer/cydonia-24b-v4.1": {
     "context_window": 131072,
     "max_output": 117964
    },
    "baidu/ernie-4.5-vl-424b-a47b": {
     "context_window": 123000,
     "max_output": 16000
    },
    "x-ai/grok-4.20-multi-agent": {
     "context_window": 2000000,
     "max_output": 1800000
    },
    "x-ai/grok-4.7": {
     "context_window": 500000,
     "max_output": 450000
    },
    "x-ai/grok-4.3": {
     "context_window": 1000000,
     "max_output": 900000
    },
    "x-ai/grok-4.5": {
     "context_window": 500000,
     "max_output": 450000
    },
    "x-ai/grok-build-0.1": {
     "context_window": 256000,
     "max_output": 230400
    },
    "x-ai/grok-4.20": {
     "context_window": 2000000,
     "max_output": 1800000
    },
    "x-ai/grok-4.6": {
     "context_window": 500000,
     "max_output": 450000
    },
    "~anthropic/claude-opus-latest": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "~anthropic/claude-haiku-latest": {
     "context_window": 200000,
     "max_output": 64000
    },
    "~anthropic/claude-sonnet-latest": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "~anthropic/claude-fable-latest": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "upstage/solar-pro-3": {
     "context_window": 131072,
     "max_output": 117964
    },
    "upstage/solar-pro4": {
     "context_window": 524288,
     "max_output": 131072
    },
    "upstage/solar-mini4": {
     "context_window": 524288,
     "max_output": 131072
    },
    "~deepseek/deepseek-flash-latest": {
     "context_window": 1048576,
     "max_output": 943718
    },
    "~deepseek/deepseek-pro-latest": {
     "context_window": 1048576,
     "max_output": 393216
    },
    "~deepseek/deepseek-v4-flash-latest": {
     "context_window": 1048576,
     "max_output": 943718
    },
    "~x-ai/grok-latest": {
     "context_window": 500000,
     "max_output": 450000
    },
    "bytedance/ui-tars-1.5-7b": {
     "context_window": 128000,
     "max_output": 2048
    },
    "liquid/lfm-2.5-2.6b:free": {
     "context_window": 65536,
     "max_output": 8192
    },
    "google/gemma-4-31b-it": {
     "context_window": 262144,
     "max_output": 16384
    },
    "google/gemini-3.1-flash-image-preview": {
     "context_window": 65536,
     "max_output": 58982
    },
    "google/lyria-3-pro-preview": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemma-3-27b-it": {
     "context_window": 131072,
     "max_output": 117964
    },
    "google/gemma-4-31b-it:free": {
     "context_window": 262144,
     "max_output": 32768
    },
    "google/gemini-2.5-flash-image": {
     "context_window": 32768,
     "max_output": 8192
    },
    "google/gemma-4-26b-a4b-it:free": {
     "context_window": 262144,
     "max_output": 32768
    },
    "google/gemma-2-27b-it": {
     "context_window": 8192,
     "max_output": 2048
    },
    "google/gemini-3.6-flash": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemma-4-26b-a4b-it": {
     "context_window": 262144,
     "max_output": 235929
    },
    "google/gemini-3-pro-image-preview": {
     "context_window": 65536,
     "max_output": 32768
    },
    "google/gemini-3.5-flash-lite": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemini-3.1-flash-image": {
     "context_window": 131072,
     "max_output": 32768
    },
    "google/lyria-3-clip-preview": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemini-3.1-pro-preview": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemma-3-12b-it": {
     "context_window": 131072,
     "max_output": 16384
    },
    "google/gemini-3.5-flash": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemini-2.5-pro": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemini-3-pro-image": {
     "context_window": 131072,
     "max_output": 32768
    },
    "google/gemini-2.5-flash": {
     "context_window": 1048576,
     "max_output": 65535
    },
    "google/gemini-3.1-flash-lite-image": {
     "context_window": 65536,
     "max_output": 58982
    },
    "google/gemini-3.7-flash": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemini-3.1-pro-preview-customtools": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemini-3-flash-preview": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemini-3.8-flash": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemma-3-4b-it": {
     "context_window": 131072,
     "max_output": 16384
    },
    "google/gemini-2.5-flash-lite": {
     "context_window": 1048576,
     "max_output": 65535
    },
    "google/gemini-2.5-pro-preview": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemini-3.1-flash-lite-preview": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemini-3.1-flash-lite": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "writer/palmyra-x5": {
     "context_window": 1040000,
     "max_output": 8192
    },
    "ibm-granite/granite-4.0-h-micro": {
     "context_window": 131000,
     "max_output": 117900
    },
    "ibm-granite/granite-4.2-8b": {
     "context_window": 131072,
     "max_output": 117964
    },
    "fireworks/ember-1": {
     "context_window": 1048576,
     "max_output": 943718
    },
    "mistralai/mistral-nemo": {
     "context_window": 131072,
     "max_output": 16384
    },
    "mistralai/ministral-8b-2512": {
     "context_window": 262144,
     "max_output": 209715
    },
    "mistralai/mistral-small-24b-instruct-2501": {
     "context_window": 32768,
     "max_output": 16384
    },
    "mistralai/devstral-2512": {
     "context_window": 262144,
     "max_output": 209715
    },
    "mistralai/mistral-saba": {
     "context_window": 32768,
     "max_output": 26214
    },
    "mistralai/mistral-medium-3-5": {
     "context_window": 262144,
     "max_output": 209715
    },
    "mistralai/mistral-medium-3.1": {
     "context_window": 131072,
     "max_output": 104857
    },
    "mistralai/mistral-small-3.2-24b-instruct": {
     "context_window": 256000,
     "max_output": 16384
    },
    "mistralai/mistral-large": {
     "context_window": 128000,
     "max_output": 102400
    },
    "mistralai/mistral-small-2603": {
     "context_window": 262144,
     "max_output": 209715
    },
    "mistralai/mistral-medium-3": {
     "context_window": 131072,
     "max_output": 104857
    },
    "mistralai/voxtral-small-24b-2507": {
     "context_window": 32768,
     "max_output": 26214
    },
    "mistralai/mistral-large-2512": {
     "context_window": 262144,
     "max_output": 209715
    },
    "mistralai/mistral-large-2407": {
     "context_window": 131072,
     "max_output": 104857
    },
    "mistralai/ministral-14b-2512": {
     "context_window": 262144,
     "max_output": 209715
    },
    "mistralai/mistral-small-3.1-24b-instruct": {
     "context_window": 128000,
     "max_output": 102400
    },
    "mistralai/ministral-3b-2512": {
     "context_window": 131072,
     "max_output": 104857
    },
    "mistralai/mixtral-8x22b-instruct": {
     "context_window": 65536,
     "max_output": 52428
    },
    "mistralai/codestral-2508": {
     "context_window": 256000,
     "max_output": 204800
    },
    "sakana/fugu-max": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "sakana/fugu-ultra-v2": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "sakana/fugu-ultra": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "sakana/sakana-namazu": {
     "context_window": 262144,
     "max_output": 65536
    },
    "inclusionai/ling-3.0-flash-sante:free": {
     "context_window": 262144,
     "max_output": 32768
    },
    "inclusionai/ling-3.0-flash": {
     "context_window": 262144,
     "max_output": 32768
    },
    "inclusionai/ling-3.1-flash": {
     "context_window": 262144,
     "max_output": 32768
    },
    "inclusionai/ling-3.0-flash-vl": {
     "context_window": 262144,
     "max_output": 32768
    },
    "inclusionai/ling-3.0-flash-fin": {
     "context_window": 262144,
     "max_output": 32768
    },
    "moonshotai/kimi-k3": {
     "context_window": 1048576,
     "max_output": 943718
    },
    "moonshotai/kimi-k2.6": {
     "context_window": 262144,
     "max_output": 235929
    },
    "moonshotai/kimi-k2-thinking": {
     "context_window": 262144,
     "max_output": 235929
    },
    "moonshotai/kimi-k2.5": {
     "context_window": 262144,
     "max_output": 235929
    },
    "moonshotai/kimi-k2-0905": {
     "context_window": 262144,
     "max_output": 98304
    },
    "moonshotai/kimi-k2": {
     "context_window": 131072,
     "max_output": 98304
    },
    "moonshotai/kimi-k2.7-code": {
     "context_window": 262144,
     "max_output": 235929
    },
    "rekaai/reka-flash-3": {
     "context_window": 65536,
     "max_output": 58982
    },
    "rekaai/reka-edge": {
     "context_window": 16384,
     "max_output": 14745
    },
    "apodex/apodex-1.1-mini:free": {
     "context_window": 262144,
     "max_output": 235929
    },
    "nvidia/nemotron-3-nano-30b-a3b": {
     "context_window": 262144,
     "max_output": 235929
    },
    "nvidia/nemotron-3.5-content-safety:free": {
     "context_window": 128000,
     "max_output": 8192
    },
    "nvidia/nemotron-3.5-lightning": {
     "context_window": 262144,
     "max_output": 32768
    },
    "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free": {
     "context_window": 256000,
     "max_output": 65536
    },
    "nvidia/nemotron-3-super-120b-a12b": {
     "context_window": 262144,
     "max_output": 235929
    },
    "nvidia/nemotron-3-ultra-550b-a55b:free": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "nvidia/nemotron-3-ultra-550b-a55b": {
     "context_window": 262144,
     "max_output": 16384
    },
    "nvidia/nemotron-3-super-120b-a12b:free": {
     "context_window": 262144,
     "max_output": 235929
    },
    "nvidia/nemotron-3.5-content-safety": {
     "context_window": 131072,
     "max_output": 117964
    },
    "nvidia/nemotron-3.5-lightning:free": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "xiaomi/mimo-v2.6-pro": {
     "context_window": 1050000,
     "max_output": 131072
    },
    "xiaomi/mimo-v2.5": {
     "context_window": 1050000,
     "max_output": 131072
    },
    "xiaomi/mimo-v2.6-pro-ultraspeed": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "xiaomi/mimo-v2.5-pro": {
     "context_window": 1050000,
     "max_output": 131072
    },
    "xiaomi/mimo-v2.6-flash": {
     "context_window": 1050000,
     "max_output": 131072
    },
    "undi95/remm-slerp-l2-13b": {
     "context_window": 6144,
     "max_output": 5529
    },
    "gryphe/mythomax-l2-13b": {
     "context_window": 8192,
     "max_output": 3686
    },
    "minimax/minimax-m2.5": {
     "context_window": 204800,
     "max_output": 128000
    },
    "minimax/minimax-01": {
     "context_window": 1000192,
     "max_output": 40000
    },
    "minimax/minimax-m2-her": {
     "context_window": 65536,
     "max_output": 2048
    },
    "minimax/minimax-m2.7": {
     "context_window": 204800,
     "max_output": 176947
    },
    "minimax/minimax-m1": {
     "context_window": 1000000,
     "max_output": 40000
    },
    "minimax/minimax-m3": {
     "context_window": 1048576,
     "max_output": 512000
    },
    "minimax/minimax-m2.1": {
     "context_window": 204800,
     "max_output": 131072
    },
    "minimax/minimax-m2": {
     "context_window": 204800,
     "max_output": 176947
    },
    "mancer/weaver": {
     "context_window": 8000,
     "max_output": 6000
    },
    "stepfun/step-3.5-flash": {
     "context_window": 262144,
     "max_output": 65536
    },
    "stepfun/step-3.7-flash": {
     "context_window": 262144,
     "max_output": 230400
    },
    "dots-studio/dots-3-note-preview:free": {
     "context_window": 512000,
     "max_output": 460800
    },
    "inception/mercury-2.5": {
     "context_window": 260000,
     "max_output": 65536
    },
    "inception/mercury-2": {
     "context_window": 128000,
     "max_output": 50000
    },
    "amazon/nova-lite-v1": {
     "context_window": 300000,
     "max_output": 5120
    },
    "amazon/nova-2-lite-v1": {
     "context_window": 1000000,
     "max_output": 65535
    },
    "amazon/nova-pro-v1": {
     "context_window": 300000,
     "max_output": 5120
    },
    "amazon/nova-premier-v1": {
     "context_window": 1000000,
     "max_output": 32000
    },
    "amazon/nova-micro-v1": {
     "context_window": 128000,
     "max_output": 5120
    },
    "relace/relace-search": {
     "context_window": 256000,
     "max_output": 128000
    },
    "relace/relace-apply-3": {
     "context_window": 256000,
     "max_output": 128000
    },
    "aion-labs/aion-2.0": {
     "context_window": 131072,
     "max_output": 32768
    },
    "aion-labs/aion-rp-llama-3.1-8b": {
     "context_window": 32768,
     "max_output": 29491
    },
    "aion-labs/aion-3.0": {
     "context_window": 131072,
     "max_output": 32768
    },
    "aion-labs/aion-3.5": {
     "context_window": 262144,
     "max_output": 32768
    },
    "aion-labs/aion-3.5-mini": {
     "context_window": 262144,
     "max_output": 32768
    },
    "aion-labs/aion-3.0-mini": {
     "context_window": 131072,
     "max_output": 32768
    },
    "qwen/qwen3-235b-a22b-2507": {
     "context_window": 262144,
     "max_output": 235929
    },
    "qwen/qwen3-vl-235b-a22b-instruct": {
     "context_window": 262144,
     "max_output": 32768
    },
    "qwen/qwen3.7-max": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "qwen/qwen3.8-27b": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "qwen/qwen3-vl-235b-a22b-thinking": {
     "context_window": 131072,
     "max_output": 32768
    },
    "qwen/qwen3.8-2.4t-a95b": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "qwen/qwen3.5-27b": {
     "context_window": 262144,
     "max_output": 65536
    },
    "qwen/qwen3-next-80b-a3b-thinking": {
     "context_window": 262144,
     "max_output": 32768
    },
    "qwen/qwen3-coder-next": {
     "context_window": 262144,
     "max_output": 235929
    },
    "qwen/qwen3-coder": {
     "context_window": 262144,
     "max_output": 65536
    },
    "qwen/qwen3-32b": {
     "context_window": 131072,
     "max_output": 16384
    },
    "qwen/qwen-plus": {
     "context_window": 1000000,
     "max_output": 32768
    },
    "qwen/qwen3.7-flash": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "qwen/qwen3-max": {
     "context_window": 262144,
     "max_output": 65536
    },
    "qwen/qwen3-coder-30b-a3b-instruct": {
     "context_window": 262144,
     "max_output": 235929
    },
    "qwen/qwen3.8-omni-flash": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "qwen/qwen3-vl-30b-a3b-instruct": {
     "context_window": 262144,
     "max_output": 16384
    },
    "qwen/qwen3-235b-a22b-thinking-2507": {
     "context_window": 131072,
     "max_output": 117964
    },
    "qwen/qwen3-235b-a22b": {
     "context_window": 131072,
     "max_output": 8192
    },
    "qwen/qwen3.5-122b-a10b": {
     "context_window": 262144,
     "max_output": 65536
    },
    "qwen/qwen-plus-2025-07-28": {
     "context_window": 1000000,
     "max_output": 32768
    },
    "qwen/qwen3.6-35b-a3b": {
     "context_window": 262144,
     "max_output": 235929
    },
    "qwen/qwen3-next-80b-a3b-instruct": {
     "context_window": 262144,
     "max_output": 235929
    },
    "qwen/qwen3-vl-30b-a3b-thinking": {
     "context_window": 262144,
     "max_output": 32768
    },
    "qwen/qwen3.6-flash": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "qwen/qwen3-coder-flash": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "qwen/qwen-2.5-coder-32b-instruct": {
     "context_window": 32768,
     "max_output": 29491
    },
    "qwen/qwen3.5-flash-02-23": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "qwen/qwen3-max-thinking": {
     "context_window": 262144,
     "max_output": 65536
    },
    "qwen/qwen3-coder-plus": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "qwen/qwen3.5-9b": {
     "context_window": 262144,
     "max_output": 32768
    },
    "qwen/qwen3.8-max-prime": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "qwen/qwen3.5-plus-20260420": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "qwen/qwen3.8-flash": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "qwen/qwen3.5-35b-a3b": {
     "context_window": 262144,
     "max_output": 235929
    },
    "qwen/qwen3.6-max-preview": {
     "context_window": 262144,
     "max_output": 65536
    },
    "qwen/qwen3-30b-a3b": {
     "context_window": 131072,
     "max_output": 16384
    },
    "qwen/qwen3.5-397b-a17b": {
     "context_window": 262144,
     "max_output": 235929
    },
    "qwen/qwen3-8b": {
     "context_window": 131072,
     "max_output": 8192
    },
    "qwen/qwen3-vl-32b-instruct": {
     "context_window": 131072,
     "max_output": 32768
    },
    "qwen/qwen3-vl-8b-instruct": {
     "context_window": 262144,
     "max_output": 32768
    },
    "qwen/qwen3-30b-a3b-instruct-2507": {
     "context_window": 262144,
     "max_output": 32000
    },
    "qwen/qwen2.5-vl-72b-instruct": {
     "context_window": 128000,
     "max_output": 115200
    },
    "qwen/qwen-2.5-7b-instruct": {
     "context_window": 32768,
     "max_output": 29491
    },
    "qwen/qwen3.5-plus-02-15": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "qwen/qwen-2.5-72b-instruct": {
     "context_window": 32768,
     "max_output": 16384
    },
    "qwen/qwen3-30b-a3b-thinking-2507": {
     "context_window": 81920,
     "max_output": 32768
    },
    "qwen/qwen3.6-27b": {
     "context_window": 262144,
     "max_output": 262140
    },
    "qwen/qwen3.6-plus": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "qwen/qwen3-14b": {
     "context_window": 131072,
     "max_output": 16384
    },
    "qwen/qwen3-vl-8b-thinking": {
     "context_window": 131072,
     "max_output": 32768
    },
    "qwen/qwen3.7-plus": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "qwen/qwen3.8-27b:free": {
     "context_window": 262144,
     "max_output": 235929
    },
    "qwen/qwen3.8-max-0902": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "morph/morph-v3-large": {
     "context_window": 262144,
     "max_output": 131072
    },
    "morph/morph-v3-fast": {
     "context_window": 81920,
     "max_output": 38000
    },
    "openai/gpt-5.4": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-5.4-image-2": {
     "context_window": 272000,
     "max_output": 128000
    },
    "openai/gpt-5.4-pro": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-audio": {
     "context_window": 128000,
     "max_output": 16384
    },
    "openai/gpt-3.5-turbo": {
     "context_window": 16385,
     "max_output": 4096
    },
    "openai/gpt-6-astra-pro": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-5.5-pro": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-5.4-nano": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-4o-2024-05-13": {
     "context_window": 128000,
     "max_output": 4096
    },
    "openai/gpt-4o-mini-2024-07-18": {
     "context_window": 128000,
     "max_output": 16384
    },
    "openai/gpt-5.2-codex": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-5.1-codex": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-4o": {
     "context_window": 128000,
     "max_output": 16384
    },
    "openai/gpt-chat-latest": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-audio-mini": {
     "context_window": 128000,
     "max_output": 16384
    },
    "openai/gpt-5.6-sol-pro": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-5-mini": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-5.2-pro": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/o4-mini": {
     "context_window": 200000,
     "max_output": 100000
    },
    "openai/o3-mini": {
     "context_window": 200000,
     "max_output": 100000
    },
    "openai/gpt-4": {
     "context_window": 8191,
     "max_output": 4096
    },
    "openai/gpt-5.3-codex": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-4.1-nano": {
     "context_window": 1047576,
     "max_output": 32768
    },
    "openai/gpt-5-nano": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/o1": {
     "context_window": 200000,
     "max_output": 100000
    },
    "openai/gpt-5-pro": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-3.5-turbo-instruct": {
     "context_window": 4095,
     "max_output": 3685
    },
    "openai/gpt-6.1-sol": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-4o-2024-08-06": {
     "context_window": 128000,
     "max_output": 16384
    },
    "openai/gpt-6-astra": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-5.6-luna-pro": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-5.1": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-5-image-mini": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-4o-mini": {
     "context_window": 128000,
     "max_output": 16384
    },
    "openai/o3-pro": {
     "context_window": 200000,
     "max_output": 100000
    },
    "openai/gpt-oss-20b": {
     "context_window": 131072,
     "max_output": 32768
    },
    "openai/gpt-oss-safeguard-20b": {
     "context_window": 131072,
     "max_output": 65536
    },
    "openai/o3-mini-high": {
     "context_window": 200000,
     "max_output": 100000
    },
    "openai/gpt-3.5-turbo-16k": {
     "context_window": 16385,
     "max_output": 4096
    },
    "openai/gpt-5.2-chat": {
     "context_window": 128000,
     "max_output": 32000
    },
    "openai/gpt-6-sol-pro": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-5-image": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-5.4-mini": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-5.6-luna": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-5.1-codex-max": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-5.2": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-5.5": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-4.1": {
     "context_window": 1047576,
     "max_output": 32768
    },
    "openai/gpt-4o-2024-11-20": {
     "context_window": 128000,
     "max_output": 16384
    },
    "openai/gpt-3.5-turbo-0613": {
     "context_window": 4095,
     "max_output": 3685
    },
    "openai/gpt-4.1-mini": {
     "context_window": 1047576,
     "max_output": 32768
    },
    "openai/gpt-5.6-terra-pro": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-6-luna": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-6.1-sol-pro": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/o4-mini-high": {
     "context_window": 200000,
     "max_output": 100000
    },
    "openai/gpt-6-luna-pro": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-5.6-terra": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-4-turbo": {
     "context_window": 128000,
     "max_output": 4096
    },
    "openai/gpt-oss-120b": {
     "context_window": 131072,
     "max_output": 117964
    },
    "openai/gpt-5.1-codex-mini": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/o3": {
     "context_window": 200000,
     "max_output": 100000
    },
    "openai/gpt-5": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-5.6-sol": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-6-sol": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/o1-pro": {
     "context_window": 200000,
     "max_output": 100000
    },
    "microsoft/phi-4": {
     "context_window": 16384,
     "max_output": 14745
    },
    "microsoft/wizardlm-2-8x22b": {
     "context_window": 65535,
     "max_output": 8000
    }
   }
  },
  "perplexity": {
   "api": null,
   "models": {
    "sonar-pro": {
     "context_window": 200000,
     "max_output": 8192
    },
    "sonar-deep-research": {
     "context_window": 128000,
     "max_output": 32768
    },
    "sonar": {
     "context_window": 128000,
     "max_output": 4096
    },
    "sonar-reasoning-pro": {
     "context_window": 128000,
     "max_output": 4096
    }
   }
  },
  "iteracompute": {
   "api": "https://api.iteracompute.com/v1",
   "models": {
    "deepseek/deepseek-v4-flash-0731": {
     "context_window": 970000,
     "max_output": 393216
    },
    "deepseek/deepseek-v4-pro-0813": {
     "context_window": 1048576,
     "max_output": 393216
    },
    "z-ai/glm-5.3-flash": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "z-ai/glm-5.3": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "moonshotai/kimi-k3": {
     "context_window": 1048576,
     "max_output": 999999
    },
    "minimax/minimax-m3": {
     "context_window": 1048576,
     "max_output": 524288
    },
    "ornith-ai/ornith-1.5-35b-a3b": {
     "context_window": 327680,
     "max_output": 65536
    },
    "qwen/qwen3.8-27b": {
     "context_window": 327680,
     "max_output": 65536
    },
    "qwen/qwen3.8-2.4t-a95b": {
     "context_window": 970000,
     "max_output": 131072
    }
   }
  },
  "the-grid-ai": {
   "api": "https://api.thegrid.ai/v1",
   "models": {
    "agent-prime": {
     "context_window": 196608,
     "max_output": 30000
    },
    "code-max": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "agent-max": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "text-max": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "code-prime": {
     "context_window": 196608,
     "max_output": 30000
    },
    "text-prime": {
     "context_window": 196608,
     "max_output": 30000
    },
    "code-standard": {
     "context_window": 128000,
     "max_output": 16000
    },
    "text-standard": {
     "context_window": 128000,
     "max_output": 16000
    },
    "agent-standard": {
     "context_window": 128000,
     "max_output": 16000
    }
   }
  },
  "meta": {
   "api": "https://api.meta.ai/v1",
   "models": {
    "muse-spark-1.3": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "muse-spark-1.1": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "muse-spark-1.2": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "muse-spark-1.2-contributor": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "muse-spark-1.3-contributor": {
     "context_window": 1048576,
     "max_output": 131072
    }
   }
  },
  "cline-pass": {
   "api": "https://api.cline.bot/api/v1",
   "models": {
    "cline-pass/mimo-v2.6-pro": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "cline-pass/qwen3.7-max": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "cline-pass/mimo-v2.5": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "cline-pass/glm-5.3-flash": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "cline-pass/qwen3.8-max": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "cline-pass/kimi-k3": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "cline-pass/deepseek-v4.1-flash": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "cline-pass/kimi-k2.6": {
     "context_window": 262144,
     "max_output": 262144
    },
    "cline-pass/mimo-v2.5-pro": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "cline-pass/mimo-v2.6-flash": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "cline-pass/minimax-m3": {
     "context_window": 1048576,
     "max_output": 512000
    },
    "cline-pass/glm-5.2": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "cline-pass/deepseek-v4-pro": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "cline-pass/muse-spark-1.3-contributor": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "cline-pass/glm-5.3": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "cline-pass/kimi-k2.7-code": {
     "context_window": 262144,
     "max_output": 262144
    },
    "cline-pass/qwen3.7-plus": {
     "context_window": 1000000,
     "max_output": 64000
    },
    "cline-pass/deepseek-v4-flash": {
     "context_window": 1000000,
     "max_output": 384000
    }
   }
  },
  "modal": {
   "api": "https://inference.us-west.modal.direct/v1",
   "models": {
    "thinkingmachines/Inkling-NVFP4": {
     "context_window": 1048576,
     "max_output": 262144
    },
    "Qwen/Qwen3.8-2.4T-A95B": {
     "context_window": 1010000,
     "max_output": 131072
    },
    "moonshotai/Kimi-K3": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "zai-org/GLM-5.3-Flash": {
     "context_window": 1000000,
     "max_output": 131072
    }
   }
  },
  "coralbricks": {
   "api": "https://inference.coralbricks.ai/v1",
   "models": {
    "glm-5.3-fp4": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "glm-5.3-flash-fp4": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "deepseek-v4.1-flash-fast": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "glm-5.3-fast": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "deepseek-v4.1-flash-fast-fp4": {
     "context_window": 1048576,
     "max_output": 131072
    }
   }
  },
  "routing-run": {
   "api": "https://api.routing.run/v1",
   "models": {
    "nemotron-3-ultra": {
     "context_window": 131072,
     "max_output": 32000
    },
    "kimi-k2.6": {
     "context_window": 200000,
     "max_output": 32000
    },
    "qwen3.5-9b": {
     "context_window": 262144,
     "max_output": 32000
    },
    "gpt-5.6-luna": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "claude-opus-4-8": {
     "context_window": 1000000,
     "max_output": 32000
    },
    "glm-5.2-nitro": {
     "context_window": 200000,
     "max_output": 32000
    },
    "glm-5.2": {
     "context_window": 200000,
     "max_output": 32000
    },
    "kimi-k2.6-nitro": {
     "context_window": 200000,
     "max_output": 32000
    },
    "deepseek-v4-pro": {
     "context_window": 1000000,
     "max_output": 64000
    },
    "claude-sonnet-4-6": {
     "context_window": 1000000,
     "max_output": 64000
    },
    "kimi-k2.7-code-nitro": {
     "context_window": 200000,
     "max_output": 32000
    },
    "gpt-5.6-terra": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "kimi-k2.7-code": {
     "context_window": 200000,
     "max_output": 32000
    },
    "gpt-5.6-sol": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "deepseek-v4-flash": {
     "context_window": 1000000,
     "max_output": 64000
    }
   }
  },
  "echo": {
   "api": "https://echo.tracerml.ai/v1",
   "models": {
    "echo": {
     "context_window": 262144,
     "max_output": 65536
    }
   }
  },
  "neuralwatt": {
   "api": "https://api.neuralwatt.com/v1",
   "models": {
    "glm-5.2-short-fast": {
     "context_window": 199984,
     "max_output": 32000
    },
    "kimi-k3-flex": {
     "context_window": 1048560,
     "max_output": 1048560
    },
    "deepseek-v4-flash-flex": {
     "context_window": 1048560,
     "max_output": 393216
    },
    "glm-5.3-flash": {
     "context_window": 1048560,
     "max_output": 1048560
    },
    "glm-5.2-short-flex": {
     "context_window": 199984,
     "max_output": 32000
    },
    "qwen3.6-35b": {
     "context_window": 131056,
     "max_output": 131056
    },
    "glm-5.2-fast": {
     "context_window": 1048560,
     "max_output": 1048560
    },
    "kimi-k3": {
     "context_window": 1048560,
     "max_output": 1048560
    },
    "deepseek-v4.1-flash": {
     "context_window": 1048560,
     "max_output": 393216
    },
    "kimi-k3-fast": {
     "context_window": 1048560,
     "max_output": 1048560
    },
    "qwen3.6-35b-flex": {
     "context_window": 131056,
     "max_output": 131056
    },
    "qwen-3.8-27b": {
     "context_window": 262128,
     "max_output": 131072
    },
    "glm-5.2-short": {
     "context_window": 199984,
     "max_output": 32000
    },
    "glm-5.3-flash-flex": {
     "context_window": 1048560,
     "max_output": 1048560
    },
    "qwen3.6-35b-fast": {
     "context_window": 131056,
     "max_output": 131056
    },
    "glm-5.2-flex": {
     "context_window": 1048560,
     "max_output": 1048560
    },
    "deepseek-v4-flash-speed": {
     "context_window": 1048560,
     "max_output": 393216
    },
    "glm-5.2": {
     "context_window": 1048560,
     "max_output": 1048560
    },
    "glm-5.2-short-fast-flex": {
     "context_window": 199984,
     "max_output": 32000
    },
    "kimi-k2.7-code-fast": {
     "context_window": 262128,
     "max_output": 262128
    },
    "gemma-4-31b": {
     "context_window": 262128,
     "max_output": 16384
    },
    "glm-5.3-flex": {
     "context_window": 1048560,
     "max_output": 1048560
    },
    "deepseek-v4-pro": {
     "context_window": 1048560,
     "max_output": 393216
    },
    "qwen-3.8-27b-flex": {
     "context_window": 262128,
     "max_output": 131072
    },
    "kimi-k2.7-code-flex": {
     "context_window": 262128,
     "max_output": 262128
    },
    "glm-5.3": {
     "context_window": 1048560,
     "max_output": 1048560
    },
    "kimi-k2.7-code": {
     "context_window": 262128,
     "max_output": 262128
    },
    "deepseek-v4.1-flash-flex": {
     "context_window": 1048560,
     "max_output": 393216
    },
    "deepseek-v4-flash": {
     "context_window": 1048560,
     "max_output": 393216
    }
   }
  },
  "gitlab": {
   "api": null,
   "models": {
    "duo-chat-gpt-5-4-nano": {
     "context_window": 400000,
     "max_output": 128000
    },
    "duo-chat-opus-5-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "duo-chat-gpt-6-1-sol": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "duo-chat-sonnet-5-5": {
     "context_window": 1000000,
     "max_output": 64000
    },
    "duo-chat-gpt-6-astra": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "duo-chat-opus-4-5": {
     "context_window": 200000,
     "max_output": 64000
    },
    "duo-chat-gpt-5-mini": {
     "context_window": 400000,
     "max_output": 128000
    },
    "duo-chat-gpt-6-luna": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "duo-chat-sonnet-4-5": {
     "context_window": 200000,
     "max_output": 64000
    },
    "duo-chat-gpt-5-6-sol": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "duo-chat-sonnet-4-6": {
     "context_window": 1000000,
     "max_output": 64000
    },
    "duo-chat-gpt-5-4-mini": {
     "context_window": 400000,
     "max_output": 128000
    },
    "duo-chat-haiku-4-5": {
     "context_window": 200000,
     "max_output": 64000
    },
    "duo-chat-fable-5-1": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "duo-chat-gpt-5-5": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "duo-chat-fable-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "duo-chat-gpt-5-3-codex": {
     "context_window": 400000,
     "max_output": 128000
    },
    "duo-chat-gpt-5-1": {
     "context_window": 400000,
     "max_output": 128000
    },
    "duo-chat-gpt-6-sol": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "duo-chat-opus-4-7": {
     "context_window": 1000000,
     "max_output": 64000
    },
    "duo-chat-gpt-5-2": {
     "context_window": 400000,
     "max_output": 128000
    },
    "duo-chat-opus-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "duo-chat-opus-4-6": {
     "context_window": 1000000,
     "max_output": 64000
    },
    "duo-chat-gpt-5-6-luna": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "duo-chat-gpt-5-codex": {
     "context_window": 400000,
     "max_output": 128000
    },
    "duo-chat-sonnet-5": {
     "context_window": 1000000,
     "max_output": 64000
    },
    "duo-chat-opus-4-8": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "duo-chat-gpt-5-2-codex": {
     "context_window": 400000,
     "max_output": 128000
    },
    "duo-chat-gpt-5-4": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "duo-chat-gpt-5-6-terra": {
     "context_window": 1050000,
     "max_output": 128000
    }
   }
  },
  "infer": {
   "api": "https://infer.flow7.org/v1",
   "models": {
    "infer/gpt-6-astra:official": {
     "context_window": 271999,
     "max_output": 128000
    },
    "infer/gpt-5.6-sol:official": {
     "context_window": 271999,
     "max_output": 128000
    }
   }
  },
  "azure": {
   "api": null,
   "models": {
    "grok-4-1-fast-reasoning": {
     "context_window": 128000,
     "max_output": 8192
    },
    "gpt-5.4": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "deepseek-v3.2-speciale": {
     "context_window": 128000,
     "max_output": 128000
    },
    "claude-haiku-4-5": {
     "context_window": 200000,
     "max_output": 64000
    },
    "gpt-5.4-pro": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "grok-4-1-fast-non-reasoning": {
     "context_window": 128000,
     "max_output": 8192
    },
    "phi-4-reasoning": {
     "context_window": 32000,
     "max_output": 4096
    },
    "text-embedding-3-small": {
     "context_window": 8192,
     "max_output": 1536
    },
    "gpt-5.4-nano": {
     "context_window": 400000,
     "max_output": 128000
    },
    "gpt-5.2-codex": {
     "context_window": 400000,
     "max_output": 128000
    },
    "gpt-5.1-codex": {
     "context_window": 400000,
     "max_output": 128000
    },
    "gpt-4o": {
     "context_window": 128000,
     "max_output": 16384
    },
    "ministral-3b": {
     "context_window": 128000,
     "max_output": 8192
    },
    "gpt-chat-latest": {
     "context_window": 400000,
     "max_output": 128000
    },
    "gpt-5-codex": {
     "context_window": 400000,
     "max_output": 128000
    },
    "gpt-5-mini": {
     "context_window": 400000,
     "max_output": 128000
    },
    "o4-mini": {
     "context_window": 200000,
     "max_output": 100000
    },
    "llama-4-maverick-17b-128e-instruct-fp8": {
     "context_window": 1000000,
     "max_output": 16384
    },
    "o3-mini": {
     "context_window": 200000,
     "max_output": 100000
    },
    "claude-opus-4-5": {
     "context_window": 200000,
     "max_output": 64000
    },
    "text-embedding-ada-002": {
     "context_window": 8192,
     "max_output": 1536
    },
    "gpt-5.3-codex": {
     "context_window": 400000,
     "max_output": 128000
    },
    "gpt-4.1-nano": {
     "context_window": 1047576,
     "max_output": 32768
    },
    "gpt-5-nano": {
     "context_window": 400000,
     "max_output": 128000
    },
    "phi-4-multimodal": {
     "context_window": 128000,
     "max_output": 4096
    },
    "kimi-k2.6": {
     "context_window": 262144,
     "max_output": 262144
    },
    "claude-sonnet-4-5": {
     "context_window": 200000,
     "max_output": 64000
    },
    "claude-opus-5-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "claude-fable-5-1": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "mistral-medium-2505": {
     "context_window": 128000,
     "max_output": 128000
    },
    "cohere-embed-v3-multilingual": {
     "max_output": 1024
    },
    "o1": {
     "context_window": 200000,
     "max_output": 100000
    },
    "codex-mini": {
     "context_window": 200000,
     "max_output": 100000
    },
    "phi-4-reasoning-plus": {
     "context_window": 32000,
     "max_output": 4096
    },
    "claude-mythos-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "gpt-5-pro": {
     "context_window": 400000,
     "max_output": 128000
    },
    "gpt-3.5-turbo-instruct": {
     "context_window": 4096,
     "max_output": 4096
    },
    "gpt-3.5-turbo-0125": {
     "context_window": 16384,
     "max_output": 4096
    },
    "gpt-6.1-sol": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "text-embedding-3-large": {
     "context_window": 8192,
     "max_output": 3072
    },
    "claude-opus-4-1": {
     "context_window": 200000,
     "max_output": 32000
    },
    "cohere-embed-v-4-0": {
     "context_window": 128000,
     "max_output": 1536
    },
    "gpt-6-astra": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "codestral-2501": {
     "context_window": 256000,
     "max_output": 256000
    },
    "kimi-k2.5": {
     "context_window": 262144,
     "max_output": 262144
    },
    "gpt-5.1": {
     "context_window": 400000,
     "max_output": 128000
    },
    "claude-opus-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "llama-3.3-70b-instruct": {
     "context_window": 128000,
     "max_output": 32768
    },
    "gpt-4o-mini": {
     "context_window": 128000,
     "max_output": 16384
    },
    "cohere-command-a": {
     "context_window": 131072,
     "max_output": 8192
    },
    "cohere-embed-v3-english": {
     "max_output": 1024
    },
    "model-router": {
     "context_window": 200000,
     "max_output": 16384
    },
    "claude-fable-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "gpt-5.4-mini": {
     "context_window": 400000,
     "max_output": 128000
    },
    "gpt-5.6-luna": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "gpt-5.1-codex-max": {
     "context_window": 400000,
     "max_output": 128000
    },
    "gpt-5.2": {
     "context_window": 400000,
     "max_output": 128000
    },
    "claude-opus-4-8": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "phi-4": {
     "context_window": 128000,
     "max_output": 4096
    },
    "gpt-5.5": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "mistral-small-2503": {
     "context_window": 128000,
     "max_output": 32768
    },
    "phi-4-mini-reasoning": {
     "context_window": 128000,
     "max_output": 4096
    },
    "gpt-4.1": {
     "context_window": 1047576,
     "max_output": 32768
    },
    "claude-sonnet-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "claude-opus-4-6": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "gpt-4-turbo-vision": {
     "context_window": 128000,
     "max_output": 4096
    },
    "grok-4-20-non-reasoning": {
     "context_window": 262000,
     "max_output": 8192
    },
    "gpt-3.5-turbo-1106": {
     "context_window": 16384,
     "max_output": 4096
    },
    "gpt-4.1-mini": {
     "context_window": 1047576,
     "max_output": 32768
    },
    "gpt-6-luna": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "deepseek-r1": {
     "context_window": 163840,
     "max_output": 163840
    },
    "deepseek-v4-pro": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "claude-sonnet-4-6": {
     "context_window": 1000000,
     "max_output": 64000
    },
    "llama-4-scout-17b-16e-instruct": {
     "context_window": 128000,
     "max_output": 8192
    },
    "claude-sonnet-5-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "grok-4-20-reasoning": {
     "context_window": 262000,
     "max_output": 8192
    },
    "gpt-5.6-terra": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "deepseek-v3.2": {
     "context_window": 128000,
     "max_output": 128000
    },
    "gpt-4-turbo": {
     "context_window": 128000,
     "max_output": 4096
    },
    "gpt-5.1-codex-mini": {
     "context_window": 400000,
     "max_output": 128000
    },
    "o3": {
     "context_window": 200000,
     "max_output": 100000
    },
    "claude-opus-4-7": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "kimi-k2.7-code": {
     "context_window": 262144,
     "max_output": 262144
    },
    "gpt-5": {
     "context_window": 400000,
     "max_output": 128000
    },
    "grok-4.6": {
     "context_window": 200000,
     "max_output": 128000
    },
    "gpt-5.6-sol": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "phi-4-mini": {
     "context_window": 128000,
     "max_output": 4096
    },
    "deepseek-v4-flash": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "gpt-6-sol": {
     "context_window": 1050000,
     "max_output": 128000
    }
   }
  },
  "freemodel": {
   "api": "https://cc.freemodel.dev/v1",
   "models": {
    "gpt-5.4": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "gpt-5.3-codex": {
     "context_window": 400000,
     "max_output": 128000
    },
    "claude-fable-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "gpt-5.4-mini": {
     "context_window": 400000,
     "max_output": 128000
    },
    "claude-opus-4-8": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "gpt-5.5": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "claude-opus-4-6": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "claude-haiku-4-5-20251001": {
     "context_window": 200000,
     "max_output": 64000
    },
    "claude-sonnet-4-6": {
     "context_window": 1000000,
     "max_output": 64000
    },
    "claude-opus-4-7": {
     "context_window": 1000000,
     "max_output": 128000
    }
   }
  },
  "azure-cognitive-services": {
   "api": null,
   "models": {
    "gpt-5.4": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "claude-haiku-4-5": {
     "context_window": 200000,
     "max_output": 64000
    },
    "gpt-5.4-pro": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "gpt-5.4-nano": {
     "context_window": 400000,
     "max_output": 128000
    },
    "gpt-chat-latest": {
     "context_window": 400000,
     "max_output": 128000
    },
    "claude-opus-4-5": {
     "context_window": 200000,
     "max_output": 64000
    },
    "kimi-k2.6": {
     "context_window": 262144,
     "max_output": 262144
    },
    "claude-sonnet-4-5": {
     "context_window": 200000,
     "max_output": 64000
    },
    "claude-opus-5-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "claude-fable-5-1": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "claude-mythos-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "gpt-6.1-sol": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "claude-opus-4-1": {
     "context_window": 200000,
     "max_output": 32000
    },
    "kimi-k2.5": {
     "context_window": 262144,
     "max_output": 262144
    },
    "claude-opus-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "claude-fable-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "gpt-5.4-mini": {
     "context_window": 400000,
     "max_output": 128000
    },
    "gpt-5.6-luna": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "claude-opus-4-8": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "claude-sonnet-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "claude-opus-4-6": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "claude-sonnet-4-6": {
     "context_window": 1000000,
     "max_output": 64000
    },
    "claude-sonnet-5-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "gpt-5.6-terra": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "claude-opus-4-7": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "gpt-5.6-sol": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "gpt-6-sol": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "phi-4-mini": {
     "context_window": 128000,
     "max_output": 4096
    },
    "gpt-5": {
     "context_window": 400000,
     "max_output": 128000
    },
    "o3": {
     "context_window": 200000,
     "max_output": 100000
    },
    "gpt-5.1-codex-mini": {
     "context_window": 400000,
     "max_output": 128000
    },
    "gpt-4-turbo": {
     "context_window": 128000,
     "max_output": 4096
    },
    "deepseek-v3.2": {
     "context_window": 128000,
     "max_output": 128000
    },
    "llama-4-scout-17b-16e-instruct": {
     "context_window": 128000,
     "max_output": 8192
    },
    "deepseek-r1": {
     "context_window": 163840,
     "max_output": 163840
    },
    "gpt-6-luna": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "gpt-4.1-mini": {
     "context_window": 1047576,
     "max_output": 32768
    },
    "gpt-3.5-turbo-1106": {
     "context_window": 16384,
     "max_output": 4096
    },
    "gpt-4-turbo-vision": {
     "context_window": 128000,
     "max_output": 4096
    },
    "gpt-4.1": {
     "context_window": 1047576,
     "max_output": 32768
    },
    "phi-4-mini-reasoning": {
     "context_window": 128000,
     "max_output": 4096
    },
    "mistral-small-2503": {
     "context_window": 128000,
     "max_output": 32768
    },
    "gpt-5.5": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "phi-4": {
     "context_window": 128000,
     "max_output": 4096
    },
    "gpt-5.2": {
     "context_window": 400000,
     "max_output": 128000
    },
    "gpt-5.1-codex-max": {
     "context_window": 400000,
     "max_output": 128000
    },
    "model-router": {
     "context_window": 200000,
     "max_output": 16384
    },
    "cohere-embed-v3-english": {
     "max_output": 1024
    },
    "cohere-command-a": {
     "context_window": 131072,
     "max_output": 8192
    },
    "gpt-4o-mini": {
     "context_window": 128000,
     "max_output": 16384
    },
    "llama-3.3-70b-instruct": {
     "context_window": 128000,
     "max_output": 32768
    },
    "gpt-5.1": {
     "context_window": 400000,
     "max_output": 128000
    },
    "codestral-2501": {
     "context_window": 256000,
     "max_output": 256000
    },
    "gpt-6-astra": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "cohere-embed-v-4-0": {
     "context_window": 128000,
     "max_output": 1536
    },
    "text-embedding-3-large": {
     "context_window": 8192,
     "max_output": 3072
    },
    "gpt-3.5-turbo-0125": {
     "context_window": 16384,
     "max_output": 4096
    },
    "gpt-3.5-turbo-instruct": {
     "context_window": 4096,
     "max_output": 4096
    },
    "gpt-5-pro": {
     "context_window": 400000,
     "max_output": 128000
    },
    "phi-4-reasoning-plus": {
     "context_window": 32000,
     "max_output": 4096
    },
    "codex-mini": {
     "context_window": 200000,
     "max_output": 100000
    },
    "o1": {
     "context_window": 200000,
     "max_output": 100000
    },
    "cohere-embed-v3-multilingual": {
     "max_output": 1024
    },
    "mistral-medium-2505": {
     "context_window": 128000,
     "max_output": 128000
    },
    "phi-4-multimodal": {
     "context_window": 128000,
     "max_output": 4096
    },
    "gpt-5-nano": {
     "context_window": 400000,
     "max_output": 128000
    },
    "gpt-4.1-nano": {
     "context_window": 1047576,
     "max_output": 32768
    },
    "gpt-5.3-codex": {
     "context_window": 400000,
     "max_output": 128000
    },
    "text-embedding-ada-002": {
     "context_window": 8192,
     "max_output": 1536
    },
    "o3-mini": {
     "context_window": 200000,
     "max_output": 100000
    },
    "llama-4-maverick-17b-128e-instruct-fp8": {
     "context_window": 1000000,
     "max_output": 16384
    },
    "o4-mini": {
     "context_window": 200000,
     "max_output": 100000
    },
    "gpt-5-mini": {
     "context_window": 400000,
     "max_output": 128000
    },
    "gpt-5-codex": {
     "context_window": 400000,
     "max_output": 128000
    },
    "ministral-3b": {
     "context_window": 128000,
     "max_output": 8192
    },
    "gpt-4o": {
     "context_window": 128000,
     "max_output": 16384
    },
    "gpt-5.1-codex": {
     "context_window": 400000,
     "max_output": 128000
    },
    "gpt-5.2-codex": {
     "context_window": 400000,
     "max_output": 128000
    },
    "text-embedding-3-small": {
     "context_window": 8192,
     "max_output": 1536
    },
    "phi-4-reasoning": {
     "context_window": 32000,
     "max_output": 4096
    },
    "deepseek-v3.2-speciale": {
     "context_window": 128000,
     "max_output": 128000
    }
   }
  },
  "pendra": {
   "api": "https://api.pendra.ai/api/v1",
   "models": {
    "llama3.3:70b": {
     "context_window": 128000,
     "max_output": 4096
    },
    "qwen3-coder:30b": {
     "context_window": 262144,
     "max_output": 65536
    },
    "gpt-oss:120b": {
     "context_window": 131072,
     "max_output": 32768
    },
    "qwen3.6:27b": {
     "context_window": 262144,
     "max_output": 65536
    },
    "glm-4.7-flash": {
     "context_window": 200000,
     "max_output": 131072
    },
    "deepseek-v4-flash": {
     "context_window": 1000000,
     "max_output": 384000
    }
   }
  },
  "moark": {
   "api": "https://moark.com/v1",
   "models": {
    "GLM-4.7": {
     "context_window": 204800,
     "max_output": 131072
    },
    "MiniMax-M2.1": {
     "context_window": 204800,
     "max_output": 131072
    }
   }
  },
  "atomic-chat": {
   "api": "http://127.0.0.1:1337/v1",
   "models": {
    "gemma-4-E4B-it-MLX-4bit": {
     "context_window": 32768,
     "max_output": 8192
    },
    "Meta-Llama-3_1-8B-Instruct-GGUF": {
     "context_window": 131072,
     "max_output": 4096
    },
    "Qwen3_5-9B-Q4_K_M": {
     "context_window": 32768,
     "max_output": 8192
    },
    "gemma-4-E4B-it-IQ4_XS": {
     "context_window": 32768,
     "max_output": 8192
    },
    "Qwen3_5-9B-MLX-4bit": {
     "context_window": 32768,
     "max_output": 8192
    }
   }
  },
  "qihang-ai": {
   "api": "https://api.qhaigc.net/v1",
   "models": {
    "gpt-5.2-codex": {
     "context_window": 400000,
     "max_output": 128000
    },
    "gemini-3-pro-preview": {
     "context_window": 1000000,
     "max_output": 65000
    },
    "gpt-5-mini": {
     "context_window": 200000,
     "max_output": 64000
    },
    "claude-opus-4-5-20251101": {
     "context_window": 200000,
     "max_output": 32000
    },
    "gemini-2.5-flash": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "gpt-5.2": {
     "context_window": 400000,
     "max_output": 128000
    },
    "claude-sonnet-4-5-20250929": {
     "context_window": 200000,
     "max_output": 64000
    },
    "gemini-3-flash-preview": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "claude-haiku-4-5-20251001": {
     "context_window": 200000,
     "max_output": 64000
    }
   }
  },
  "ai-router": {
   "api": "https://api.ai-router.dev/v1",
   "models": {
    "gpt-5.4": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "gpt-5.6-luna": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "gpt-5.5": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "gpt-5.6-terra": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "gpt-5.6-sol": {
     "context_window": 1050000,
     "max_output": 128000
    }
   }
  },
  "llmtr": {
   "api": "https://llmtr.com/v1",
   "models": {
    "muse-glimmer-30b-tr": {
     "context_window": 131072,
     "max_output": 131072
    },
    "magibu-11b-v8": {
     "context_window": 8192,
     "max_output": 8192
    },
    "gemma-4": {
     "context_window": 131072,
     "max_output": 131072
    },
    "trendyol-asure-12b": {
     "context_window": 40960,
     "max_output": 40960
    },
    "medgemma-4b": {
     "context_window": 8192,
     "max_output": 8192
    },
    "qwen3-6-35b": {
     "context_window": 16384,
     "max_output": 16384
    },
    "poolside/laguna-xs-2.1": {
     "context_window": 262144,
     "max_output": 32768
    },
    "publicai/apertus-70b-instruct": {
     "context_window": 65536,
     "max_output": 8192
    },
    "publicai/apertus-8b-instruct": {
     "context_window": 65536,
     "max_output": 8192
    },
    "thinkingmachines/inkling-small": {
     "context_window": 262144,
     "max_output": 262144
    },
    "thinkingmachines/inkling": {
     "context_window": 262144,
     "max_output": 262144
    },
    "perplexity/sonar-deep-research": {
     "context_window": 128000,
     "max_output": 32768
    },
    "meta/muse-spark-1.2-contributor": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "upstage/solar-pro4": {
     "context_window": 524288,
     "max_output": 131072
    },
    "upstage/solar-pro3": {
     "context_window": 131072,
     "max_output": 8192
    },
    "upstage/solar-pro2": {
     "context_window": 65536,
     "max_output": 8192
    },
    "google/gemini-2.5-flash-lite": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "mimo/mimo-v2.5": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "mimo/mimo-v2.5-pro": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "sakana/fugu-ultra": {
     "context_window": 1000000,
     "max_output": 1000000
    },
    "mistral/voxtral-small-latest": {
     "context_window": 32000,
     "max_output": 32000
    },
    "qwen/qwen-flash": {
     "context_window": 1000000,
     "max_output": 32768
    },
    "qwen/qwen3-vl-plus": {
     "context_window": 256000,
     "max_output": 32768
    },
    "qwen/qwen3.5-plus": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "qwen/qwen-plus": {
     "context_window": 1000000,
     "max_output": 32768
    },
    "qwen/qwen3-max": {
     "context_window": 256000,
     "max_output": 65536
    },
    "qwen/qwen3.6-flash": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "qwen/qwen3-coder-flash": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "qwen/qwen3-coder-plus": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "qwen/qwen3.5-397b-a17b": {
     "context_window": 256000,
     "max_output": 65536
    },
    "qwen/qwen3.6-plus": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "qwen/qwen3.7-plus": {
     "context_window": 1000000,
     "max_output": 64000
    }
   }
  },
  "alibaba": {
   "api": "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
   "models": {
    "qwen-flash": {
     "context_window": 1000000,
     "max_output": 32768
    },
    "qwen3.5-flash": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "qwen3.7-max": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "qwen2-5-32b-instruct": {
     "context_window": 131072,
     "max_output": 8192
    },
    "qwq-plus": {
     "context_window": 131072,
     "max_output": 8192
    },
    "qwen2-5-vl-72b-instruct": {
     "context_window": 131072,
     "max_output": 8192
    },
    "qwen3-vl-plus": {
     "context_window": 262144,
     "max_output": 32768
    },
    "qwen3.5-27b": {
     "context_window": 262144,
     "max_output": 65536
    },
    "deepseek-v4-flash-0731": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "qwen-max": {
     "context_window": 32768,
     "max_output": 8192
    },
    "qwen3-next-80b-a3b-thinking": {
     "context_window": 131072,
     "max_output": 32768
    },
    "qwen3.8-max": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "kimi-k3": {
     "context_window": 1048576,
     "max_output": 1048576
    },
    "qwen-plus-character-ja": {
     "context_window": 8192,
     "max_output": 512
    },
    "qwen3.5-plus": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "qwen3-livetranslate-flash-realtime": {
     "context_window": 53248,
     "max_output": 4096
    },
    "qwen2-5-72b-instruct": {
     "context_window": 131072,
     "max_output": 8192
    },
    "qwen3-32b": {
     "context_window": 131072,
     "max_output": 16384
    },
    "qwen-plus": {
     "context_window": 1000000,
     "max_output": 32768
    },
    "qwen3.7-flash": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "qwen3-max": {
     "context_window": 262144,
     "max_output": 65536
    },
    "qwen-omni-turbo-realtime": {
     "context_window": 32768,
     "max_output": 2048
    },
    "qwen3-coder-480b-a35b-instruct": {
     "context_window": 262144,
     "max_output": 65536
    },
    "qwen-turbo": {
     "context_window": 1000000,
     "max_output": 16384
    },
    "qwen3-coder-30b-a3b-instruct": {
     "context_window": 262144,
     "max_output": 65536
    },
    "qwen3.8-omni-flash": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "qvq-max": {
     "context_window": 131072,
     "max_output": 8192
    },
    "qwen2-5-7b-instruct": {
     "context_window": 131072,
     "max_output": 8192
    },
    "qwen3-omni-flash": {
     "context_window": 65536,
     "max_output": 16384
    },
    "qwen-vl-max": {
     "context_window": 131072,
     "max_output": 8192
    },
    "qwen3-235b-a22b": {
     "context_window": 131072,
     "max_output": 16384
    },
    "qwen3-vl-30b-a3b": {
     "context_window": 131072,
     "max_output": 32768
    },
    "qwen3.5-122b-a10b": {
     "context_window": 262144,
     "max_output": 65536
    },
    "qwen3.6-35b-a3b": {
     "context_window": 262144,
     "max_output": 65536
    },
    "qwen3-next-80b-a3b-instruct": {
     "context_window": 131072,
     "max_output": 32768
    },
    "qwen-vl-plus": {
     "context_window": 131072,
     "max_output": 8192
    },
    "qwen3.6-flash": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "qwen3-coder-flash": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "qwen2-5-omni-7b": {
     "context_window": 32768,
     "max_output": 2048
    },
    "qwen-mt-plus": {
     "context_window": 16384,
     "max_output": 8192
    },
    "qwen3-vl-235b-a22b": {
     "context_window": 131072,
     "max_output": 32768
    },
    "qwen3-coder-plus": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "qwen2-5-14b-instruct": {
     "context_window": 131072,
     "max_output": 8192
    },
    "qwen3.8-flash": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "qwen2-5-vl-7b-instruct": {
     "context_window": 131072,
     "max_output": 8192
    },
    "qwen3.5-35b-a3b": {
     "context_window": 262144,
     "max_output": 65536
    },
    "qwen3.6-max-preview": {
     "context_window": 262144,
     "max_output": 65536
    },
    "qwen-mt-turbo": {
     "context_window": 16384,
     "max_output": 8192
    },
    "qwen3.5-397b-a17b": {
     "context_window": 262144,
     "max_output": 65536
    },
    "qwen3-8b": {
     "context_window": 131072,
     "max_output": 8192
    },
    "glm-5.2": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "qwen-omni-turbo": {
     "context_window": 32768,
     "max_output": 2048
    },
    "qwen3-omni-flash-realtime": {
     "context_window": 65536,
     "max_output": 16384
    },
    "qwen3-asr-flash": {
     "context_window": 53248,
     "max_output": 4096
    },
    "qwen3.6-27b": {
     "context_window": 262144,
     "max_output": 65536
    },
    "qwen3.6-plus": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "qwen3-14b": {
     "context_window": 131072,
     "max_output": 8192
    },
    "qwen3.7-plus": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "qwen-vl-ocr": {
     "context_window": 34096,
     "max_output": 4096
    }
   }
  },
  "auriko": {
   "api": "https://api.auriko.ai/v1",
   "models": {
    "qwen-3.6-plus": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "minimax-m2-7-highspeed": {
     "context_window": 204800,
     "max_output": 131072
    },
    "kimi-k2.6": {
     "context_window": 262144,
     "max_output": 262144
    },
    "grok-4.3": {
     "context_window": 1000000,
     "max_output": 30000
    },
    "gemini-3.1-pro-preview": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "kimi-k2.5": {
     "context_window": 262144,
     "max_output": 262144
    },
    "gemini-2.5-pro": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "gemini-2.5-flash": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "minimax-m2-7": {
     "context_window": 204800,
     "max_output": 131072
    },
    "claude-opus-4-6": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "glm-5.1": {
     "context_window": 200000,
     "max_output": 131072
    },
    "deepseek-v4-pro": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "claude-sonnet-4-6": {
     "context_window": 1000000,
     "max_output": 64000
    },
    "claude-opus-4-7": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "deepseek-v4-flash": {
     "context_window": 1000000,
     "max_output": 384000
    }
   }
  },
  "zenmux": {
   "api": "https://zenmux.ai/api/v1",
   "models": {
    "anthropic/claude-opus-4.1": {
     "context_window": 200000,
     "max_output": 64000
    },
    "anthropic/claude-opus-4.5": {
     "context_window": 200000,
     "max_output": 64000
    },
    "anthropic/claude-opus-4.6": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-3.5-haiku": {
     "context_window": 200000,
     "max_output": 64000
    },
    "anthropic/claude-opus-4.7": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-opus-4.8": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-sonnet-5-free": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-haiku-4.5": {
     "context_window": 200000,
     "max_output": 64000
    },
    "anthropic/claude-fable-5.1": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-sonnet-4.5": {
     "context_window": 1000000,
     "max_output": 64000
    },
    "anthropic/claude-fable-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-3.7-sonnet": {
     "context_window": 200000,
     "max_output": 64000
    },
    "anthropic/claude-sonnet-4": {
     "context_window": 1000000,
     "max_output": 64000
    },
    "anthropic/claude-sonnet-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-sonnet-4.6": {
     "context_window": 1000000,
     "max_output": 64000
    },
    "anthropic/claude-opus-5.5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-opus-4": {
     "context_window": 200000,
     "max_output": 32000
    },
    "deepseek/deepseek-v4.1-flash": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "deepseek/deepseek-chat": {
     "context_window": 128000,
     "max_output": 64000
    },
    "deepseek/deepseek-v3.2-exp": {
     "context_window": 163000,
     "max_output": 64000
    },
    "deepseek/deepseek-v4-pro": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "deepseek/deepseek-v3.2": {
     "context_window": 128000,
     "max_output": 64000
    },
    "deepseek/deepseek-v4-flash": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "tencent/hy3-preview": {
     "context_window": 256000,
     "max_output": 64000
    },
    "z-ai/glm-4.6v": {
     "context_window": 200000,
     "max_output": 128000
    },
    "z-ai/glm-4.5": {
     "context_window": 128000,
     "max_output": 96000
    },
    "z-ai/glm-5v-turbo": {
     "context_window": 200000,
     "max_output": 128000
    },
    "z-ai/glm-5.3-flash": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "z-ai/glm-4.6": {
     "context_window": 200000,
     "max_output": 128000
    },
    "z-ai/glm-5": {
     "context_window": 200000,
     "max_output": 128000
    },
    "z-ai/glm-4.6v-flash": {
     "context_window": 200000,
     "max_output": 128000
    },
    "z-ai/glm-5.3-flashx": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "z-ai/glm-4.7": {
     "context_window": 200000,
     "max_output": 128000
    },
    "z-ai/glm-4.7-flash-free": {
     "context_window": 200000,
     "max_output": 128000
    },
    "z-ai/glm-5.2": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "z-ai/glm-5.1": {
     "context_window": 200000,
     "max_output": 128000
    },
    "z-ai/glm-4.7-flashx": {
     "context_window": 200000,
     "max_output": 128000
    },
    "z-ai/glm-5-turbo": {
     "context_window": 200000,
     "max_output": 128000
    },
    "z-ai/glm-4.6v-flash-free": {
     "context_window": 200000,
     "max_output": 128000
    },
    "z-ai/glm-image": {
     "context_window": 10240
    },
    "z-ai/glm-4.5-air": {
     "context_window": 128000,
     "max_output": 96000
    },
    "z-ai/glm-5.3": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "kuaishou/kat-coder-pro-v2": {
     "context_window": 256000,
     "max_output": 80000
    },
    "baidu/ernie-5.0-thinking-preview": {
     "context_window": 128000,
     "max_output": 64000
    },
    "x-ai/grok-4.3": {
     "context_window": 1000000,
     "max_output": 1000000
    },
    "x-ai/grok-4.5": {
     "context_window": 500000,
     "max_output": 500000
    },
    "x-ai/grok-voice-tts-1.0": {
     "context_window": 15000,
     "max_output": 15000
    },
    "x-ai/grok-imagine-image-2.0": {
     "context_window": 66000
    },
    "x-ai/grok-voice-stt-1.0": {
     "context_window": 15000,
     "max_output": 15000
    },
    "x-ai/grok-build-0.1": {
     "context_window": 256000,
     "max_output": 256000
    },
    "x-ai/grok-4.2-fast": {
     "context_window": 2000000,
     "max_output": 30000
    },
    "x-ai/grok-4.2-fast-non-reasoning": {
     "context_window": 2000000,
     "max_output": 30000
    },
    "x-ai/grok-4.6": {
     "context_window": 500000,
     "max_output": 500000
    },
    "volcengine/doubao-seed-2.0-mini": {
     "context_window": 256000,
     "max_output": 64000
    },
    "volcengine/doubao-seed-2.0-lite": {
     "context_window": 256000,
     "max_output": 64000
    },
    "volcengine/doubao-seed-code": {
     "context_window": 256000,
     "max_output": 64000
    },
    "volcengine/doubao-seed-2.0-pro": {
     "context_window": 256000,
     "max_output": 64000
    },
    "volcengine/doubao-seed-1.8": {
     "context_window": 256000,
     "max_output": 64000
    },
    "volcengine/doubao-seed-2.0-code": {
     "context_window": 256000,
     "max_output": 32000
    },
    "google/gemini-3.1-pro-preview": {
     "context_window": 1048000,
     "max_output": 64000
    },
    "google/gemini-3.5-flash": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemini-2.5-pro": {
     "context_window": 1048000,
     "max_output": 64000
    },
    "google/gemini-2.5-flash": {
     "context_window": 1048000,
     "max_output": 64000
    },
    "google/gemini-3-flash-preview": {
     "context_window": 1048000,
     "max_output": 64000
    },
    "google/gemini-2.5-flash-lite": {
     "context_window": 1048000,
     "max_output": 64000
    },
    "google/gemini-3.1-flash-lite-preview": {
     "context_window": 1050000,
     "max_output": 65530
    },
    "google/gemini-3.1-flash-lite": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "sapiens-ai/agnes-1.5-lite": {
     "context_window": 256000,
     "max_output": 256000
    },
    "sapiens-ai/agnes-1.5-pro": {
     "context_window": 256000,
     "max_output": 256000
    },
    "inclusionai/ring-2.6-1t": {
     "context_window": 262000,
     "max_output": 65000
    },
    "inclusionai/ring-1t": {
     "context_window": 128000,
     "max_output": 64000
    },
    "inclusionai/ling-1t": {
     "context_window": 128000,
     "max_output": 64000
    },
    "moonshotai/kimi-k3": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "moonshotai/kimi-k2.7-code-highspeed": {
     "context_window": 262144,
     "max_output": 262144
    },
    "moonshotai/kimi-k2.6": {
     "context_window": 262140,
     "max_output": 262140
    },
    "moonshotai/kimi-k2-thinking": {
     "context_window": 262000,
     "max_output": 64000
    },
    "moonshotai/kimi-k2.5": {
     "context_window": 262000,
     "max_output": 64000
    },
    "moonshotai/kimi-k3-free": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "moonshotai/kimi-k2-0905": {
     "context_window": 262000,
     "max_output": 64000
    },
    "moonshotai/kimi-k2.7-code-free": {
     "context_window": 262144,
     "max_output": 262144
    },
    "moonshotai/kimi-k2-thinking-turbo": {
     "context_window": 262000,
     "max_output": 64000
    },
    "moonshotai/kimi-k2.7-code": {
     "context_window": 262144,
     "max_output": 262144
    },
    "xiaomi/mimo-v2.6-pro": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "xiaomi/mimo-v2-flash": {
     "context_window": 262144,
     "max_output": 65536
    },
    "xiaomi/mimo-v2.5": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "xiaomi/mimo-v2-omni": {
     "context_window": 265000,
     "max_output": 265000
    },
    "xiaomi/mimo-v2-pro": {
     "context_window": 1000000,
     "max_output": 256000
    },
    "xiaomi/mimo-v2.5-pro": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "minimax/minimax-m2.5-lightning": {
     "context_window": 204800,
     "max_output": 131072
    },
    "minimax/minimax-m2.5": {
     "context_window": 204800,
     "max_output": 131072
    },
    "minimax/minimax-m2.7": {
     "context_window": 204800,
     "max_output": 131070
    },
    "minimax/minimax-m3": {
     "context_window": 1048576,
     "max_output": 512000
    },
    "minimax/minimax-m2.7-highspeed": {
     "context_window": 204800,
     "max_output": 131070
    },
    "minimax/minimax-m2.1": {
     "context_window": 204000,
     "max_output": 64000
    },
    "minimax/minimax-m2": {
     "context_window": 204000,
     "max_output": 64000
    },
    "stepfun/step-3": {
     "context_window": 65536,
     "max_output": 64000
    },
    "stepfun/step-3.5-flash": {
     "context_window": 256000,
     "max_output": 64000
    },
    "stepfun/step-3.7-flash": {
     "context_window": 256000,
     "max_output": 256000
    },
    "stepfun/step-3.7-flash-free": {
     "context_window": 256000,
     "max_output": 256000
    },
    "qwen/qwen3.5-flash": {
     "context_window": 1020000,
     "max_output": 1020000
    },
    "qwen/qwen3.7-max": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "qwen/qwen3.5-plus": {
     "context_window": 1000000,
     "max_output": 64000
    },
    "qwen/qwen3-max": {
     "context_window": 256000,
     "max_output": 64000
    },
    "qwen/qwen3-coder-plus": {
     "context_window": 1000000,
     "max_output": 64000
    },
    "qwen/qwen3.6-plus": {
     "context_window": 1000000,
     "max_output": 64000
    },
    "qwen/qwen3.7-plus": {
     "context_window": 1000000,
     "max_output": 64000
    },
    "openai/gpt-5.4": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-5.4-pro": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-5.3-chat": {
     "context_window": 128000,
     "max_output": 16380
    },
    "openai/gpt-5.5-pro": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-5.4-nano": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-5.2-codex": {
     "context_window": 400000,
     "max_output": 64000
    },
    "openai/gpt-5.1-codex": {
     "context_window": 400000,
     "max_output": 64000
    },
    "openai/gpt-5-codex": {
     "context_window": 400000,
     "max_output": 64000
    },
    "openai/gpt-5.2-pro": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-5.3-codex": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-5.5-instant": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-6-astra": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-5.1": {
     "context_window": 400000,
     "max_output": 64000
    },
    "openai/gpt-5.4-mini": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-5.6-luna": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-5.2": {
     "context_window": 400000,
     "max_output": 64000
    },
    "openai/gpt-5.5": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-5.1-chat": {
     "context_window": 128000,
     "max_output": 64000
    },
    "openai/gpt-5.6-terra": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-5.1-codex-mini": {
     "context_window": 400000,
     "max_output": 64000
    },
    "openai/gpt-5": {
     "context_window": 400000,
     "max_output": 64000
    },
    "openai/gpt-5.6-sol": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-6-sol": {
     "context_window": 1050000,
     "max_output": 128000
    }
   }
  },
  "unorouter": {
   "api": "https://api.unorouter.com/v1",
   "models": {
    "gpt-5.5:free": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "gpt-5.4": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "glm-4.5-flash:free": {
     "context_window": 131072,
     "max_output": 98304
    },
    "gemma-4-31b-it:free": {
     "context_window": 262144,
     "max_output": 32768
    },
    "kimi-k2.6": {
     "context_window": 262144,
     "max_output": 262144
    },
    "nemotron-3-ultra-550b-a55b:free": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "gpt-5.4:free": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "minimax-m2.7": {
     "context_window": 204800,
     "max_output": 131072
    },
    "gemini-3.5-flash": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "gpt-5.2": {
     "context_window": 400000,
     "max_output": 128000
    },
    "claude-opus-4-8": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "gpt-5.5": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "claude-sonnet-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "glm-5.2": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "step-3.7-flash:free": {
     "context_window": 256000,
     "max_output": 256000
    },
    "deepseek-v4-flash:free": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "claude-haiku-4-5-20251001": {
     "context_window": 200000,
     "max_output": 64000
    },
    "deepseek-v4-pro:free": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "glm-5.2:free": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "deepseek-v4-pro": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "qwen3.5-397b-a17b:free": {
     "context_window": 262144,
     "max_output": 65536
    },
    "minimax-m2.7:free": {
     "context_window": 204800,
     "max_output": 131072
    },
    "deepseek-v4-flash": {
     "context_window": 1000000,
     "max_output": 384000
    }
   }
  },
  "salad-cloud": {
   "api": null,
   "models": {
    "qwen3.6-35b-a3b": {
     "context_window": 262144,
     "max_output": 262144
    }
   }
  },
  "vispark": {
   "api": "https://api.lab.vispark.in/v1",
   "models": {
    "vispark/vision-large": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "vispark/vision-small": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "vispark/vision-medium": {
     "context_window": 1000000,
     "max_output": 65536
    }
   }
  },
  "siliconflow-cn": {
   "api": "https://api.siliconflow.cn/v1",
   "models": {
    "ByteDance-Seed/Seed-OSS-36B-Instruct": {
     "context_window": 262000,
     "max_output": 262000
    },
    "tencent/Hunyuan-A13B-Instruct": {
     "context_window": 131000,
     "max_output": 131000
    },
    "Qwen/Qwen3.5-4B": {
     "context_window": 262144,
     "max_output": 65536
    },
    "Qwen/Qwen3.5-27B": {
     "context_window": 262144,
     "max_output": 65536
    },
    "Qwen/Qwen3.6-35B-A3B": {
     "context_window": 262144,
     "max_output": 65536
    },
    "Qwen/Qwen3-235B-A22B-Thinking-2507": {
     "context_window": 262000,
     "max_output": 262000
    },
    "Qwen/Qwen3-14B": {
     "context_window": 131000,
     "max_output": 131000
    },
    "Qwen/Qwen3-8B": {
     "context_window": 131000,
     "max_output": 131000
    },
    "Qwen/Qwen3-32B": {
     "context_window": 131000,
     "max_output": 131000
    },
    "Qwen/Qwen3.5-35B-A3B": {
     "context_window": 262144,
     "max_output": 65536
    },
    "Qwen/Qwen3.5-122B-A10B": {
     "context_window": 262144,
     "max_output": 65536
    },
    "Qwen/Qwen3.5-9B": {
     "context_window": 262144,
     "max_output": 65536
    },
    "Qwen/Qwen3.5-397B-A17B": {
     "context_window": 262144,
     "max_output": 65536
    },
    "Qwen/Qwen3-Coder-480B-A35B-Instruct": {
     "context_window": 262000,
     "max_output": 262000
    },
    "Qwen/Qwen3-VL-32B-Instruct": {
     "context_window": 262000,
     "max_output": 262000
    },
    "Qwen/Qwen2.5-7B-Instruct": {
     "context_window": 33000,
     "max_output": 4000
    },
    "Qwen/Qwen3-Coder-30B-A3B-Instruct": {
     "context_window": 262000,
     "max_output": 262000
    },
    "Qwen/Qwen2.5-72B-Instruct": {
     "context_window": 33000,
     "max_output": 4000
    },
    "Qwen/Qwen3-VL-30B-A3B-Thinking": {
     "context_window": 262000,
     "max_output": 262000
    },
    "Qwen/Qwen3-30B-A3B-Instruct-2507": {
     "context_window": 262000,
     "max_output": 262000
    },
    "Qwen/Qwen3-VL-32B-Thinking": {
     "context_window": 262000,
     "max_output": 262000
    },
    "Qwen/Qwen3-VL-8B-Instruct": {
     "context_window": 262000,
     "max_output": 262000
    },
    "Qwen/Qwen3-VL-30B-A3B-Instruct": {
     "context_window": 262000,
     "max_output": 262000
    },
    "deepseek-ai/DeepSeek-R1": {
     "context_window": 164000,
     "max_output": 164000
    },
    "deepseek-ai/DeepSeek-V4-Flash": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "deepseek-ai/DeepSeek-OCR": {
     "context_window": 8192,
     "max_output": 8192
    },
    "deepseek-ai/DeepSeek-V4-Pro": {
     "context_window": 1049000,
     "max_output": 393000
    },
    "deepseek-ai/DeepSeek-V3.2": {
     "context_window": 164000,
     "max_output": 164000
    },
    "deepseek-ai/DeepSeek-V3.1-Terminus": {
     "context_window": 164000,
     "max_output": 164000
    },
    "deepseek-ai/DeepSeek-V3": {
     "context_window": 164000,
     "max_output": 164000
    },
    "stepfun-ai/Step-3.5-Flash": {
     "context_window": 262000,
     "max_output": 262000
    },
    "inclusionAI/Ling-flash-2.0": {
     "context_window": 131000,
     "max_output": 131000
    },
    "zai-org/GLM-5.2": {
     "context_window": 1049000,
     "max_output": 262000
    },
    "zai-org/GLM-4.5-Air": {
     "context_window": 131000,
     "max_output": 131000
    },
    "Pro/deepseek-ai/DeepSeek-R1": {
     "context_window": 164000,
     "max_output": 164000
    },
    "Pro/deepseek-ai/DeepSeek-V3.2": {
     "context_window": 164000,
     "max_output": 164000
    },
    "Pro/deepseek-ai/DeepSeek-V3": {
     "context_window": 164000,
     "max_output": 164000
    },
    "Pro/deepseek-ai/DeepSeek-V3.1-Terminus": {
     "context_window": 164000,
     "max_output": 164000
    },
    "Pro/MiniMaxAI/MiniMax-M2.5": {
     "context_window": 192000,
     "max_output": 131000
    },
    "Pro/moonshotai/Kimi-K2.6": {
     "context_window": 262000,
     "max_output": 262000
    },
    "Pro/moonshotai/Kimi-K2.5": {
     "context_window": 262000,
     "max_output": 262000
    },
    "Pro/zai-org/GLM-5.1": {
     "context_window": 205000,
     "max_output": 205000
    },
    "Pro/zai-org/GLM-5": {
     "context_window": 205000,
     "max_output": 205000
    },
    "PaddlePaddle/PaddleOCR-VL-1.5": {
     "context_window": 16384,
     "max_output": 16384
    }
   }
  },
  "regolo-ai": {
   "api": "https://api.regolo.ai/v1",
   "models": {
    "qwen3.8-27b": {
     "context_window": 120000,
     "max_output": 120000
    },
    "brick-v1-beta": {
     "context_window": 100000,
     "max_output": 15000
    },
    "qwen3.5-122b": {
     "context_window": 262144,
     "max_output": 16384
    },
    "qwen3-coder-next": {
     "context_window": 262144,
     "max_output": 16384
    },
    "apertus-70b": {
     "context_window": 30000,
     "max_output": 30000
    },
    "glm5.2": {
     "context_window": 96000,
     "max_output": 96000
    },
    "qwen3-reranker-4b": {
     "context_window": 32768,
     "max_output": 8192
    },
    "deepseek-ocr-2": {
     "context_window": 4000,
     "max_output": 4000
    },
    "llama-3.3-70b-instruct": {
     "context_window": 128000,
     "max_output": 16384
    },
    "gemma4-31b": {
     "context_window": 100000,
     "max_output": 100000
    },
    "brick-complexity-pro": {
     "context_window": 100000,
     "max_output": 15000
    },
    "gpt-oss-20b": {
     "context_window": 128000,
     "max_output": 16384
    },
    "qwen3.5-9b": {
     "context_window": 262144,
     "max_output": 8192
    },
    "qwen3-embedding-8b": {
     "context_window": 32768,
     "max_output": 8192
    },
    "mistral-small-4-119b": {
     "context_window": 256000,
     "max_output": 16384
    },
    "qwen-image": {
     "context_window": 8192,
     "max_output": 4096
    },
    "gpt-oss-120b": {
     "context_window": 128000,
     "max_output": 16384
    },
    "faster-whisper-large-v3": {
     "max_output": 4096
    }
   }
  },
  "xiaomi-token-plan-ams": {
   "api": "https://token-plan-ams.xiaomimimo.com/v1",
   "models": {
    "mimo-v2.6-pro": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "mimo-v2.6-flash": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "mimo-v2.5-tts-voiceclone": {
     "context_window": 8192,
     "max_output": 8192
    },
    "mimo-v2.5-pro": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "mimo-v2-tts": {
     "context_window": 8192,
     "max_output": 8192
    },
    "mimo-v2-pro": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "mimo-v2.5-tts": {
     "context_window": 8192,
     "max_output": 8192
    },
    "mimo-v2.5-tts-voicedesign": {
     "context_window": 8192,
     "max_output": 8192
    },
    "mimo-v2.5": {
     "context_window": 1048576,
     "max_output": 131072
    }
   }
  },
  "inceptron": {
   "api": "https://api.inceptron.io/v1",
   "models": {
    "deepseek-ai/DeepSeek-V4-Flash-0731": {
     "context_window": 1048576,
     "max_output": 1048576
    },
    "moonshotai/Kimi-K2.6": {
     "context_window": 262144,
     "max_output": 262144
    },
    "moonshotai/Kimi-K2.7-Code": {
     "context_window": 262144,
     "max_output": 262144
    },
    "zai-org/GLM-5.2": {
     "context_window": 1048576,
     "max_output": 1048576
    }
   }
  },
  "upstage": {
   "api": "https://api.upstage.ai/v1/solar",
   "models": {
    "solar-pro4": {
     "context_window": 524288,
     "max_output": 131072
    },
    "solar-pro3": {
     "context_window": 131072,
     "max_output": 8192
    },
    "solar-mini": {
     "context_window": 32768,
     "max_output": 4096
    },
    "solar-pro2": {
     "context_window": 65536,
     "max_output": 8192
    }
   }
  },
  "vultr": {
   "api": "https://api.vultrinference.com/v1",
   "models": {
    "mimo-v2.6-pro-rl": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "qwen3.8-27b": {
     "context_window": 262144,
     "max_output": 32768
    },
    "glm-5.3-flash": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "deepseek-v4-flash-0731": {
     "context_window": 1048576,
     "max_output": 384000
    },
    "muse-glimmer-30b": {
     "context_window": 131072,
     "max_output": 131072
    },
    "deepseek-v4.1-flash": {
     "context_window": 1048576,
     "max_output": 384000
    },
    "laguna-s-2.1": {
     "context_window": 1048576,
     "max_output": 32768
    },
    "glm-5.x-menthol": {
     "context_window": 202752,
     "max_output": 131072
    },
    "nemotron-3-nano-omni-30b-a3b-reasoning": {
     "context_window": 262144,
     "max_output": 65536
    },
    "mimo-v2.6-flash-rl": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "minimax-m3": {
     "context_window": 524288,
     "max_output": 512000
    },
    "qwen3.8-flash-next": {
     "context_window": 262144,
     "max_output": 131072
    },
    "glm-5.2": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "nemotron-3.5-content-safety": {
     "context_window": 131072,
     "max_output": 8192
    },
    "glm-5.3": {
     "context_window": 1048576,
     "max_output": 131072
    }
   }
  },
  "huggingface": {
   "api": "https://router.huggingface.co/v1",
   "models": {
    "tencent/Hy3": {
     "context_window": 262144,
     "max_output": 128000
    },
    "tencent/Hy4-preview": {
     "context_window": 1000000,
     "max_output": 64000
    },
    "meta-llama/Llama-3.1-8B-Instruct": {
     "context_window": 131072,
     "max_output": 4096
    },
    "meta-llama/Llama-3.3-70B-Instruct": {
     "context_window": 131072,
     "max_output": 4096
    },
    "XiaomiMiMo/MiMo-V2-Flash": {
     "context_window": 262144,
     "max_output": 4096
    },
    "XiaomiMiMo/MiMo-V2.5-Pro": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "XiaomiMiMo/MiMo-V2.5": {
     "context_window": 262144,
     "max_output": 131072
    },
    "thinkingmachines/Inkling-Small": {
     "context_window": 524288,
     "max_output": 1048576
    },
    "thinkingmachines/Inkling": {
     "context_window": 1048576,
     "max_output": 1048576
    },
    "google/gemma-3-27b-it": {
     "context_window": 131072,
     "max_output": 131072
    },
    "google/gemma-3-12b-it": {
     "context_window": 131072,
     "max_output": 131072
    },
    "google/gemma-3-4b-it": {
     "context_window": 131072,
     "max_output": 131072
    },
    "google/gemma-4-31B-it": {
     "context_window": 262144,
     "max_output": 32768
    },
    "google/gemma-4-26B-A4B-it": {
     "context_window": 262144,
     "max_output": 32768
    },
    "Qwen/Qwen3-VL-235B-A22B-Instruct": {
     "context_window": 131072,
     "max_output": 32768
    },
    "Qwen/Qwen3.8-27B": {
     "context_window": 262144,
     "max_output": 32768
    },
    "Qwen/Qwen3-Next-80B-A3B-Instruct": {
     "context_window": 262144,
     "max_output": 66536
    },
    "Qwen/Qwen2.5-Coder-32B-Instruct": {
     "context_window": 131072,
     "max_output": 8192
    },
    "Qwen/Qwen3-Coder-Next": {
     "context_window": 262144,
     "max_output": 65536
    },
    "Qwen/Qwen3-VL-235B-A22B-Thinking": {
     "context_window": 131072,
     "max_output": 32768
    },
    "Qwen/Qwen3.5-27B": {
     "context_window": 262144,
     "max_output": 65536
    },
    "Qwen/Qwen3-Next-80B-A3B-Thinking": {
     "context_window": 262144,
     "max_output": 131072
    },
    "Qwen/Qwen3.6-35B-A3B": {
     "context_window": 262144,
     "max_output": 65536
    },
    "Qwen/Qwen3-235B-A22B-Thinking-2507": {
     "context_window": 262144,
     "max_output": 131072
    },
    "Qwen/Qwen3-235B-A22B-Instruct-2507": {
     "context_window": 262144,
     "max_output": 16384
    },
    "Qwen/Qwen3-235B-A22B": {
     "context_window": 40960,
     "max_output": 16384
    },
    "Qwen/Qwen3-32B": {
     "context_window": 131072,
     "max_output": 16384
    },
    "Qwen/Qwen3-Coder-30B-A3B-Instruct": {
     "context_window": 262144,
     "max_output": 65536
    },
    "Qwen/Qwen3-Embedding-8B": {
     "context_window": 32000,
     "max_output": 4096
    },
    "Qwen/Qwen3.5-35B-A3B": {
     "context_window": 262144,
     "max_output": 65536
    },
    "Qwen/Qwen3.5-122B-A10B": {
     "context_window": 262144,
     "max_output": 65536
    },
    "Qwen/Qwen3.5-9B": {
     "context_window": 262144,
     "max_output": 65536
    },
    "Qwen/Qwen3.5-397B-A17B": {
     "context_window": 262144,
     "max_output": 32768
    },
    "Qwen/Qwen3-Embedding-4B": {
     "context_window": 32000,
     "max_output": 2048
    },
    "Qwen/Qwen3.8-2.4T-A95B": {
     "context_window": 262144,
     "max_output": 131072
    },
    "Qwen/Qwen3-30B-A3B": {
     "context_window": 40960,
     "max_output": 16384
    },
    "Qwen/Qwen3-Coder-480B-A35B-Instruct": {
     "context_window": 262144,
     "max_output": 66536
    },
    "Qwen/Qwen3.6-27B": {
     "context_window": 262144,
     "max_output": 65536
    },
    "deepseek-ai/DeepSeek-V3.1": {
     "context_window": 131072,
     "max_output": 8192
    },
    "deepseek-ai/DeepSeek-V4-Flash-0731": {
     "context_window": 1048576,
     "max_output": 384000
    },
    "deepseek-ai/DeepSeek-R1": {
     "context_window": 64000,
     "max_output": 32768
    },
    "deepseek-ai/DeepSeek-V4-Pro-0813": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "deepseek-ai/DeepSeek-V4.1-Flash": {
     "context_window": 1048576,
     "max_output": 384000
    },
    "deepseek-ai/DeepSeek-V4-Flash": {
     "context_window": 1048576,
     "max_output": 384000
    },
    "deepseek-ai/DeepSeek-V4-Pro": {
     "context_window": 1048576,
     "max_output": 393216
    },
    "deepseek-ai/DeepSeek-V3.2": {
     "context_window": 163840,
     "max_output": 65536
    },
    "deepseek-ai/DeepSeek-R1-0528": {
     "context_window": 163840,
     "max_output": 163840
    },
    "deepseek-ai/DeepSeek-V3": {
     "context_window": 64000,
     "max_output": 8192
    },
    "deepseek-ai/DeepSeek-V3-0324": {
     "context_window": 163840,
     "max_output": 163840
    },
    "deepseek-ai/DeepSeek-V4-Flash-Vision-Exp": {
     "context_window": 1048576,
     "max_output": 384000
    },
    "stepfun-ai/Step-3.7-Flash": {
     "context_window": 262144,
     "max_output": 256000
    },
    "stepfun-ai/Step-3.5-Flash": {
     "context_window": 262144,
     "max_output": 256000
    },
    "MiniMaxAI/MiniMax-M3": {
     "context_window": 524288,
     "max_output": 512000
    },
    "MiniMaxAI/MiniMax-M2.1": {
     "context_window": 204800,
     "max_output": 131072
    },
    "MiniMaxAI/MiniMax-M2.5": {
     "context_window": 204800,
     "max_output": 131072
    },
    "MiniMaxAI/MiniMax-M2.7": {
     "context_window": 204800,
     "max_output": 131072
    },
    "MiniMaxAI/MiniMax-M2": {
     "context_window": 204800,
     "max_output": 131072
    },
    "moonshotai/Kimi-K2.6": {
     "context_window": 262144,
     "max_output": 262144
    },
    "moonshotai/Kimi-K3": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "moonshotai/Kimi-K2-Instruct": {
     "context_window": 131072,
     "max_output": 16384
    },
    "moonshotai/Kimi-K2.7-Code": {
     "context_window": 262144,
     "max_output": 262144
    },
    "moonshotai/Kimi-K2.5": {
     "context_window": 262144,
     "max_output": 262144
    },
    "moonshotai/Kimi-K2-Thinking": {
     "context_window": 262144,
     "max_output": 262144
    },
    "moonshotai/Kimi-K2-Instruct-0905": {
     "context_window": 262144,
     "max_output": 16384
    },
    "zai-org/GLM-4.6V-Flash": {
     "context_window": 131072,
     "max_output": 32768
    },
    "zai-org/GLM-5.1": {
     "context_window": 202752,
     "max_output": 131072
    },
    "zai-org/GLM-5.2": {
     "context_window": 262144,
     "max_output": 131072
    },
    "zai-org/GLM-4.5-Air": {
     "context_window": 131072,
     "max_output": 98304
    },
    "zai-org/GLM-4.7": {
     "context_window": 204800,
     "max_output": 131072
    },
    "zai-org/GLM-5": {
     "context_window": 202752,
     "max_output": 131072
    },
    "zai-org/GLM-5.3-Flash": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "zai-org/GLM-4.5V": {
     "context_window": 65536,
     "max_output": 16384
    },
    "zai-org/GLM-4.6": {
     "context_window": 204800,
     "max_output": 131072
    },
    "zai-org/GLM-4.7-Flash": {
     "context_window": 200000,
     "max_output": 128000
    },
    "zai-org/GLM-5.3": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "zai-org/GLM-4.5": {
     "context_window": 131072,
     "max_output": 98304
    },
    "openai/gpt-oss-20b": {
     "context_window": 131072,
     "max_output": 32768
    },
    "openai/gpt-oss-120b": {
     "context_window": 131072,
     "max_output": 32768
    }
   }
  },
  "volcengine": {
   "api": "https://ark.cn-beijing.volces.com/api/v3",
   "models": {
    "glm-5-3-flash-260828": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "doubao-seed-1-6-251015": {
     "context_window": 256000,
     "max_output": 64000
    },
    "doubao-seed-2-0-pro-260215": {
     "context_window": 256000,
     "max_output": 128000
    },
    "doubao-seed-2-0-lite-260428": {
     "context_window": 256000,
     "max_output": 131072
    },
    "doubao-seed-2-1-pro-260628": {
     "context_window": 256000,
     "max_output": 256000
    },
    "doubao-seed-1-6-vision-250815": {
     "context_window": 256000,
     "max_output": 32000
    },
    "doubao-seed-2-0-mini-260428": {
     "context_window": 256000,
     "max_output": 131072
    },
    "doubao-seed-2-0-code-preview-260215": {
     "context_window": 262144,
     "max_output": 131072
    },
    "doubao-seed-2-1-turbo-260628": {
     "context_window": 256000,
     "max_output": 256000
    },
    "glm-5-2-260617": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "doubao-seed-1-8-251228": {
     "context_window": 256000,
     "max_output": 64000
    },
    "doubao-seed-evolving": {
     "context_window": 256000,
     "max_output": 256000
    },
    "doubao-seed-1-6-flash-250828": {
     "context_window": 256000,
     "max_output": 32000
    },
    "doubao-seed-character-260628": {
     "context_window": 256000,
     "max_output": 256000
    },
    "deepseek-v4-pro-ga-260813": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "deepseek-v4-flash-ga-260731": {
     "context_window": 1000000,
     "max_output": 384000
    }
   }
  },
  "impossibl": {
   "api": "https://api.impossibl.com/v1",
   "models": {
    "cerebras/gpt-oss-120b": {
     "context_window": 131072,
     "max_output": 32768
    },
    "groq/gpt-oss-20b": {
     "context_window": 131072,
     "max_output": 32768
    },
    "groq/gpt-oss-120b": {
     "context_window": 131072,
     "max_output": 32768
    },
    "zai/glm-4.5": {
     "context_window": 131072,
     "max_output": 98304
    },
    "zai/glm-4.6": {
     "context_window": 204800,
     "max_output": 131072
    },
    "zai/glm-5": {
     "context_window": 204800,
     "max_output": 131072
    },
    "zai/glm-4.7": {
     "context_window": 204800,
     "max_output": 131072
    },
    "zai/glm-5.2": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "zai/glm-5.1": {
     "context_window": 200000,
     "max_output": 131072
    },
    "zai/glm-5-turbo": {
     "context_window": 200000,
     "max_output": 131072
    },
    "zai/glm-4.5-air": {
     "context_window": 131072,
     "max_output": 98304
    },
    "anthropic/claude-haiku-4-5": {
     "context_window": 200000,
     "max_output": 64000
    },
    "anthropic/claude-opus-4-5": {
     "context_window": 200000,
     "max_output": 64000
    },
    "anthropic/claude-sonnet-4-5": {
     "context_window": 200000,
     "max_output": 64000
    },
    "anthropic/claude-fable-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-opus-4-8": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-sonnet-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-opus-4-6": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-sonnet-4-6": {
     "context_window": 1000000,
     "max_output": 64000
    },
    "anthropic/claude-opus-4-7": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "deepseek/deepseek-v4-pro": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "deepseek/deepseek-v4-flash": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "thinkingmachines/inkling": {
     "context_window": 65536,
     "max_output": 65536
    },
    "google/gemini-3.6-flash": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemini-3.5-flash-lite": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemini-3.1-pro-preview": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemini-3.5-flash": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemini-2.5-pro": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemini-2.5-flash": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemini-2.5-flash-lite": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemini-3.1-flash-lite": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "xai/grok-4.3": {
     "context_window": 1000000,
     "max_output": 30000
    },
    "xai/grok-4.20-0309-reasoning": {
     "context_window": 1000000,
     "max_output": 30000
    },
    "xai/grok-4.5": {
     "context_window": 500000,
     "max_output": 500000
    },
    "xai/grok-4.20-0309-non-reasoning": {
     "context_window": 1000000,
     "max_output": 30000
    },
    "xai/grok-build-0.1": {
     "context_window": 256000,
     "max_output": 256000
    },
    "fireworks/gpt-oss-20b": {
     "context_window": 131072,
     "max_output": 32768
    },
    "fireworks/glm-5.2": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "fireworks/gpt-oss-120b": {
     "context_window": 131072,
     "max_output": 32768
    },
    "moonshotai/kimi-k3": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "xiaomi/mimo-v2.5": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "qwen/qwen3.7-max": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "qwen/qwen3.8-max-preview": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "qwen/qwen3.6-flash": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "qwen/qwen3.7-plus": {
     "context_window": 1000000,
     "max_output": 64000
    },
    "openai/gpt-5.4": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-5.4-pro": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-3.5-turbo": {
     "context_window": 16385,
     "max_output": 4096
    },
    "openai/gpt-5.5-pro": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-5.4-nano": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-5.2-codex": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-5.1-codex": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-4o": {
     "context_window": 128000,
     "max_output": 16384
    },
    "openai/gpt-5-codex": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-5-mini": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/o4-mini": {
     "context_window": 200000,
     "max_output": 100000
    },
    "openai/o3-mini": {
     "context_window": 200000,
     "max_output": 100000
    },
    "openai/gpt-5.3-codex": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-4.1-nano": {
     "context_window": 1047576,
     "max_output": 32768
    },
    "openai/gpt-5-nano": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/o1": {
     "context_window": 200000,
     "max_output": 100000
    },
    "openai/gpt-5-pro": {
     "context_window": 400000,
     "max_output": 272000
    },
    "openai/gpt-5.1": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-4o-mini": {
     "context_window": 128000,
     "max_output": 16384
    },
    "openai/gpt-5.4-mini": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-5.6-luna": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-5.2": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-5.5": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-4.1": {
     "context_window": 1047576,
     "max_output": 32768
    },
    "openai/gpt-4.1-mini": {
     "context_window": 1047576,
     "max_output": 32768
    },
    "openai/gpt-5.6-terra": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-4-turbo": {
     "context_window": 128000,
     "max_output": 4096
    },
    "openai/gpt-5.1-codex-mini": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/o3": {
     "context_window": 200000,
     "max_output": 100000
    },
    "openai/gpt-5": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-5.6-sol": {
     "context_window": 1050000,
     "max_output": 128000
    }
   }
  },
  "xpersona": {
   "api": "https://www.xpersona.co/v1",
   "models": {
    "gpt-5.4": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "claude-haiku-4-5": {
     "context_window": 200000,
     "max_output": 128000
    },
    "xpersona-frieren-coder": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "gpt-5.6": {
     "context_window": 372000,
     "max_output": 128000
    },
    "xpersona-gpt-5.5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "gemini-3.5-flash": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "claude-fable-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "gpt-5.4-mini": {
     "context_window": 272000,
     "max_output": 128000
    },
    "claude-opus-4-8": {
     "context_window": 200000,
     "max_output": 128000
    },
    "gpt-5.5": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "claude-sonnet-4-6": {
     "context_window": 200000,
     "max_output": 128000
    },
    "gpt-5.6-terra": {
     "context_window": 372000,
     "max_output": 128000
    },
    "gpt-5.6-sol": {
     "context_window": 372000,
     "max_output": 128000
    }
   }
  },
  "qiniu-ai": {
   "api": "https://api.qnaigc.com/v1",
   "models": {
    "glm-4.5": {
     "context_window": 131072,
     "max_output": 98304
    },
    "gemini-3.0-flash-preview": {
     "context_window": 1000000,
     "max_output": 64000
    },
    "doubao-seed-2.0-mini": {
     "context_window": 256000,
     "max_output": 32000
    },
    "mimo-v2-flash": {
     "context_window": 256000,
     "max_output": 256000
    },
    "doubao-seed-2.0-lite": {
     "context_window": 256000,
     "max_output": 32000
    },
    "doubao-seed-1.6-thinking": {
     "context_window": 256000,
     "max_output": 32000
    },
    "gemini-2.5-flash-image": {
     "context_window": 32768,
     "max_output": 8192
    },
    "gemini-3.0-pro-image-preview": {
     "context_window": 32768,
     "max_output": 8192
    },
    "claude-3.5-haiku": {
     "context_window": 200000,
     "max_output": 8192
    },
    "qwen3-235b-a22b-instruct-2507": {
     "context_window": 262144,
     "max_output": 64000
    },
    "qwen3-next-80b-a3b-thinking": {
     "context_window": 131072,
     "max_output": 32768
    },
    "qwen-max-2025-01-25": {
     "context_window": 128000,
     "max_output": 4096
    },
    "deepseek-v3-0324": {
     "context_window": 128000,
     "max_output": 16000
    },
    "qwen3-32b": {
     "context_window": 40000,
     "max_output": 4096
    },
    "qwen3-max": {
     "context_window": 262144,
     "max_output": 65536
    },
    "claude-4.5-sonnet": {
     "context_window": 200000,
     "max_output": 64000
    },
    "deepseek-v3": {
     "context_window": 128000,
     "max_output": 16000
    },
    "qwen3-coder-480b-a35b-instruct": {
     "context_window": 262000,
     "max_output": 4096
    },
    "qwen-turbo": {
     "context_window": 1000000,
     "max_output": 4096
    },
    "gemini-2.0-flash": {
     "context_window": 1048576,
     "max_output": 8192
    },
    "gemini-2.0-flash-lite": {
     "context_window": 1048576,
     "max_output": 8192
    },
    "claude-4.0-sonnet": {
     "context_window": 200000,
     "max_output": 64000
    },
    "qwen2.5-vl-7b-instruct": {
     "context_window": 128000,
     "max_output": 8192
    },
    "qwen3-235b-a22b-thinking-2507": {
     "context_window": 262144,
     "max_output": 4096
    },
    "qwen3-235b-a22b": {
     "context_window": 128000,
     "max_output": 32000
    },
    "doubao-seed-2.0-pro": {
     "context_window": 256000,
     "max_output": 128000
    },
    "doubao-seed-1.6-flash": {
     "context_window": 256000,
     "max_output": 32000
    },
    "qwen3-max-preview": {
     "context_window": 256000,
     "max_output": 64000
    },
    "qwen3-next-80b-a3b-instruct": {
     "context_window": 131072,
     "max_output": 32768
    },
    "qwen3-vl-30b-a3b-thinking": {
     "context_window": 128000,
     "max_output": 32000
    },
    "doubao-1.5-pro-32k": {
     "context_window": 128000,
     "max_output": 12000
    },
    "claude-3.5-sonnet": {
     "context_window": 200000,
     "max_output": 8200
    },
    "gpt-oss-20b": {
     "context_window": 128000,
     "max_output": 4096
    },
    "gemini-2.5-pro": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "gemini-2.5-flash": {
     "context_window": 1048576,
     "max_output": 64000
    },
    "qwen-vl-max-2025-01-25": {
     "context_window": 128000,
     "max_output": 4096
    },
    "doubao-1.5-thinking-pro": {
     "context_window": 128000,
     "max_output": 16000
    },
    "claude-4.5-haiku": {
     "context_window": 200000,
     "max_output": 64000
    },
    "claude-4.1-opus": {
     "context_window": 200000,
     "max_output": 32000
    },
    "claude-3.7-sonnet": {
     "context_window": 200000,
     "max_output": 128000
    },
    "MiniMax-M1": {
     "context_window": 1000000,
     "max_output": 80000
    },
    "doubao-seed-1.6": {
     "context_window": 256000,
     "max_output": 32000
    },
    "qwen3-30b-a3b": {
     "context_window": 40000,
     "max_output": 4096
    },
    "qwen3.5-397b-a17b": {
     "context_window": 256000,
     "max_output": 64000
    },
    "doubao-seed-2.0-code": {
     "context_window": 256000,
     "max_output": 128000
    },
    "claude-4.0-opus": {
     "context_window": 200000,
     "max_output": 32000
    },
    "kimi-k2": {
     "context_window": 128000,
     "max_output": 128000
    },
    "qwen3-30b-a3b-instruct-2507": {
     "context_window": 128000,
     "max_output": 32000
    },
    "qwen2.5-vl-72b-instruct": {
     "context_window": 128000,
     "max_output": 8192
    },
    "doubao-1.5-vision-pro": {
     "context_window": 128000,
     "max_output": 16000
    },
    "claude-4.5-opus": {
     "context_window": 200000,
     "max_output": 200000
    },
    "deepseek-v3.1": {
     "context_window": 128000,
     "max_output": 32000
    },
    "deepseek-r1": {
     "context_window": 128000,
     "max_output": 32000
    },
    "qwen3-30b-a3b-thinking-2507": {
     "context_window": 126000,
     "max_output": 32000
    },
    "gemini-2.5-flash-lite": {
     "context_window": 1048576,
     "max_output": 64000
    },
    "deepseek-r1-0528": {
     "context_window": 128000,
     "max_output": 32000
    },
    "glm-4.5-air": {
     "context_window": 131000,
     "max_output": 4096
    },
    "gpt-oss-120b": {
     "context_window": 128000,
     "max_output": 4096
    },
    "gemini-3.0-pro-preview": {
     "context_window": 1000000,
     "max_output": 64000
    },
    "deepseek/deepseek-v3.2-exp-thinking": {
     "context_window": 128000,
     "max_output": 32000
    },
    "deepseek/deepseek-math-v2": {
     "context_window": 160000,
     "max_output": 160000
    },
    "deepseek/deepseek-v3.1-terminus": {
     "context_window": 128000,
     "max_output": 32000
    },
    "deepseek/deepseek-v3.2-251201": {
     "context_window": 128000,
     "max_output": 32000
    },
    "deepseek/deepseek-v3.1-terminus-thinking": {
     "context_window": 128000,
     "max_output": 32000
    },
    "deepseek/deepseek-v3.2-exp": {
     "context_window": 128000,
     "max_output": 32000
    },
    "z-ai/glm-4.6": {
     "context_window": 200000,
     "max_output": 200000
    },
    "z-ai/glm-5": {
     "context_window": 200000,
     "max_output": 128000
    },
    "z-ai/glm-4.7": {
     "context_window": 200000,
     "max_output": 200000
    },
    "z-ai/autoglm-phone-9b": {
     "context_window": 12800,
     "max_output": 4096
    },
    "meituan/longcat-flash-chat": {
     "context_window": 131072,
     "max_output": 131072
    },
    "meituan/longcat-flash-lite": {
     "context_window": 256000,
     "max_output": 320000
    },
    "x-ai/grok-4-fast-reasoning": {
     "context_window": 2000000,
     "max_output": 2000000
    },
    "x-ai/grok-4.1-fast-reasoning": {
     "max_output": 2000000
    },
    "x-ai/grok-4-fast-non-reasoning": {
     "context_window": 2000000,
     "max_output": 2000000
    },
    "x-ai/grok-code-fast-1": {
     "context_window": 256000,
     "max_output": 10000
    },
    "x-ai/grok-4.1-fast": {
     "context_window": 2000000,
     "max_output": 2000000
    },
    "x-ai/grok-4.1-fast-non-reasoning": {
     "context_window": 2000000,
     "max_output": 2000000
    },
    "x-ai/grok-4-fast": {
     "context_window": 2000000,
     "max_output": 2000000
    },
    "stepfun-ai/gelab-zero-4b-preview": {
     "context_window": 8192,
     "max_output": 4096
    },
    "moonshotai/kimi-k2-thinking": {
     "context_window": 256000,
     "max_output": 100000
    },
    "moonshotai/kimi-k2.5": {
     "context_window": 256000,
     "max_output": 256000
    },
    "moonshotai/kimi-k2-0905": {
     "context_window": 256000,
     "max_output": 100000
    },
    "xiaomi/mimo-v2-flash": {
     "context_window": 256000,
     "max_output": 256000
    },
    "minimax/minimax-m2.5": {
     "context_window": 204800,
     "max_output": 128000
    },
    "minimax/minimax-m2.5-highspeed": {
     "context_window": 204800,
     "max_output": 128000
    },
    "minimax/minimax-m2.1": {
     "context_window": 204800,
     "max_output": 128000
    },
    "minimax/minimax-m2": {
     "context_window": 200000,
     "max_output": 128000
    },
    "stepfun/step-3.5-flash": {
     "context_window": 64000,
     "max_output": 4096
    },
    "openai/gpt-5.2": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-5": {
     "context_window": 400000,
     "max_output": 128000
    }
   }
  },
  "modelscope": {
   "api": "https://api-inference.modelscope.cn/v1",
   "models": {
    "ZhipuAI/GLM-4.6": {
     "context_window": 202752,
     "max_output": 98304
    },
    "ZhipuAI/GLM-4.5": {
     "context_window": 131072,
     "max_output": 98304
    },
    "Qwen/Qwen3-30B-A3B-Instruct-2507": {
     "context_window": 262144,
     "max_output": 16384
    },
    "Qwen/Qwen3-235B-A22B-Thinking-2507": {
     "context_window": 262144,
     "max_output": 131072
    },
    "Qwen/Qwen3-235B-A22B-Instruct-2507": {
     "context_window": 262144,
     "max_output": 131072
    },
    "Qwen/Qwen3-30B-A3B-Thinking-2507": {
     "context_window": 262144,
     "max_output": 32768
    },
    "Qwen/Qwen3-Coder-30B-A3B-Instruct": {
     "context_window": 262144,
     "max_output": 65536
    }
   }
  },
  "google": {
   "api": null,
   "models": {
    "gemini-flash-latest": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "gemma-4-31b-it": {
     "context_window": 262144,
     "max_output": 32768
    },
    "gemini-omni-flash-preview": {
     "context_window": 131072,
     "max_output": 65536
    },
    "gemini-3.1-flash-image-preview": {
     "context_window": 65536,
     "max_output": 65536
    },
    "veo-3.1-lite-generate-preview": {
     "max_output": 8192
    },
    "lyria-3-pro-preview": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "gemini-3.1-flash-tts-preview": {
     "context_window": 8192,
     "max_output": 16384
    },
    "gemini-2.5-flash-image": {
     "context_window": 32768,
     "max_output": 32768
    },
    "gemini-flash-lite-latest": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "gemini-embedding-2": {
     "context_window": 8192
    },
    "gemini-3.6-flash": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "gemma-4-26b-a4b-it": {
     "context_window": 262144,
     "max_output": 32768
    },
    "gemini-3-pro-image-preview": {
     "context_window": 131072,
     "max_output": 32768
    },
    "gemini-2.5-pro-preview-tts": {
     "context_window": 8192,
     "max_output": 16384
    },
    "gemini-3.5-flash-lite": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "gemini-3.1-flash-image": {
     "context_window": 131072,
     "max_output": 32768
    },
    "lyria-3-clip-preview": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "gemini-3.1-pro-preview": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "gemini-2.5-computer-use-preview-10-2025": {
     "context_window": 128000,
     "max_output": 64000
    },
    "gemini-3.5-flash": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "gemini-2.5-pro": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "gemini-3-pro-image": {
     "context_window": 65536,
     "max_output": 32768
    },
    "gemini-2.5-flash": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "gemini-2.5-flash-preview-tts": {
     "context_window": 8192,
     "max_output": 16384
    },
    "gemini-3.1-flash-lite-image": {
     "context_window": 65536,
     "max_output": 4096
    },
    "deep-research-preview-04-2026": {
     "context_window": 131072,
     "max_output": 65536
    },
    "deep-research-max-preview-04-2026": {
     "context_window": 131072,
     "max_output": 65536
    },
    "veo-3.1-fast-generate-preview": {
     "max_output": 8192
    },
    "gemini-3.7-flash": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "veo-3.1-generate-preview": {
     "max_output": 8192
    },
    "gemini-3.1-pro-preview-customtools": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "gemini-3-flash-preview": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "gemini-3.8-flash": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "gemini-3.5-live-translate-preview": {
     "context_window": 16384,
     "max_output": 32768
    },
    "gemini-2.5-flash-lite": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "gemini-embedding-001": {
     "context_window": 2048
    },
    "gemini-3.1-flash-lite-preview": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "gemini-3.1-flash-live-preview": {
     "context_window": 131072,
     "max_output": 65536
    },
    "gemini-3.1-flash-lite": {
     "context_window": 1048576,
     "max_output": 65536
    }
   }
  },
  "vancine": {
   "api": "https://vancine.com/v1",
   "models": {
    "MiniMax-M3": {
     "context_window": 1048576,
     "max_output": 512000
    },
    "glm-5.3-flash": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "qwen3.8-max": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "kimi-k3": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "deepseek-v4.1-flash": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "qwen3.8-flash": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "hy4-preview": {
     "context_window": 1024000,
     "max_output": 64000
    },
    "glm-5.3": {
     "context_window": 1000000,
     "max_output": 131072
    }
   }
  },
  "zhipuai-coding-plan": {
   "api": "https://open.bigmodel.cn/api/coding/paas/v4",
   "models": {
    "glm-5.3-flash": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "glm-5.3-highspeed": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "glm-5.3": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "glm-4.6v": {
     "context_window": 128000,
     "max_output": 32768
    }
   }
  },
  "lucidquery": {
   "api": "https://api.lucidquery.com/v1",
   "models": {
    "lucidquery-agi-01-frontier": {
     "context_window": 300000,
     "max_output": 120000
    },
    "lucidquery-nexus-coder": {
     "context_window": 250000,
     "max_output": 60000
    },
    "lucidnova-rf1-100b": {
     "context_window": 120000,
     "max_output": 8000
    },
    "lucidquery-agi-01-swift": {
     "context_window": 300000,
     "max_output": 120000
    }
   }
  },
  "gmicloud": {
   "api": "https://api.gmi-serving.com/v1",
   "models": {
    "anthropic/claude-opus-4.6": {
     "context_window": 409600,
     "max_output": 128000
    },
    "anthropic/claude-opus-4.7": {
     "context_window": 409600,
     "max_output": 128000
    },
    "anthropic/claude-opus-4.8": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-sonnet-4.6": {
     "context_window": 409600,
     "max_output": 64000
    },
    "Qwen/Qwen3.7-Max": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "Qwen/Qwen3.8-Max": {
     "context_window": 262144,
     "max_output": 131072
    },
    "Qwen/Qwen3.8-Flash": {
     "context_window": 1048575,
     "max_output": 131072
    },
    "deepseek-ai/DeepSeek-V4-Flash": {
     "context_window": 1048575,
     "max_output": 384000
    },
    "deepseek-ai/DeepSeek-V4-Pro": {
     "context_window": 1048576,
     "max_output": 384000
    },
    "MiniMaxAI/MiniMax-M3": {
     "context_window": 1048576,
     "max_output": 512000
    },
    "MiniMaxAI/MiniMax-M2.7": {
     "context_window": 196608,
     "max_output": 131072
    },
    "moonshotai/Kimi-K2.6": {
     "context_window": 65536,
     "max_output": 65536
    },
    "moonshotai/kimi-k2.7-code-highspeed": {
     "context_window": 262144,
     "max_output": 262144
    },
    "zai-org/GLM-5.2-FP8": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "zai-org/GLM-5-FP8": {
     "context_window": 202752,
     "max_output": 131072
    },
    "zai-org/GLM-5.1-FP8": {
     "context_window": 202752,
     "max_output": 131072
    },
    "openai/gpt-5.5": {
     "context_window": 1050000,
     "max_output": 128000
    }
   }
  },
  "oci": {
   "api": "https://inference.generativeai.us-chicago-1.oci.oraclecloud.com/openai/v1",
   "models": {
    "xai.grok-4.3": {
     "context_window": 1000000,
     "max_output": 30000
    },
    "xai.grok-4.20-non-reasoning": {
     "context_window": 1000000,
     "max_output": 30000
    },
    "meta.llama-3.3-70b-instruct": {
     "context_window": 128000,
     "max_output": 4096
    },
    "meta.llama-4-scout-17b-16e-instruct": {
     "context_window": 192000,
     "max_output": 16384
    },
    "xai.grok-4.6": {
     "context_window": 500000,
     "max_output": 500000
    },
    "meta.llama-4-maverick-17b-128e-instruct-fp8": {
     "context_window": 512000,
     "max_output": 16384
    },
    "openai.gpt-oss-120b": {
     "context_window": 128000,
     "max_output": 16384
    },
    "openai.gpt-oss-20b": {
     "context_window": 128000,
     "max_output": 16384
    },
    "xai.grok-4.20-reasoning": {
     "context_window": 1000000,
     "max_output": 30000
    }
   }
  },
  "cloudflare-ai-gateway": {
   "api": null,
   "models": {
    "anthropic/claude-opus-4.5": {
     "context_window": 200000,
     "max_output": 64000
    },
    "anthropic/claude-opus-4.6": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-opus-4.7": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-opus-4.8": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-haiku-4.5": {
     "context_window": 200000,
     "max_output": 64000
    },
    "anthropic/claude-opus-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-fable-5.1": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-sonnet-4.5": {
     "context_window": 200000,
     "max_output": 64000
    },
    "anthropic/claude-fable-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-sonnet-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-sonnet-4.6": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-opus-5.5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "deepseek/deepseek-v4-pro": {
     "context_window": 131072,
     "max_output": 384000
    },
    "unbiased/pareto": {
     "context_window": 262144,
     "max_output": 131072
    },
    "alibaba/qwen3.7-max": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "alibaba/qwen3.8-max": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "alibaba/qwen3-max": {
     "context_window": 262144,
     "max_output": 65536
    },
    "alibaba/qwen3.5-397b-a17b": {
     "context_window": 262144,
     "max_output": 65536
    },
    "alibaba/qwen3.7-plus": {
     "context_window": 1000000,
     "max_output": 64000
    },
    "xai/grok-4.7": {
     "context_window": 500000,
     "max_output": 500000
    },
    "xai/grok-4.3": {
     "context_window": 1000000,
     "max_output": 30000
    },
    "xai/grok-4.20-0309-reasoning": {
     "context_window": 2000000,
     "max_output": 30000
    },
    "xai/grok-4.5": {
     "context_window": 500000,
     "max_output": 500000
    },
    "xai/grok-4.20-0309-non-reasoning": {
     "context_window": 2000000,
     "max_output": 30000
    },
    "xai/grok-4.6": {
     "context_window": 500000,
     "max_output": 500000
    },
    "moonshotai/kimi-k3": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "openai/gpt-5.4": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "openai/gpt-5.4-pro": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "openai/gpt-5.5-pro": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "openai/gpt-5.4-nano": {
     "context_window": 128000,
     "max_output": 128000
    },
    "openai/gpt-4o": {
     "context_window": 128000,
     "max_output": 16384
    },
    "openai/gpt-5-mini": {
     "context_window": 128000,
     "max_output": 128000
    },
    "openai/o4-mini": {
     "context_window": 200000,
     "max_output": 100000
    },
    "openai/o3-mini": {
     "context_window": 200000,
     "max_output": 100000
    },
    "openai/gpt-4.1-nano": {
     "context_window": 1000000,
     "max_output": 32768
    },
    "openai/gpt-5-nano": {
     "context_window": 128000,
     "max_output": 128000
    },
    "openai/gpt-6-astra": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-5.1": {
     "context_window": 128000,
     "max_output": 128000
    },
    "openai/gpt-4o-mini": {
     "context_window": 128000,
     "max_output": 16384
    },
    "openai/gpt-5.4-mini": {
     "context_window": 128000,
     "max_output": 128000
    },
    "openai/gpt-5.6-luna": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-5.5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "openai/gpt-4.1": {
     "context_window": 1047576,
     "max_output": 32768
    },
    "openai/gpt-4.1-mini": {
     "context_window": 1047576,
     "max_output": 32768
    },
    "openai/gpt-6-luna": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-5.6-terra": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/o3": {
     "context_window": 200000,
     "max_output": 100000
    },
    "openai/gpt-5": {
     "context_window": 128000,
     "max_output": 128000
    },
    "openai/gpt-5.6-sol": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-6-sol": {
     "context_window": 1050000,
     "max_output": 128000
    }
   }
  },
  "clarifai": {
   "api": "https://api.clarifai.com/v2/ext/openai/v1",
   "models": {
    "minimaxai/chat-completion/models/MiniMax-M2_5-high-throughput": {
     "context_window": 204800,
     "max_output": 131072
    },
    "clarifai/main/models/mm-poly-8b": {
     "context_window": 32768,
     "max_output": 4096
    },
    "deepseek-ai/deepseek-ocr/models/DeepSeek-OCR": {
     "context_window": 8192,
     "max_output": 8192
    },
    "mistralai/completion/models/Ministral-3-3B-Reasoning-2512": {
     "context_window": 262144,
     "max_output": 262144
    },
    "mistralai/completion/models/Ministral-3-14B-Reasoning-2512": {
     "context_window": 262144,
     "max_output": 262144
    },
    "moonshotai/chat-completion/models/Kimi-K2_6": {
     "context_window": 262144,
     "max_output": 262144
    },
    "arcee_ai/AFM/models/trinity-mini": {
     "context_window": 131072,
     "max_output": 131072
    },
    "qwen/qwenCoder/models/Qwen3-Coder-30B-A3B-Instruct": {
     "context_window": 262144,
     "max_output": 65536
    },
    "qwen/qwenLM/models/Qwen3-30B-A3B-Instruct-2507": {
     "context_window": 262144,
     "max_output": 262144
    },
    "qwen/qwenLM/models/Qwen3-30B-A3B-Thinking-2507": {
     "context_window": 262144,
     "max_output": 131072
    },
    "openai/chat-completion/models/gpt-oss-120b-high-throughput": {
     "context_window": 131072,
     "max_output": 16384
    },
    "openai/chat-completion/models/gpt-oss-20b": {
     "context_window": 131072,
     "max_output": 16384
    }
   }
  },
  "aiand": {
   "api": "https://api.aiand.com/v1",
   "models": {
    "motif-technologies/motif-3": {
     "context_window": 262144,
     "max_output": 262144
    },
    "google/gemma-4-31b-it": {
     "context_window": 262144,
     "max_output": 32768
    },
    "deepseek-ai/deepseek-v4.1-flash": {
     "context_window": 1048576,
     "max_output": 384000
    },
    "deepseek-ai/deepseek-v4-pro": {
     "context_window": 1048576,
     "max_output": 384000
    },
    "deepseek-ai/deepseek-v4-flash": {
     "context_window": 1048576,
     "max_output": 384000
    },
    "moonshotai/kimi-k3": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "moonshotai/kimi-k2.7-code": {
     "context_window": 262144,
     "max_output": 262144
    },
    "zai-org/glm-5.3-flash": {
     "context_window": 1048550,
     "max_output": 131072
    },
    "zai-org/glm-5.2": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "zai-org/glm-5.3": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "qwen/qwen3.8-27b": {
     "context_window": 262144,
     "max_output": 32768
    },
    "qwen/qwen3.6-27b": {
     "context_window": 262144,
     "max_output": 65536
    },
    "openai/gpt-oss-120b": {
     "context_window": 131072,
     "max_output": 32768
    }
   }
  },
  "frogbot": {
   "api": "https://app.frogbot.ai/api/v1",
   "models": {
    "grok-4-1-fast-reasoning": {
     "context_window": 2000000,
     "max_output": 128000
    },
    "gpt-5-4-mini": {
     "context_window": 400000,
     "max_output": 128000
    },
    "claude-haiku-4-5": {
     "context_window": 200000,
     "max_output": 64000
    },
    "grok-4-1-fast-non-reasoning": {
     "context_window": 2000000,
     "max_output": 128000
    },
    "gpt-4o": {
     "context_window": 128000,
     "max_output": 16384
    },
    "minimax-m2-5": {
     "context_window": 192000,
     "max_output": 8192
    },
    "gpt-5-4-nano": {
     "context_window": 400000,
     "max_output": 128000
    },
    "kimi-k2.5": {
     "context_window": 256000,
     "max_output": 128000
    },
    "gpt-oss-20b": {
     "context_window": 131072,
     "max_output": 32768
    },
    "gemini-2.5-pro": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "gemini-2.5-flash": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "minimax-m2-7": {
     "context_window": 192000,
     "max_output": 8192
    },
    "kimi-k2-6": {
     "context_window": 256000,
     "max_output": 128000
    },
    "grok-code-fast-1": {
     "context_window": 256000,
     "max_output": 128000
    },
    "qwen-3-6-plus": {
     "context_window": 1000000,
     "max_output": 64000
    },
    "claude-opus-4-6": {
     "context_window": 200000,
     "max_output": 128000
    },
    "grok-4-3": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "gpt-5-5": {
     "context_window": 272000,
     "max_output": 128000
    },
    "gemini-3-flash-preview": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "gemini-3-1-pro-preview": {
     "context_window": 1000000,
     "max_output": 64000
    },
    "deepseek-v4-pro": {
     "context_window": 128000,
     "max_output": 8192
    },
    "claude-sonnet-4-6": {
     "context_window": 200000,
     "max_output": 64000
    },
    "gpt-5-3-codex": {
     "context_window": 400000,
     "max_output": 128000
    },
    "gpt-oss-120b": {
     "context_window": 131072,
     "max_output": 32768
    },
    "claude-opus-4-7": {
     "context_window": 200000,
     "max_output": 128000
    },
    "zai-glm-5-1": {
     "context_window": 198000,
     "max_output": 8192
    }
   }
  },
  "stackit": {
   "api": "https://api.openai-compat.model-serving.eu01.onstackit.cloud/v1",
   "models": {
    "google/gemma-3-27b-it": {
     "context_window": 37000,
     "max_output": 4096
    },
    "intfloat/e5-mistral-7b-instruct": {
     "context_window": 4096,
     "max_output": 4096
    },
    "Qwen/Qwen3-VL-235B-A22B-Instruct-FP8": {
     "context_window": 218000,
     "max_output": 16384
    },
    "Qwen/Qwen3-VL-Embedding-8B": {
     "context_window": 32000,
     "max_output": 4096
    },
    "Qwen/Qwen3.6-27B": {
     "context_window": 262144,
     "max_output": 16384
    },
    "cortecs/Llama-3.3-70B-Instruct-FP8-Dynamic": {
     "context_window": 128000,
     "max_output": 4096
    },
    "openai/gpt-oss-20b": {
     "context_window": 131072,
     "max_output": 8192
    },
    "openai/gpt-oss-120b": {
     "context_window": 131000,
     "max_output": 8192
    }
   }
  },
  "anyapi": {
   "api": "https://api.anyapi.ai/v1",
   "models": {
    "anthropic/claude-haiku-4-5": {
     "context_window": 200000,
     "max_output": 64000
    },
    "anthropic/claude-sonnet-4-5": {
     "context_window": 200000,
     "max_output": 64000
    },
    "anthropic/claude-opus-4-6": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-sonnet-4-6": {
     "context_window": 1000000,
     "max_output": 64000
    },
    "anthropic/claude-opus-4-7": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "cohere/command-r-plus-08-2024": {
     "context_window": 128000,
     "max_output": 4000
    },
    "deepseek/deepseek-chat": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "deepseek/deepseek-r1": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "deepseek/deepseek-v4-pro": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "deepseek/deepseek-v4-flash": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "perplexity/sonar-pro": {
     "context_window": 200000,
     "max_output": 8192
    },
    "perplexity/sonar-reasoning-pro": {
     "context_window": 128000,
     "max_output": 4096
    },
    "google/gemini-3-pro-preview": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemini-2.5-pro": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemini-2.5-flash": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemini-3-flash-preview": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemini-2.5-flash-lite": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "xai/grok-4.3": {
     "context_window": 1000000,
     "max_output": 30000
    },
    "mistralai/devstral-2512": {
     "context_window": 262144,
     "max_output": 262144
    },
    "mistralai/mistral-large-2512": {
     "context_window": 262144,
     "max_output": 262144
    },
    "openai/gpt-5.4": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-5-mini": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/o4-mini": {
     "context_window": 200000,
     "max_output": 100000
    },
    "openai/o3-mini": {
     "context_window": 200000,
     "max_output": 100000
    },
    "openai/gpt-5.1": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-5.2": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-4.1": {
     "context_window": 1047576,
     "max_output": 32768
    },
    "openai/gpt-4.1-mini": {
     "context_window": 1047576,
     "max_output": 32768
    },
    "openai/o3": {
     "context_window": 200000,
     "max_output": 100000
    },
    "openai/gpt-5": {
     "context_window": 400000,
     "max_output": 128000
    }
   }
  },
  "crusoe": {
   "api": "https://api.inference.crusoecloud.com/v1",
   "models": {
    "zai/GLM-5.1": {
     "context_window": 200000,
     "max_output": 131072
    },
    "zai/GLM-5.2": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "meta-llama/Llama-3.3-70B-Instruct": {
     "context_window": 128000,
     "max_output": 4096
    },
    "google/gemma-4-31b-it": {
     "context_window": 262144,
     "max_output": 32768
    },
    "Qwen/Qwen3-235B-A22B-Instruct-2507": {
     "context_window": 262144,
     "max_output": 16384
    },
    "deepseek-ai/DeepSeek-V3-0324": {
     "context_window": 163840,
     "max_output": 163840
    },
    "moonshotai/Kimi-K2.6": {
     "context_window": 262144,
     "max_output": 262144
    },
    "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B": {
     "context_window": 262144,
     "max_output": 262144
    },
    "nvidia/Nemotron-3-Nano-Omni-Reasoning-30B-A3B": {
     "context_window": 256000,
     "max_output": 65536
    },
    "nvidia/NVIDIA-Nemotron-3-Super-120B-A12B": {
     "context_window": 262144,
     "max_output": 262144
    },
    "openai/gpt-oss-120b": {
     "context_window": 131072,
     "max_output": 32768
    }
   }
  },
  "volcengine-coding-plan": {
   "api": "https://ark.cn-beijing.volces.com/api/coding/v3",
   "models": {
    "doubao-seed-2.0-lite": {
     "context_window": 256000,
     "max_output": 32000
    },
    "glm-5.3-flash": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "kimi-k3": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "doubao-seed-2.1-turbo": {
     "context_window": 256000,
     "max_output": 256000
    },
    "minimax-m3": {
     "context_window": 1048576,
     "max_output": 512000
    },
    "doubao-seed-evolving": {
     "context_window": 256000,
     "max_output": 256000
    },
    "deepseek-v4-pro": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "glm-5.3": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "kimi-k2.7-code": {
     "context_window": 262144,
     "max_output": 262144
    },
    "deepseek-v4-flash": {
     "context_window": 1000000,
     "max_output": 384000
    }
   }
  },
  "jiekou": {
   "api": "https://api.jiekou.ai/openai",
   "models": {
    "grok-4-1-fast-reasoning": {
     "context_window": 2000000,
     "max_output": 2000000
    },
    "grok-4-1-fast-non-reasoning": {
     "context_window": 2000000,
     "max_output": 2000000
    },
    "gpt-5.2-codex": {
     "context_window": 400000,
     "max_output": 128000
    },
    "gpt-5.1-codex": {
     "context_window": 400000,
     "max_output": 128000
    },
    "gemini-3-pro-preview": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "gpt-5-codex": {
     "context_window": 400000,
     "max_output": 128000
    },
    "gpt-5-mini": {
     "context_window": 400000,
     "max_output": 128000
    },
    "gpt-5.2-pro": {
     "context_window": 400000,
     "max_output": 128000
    },
    "o4-mini": {
     "context_window": 200000,
     "max_output": 100000
    },
    "o3-mini": {
     "context_window": 131072,
     "max_output": 131072
    },
    "grok-4-fast-reasoning": {
     "context_window": 2000000,
     "max_output": 2000000
    },
    "gpt-5-nano": {
     "context_window": 400000,
     "max_output": 128000
    },
    "gemini-2.5-flash-lite-preview-06-17": {
     "context_window": 1048576,
     "max_output": 65535
    },
    "claude-opus-4-20250514": {
     "context_window": 200000,
     "max_output": 32000
    },
    "grok-4-fast-non-reasoning": {
     "context_window": 2000000,
     "max_output": 2000000
    },
    "claude-opus-4-1-20250805": {
     "context_window": 200000,
     "max_output": 32000
    },
    "gpt-5-pro": {
     "context_window": 400000,
     "max_output": 272000
    },
    "gpt-5-chat-latest": {
     "context_window": 400000,
     "max_output": 128000
    },
    "claude-opus-4-5-20251101": {
     "context_window": 200000,
     "max_output": 65536
    },
    "gpt-5.1": {
     "context_window": 400000,
     "max_output": 128000
    },
    "gemini-2.5-pro": {
     "context_window": 1048576,
     "max_output": 65535
    },
    "gemini-2.5-flash": {
     "context_window": 1048576,
     "max_output": 65535
    },
    "gemini-2.5-flash-preview-05-20": {
     "context_window": 1048576,
     "max_output": 200000
    },
    "gpt-5.1-codex-max": {
     "context_window": 400000,
     "max_output": 128000
    },
    "gpt-5.2": {
     "context_window": 400000,
     "max_output": 128000
    },
    "grok-code-fast-1": {
     "context_window": 256000,
     "max_output": 256000
    },
    "claude-sonnet-4-5-20250929": {
     "context_window": 200000,
     "max_output": 64000
    },
    "claude-opus-4-6": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "gemini-3-flash-preview": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "claude-haiku-4-5-20251001": {
     "context_window": 20000,
     "max_output": 64000
    },
    "gemini-2.5-flash-lite-preview-09-2025": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "gemini-2.5-pro-preview-06-05": {
     "context_window": 1048576,
     "max_output": 200000
    },
    "gemini-2.5-flash-lite": {
     "context_window": 1048576,
     "max_output": 65535
    },
    "claude-sonnet-4-20250514": {
     "context_window": 200000,
     "max_output": 64000
    },
    "gpt-5.1-codex-mini": {
     "context_window": 400000,
     "max_output": 128000
    },
    "o3": {
     "context_window": 131072,
     "max_output": 131072
    },
    "grok-4-0709": {
     "context_window": 256000,
     "max_output": 8192
    },
    "deepseek/deepseek-v3-0324": {
     "context_window": 163840,
     "max_output": 163840
    },
    "deepseek/deepseek-v3.1": {
     "context_window": 163840,
     "max_output": 32768
    },
    "deepseek/deepseek-r1-0528": {
     "context_window": 163840,
     "max_output": 32768
    },
    "xiaomimimo/mimo-v2-flash": {
     "context_window": 262144,
     "max_output": 131072
    },
    "baidu/ernie-4.5-vl-424b-a47b": {
     "context_window": 123000,
     "max_output": 16000
    },
    "baidu/ernie-4.5-300b-a47b-paddle": {
     "context_window": 123000,
     "max_output": 12000
    },
    "minimaxai/minimax-m1-80k": {
     "context_window": 1000000,
     "max_output": 40000
    },
    "moonshotai/kimi-k2.5": {
     "context_window": 262144,
     "max_output": 262144
    },
    "moonshotai/kimi-k2-instruct": {
     "context_window": 131072,
     "max_output": 131072
    },
    "moonshotai/kimi-k2-0905": {
     "context_window": 262144,
     "max_output": 262144
    },
    "zai-org/glm-4.5": {
     "context_window": 131072,
     "max_output": 98304
    },
    "zai-org/glm-4.5v": {
     "context_window": 65536,
     "max_output": 16384
    },
    "zai-org/glm-4.7-flash": {
     "context_window": 200000,
     "max_output": 128000
    },
    "zai-org/glm-4.7": {
     "context_window": 204800,
     "max_output": 131072
    },
    "minimax/minimax-m2.1": {
     "context_window": 204800,
     "max_output": 131072
    },
    "qwen/qwen3-235b-a22b-instruct-2507": {
     "context_window": 131072,
     "max_output": 16384
    },
    "qwen/qwen3-next-80b-a3b-thinking": {
     "context_window": 65536,
     "max_output": 65536
    },
    "qwen/qwen3-coder-next": {
     "context_window": 262144,
     "max_output": 65536
    },
    "qwen/qwen3-235b-a22b-fp8": {
     "context_window": 40960,
     "max_output": 20000
    },
    "qwen/qwen3-coder-480b-a35b-instruct": {
     "context_window": 262144,
     "max_output": 65536
    },
    "qwen/qwen3-235b-a22b-thinking-2507": {
     "context_window": 131072,
     "max_output": 131072
    },
    "qwen/qwen3-30b-a3b-fp8": {
     "context_window": 40960,
     "max_output": 20000
    },
    "qwen/qwen3-next-80b-a3b-instruct": {
     "context_window": 65536,
     "max_output": 65536
    },
    "qwen/qwen3-32b-fp8": {
     "context_window": 40960,
     "max_output": 20000
    }
   }
  },
  "ollama-cloud": {
   "api": "https://ollama.com/v1",
   "models": {
    "glm-5.3-flash": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "nemotron-3-ultra": {
     "context_window": 262144,
     "max_output": 128000
    },
    "kimi-k3": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "deepseek-v4.1-flash": {
     "context_window": 1048576,
     "max_output": 384000
    },
    "minimax-m2.5": {
     "context_window": 204800,
     "max_output": 131072
    },
    "kimi-k2.6": {
     "context_window": 262144,
     "max_output": 262144
    },
    "qwen3.5:397b": {
     "context_window": 262144,
     "max_output": 65536
    },
    "gpt-oss:20b": {
     "context_window": 131072,
     "max_output": 32768
    },
    "gpt-oss:120b": {
     "context_window": 131072,
     "max_output": 32768
    },
    "nemotron-3-nano:30b": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "kimi-k2.5": {
     "context_window": 262144,
     "max_output": 262144
    },
    "mistral-large-3:675b": {
     "context_window": 262144,
     "max_output": 262144
    },
    "minimax-m2.7": {
     "context_window": 196608,
     "max_output": 196608
    },
    "deepseek-v4-pro:0813": {
     "context_window": 1048576,
     "max_output": 1048576
    },
    "minimax-m3": {
     "context_window": 512000,
     "max_output": 131072
    },
    "deepseek-v4-flash:0731": {
     "context_window": 1048576,
     "max_output": 1048576
    },
    "gemma4:31b": {
     "context_window": 262144,
     "max_output": 262144
    },
    "glm-5.2": {
     "context_window": 976000,
     "max_output": 131072
    },
    "glm-5.1": {
     "context_window": 202752,
     "max_output": 131072
    },
    "deepseek-v4-pro": {
     "context_window": 1048576,
     "max_output": 1048576
    },
    "glm-5.3": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "kimi-k2.7-code": {
     "context_window": 262144,
     "max_output": 262144
    },
    "nemotron-3-super": {
     "context_window": 262144,
     "max_output": 65536
    },
    "deepseek-v4-flash": {
     "context_window": 1048576,
     "max_output": 1048576
    }
   }
  },
  "agentrouter": {
   "api": "https://agentrouter.org/v1",
   "models": {
    "claude-opus-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "claude-opus-4-8": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "glm-5.3": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "gpt-5.6-sol": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "deepseek-v4-flash": {
     "context_window": 1000000,
     "max_output": 384000
    }
   }
  },
  "tencent-tokenhub": {
   "api": "https://tokenhub.tencentmaas.com/v1",
   "models": {
    "hy3-preview": {
     "context_window": 256000,
     "max_output": 64000
    },
    "hy3": {
     "context_window": 256000,
     "max_output": 128000
    },
    "hy4-preview": {
     "context_window": 1024000,
     "max_output": 64000
    }
   }
  },
  "watsonx": {
   "api": null,
   "models": {
    "meta-llama/llama-4-maverick-17b-128e-instruct-fp8": {
     "context_window": 131072,
     "max_output": 8192
    },
    "meta-llama/llama-3-3-70b-instruct": {
     "context_window": 131072,
     "max_output": 4096
    },
    "ibm/granite-4-h-small": {
     "context_window": 131072,
     "max_output": 131072
    },
    "mistralai/mistral-small-3-1-24b-instruct-2503": {
     "context_window": 131072,
     "max_output": 16384
    },
    "openai/gpt-oss-120b": {
     "context_window": 131072,
     "max_output": 32768
    }
   }
  },
  "ambient": {
   "api": "https://api.ambient.xyz/v1",
   "models": {
    "deepseek/deepseek-v4-flash-0731": {
     "context_window": 1048576,
     "max_output": 1048576
    },
    "deepseek/deepseek-v4-flash": {
     "context_window": 1048576,
     "max_output": 1048576
    },
    "z-ai/glm-5.2": {
     "context_window": 202752,
     "max_output": 202752
    },
    "ambient/large": {
     "context_window": 202752,
     "max_output": 202752
    },
    "moonshotai/kimi-k2.6": {
     "context_window": 262144,
     "max_output": 262144
    },
    "moonshotai/kimi-k2.7-code": {
     "context_window": 262144,
     "max_output": 262144
    },
    "zai-org/GLM-5.2-FP8": {
     "context_window": 202752,
     "max_output": 202752
    },
    "zai-org/GLM-5.1-FP8": {
     "context_window": 202752,
     "max_output": 131072
    },
    "xiaomi/mimo-v2.5": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "stepfun/step-3.7-flash": {
     "context_window": 262144,
     "max_output": 262144
    },
    "qwen/qwen3.8-27b": {
     "context_window": 32768,
     "max_output": 8192
    },
    "qwen/qwen3.6-27b": {
     "context_window": 32768,
     "max_output": 8192
    }
   }
  },
  "model-oracle-ai": {
   "api": "https://api.modeloracle.com/api/v1",
   "models": {
    "gpt-5.4": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "gpt-5.4-nano": {
     "context_window": 400000,
     "max_output": 128000
    },
    "o4-mini": {
     "context_window": 200000,
     "max_output": 100000
    },
    "claude-opus-4.8": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "claude-haiku-4.5": {
     "context_window": 200000,
     "max_output": 64000
    },
    "claude-fable-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "gpt-5.4-mini": {
     "context_window": 400000,
     "max_output": 128000
    },
    "gpt-5.5": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "gpt-4.1": {
     "context_window": 1047576,
     "max_output": 32768
    },
    "claude-sonnet-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "glm-5.2": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "gpt-4.1-mini": {
     "context_window": 1047576,
     "max_output": 32768
    },
    "deepseek-v4-pro": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "gpt-5": {
     "context_window": 400000,
     "max_output": 128000
    },
    "auto": {
     "context_window": 1000000,
     "max_output": 128000
    }
   }
  },
  "xai": {
   "api": null,
   "models": {
    "grok-4.7": {
     "context_window": 500000,
     "max_output": 500000
    },
    "grok-imagine-video-1.5-lite": {
     "context_window": 1024
    },
    "grok-imagine-image": {
     "context_window": 16000
    },
    "grok-imagine-video": {
     "context_window": 1024
    },
    "grok-4.3": {
     "context_window": 1000000,
     "max_output": 30000
    },
    "grok-4.20-0309-reasoning": {
     "context_window": 1000000,
     "max_output": 30000
    },
    "grok-imagine-video-1.5": {
     "context_window": 1024
    },
    "grok-4.5": {
     "context_window": 500000,
     "max_output": 500000
    },
    "grok-4.20-0309-non-reasoning": {
     "context_window": 1000000,
     "max_output": 30000
    },
    "grok-imagine-image-quality": {
     "context_window": 16000
    },
    "grok-build-0.1": {
     "context_window": 256000,
     "max_output": 256000
    },
    "grok-4.20-multi-agent-0309": {
     "context_window": 1000000,
     "max_output": 30000
    },
    "grok-4.6": {
     "context_window": 500000,
     "max_output": 500000
    }
   }
  },
  "nebius": {
   "api": "https://api.tokenfactory.nebius.com/v1",
   "models": {
    "google/gemma-3-27b-it": {
     "context_window": 110000,
     "max_output": 8192
    },
    "Qwen/Qwen3.8-27B": {
     "context_window": 262144,
     "max_output": 262144
    },
    "Qwen/Qwen3-30B-A3B-Instruct-2507": {
     "context_window": 262144,
     "max_output": 8192
    },
    "Qwen/Qwen3-235B-A22B-Instruct-2507": {
     "context_window": 262144,
     "max_output": 8192
    },
    "Qwen/Qwen3-Embedding-8B": {
     "context_window": 40960
    },
    "Qwen/Qwen3.5-397B-A17B": {
     "context_window": 262144,
     "max_output": 8192
    },
    "deepseek-ai/DeepSeek-V4-Flash-0731": {
     "context_window": 1024000,
     "max_output": 1024000
    },
    "deepseek-ai/DeepSeek-V4-Pro-0813": {
     "context_window": 979000,
     "max_output": 979000
    },
    "deepseek-ai/DeepSeek-V4.1-Flash": {
     "context_window": 1048000,
     "max_output": 1048000
    },
    "deepseek-ai/DeepSeek-V4-Pro": {
     "context_window": 1048576,
     "max_output": 1048576
    },
    "MiniMaxAI/MiniMax-M3": {
     "context_window": 1048576,
     "max_output": 1048576
    },
    "moonshotai/Kimi-K3": {
     "context_window": 1048576,
     "max_output": 8000
    },
    "moonshotai/Kimi-K2.7-Code": {
     "context_window": 262144,
     "max_output": 8000
    },
    "zai-org/GLM-5.2": {
     "context_window": 1048576,
     "max_output": 1048576
    },
    "zai-org/GLM-5.3-Flash": {
     "context_window": 1024000,
     "max_output": 1024000
    },
    "zai-org/GLM-5.3": {
     "context_window": 1024000,
     "max_output": 1024000
    },
    "nvidia/nemotron-3-super-120b-a12b": {
     "context_window": 262144,
     "max_output": 32768
    },
    "nvidia/Nemotron-3_5-Lightning": {
     "context_window": 1048576,
     "max_output": 1048576
    },
    "nvidia/Nemotron-3-Ultra-550b-a55b": {
     "context_window": 1048576,
     "max_output": 1048576
    },
    "openai/gpt-oss-120b": {
     "context_window": 131072,
     "max_output": 8192
    },
    "NousResearch/Hermes-4-405B": {
     "context_window": 131072,
     "max_output": 8192
    }
   }
  },
  "minimax-cn": {
   "api": "https://api.minimax.cn/anthropic/v1",
   "models": {
    "MiniMax-M3": {
     "context_window": 1000000,
     "max_output": 512000
    },
    "MiniMax-M2.1": {
     "context_window": 204800,
     "max_output": 131072
    },
    "MiniMax-M2.5": {
     "context_window": 204800,
     "max_output": 131072
    },
    "MiniMax-M2.7": {
     "context_window": 204800,
     "max_output": 131072
    },
    "MiniMax-M2.7-highspeed": {
     "context_window": 204800,
     "max_output": 131072
    },
    "MiniMax-M2": {
     "context_window": 204800,
     "max_output": 131072
    },
    "MiniMax-M2.5-highspeed": {
     "context_window": 204800,
     "max_output": 131072
    }
   }
  },
  "scaleway": {
   "api": "https://api.scaleway.ai/v1",
   "models": {
    "qwen3.8-27b": {
     "context_window": 262144,
     "max_output": 32768
    },
    "deepseek-v4-flash-0731": {
     "context_window": 256000,
     "max_output": 32768
    },
    "qwen3-235b-a22b-instruct-2507": {
     "context_window": 260000,
     "max_output": 16384
    },
    "whisper-large-v3": {
     "max_output": 8192
    },
    "bge-multilingual-gemma2": {
     "context_window": 8191,
     "max_output": 3072
    },
    "qwen3-coder-30b-a3b-instruct": {
     "context_window": 128000,
     "max_output": 32768
    },
    "gemma-4-26b-a4b-it": {
     "context_window": 256000,
     "max_output": 16384
    },
    "llama-3.3-70b-instruct": {
     "context_window": 100000,
     "max_output": 16384
    },
    "qwen3.6-35b-a3b": {
     "context_window": 128000,
     "max_output": 16384
    },
    "pixtral-12b-2409": {
     "context_window": 128000,
     "max_output": 4096
    },
    "qwen3-embedding-8b": {
     "context_window": 32768,
     "max_output": 4096
    },
    "mistral-medium-3.5-128b": {
     "context_window": 256000,
     "max_output": 16384
    },
    "qwen3.5-397b-a17b": {
     "context_window": 256000,
     "max_output": 16384
    },
    "glm-5.2": {
     "context_window": 256000,
     "max_output": 16384
    },
    "mistral-small-3.2-24b-instruct-2506": {
     "context_window": 128000,
     "max_output": 32768
    },
    "gpt-oss-120b": {
     "context_window": 128000,
     "max_output": 32768
    }
   }
  },
  "vercel": {
   "api": null,
   "models": {
    "voyage/rerank-3-lite": {
     "context_window": 32000,
     "max_output": 32000
    },
    "voyage/voyage-law-2": {
     "context_window": 8192,
     "max_output": 1536
    },
    "voyage/rerank-2.5-lite": {
     "context_window": 32000,
     "max_output": 32000
    },
    "voyage/voyage-3.5": {
     "context_window": 8192,
     "max_output": 1536
    },
    "voyage/rerank-3": {
     "context_window": 32000,
     "max_output": 32000
    },
    "voyage/voyage-finance-2": {
     "context_window": 8192,
     "max_output": 1536
    },
    "voyage/voyage-4-large": {
     "context_window": 32000
    },
    "voyage/voyage-3.5-lite": {
     "context_window": 8192,
     "max_output": 1536
    },
    "voyage/voyage-4": {
     "context_window": 32000
    },
    "voyage/voyage-3-large": {
     "context_window": 8192,
     "max_output": 1536
    },
    "voyage/voyage-code-2": {
     "context_window": 8192,
     "max_output": 1536
    },
    "voyage/voyage-code-3": {
     "context_window": 8192,
     "max_output": 1536
    },
    "voyage/rerank-2.5": {
     "context_window": 32000,
     "max_output": 32000
    },
    "voyage/voyage-4-lite": {
     "context_window": 32000
    },
    "interfaze/interfaze-beta": {
     "context_window": 1000000,
     "max_output": 32000
    },
    "zai/glm-4.5": {
     "context_window": 128000,
     "max_output": 96000
    },
    "zai/glm-5v-turbo": {
     "context_window": 200000,
     "max_output": 128000
    },
    "zai/glm-5.3-flash": {
     "context_window": 1000000,
     "max_output": 131000
    },
    "zai/glm-4.6": {
     "context_window": 200000,
     "max_output": 96000
    },
    "zai/glm-5.2-fast": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "zai/glm-5": {
     "context_window": 202800,
     "max_output": 131100
    },
    "zai/glm-4.5v": {
     "context_window": 66000,
     "max_output": 16000
    },
    "zai/glm-5.3-flashx": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "zai/glm-4.7-flash": {
     "context_window": 200000,
     "max_output": 131000
    },
    "zai/glm-4.7": {
     "context_window": 200000,
     "max_output": 120000
    },
    "zai/glm-5.2": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "zai/glm-5.1": {
     "context_window": 202800,
     "max_output": 64000
    },
    "zai/glm-4.7-flashx": {
     "context_window": 200000,
     "max_output": 128000
    },
    "zai/glm-5-turbo": {
     "context_window": 202800,
     "max_output": 131072
    },
    "zai/glm-4.5-air": {
     "context_window": 128000,
     "max_output": 96000
    },
    "zai/glm-5.3": {
     "context_window": 1000000,
     "max_output": 1000000
    },
    "zai/glm-5.3-fast": {
     "context_window": 1048576,
     "max_output": 262144
    },
    "spacexai/grok-4.20-multi-agent": {
     "context_window": 2000000,
     "max_output": 2000000
    },
    "spacexai/grok-4.20-reasoning": {
     "context_window": 2000000,
     "max_output": 2000000
    },
    "spacexai/grok-4.7": {
     "context_window": 500000,
     "max_output": 500000
    },
    "spacexai/grok-4.20-non-reasoning": {
     "context_window": 2000000,
     "max_output": 2000000
    },
    "spacexai/grok-4.1-fast-reasoning": {
     "context_window": 1000000,
     "max_output": 1000000
    },
    "spacexai/grok-4.3": {
     "context_window": 1000000,
     "max_output": 1000000
    },
    "spacexai/grok-4.5": {
     "context_window": 500000,
     "max_output": 500000
    },
    "spacexai/grok-4.20-multi-agent-beta": {
     "context_window": 2000000,
     "max_output": 2000000
    },
    "spacexai/grok-4.20-non-reasoning-beta": {
     "context_window": 2000000,
     "max_output": 2000000
    },
    "spacexai/grok-build-0.1": {
     "context_window": 256000,
     "max_output": 256000
    },
    "spacexai/grok-4.1-fast-non-reasoning": {
     "context_window": 1000000,
     "max_output": 1000000
    },
    "spacexai/grok-4.20-reasoning-beta": {
     "context_window": 2000000,
     "max_output": 2000000
    },
    "spacexai/grok-4.6": {
     "context_window": 500000,
     "max_output": 500000
    },
    "poolside/laguna-s-2.1-free": {
     "context_window": 256000,
     "max_output": 32768
    },
    "poolside/laguna-s-2.1": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "anthropic/claude-opus-4.5": {
     "context_window": 200000,
     "max_output": 64000
    },
    "anthropic/claude-opus-4.6": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-opus-4.7": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-3-haiku": {
     "context_window": 200000,
     "max_output": 4096
    },
    "anthropic/claude-opus-4.8": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-opus-5.5-fast": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-haiku-4.5": {
     "context_window": 200000,
     "max_output": 64000
    },
    "anthropic/claude-opus-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-sonnet-5.5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-fable-5.1": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-fable-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-opus-4.8-fast": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-sonnet-4": {
     "context_window": 1000000,
     "max_output": 64000
    },
    "anthropic/claude-sonnet-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-sonnet-4.6": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-opus-5.5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-opus-5-fast": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-opus-4": {
     "context_window": 200000,
     "max_output": 32000
    },
    "anthropic/claude-sonnet-4.5": {
     "context_window": 1000000,
     "max_output": 64000
    },
    "cohere/rerank-v4-fast": {
     "context_window": 32000,
     "max_output": 32000
    },
    "cohere/rerank-v4-pro": {
     "context_window": 32000,
     "max_output": 32000
    },
    "cohere/command-a": {
     "context_window": 256000,
     "max_output": 8000
    },
    "cohere/embed-v4.0": {
     "context_window": 128000,
     "max_output": 1536
    },
    "cohere/rerank-v3.5": {
     "context_window": 4096,
     "max_output": 4096
    },
    "deepseek/deepseek-v4-flash-0731": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "deepseek/deepseek-v4.1-flash": {
     "context_window": 1048576,
     "max_output": 32768
    },
    "deepseek/deepseek-v4-flash-vision-exp": {
     "context_window": 1048576,
     "max_output": 1048576
    },
    "deepseek/deepseek-v3.1-terminus": {
     "context_window": 131072,
     "max_output": 32768
    },
    "deepseek/deepseek-v4-pro-0813": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "deepseek/deepseek-v3.2-thinking": {
     "context_window": 128000,
     "max_output": 8000
    },
    "deepseek/deepseek-v4.1-flash-fast": {
     "context_window": 1048576,
     "max_output": 1000000
    },
    "deepseek/deepseek-v3.1": {
     "context_window": 163840,
     "max_output": 128000
    },
    "deepseek/deepseek-v4-pro": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "deepseek/deepseek-v3.2": {
     "context_window": 128000,
     "max_output": 8000
    },
    "deepseek/deepseek-v4-flash": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "deepseek/deepseek-r1": {
     "context_window": 128000,
     "max_output": 32768
    },
    "quiverai/arrow-1.1": {
     "context_window": 131072,
     "max_output": 131072
    },
    "quiverai/arrow-2": {
     "context_window": 131072,
     "max_output": 65536
    },
    "quiverai/arrow-2-telos": {
     "context_window": 131072,
     "max_output": 65536
    },
    "bfl/flux-2-pro": {
     "context_window": 67300,
     "max_output": 67300
    },
    "bfl/flux-2-max": {
     "context_window": 67300,
     "max_output": 67300
    },
    "tencent/hy-mt2-lite": {
     "context_window": 8000,
     "max_output": 4000
    },
    "tencent/hy3": {
     "context_window": 262144,
     "max_output": 262144
    },
    "tencent/hy-mt2-plus": {
     "context_window": 8000,
     "max_output": 4000
    },
    "tencent/hy-mt2-pro": {
     "context_window": 8000,
     "max_output": 4000
    },
    "tencent/hy4-preview": {
     "context_window": 1024000,
     "max_output": 64000
    },
    "inference-net/schematron-v2-small": {
     "context_window": 128000,
     "max_output": 4096
    },
    "inference-net/schematron-v2-turbo": {
     "context_window": 128000,
     "max_output": 8192
    },
    "thinkingmachines/inkling-small": {
     "context_window": 1000000,
     "max_output": 1000000
    },
    "thinkingmachines/inkling": {
     "context_window": 256000,
     "max_output": 256000
    },
    "meituan/longcat-2.5-preview": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "perplexity/pplx-embed-v1-4b": {
     "context_window": 32000
    },
    "perplexity/pplx-embed-v1-0.6b": {
     "context_window": 32000
    },
    "perplexity/sonar": {
     "context_window": 127000,
     "max_output": 8000
    },
    "meta/muse-spark-1.3": {
     "context_window": 1048576,
     "max_output": 1048576
    },
    "meta/muse-glimmer-30b": {
     "context_window": 131072,
     "max_output": 131072
    },
    "meta/muse-spark-1.1": {
     "context_window": 1048576,
     "max_output": 1048576
    },
    "meta/llama-3.1-8b": {
     "context_window": 128000,
     "max_output": 8192
    },
    "meta/llama-3.1-70b": {
     "context_window": 128000,
     "max_output": 8192
    },
    "meta/muse-spark-1.2": {
     "context_window": 1048576,
     "max_output": 1048576
    },
    "meta/muse-spark-1.2-contributor": {
     "context_window": 1048576,
     "max_output": 1048576
    },
    "meta/muse-spark-1.3-contributor": {
     "context_window": 1048576,
     "max_output": 1048576
    },
    "meta/llama-3.3-70b": {
     "context_window": 128000,
     "max_output": 4096
    },
    "meta/llama-4-maverick": {
     "context_window": 128000,
     "max_output": 4096
    },
    "meta/llama-4-scout": {
     "context_window": 128000,
     "max_output": 4096
    },
    "arcee-ai/trinity-large-thinking": {
     "context_window": 262100,
     "max_output": 80000
    },
    "alibaba/qwen3.5-flash": {
     "context_window": 1000000,
     "max_output": 64000
    },
    "alibaba/qwen-3-32b": {
     "context_window": 128000,
     "max_output": 8192
    },
    "alibaba/qwen3-vl-235b-a22b-instruct": {
     "context_window": 131072,
     "max_output": 129024
    },
    "alibaba/qwen3.7-max": {
     "context_window": 991000,
     "max_output": 64000
    },
    "alibaba/qwen3.8-27b": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "alibaba/qwen3-vl-thinking": {
     "context_window": 131072,
     "max_output": 32768
    },
    "alibaba/qwen3.8-2.4t-a95b": {
     "context_window": 262144,
     "max_output": 128000
    },
    "alibaba/qwen3-next-80b-a3b-thinking": {
     "context_window": 262144,
     "max_output": 262144
    },
    "alibaba/qwen3.8-max": {
     "context_window": 262144,
     "max_output": 128000
    },
    "alibaba/qwen3-coder-next": {
     "context_window": 256000,
     "max_output": 256000
    },
    "alibaba/qwen3-vl-instruct": {
     "context_window": 131072,
     "max_output": 129024
    },
    "alibaba/qwen3-coder": {
     "context_window": 262144,
     "max_output": 65536
    },
    "alibaba/qwen3.5-plus": {
     "context_window": 1000000,
     "max_output": 64000
    },
    "alibaba/qwen-3.6-max-preview": {
     "context_window": 240000,
     "max_output": 64000
    },
    "alibaba/qwen-3-14b": {
     "context_window": 40960,
     "max_output": 16384
    },
    "alibaba/qwen3.7-flash": {
     "context_window": 991000,
     "max_output": 64000
    },
    "alibaba/qwen3-max": {
     "context_window": 262144,
     "max_output": 32768
    },
    "alibaba/qwen3-embedding-0.6b": {
     "context_window": 32768,
     "max_output": 32768
    },
    "alibaba/qwen-3-30b": {
     "context_window": 40960,
     "max_output": 16384
    },
    "alibaba/qwen3.8-omni-flash": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "alibaba/qwen3-coder-30b-a3b": {
     "context_window": 262144,
     "max_output": 8192
    },
    "alibaba/qwen3-embedding-4b": {
     "context_window": 32768,
     "max_output": 32768
    },
    "alibaba/qwen3-max-preview": {
     "context_window": 262144,
     "max_output": 32768
    },
    "alibaba/qwen3-next-80b-a3b-instruct": {
     "context_window": 262114,
     "max_output": 262114
    },
    "alibaba/qwen3-max-thinking": {
     "context_window": 256000,
     "max_output": 65536
    },
    "alibaba/qwen3-coder-plus": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "alibaba/qwen3.8-max-prime": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "alibaba/qwen3-235b-a22b-thinking": {
     "context_window": 131072,
     "max_output": 32768
    },
    "alibaba/qwen3.8-flash": {
     "context_window": 991000,
     "max_output": 128000
    },
    "alibaba/qwen3-embedding-8b": {
     "context_window": 32768,
     "max_output": 32768
    },
    "alibaba/qwen3.6-27b": {
     "context_window": 256000,
     "max_output": 65536
    },
    "alibaba/qwen-3-235b": {
     "context_window": 262144,
     "max_output": 16384
    },
    "alibaba/qwen3.6-plus": {
     "context_window": 1000000,
     "max_output": 64000
    },
    "alibaba/qwen3.7-plus": {
     "context_window": 1000000,
     "max_output": 64000
    },
    "alibaba/qwen3.8-max-0902": {
     "context_window": 991000,
     "max_output": 128000
    },
    "mixedbread/toast-1": {
     "context_window": 131000,
     "max_output": 4000
    },
    "bytedance/seed-1.8": {
     "context_window": 256000,
     "max_output": 32768
    },
    "bytedance/seed-2.1-turbo": {
     "context_window": 262144,
     "max_output": 262144
    },
    "bytedance/seed-1.6": {
     "context_window": 256000,
     "max_output": 32000
    },
    "google/gemma-4-31b-it": {
     "context_window": 262144,
     "max_output": 131072
    },
    "google/gemini-omni-flash-preview": {
     "context_window": 1000000,
     "max_output": 57920
    },
    "google/gemini-3.1-flash-image-preview": {
     "context_window": 131072,
     "max_output": 32768
    },
    "google/gemini-2.5-flash-image": {
     "context_window": 32768,
     "max_output": 65535
    },
    "google/text-multilingual-embedding-002": {
     "context_window": 8192,
     "max_output": 1536
    },
    "google/gemini-3.6-flash": {
     "context_window": 1000000,
     "max_output": 64000
    },
    "google/gemma-4-26b-a4b-it": {
     "context_window": 262144,
     "max_output": 131072
    },
    "google/gemini-3.5-flash-lite": {
     "context_window": 1000000,
     "max_output": 65000
    },
    "google/gemini-3.1-flash-image": {
     "context_window": 131072,
     "max_output": 32768
    },
    "google/gemini-3.1-pro-preview": {
     "context_window": 1000000,
     "max_output": 64000
    },
    "google/gemini-3-flash": {
     "context_window": 1000000,
     "max_output": 65000
    },
    "google/gemini-3.5-flash": {
     "context_window": 1000000,
     "max_output": 64000
    },
    "google/gemini-3-pro-image": {
     "context_window": 65536,
     "max_output": 32768
    },
    "google/gemini-3.1-flash-lite-image": {
     "context_window": 65536,
     "max_output": 4096
    },
    "google/gemini-3.7-flash": {
     "context_window": 1000000,
     "max_output": 65535
    },
    "google/text-embedding-005": {
     "context_window": 8192,
     "max_output": 1536
    },
    "google/gemini-3.8-flash": {
     "context_window": 1000000,
     "max_output": 65535
    },
    "google/gemini-2.5-flash-lite": {
     "context_window": 1048576,
     "max_output": 65535
    },
    "google/gemini-embedding-001": {
     "context_window": 8192,
     "max_output": 1536
    },
    "google/gemini-3.1-flash-lite": {
     "context_window": 1000000,
     "max_output": 65000
    },
    "google/gemini-2.5-flash": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemini-2.5-pro": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "fireworks/ember-1": {
     "context_window": 1048576,
     "max_output": 1048576
    },
    "sakana/fugu-max": {
     "context_window": 1000000,
     "max_output": 1000000
    },
    "sakana/fugu-ultra-v2": {
     "context_window": 1000000,
     "max_output": 1000000
    },
    "sakana/namazu": {
     "context_window": 256000,
     "max_output": 256000
    },
    "sakana/fugu-ultra": {
     "context_window": 1000000,
     "max_output": 1000000
    },
    "inclusionai/ling-3.1-flash-free": {
     "context_window": 262144,
     "max_output": 32768
    },
    "inclusionai/ling-3.0-flash": {
     "context_window": 256000,
     "max_output": 32000
    },
    "inclusionai/ling-3.1-flash": {
     "context_window": 262144,
     "max_output": 32768
    },
    "inclusionai/ling-3.0-flash-sante": {
     "context_window": 256000,
     "max_output": 32000
    },
    "inclusionai/ling-3.0-flash-vl": {
     "context_window": 256000,
     "max_output": 32000
    },
    "inclusionai/ling-3.0-flash-fin": {
     "context_window": 256000,
     "max_output": 32000
    },
    "moonshotai/kimi-k3": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "moonshotai/kimi-k3-fast": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "moonshotai/kimi-k2.7-code-highspeed": {
     "context_window": 262144,
     "max_output": 32768
    },
    "moonshotai/kimi-k2.6": {
     "context_window": 262000,
     "max_output": 262000
    },
    "moonshotai/kimi-k2-thinking": {
     "context_window": 216144,
     "max_output": 216144
    },
    "moonshotai/kimi-k2.5": {
     "context_window": 256000,
     "max_output": 256000
    },
    "moonshotai/kimi-k2": {
     "context_window": 131072,
     "max_output": 131072
    },
    "moonshotai/kimi-k2.7-code": {
     "context_window": 256000,
     "max_output": 32768
    },
    "nvidia/nemotron-3-nano-30b-a3b": {
     "context_window": 262144,
     "max_output": 262144
    },
    "nvidia/nemotron-3.5-lightning": {
     "context_window": 262144,
     "max_output": 131072
    },
    "nvidia/nemotron-nano-9b-v2": {
     "context_window": 131072,
     "max_output": 131072
    },
    "nvidia/nemotron-3-super-120b-a12b": {
     "context_window": 256000,
     "max_output": 32000
    },
    "nvidia/nemotron-3-ultra-550b-a55b": {
     "context_window": 1000000,
     "max_output": 65000
    },
    "nvidia/nemotron-nano-12b-v2-vl": {
     "context_window": 131072,
     "max_output": 131072
    },
    "xiaomi/mimo-v2.6-pro": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "xiaomi/mimo-v2.5": {
     "context_window": 1050000,
     "max_output": 131100
    },
    "xiaomi/mimo-v2.6-pro-ultraspeed": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "xiaomi/mimo-v2.5-pro": {
     "context_window": 1050000,
     "max_output": 131000
    },
    "xiaomi/mimo-v2.6-flash": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "minimax/minimax-m2.5": {
     "context_window": 204800,
     "max_output": 131000
    },
    "minimax/minimax-m2.1-lightning": {
     "context_window": 204800,
     "max_output": 131072
    },
    "minimax/minimax-m2.7": {
     "context_window": 204800,
     "max_output": 131000
    },
    "minimax/minimax-m3": {
     "context_window": 512000,
     "max_output": 512000
    },
    "minimax/minimax-m2.7-highspeed": {
     "context_window": 204800,
     "max_output": 131100
    },
    "minimax/minimax-m2.5-highspeed": {
     "context_window": 204800,
     "max_output": 131000
    },
    "minimax/minimax-m2.1": {
     "context_window": 204800,
     "max_output": 131072
    },
    "minimax/minimax-m2": {
     "context_window": 205000,
     "max_output": 196608
    },
    "stepfun/step-5-preview": {
     "context_window": 1000000,
     "max_output": 1000000
    },
    "stepfun/step-3.5-flash": {
     "context_window": 262114,
     "max_output": 262114
    },
    "stepfun/step-3.7-flash": {
     "context_window": 256000,
     "max_output": 256000
    },
    "inception/mercury-coder-small": {
     "context_window": 32000,
     "max_output": 16384
    },
    "inception/mercury-2.5": {
     "context_window": 260000,
     "max_output": 65536
    },
    "inception/mercury-2": {
     "context_window": 128000,
     "max_output": 50000
    },
    "amazon/titan-embed-text-v2": {
     "context_window": 8192,
     "max_output": 1536
    },
    "amazon/nova-2-lite": {
     "context_window": 1000000,
     "max_output": 65535
    },
    "amazon/nova-lite": {
     "context_window": 300000,
     "max_output": 10000
    },
    "amazon/nova-pro": {
     "context_window": 300000,
     "max_output": 10000
    },
    "amazon/nova-micro": {
     "context_window": 128000,
     "max_output": 10000
    },
    "mistral/codestral-embed": {
     "context_window": 8192,
     "max_output": 1536
    },
    "mistral/mistral-nemo": {
     "context_window": 60288,
     "max_output": 16000
    },
    "mistral/mistral-medium-3.5": {
     "context_window": 262144,
     "max_output": 256000
    },
    "mistral/mistral-small": {
     "context_window": 262144,
     "max_output": 4000
    },
    "mistral/mistral-large-3": {
     "context_window": 262144,
     "max_output": 256000
    },
    "mistral/mistral-embed": {
     "context_window": 8192,
     "max_output": 1536
    },
    "mistral/ministral-14b": {
     "context_window": 262144,
     "max_output": 256000
    },
    "mistral/codestral": {
     "context_window": 256000,
     "max_output": 4096
    },
    "mistral/ministral-8b": {
     "context_window": 128000,
     "max_output": 128000
    },
    "mistral/ministral-3b": {
     "context_window": 128000,
     "max_output": 128000
    },
    "morph/morph-v3-fast": {
     "context_window": 16000,
     "max_output": 16000
    },
    "morph/morph-v3-large": {
     "context_window": 32000,
     "max_output": 32000
    },
    "openai/gpt-4.1-mini-fast": {
     "context_window": 1047576,
     "max_output": 32768
    },
    "openai/o3-fast": {
     "context_window": 200000,
     "max_output": 100000
    },
    "openai/gpt-5.4": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-5.4-pro": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-oss-safeguard-120b": {
     "context_window": 128000,
     "max_output": 16000
    },
    "openai/gpt-3.5-turbo": {
     "context_window": 16385,
     "max_output": 4096
    },
    "openai/gpt-5.2-fast": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-5.5-pro": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "openai/text-embedding-3-small": {
     "context_window": 8192,
     "max_output": 1536
    },
    "openai/gpt-5.4-nano": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-realtime-2.1": {
     "context_window": 128000,
     "max_output": 32000
    },
    "openai/gpt-5.2-codex": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-4o-fast": {
     "context_window": 128000,
     "max_output": 16384
    },
    "openai/gpt-5.1-codex": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-6.1-sol-fast": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-4.1-nano-fast": {
     "context_window": 1047576,
     "max_output": 32768
    },
    "openai/gpt-5-codex": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-5.6-luna-fast": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-6-astra-fast": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-5.2-pro": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-5.1-thinking-fast": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/text-embedding-ada-002": {
     "context_window": 8192,
     "max_output": 1536
    },
    "openai/gpt-5.3-codex": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-5.3-codex-fast": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-5.5-fast": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "openai/gpt-5.4-fast": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-5.6-sol-fast": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/o4-mini-fast": {
     "context_window": 200000,
     "max_output": 100000
    },
    "openai/gpt-5-pro": {
     "context_window": 400000,
     "max_output": 272000
    },
    "openai/gpt-6.1-sol": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-5.1-thinking": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/text-embedding-3-large": {
     "context_window": 8192,
     "max_output": 1536
    },
    "openai/gpt-6-astra": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-5.4-mini-fast": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-5-mini-fast": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/o3-pro": {
     "context_window": 200000,
     "max_output": 100000
    },
    "openai/gpt-oss-20b": {
     "context_window": 131072,
     "max_output": 8192
    },
    "openai/gpt-oss-safeguard-20b": {
     "context_window": 128000,
     "max_output": 16000
    },
    "openai/gpt-5.6-terra-fast": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-5.4-mini": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-5.6-luna": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-5.1-codex-max": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-5.2": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-5.5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "openai/gpt-6-sol-fast": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-6-luna-fast": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-5-fast": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-4.1-fast": {
     "context_window": 1047576,
     "max_output": 32768
    },
    "openai/gpt-6-luna": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-5.6-terra": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-oss-120b": {
     "context_window": 131072,
     "max_output": 131072
    },
    "openai/gpt-5.1-codex-mini": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-5.6-sol": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-4o-mini-fast": {
     "context_window": 128000,
     "max_output": 16384
    },
    "openai/gpt-6-sol": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-5": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/o3": {
     "context_window": 200000,
     "max_output": 100000
    },
    "openai/gpt-4-turbo": {
     "context_window": 128000,
     "max_output": 4096
    },
    "openai/gpt-4.1-mini": {
     "context_window": 1047576,
     "max_output": 32768
    },
    "openai/gpt-4.1": {
     "context_window": 1047576,
     "max_output": 32768
    },
    "openai/gpt-4o-mini": {
     "context_window": 128000,
     "max_output": 16384
    },
    "openai/o1": {
     "context_window": 200000,
     "max_output": 100000
    },
    "openai/gpt-5-nano": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-4.1-nano": {
     "context_window": 1047576,
     "max_output": 32768
    },
    "openai/o3-mini": {
     "context_window": 200000,
     "max_output": 100000
    },
    "openai/o4-mini": {
     "context_window": 200000,
     "max_output": 100000
    },
    "openai/gpt-5-mini": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-4o": {
     "context_window": 128000,
     "max_output": 16384
    }
   }
  },
  "zai-coding-plan": {
   "api": "https://api.z.ai/api/coding/paas/v4",
   "models": {
    "glm-5.3-flash": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "glm-5.3-highspeed": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "glm-5.2-highspeed": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "glm-4.7": {
     "context_window": 204800,
     "max_output": 131072
    },
    "glm-5.2": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "glm-5-turbo": {
     "context_window": 200000,
     "max_output": 131072
    },
    "glm-5.3": {
     "context_window": 1000000,
     "max_output": 131072
    }
   }
  },
  "ebcloud": {
   "api": "https://maas-api.ebcloud.com/v1",
   "models": {
    "Kimi-K2.6": {
     "context_window": 262144,
     "max_output": 262144
    },
    "GLM-5.1": {
     "context_window": 200000,
     "max_output": 131072
    },
    "DeepSeek-V4-Flash": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "DeepSeek-V4-Pro": {
     "context_window": 1000000,
     "max_output": 384000
    }
   }
  },
  "greenpt": {
   "api": "https://api.greenpt.ai/v1",
   "models": {
    "glm-5.2-honey-ultra": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "glm-5.2-ponytail-lite": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "gemma-3-27b-it": {
     "context_window": 40000,
     "max_output": 8192
    },
    "glm-5.3-flash": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "deepseek-v4-flash-0731": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "qwen3-235b-a22b-instruct-2507": {
     "context_window": 262144,
     "max_output": 16384
    },
    "kimi-k3": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "deepseek-v4.1-flash": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "minimax-m2.5": {
     "context_window": 204800,
     "max_output": 131072
    },
    "kimi-k2.6": {
     "context_window": 262144,
     "max_output": 262144
    },
    "green-s": {
     "max_output": 8192
    },
    "green-l": {
     "context_window": 128000,
     "max_output": 32768
    },
    "qwen3-coder-30b-a3b-instruct": {
     "context_window": 128000,
     "max_output": 32768
    },
    "llama-3.3-70b-instruct": {
     "context_window": 100000,
     "max_output": 16384
    },
    "gemma4": {
     "context_window": 262144,
     "max_output": 32768
    },
    "qwen3.6-35b-a3b": {
     "context_window": 262144,
     "max_output": 32768
    },
    "pixtral-12b-2409": {
     "context_window": 128000,
     "max_output": 4096
    },
    "glm-5.2-honey": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "holo2-30b-a3b": {
     "context_window": 22016,
     "max_output": 16384
    },
    "green-r-raw": {
     "context_window": 131072,
     "max_output": 32768
    },
    "green-s-pro": {
     "max_output": 8192
    },
    "devstral-2-123b-instruct-2512": {
     "context_window": 200000,
     "max_output": 16384
    },
    "mistral-medium-3.5-128b": {
     "context_window": 262144,
     "max_output": 16384
    },
    "qwen3.5-397b-a17b": {
     "context_window": 262144,
     "max_output": 16384
    },
    "glm-5.2": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "voxtral-small-24b-2507": {
     "context_window": 32768,
     "max_output": 16384
    },
    "green-l-raw": {
     "context_window": 128000,
     "max_output": 32768
    },
    "glm-5.2-ponytail-ultra": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "green-r": {
     "context_window": 131072,
     "max_output": 32768
    },
    "glm-5.1": {
     "context_window": 200000,
     "max_output": 131072
    },
    "mistral-small-3.2-24b-instruct-2506": {
     "context_window": 128000,
     "max_output": 32768
    },
    "glm-5.2-caveman": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "kimi-k2.6-fast": {
     "context_window": 262144,
     "max_output": 262144
    },
    "gpt-oss-120b": {
     "context_window": 131072,
     "max_output": 32768
    },
    "glm-5.3": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "glm-5.2-caveman-ultra": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "kimi-k2.7-code": {
     "context_window": 262144,
     "max_output": 262144
    },
    "glm-5.2-ponytail": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "glm-5.2-honey-lite": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "glm-5.2-caveman-lite": {
     "context_window": 1000000,
     "max_output": 131072
    }
   }
  },
  "mixlayer": {
   "api": "https://models.mixlayer.ai/v1",
   "models": {
    "qwen/qwen3.5-27b": {
     "context_window": 262144,
     "max_output": 262144
    },
    "qwen/qwen3.5-122b-a10b": {
     "context_window": 262144,
     "max_output": 262144
    },
    "qwen/qwen3.5-9b": {
     "context_window": 262144,
     "max_output": 262144
    },
    "qwen/qwen3.5-35b-a3b": {
     "context_window": 262144,
     "max_output": 262144
    },
    "qwen/qwen3.5-397b-a17b": {
     "context_window": 262144,
     "max_output": 262144
    }
   }
  },
  "hyper": {
   "api": "https://hyper.charm.land/v1",
   "models": {
    "qwen3.7-max": {
     "context_window": 1000000,
     "max_output": 64000
    },
    "qwen3.8-27b": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "qwen3.8-2.4t-a95b": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "glm-5.3-flash": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "deepseek-v4-flash-0731": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "qwen3.8-max": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "kimi-k3": {
     "context_window": 1048576,
     "max_output": 16000
    },
    "deepseek-v4.1-flash": {
     "context_window": 1048576,
     "max_output": 262144
    },
    "qwen3.7-flash": {
     "context_window": 1000000,
     "max_output": 64000
    },
    "kimi-k2-thinking": {
     "context_window": 262144,
     "max_output": 26214
    },
    "gemma-4-26b-a4b-it": {
     "context_window": 256000,
     "max_output": 25600
    },
    "minimax-m2.7": {
     "context_window": 262100,
     "max_output": 6553
    },
    "deepseek-v4-pro-0813": {
     "context_window": 1000000,
     "max_output": 262144
    },
    "inkling": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "minimax-m3": {
     "context_window": 512000,
     "max_output": 512000
    },
    "qwen3.8-flash": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "glm-5.2": {
     "context_window": 1000000,
     "max_output": 32768
    },
    "deepseek-v4-pro": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "gpt-oss-120b": {
     "context_window": 131072,
     "max_output": 13107
    },
    "glm-5.3": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "kimi-k2.7-code": {
     "context_window": 256000,
     "max_output": 16000
    },
    "qwen3.7-plus": {
     "context_window": 1000000,
     "max_output": 64000
    },
    "deepseek-v4-flash": {
     "context_window": 1000000,
     "max_output": 384000
    }
   }
  },
  "jalapeno": {
   "api": "https://api.jalapeno-cloud.ai/v1",
   "models": {
    "Qwen3-VL-235B-A22B-Instruct": {
     "context_window": 129024,
     "max_output": 32768
    },
    "MiniMax-M3": {
     "context_window": 524288,
     "max_output": 512000
    },
    "Qwen3-Next-80B-A3B-Instruct": {
     "context_window": 129024,
     "max_output": 32768
    },
    "GLM-5.1": {
     "context_window": 202752,
     "max_output": 131072
    },
    "Hy3": {
     "context_window": 202752,
     "max_output": 128000
    },
    "GLM-5.2": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "Qwen3-VL-235B-A22B-Thinking": {
     "context_window": 131072,
     "max_output": 32768
    },
    "Qwen3.5-27B": {
     "context_window": 262144,
     "max_output": 65536
    },
    "Kimi-K3": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "Qwen3-Next-80B-A3B-Thinking": {
     "context_window": 131072,
     "max_output": 32768
    },
    "DeepSeek-V4-Flash": {
     "context_window": 1048576,
     "max_output": 384000
    },
    "DeepSeek-V4-Pro": {
     "context_window": 1048576,
     "max_output": 384000
    },
    "Qwen3.5-35B-A3B": {
     "context_window": 262144,
     "max_output": 65536
    },
    "Qwen3.5-122B-A10B": {
     "context_window": 262144,
     "max_output": 65536
    },
    "Qwen3.5-397B-A17B": {
     "context_window": 262144,
     "max_output": 65536
    },
    "Kimi-K2.7-Code": {
     "context_window": 271360,
     "max_output": 262144
    },
    "Kimi-K2.5": {
     "context_window": 262144,
     "max_output": 180224
    }
   }
  },
  "dinference": {
   "api": "https://api.dinference.com/v1",
   "models": {
    "glm-5": {
     "context_window": 200000,
     "max_output": 128000
    },
    "minimax-m2.5": {
     "context_window": 200000,
     "max_output": 32000
    },
    "glm-4.7": {
     "context_window": 200000,
     "max_output": 128000
    },
    "glm-5.2": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "glm-5.1": {
     "context_window": 200000,
     "max_output": 128000
    },
    "gpt-oss-120b": {
     "context_window": 131072,
     "max_output": 32768
    }
   }
  },
  "neosmith": {
   "api": "https://router.neosmith.ai/v1",
   "models": {
    "neosmith.neolite": {
     "context_window": 512000,
     "max_output": 64000
    },
    "neosmith.intelligent-maestro": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "neosmith.intelligent-pro": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "neosmith.intelligent-basic": {
     "context_window": 1000000,
     "max_output": 128000
    }
   }
  },
  "fireworks-ai": {
   "api": "https://api.fireworks.ai/inference/v1/",
   "models": {
    "accounts/fireworks/models/nemotron-3-ultra-nvfp4": {
     "context_window": 262144,
     "max_output": 128000
    },
    "accounts/fireworks/models/kimi-k3": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "accounts/fireworks/models/qwen3p8-2p4t-a95b": {
     "context_window": 262144,
     "max_output": 131072
    },
    "accounts/fireworks/models/ember-1": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "accounts/fireworks/models/deepseek-v4p1-flash": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "accounts/fireworks/models/glm-5p3": {
     "context_window": 1048573,
     "max_output": 262144
    },
    "accounts/fireworks/models/nemotron-lightning-3p5-30b-a3b": {
     "context_window": 262144,
     "max_output": 262144
    },
    "accounts/fireworks/models/inkling": {
     "context_window": 1048576,
     "max_output": 1048576
    },
    "accounts/fireworks/models/minimax-m3": {
     "context_window": 512000,
     "max_output": 512000
    },
    "accounts/fireworks/models/glm-5p3-flash": {
     "context_window": 1048573,
     "max_output": 131072
    },
    "accounts/fireworks/models/gpt-oss-120b": {
     "context_window": 131072,
     "max_output": 32768
    },
    "accounts/fireworks/models/qwen3p8-max": {
     "context_window": 262144,
     "max_output": 131072
    },
    "accounts/fireworks/routers/minimax-latest": {
     "context_window": 512000,
     "max_output": 512000
    },
    "accounts/fireworks/routers/glm-flash-latest": {
     "context_window": 1048573,
     "max_output": 131072
    },
    "accounts/fireworks/routers/glm-fast-latest": {
     "context_window": 1048572,
     "max_output": 262144
    },
    "accounts/fireworks/routers/kimi-k3-fast": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "accounts/fireworks/routers/glm-5p3-fast": {
     "context_window": 1048572,
     "max_output": 262144
    },
    "accounts/fireworks/routers/kimi-fast-latest": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "accounts/fireworks/routers/qwen-max-latest": {
     "context_window": 262144,
     "max_output": 131072
    },
    "accounts/fireworks/routers/kimi-latest": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "accounts/fireworks/routers/deepseek-flash-latest": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "accounts/fireworks/routers/glm-latest": {
     "context_window": 1048573,
     "max_output": 262144
    }
   }
  },
  "stepfun-ai": {
   "api": "https://api.stepfun.ai/v1",
   "models": {
    "step-5-preview": {
     "context_window": 1024000,
     "max_output": 65536
    },
    "step-3.7-flash": {
     "context_window": 256000,
     "max_output": 256000
    },
    "step-3.5-flash": {
     "context_window": 256000,
     "max_output": 256000
    },
    "step-2-16k": {
     "context_window": 16384,
     "max_output": 8192
    },
    "step-3.5-flash-2603": {
     "context_window": 256000,
     "max_output": 256000
    },
    "step-1-32k": {
     "context_window": 32768,
     "max_output": 32768
    }
   }
  },
  "fastrouter": {
   "api": "https://go.fastrouter.ai/api/v1",
   "models": {
    "anthropic/claude-opus-4.1": {
     "context_window": 200000,
     "max_output": 32000
    },
    "anthropic/claude-opus-4.8": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-sonnet-4": {
     "context_window": 200000,
     "max_output": 64000
    },
    "anthropic/claude-sonnet-4.6": {
     "context_window": 1000000,
     "max_output": 64000
    },
    "deepseek/deepseek-v4-pro": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "z-ai/glm-5": {
     "context_window": 204800,
     "max_output": 131072
    },
    "z-ai/glm-5.1": {
     "context_window": 200000,
     "max_output": 131072
    },
    "sarvam/sarvam-30b": {
     "context_window": 128000,
     "max_output": 128000
    },
    "sarvam/sarvam-105b": {
     "context_window": 131072,
     "max_output": 131072
    },
    "x-ai/grok-4": {
     "context_window": 256000,
     "max_output": 64000
    },
    "x-ai/grok-4.3": {
     "context_window": 1000000,
     "max_output": 30000
    },
    "x-ai/grok-build-0.1": {
     "context_window": 256000,
     "max_output": 256000
    },
    "bytedance/seedance-2": {
     "context_window": 4096
    },
    "google/gemma-4-31b-it": {
     "context_window": 262144,
     "max_output": 32768
    },
    "google/gemini-3.1-flash-image-preview": {
     "context_window": 65536,
     "max_output": 65536
    },
    "google/veo3.1": {
     "context_window": 400000
    },
    "google/veo3.1-lite": {
     "context_window": 400000
    },
    "google/gemini-3-pro-image-preview": {
     "context_window": 65536,
     "max_output": 32768
    },
    "google/gemini-3.1-pro-preview": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemini-3.5-flash": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemini-2.5-pro": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/veo3.1-fast": {
     "context_window": 400000
    },
    "google/gemini-2.5-flash": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "deepseek-ai/deepseek-r1-distill-llama-70b": {
     "context_window": 131072,
     "max_output": 131072
    },
    "moonshotai/kimi-k2.6": {
     "context_window": 262144,
     "max_output": 262144
    },
    "moonshotai/kimi-k2": {
     "context_window": 131072,
     "max_output": 32768
    },
    "minimax/minimax-m2.7": {
     "context_window": 204800,
     "max_output": 131072
    },
    "minimax/minimax-m2.7-highspeed": {
     "context_window": 204800,
     "max_output": 131072
    },
    "wanx/wan-v2-6": {
     "context_window": 400000
    },
    "qwen/qwen3-coder": {
     "context_window": 262144,
     "max_output": 66536
    },
    "leonardo-ai/lucid-realism": {
     "context_window": 4096
    },
    "leonardo-ai/lucid-origin": {
     "context_window": 4096
    },
    "openai/gpt-5.5-pro": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-5.4-nano": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-realtime-1.5": {
     "context_window": 32000,
     "max_output": 4096
    },
    "openai/gpt-5-mini": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-image-2": {
     "context_window": 128000
    },
    "openai/gpt-5.3-codex": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-5-nano": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-oss-20b": {
     "context_window": 131072,
     "max_output": 65536
    },
    "openai/gpt-5.4-mini": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-5.5": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-4.1": {
     "context_window": 1047576,
     "max_output": 32768
    },
    "openai/gpt-oss-120b": {
     "context_window": 131072,
     "max_output": 32768
    },
    "openai/gpt-5": {
     "context_window": 400000,
     "max_output": 128000
    }
   }
  },
  "orcarouter": {
   "api": "https://api.orcarouter.ai/v1",
   "models": {
    "grok/grok-4.3": {
     "context_window": 1000000,
     "max_output": 30000
    },
    "grok/grok-4.5": {
     "context_window": 500000,
     "max_output": 500000
    },
    "grok/grok-4.6": {
     "context_window": 500000,
     "max_output": 500000
    },
    "anthropic/claude-opus-4.5": {
     "context_window": 200000,
     "max_output": 64000
    },
    "anthropic/claude-opus-4.6": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-opus-4.7": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-opus-4.8": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-haiku-4.5": {
     "context_window": 200000,
     "max_output": 64000
    },
    "anthropic/claude-opus-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-sonnet-4.5": {
     "context_window": 1000000,
     "max_output": 64000
    },
    "anthropic/claude-fable-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-sonnet-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-sonnet-4.6": {
     "context_window": 1000000,
     "max_output": 64000
    },
    "deepseek/deepseek-v4-flash-0731": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "deepseek/deepseek-v4-flash-vision-exp": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "deepseek/deepseek-chat": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "deepseek/deepseek-v4-pro-0813": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "deepseek/deepseek-v4-flash-free": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "deepseek/deepseek-reasoner": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "deepseek/deepseek-v4-pro": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "deepseek/deepseek-v4-flash": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "tencent/hy3-free": {
     "context_window": 256000,
     "max_output": 128000
    },
    "tencent/hy3": {
     "context_window": 256000,
     "max_output": 128000
    },
    "z-ai/glm-4.5": {
     "context_window": 131072,
     "max_output": 98304
    },
    "z-ai/glm-5.3-flash": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "z-ai/glm-4.6": {
     "context_window": 204800,
     "max_output": 131072
    },
    "z-ai/glm-5": {
     "context_window": 204800,
     "max_output": 131072
    },
    "z-ai/glm-4.7": {
     "context_window": 204800,
     "max_output": 131072
    },
    "z-ai/glm-5.3-flash-free": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "z-ai/glm-5.2": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "z-ai/glm-5.1": {
     "context_window": 200000,
     "max_output": 131072
    },
    "z-ai/glm-4.5-air": {
     "context_window": 131072,
     "max_output": 98304
    },
    "z-ai/glm-5.3": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "meta/muse-spark-1.1": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "meta/muse-spark-1.2": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "google/gemini-flash-latest": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemma-4-31b-it": {
     "context_window": 262144,
     "max_output": 32768
    },
    "google/gemini-flash-lite-latest": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemini-3.6-flash": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemini-robotics-er-1.6-preview": {
     "context_window": 131072,
     "max_output": 65536
    },
    "google/gemma-4-26b-a4b-it": {
     "context_window": 262144,
     "max_output": 32768
    },
    "google/gemini-3.5-flash-lite": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemini-3.1-pro-preview": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemini-3.5-flash": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemini-2.5-pro": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemini-2.5-flash": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemini-3.1-pro-preview-customtools": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemini-3-flash-preview": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemini-2.5-flash-lite": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemini-3.1-flash-lite-preview": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemini-3.1-flash-lite": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "kimi/kimi-k3": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "kimi/kimi-k2.6": {
     "context_window": 262144,
     "max_output": 32768
    },
    "kimi/kimi-k2.5": {
     "context_window": 262144,
     "max_output": 32768
    },
    "kimi/kimi-k2.7-code": {
     "context_window": 262144,
     "max_output": 262144
    },
    "orcarouter/fusion-mini": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "orcarouter/free": {
     "context_window": 65536,
     "max_output": 32768
    },
    "orcarouter/fusion": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "orcarouter/fusion-flash": {
     "context_window": 200000,
     "max_output": 128000
    },
    "orcarouter/auto": {
     "context_window": 128000,
     "max_output": 16384
    },
    "minimax/minimax-m2.5": {
     "context_window": 204800,
     "max_output": 131072
    },
    "minimax/minimax-m2.7": {
     "context_window": 204800,
     "max_output": 131072
    },
    "minimax/minimax-m3": {
     "context_window": 1048576,
     "max_output": 512000
    },
    "minimax/minimax-m2.7-highspeed": {
     "context_window": 204800,
     "max_output": 131072
    },
    "minimax/minimax-m2.5-highspeed": {
     "context_window": 204800,
     "max_output": 131072
    },
    "qwen/qwen3.5-flash": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "qwen/qwen3-vl-235b-a22b-instruct": {
     "context_window": 131072,
     "max_output": 32768
    },
    "qwen/qwen3.7-max": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "qwen/qwen3.8-27b": {
     "context_window": 262144,
     "max_output": 32768
    },
    "qwen/qwen3-vl-235b-a22b-thinking": {
     "context_window": 131072,
     "max_output": 40960
    },
    "qwen/qwen3.5-27b": {
     "context_window": 262144,
     "max_output": 65536
    },
    "qwen/qwen3.8-max": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "qwen/qwen3.5-plus": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "qwen/qwen3.7-flash": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "qwen/qwen3-max": {
     "context_window": 262144,
     "max_output": 65536
    },
    "qwen/qwen3.5-122b-a10b": {
     "context_window": 262144,
     "max_output": 65536
    },
    "qwen/qwen3.6-35b-a3b": {
     "context_window": 262144,
     "max_output": 65536
    },
    "qwen/qwen3.6-flash": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "qwen/qwen3.5-35b-a3b": {
     "context_window": 262144,
     "max_output": 65536
    },
    "qwen/qwen3.5-397b-a17b": {
     "context_window": 262144,
     "max_output": 65536
    },
    "qwen/qwen3.6-plus": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "qwen/qwen3.7-plus": {
     "context_window": 1000000,
     "max_output": 64000
    },
    "openai/gpt-5.4": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-5.4-pro": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-3.5-turbo": {
     "context_window": 16385,
     "max_output": 4096
    },
    "openai/gpt-5.5-pro": {
     "context_window": 1050000,
     "max_output": 100000
    },
    "openai/gpt-5.4-nano": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-4o-2024-05-13": {
     "context_window": 128000,
     "max_output": 4096
    },
    "openai/gpt-5.2-codex": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-5.1-codex": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-4o": {
     "context_window": 128000,
     "max_output": 16384
    },
    "openai/gpt-5-mini": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-5.2-pro": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-4": {
     "context_window": 8192,
     "max_output": 8192
    },
    "openai/gpt-5.3-codex": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-4.1-nano": {
     "context_window": 1047576,
     "max_output": 32768
    },
    "openai/gpt-5-nano": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-5.2-chat-latest": {
     "context_window": 128000,
     "max_output": 16384
    },
    "openai/gpt-5.1-chat-latest": {
     "context_window": 128000,
     "max_output": 16384
    },
    "openai/gpt-5-pro": {
     "context_window": 400000,
     "max_output": 272000
    },
    "openai/gpt-5-chat-latest": {
     "context_window": 400000,
     "max_output": 100000
    },
    "openai/gpt-4o-2024-08-06": {
     "context_window": 128000,
     "max_output": 16384
    },
    "openai/gpt-5.1": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-4o-mini": {
     "context_window": 128000,
     "max_output": 16384
    },
    "openai/gpt-5.4-mini": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-5.6-luna": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-5.2": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-5.5": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-4.1": {
     "context_window": 1047576,
     "max_output": 32768
    },
    "openai/gpt-4o-2024-11-20": {
     "context_window": 128000,
     "max_output": 16384
    },
    "openai/gpt-4.1-mini": {
     "context_window": 1047576,
     "max_output": 32768
    },
    "openai/gpt-5.6-terra": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-4-turbo": {
     "context_window": 128000,
     "max_output": 4096
    },
    "openai/gpt-oss-120b": {
     "context_window": 131072,
     "max_output": 32768
    },
    "openai/gpt-5.1-codex-mini": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-5": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-5.6-sol": {
     "context_window": 1050000,
     "max_output": 128000
    }
   }
  },
  "friendli": {
   "api": "https://api.friendli.ai/serverless/v1",
   "models": {
    "google/gemma-4-31B-it": {
     "context_window": 262144,
     "max_output": 32768
    },
    "deepseek-ai/DeepSeek-V3.2": {
     "context_window": 163840,
     "max_output": 64000
    },
    "MiniMaxAI/MiniMax-M2.5": {
     "context_window": 196608,
     "max_output": 131072
    },
    "zai-org/GLM-5.1": {
     "context_window": 202752,
     "max_output": 131072
    },
    "zai-org/GLM-5.2": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "zai-org/GLM-5.3-Flash": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "zai-org/GLM-5.3": {
     "context_window": 1048576,
     "max_output": 131072
    }
   }
  },
  "kimi-code-plan-cn": {
   "api": "https://api.kimi.com/coding/v1",
   "models": {
    "kimi-for-coding-highspeed": {
     "context_window": 262144,
     "max_output": 32768
    },
    "kimi-for-coding": {
     "context_window": 1048576,
     "max_output": 32768
    },
    "k3-256k": {
     "context_window": 262144,
     "max_output": 131072
    },
    "k3": {
     "context_window": 1048576,
     "max_output": 131072
    }
   }
  },
  "inco": {
   "api": "https://api.inco.ai/v1",
   "models": {
    "kimi-k3:fast": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "glm-5.3:fast": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "glm-5.3-flash:fast": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "minimax-m3": {
     "context_window": 1048576,
     "max_output": 512000
    },
    "deepseek-v4.1-flash:fast": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "minimax-m3:fast": {
     "context_window": 1048576,
     "max_output": 512000
    },
    "glm-5.3": {
     "context_window": 1000000,
     "max_output": 131072
    }
   }
  },
  "sakana": {
   "api": "https://api.sakana.ai/v1",
   "models": {
    "fugu-ultra": {
     "context_window": 1000000,
     "max_output": 1000000
    },
    "fugu-ultra-20260615": {
     "context_window": 1000000,
     "max_output": 1000000
    },
    "sakana-namazu": {
     "context_window": 262144,
     "max_output": 65536
    },
    "fugu": {
     "context_window": 1000000,
     "max_output": 1000000
    }
   }
  },
  "scx-ai": {
   "api": "https://api.scx.ai/v1",
   "models": {
    "GLM-5.2": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "Qwen3.8-Max": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "MiniMax-M2.7": {
     "context_window": 196608,
     "max_output": 196608
    },
    "gpt-oss-120b": {
     "context_window": 131072,
     "max_output": 131072
    }
   }
  },
  "zenifra": {
   "api": "https://ai.zenifra.com/v1",
   "models": {
    "alibaba/qwen3.6-35b-a3b": {
     "context_window": 262144,
     "max_output": 65536
    }
   }
  },
  "tokenrouter": {
   "api": "https://api.tokenrouter.com/v1",
   "models": {
    "z-ai/glm-5.3-free": {
     "context_window": 1000000,
     "max_output": 131072
    }
   }
  },
  "google-vertex-anthropic": {
   "api": null,
   "models": {
    "claude-opus-4-8@default": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "claude-sonnet-4-5@20250929": {
     "context_window": 200000,
     "max_output": 64000
    },
    "claude-opus-4-6@default": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "claude-opus-4@20250514": {
     "context_window": 200000,
     "max_output": 32000
    },
    "claude-sonnet-5-5@default": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "claude-opus-5-5@default": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "claude-opus-5@default": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "claude-sonnet-4-6@default": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "claude-haiku-4-5@20251001": {
     "context_window": 200000,
     "max_output": 64000
    },
    "claude-opus-4-1@20250805": {
     "context_window": 200000,
     "max_output": 32000
    },
    "claude-opus-4-5@20251101": {
     "context_window": 200000,
     "max_output": 64000
    },
    "claude-opus-4-7@default": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "claude-fable-5-1@default": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "claude-fable-5@default": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "claude-sonnet-4@20250514": {
     "context_window": 200000,
     "max_output": 64000
    },
    "claude-sonnet-5@default": {
     "context_window": 1000000,
     "max_output": 128000
    }
   }
  },
  "moonshotai": {
   "api": "https://api.moonshot.ai/v1",
   "models": {
    "kimi-k3": {
     "context_window": 1048576,
     "max_output": 1048576
    },
    "kimi-k2.7-code-highspeed": {
     "context_window": 262144,
     "max_output": 262144
    },
    "kimi-k2.6": {
     "context_window": 262144,
     "max_output": 262144
    },
    "kimi-k2.7-code": {
     "context_window": 262144,
     "max_output": 262144
    }
   }
  },
  "ainetcafe": {
   "api": "https://microquickjs.com/v1",
   "models": {
    "Kimi-K3": {
     "context_window": 262144,
     "max_output": 32768
    }
   }
  },
  "wallaby": {
   "api": "https://api.wallabytoken.com/v1",
   "models": {
    "moonshotai/kimi-k3": {
     "context_window": 1048576,
     "max_output": 131072
    }
   }
  },
  "bee": {
   "api": "https://api.bee.heossi.com/bee",
   "models": {
    "bee-buzz": {
     "context_window": 262144,
     "max_output": 24576
    },
    "bee-swarm": {
     "context_window": 1000000,
     "max_output": 64000
    },
    "bee-comb": {
     "context_window": 262144,
     "max_output": 16384
    },
    "bee-hive": {
     "context_window": 262144,
     "max_output": 32768
    },
    "bee-brood": {
     "context_window": 262144,
     "max_output": 16384
    },
    "bee-cell": {
     "context_window": 131072,
     "max_output": 8192
    }
   }
  },
  "scnet-token-plan": {
   "api": "https://api.scnet.cn/api/llm/v1",
   "models": {
    "DeepSeek-V4-Flash-0731": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "Kimi-K2.6": {
     "context_window": 262144,
     "max_output": 262144
    },
    "MiniMax-M3": {
     "context_window": 1048576,
     "max_output": 512000
    },
    "GLM-5.1": {
     "context_window": 200000,
     "max_output": 131072
    },
    "GLM-5.2": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "Qwen3.8-Max": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "Kimi-K3": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "DeepSeek-V4-Pro-0813": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "DeepSeek-V4.1-Flash": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "DeepSeek-V4-Flash": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "GLM-5": {
     "context_window": 204800,
     "max_output": 131072
    },
    "GLM-5.3-Flash": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "DeepSeek-V4-Pro": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "Qwen3.8-Flash": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "MiniMax-M2.5": {
     "context_window": 204800,
     "max_output": 131072
    },
    "MiniMax-M2.7": {
     "context_window": 204800,
     "max_output": 131072
    },
    "GLM-5.3": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "Kimi-K2.7-Code": {
     "context_window": 262144,
     "max_output": 262144
    },
    "Kimi-K2.5": {
     "context_window": 262144,
     "max_output": 262144
    }
   }
  },
  "ofox": {
   "api": "https://api.ofox.ai/v1",
   "models": {
    "bailian/qwen-flash": {
     "context_window": 1000000,
     "max_output": 32768
    },
    "bailian/qwen3.5-flash": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "bailian/qwen3.7-max": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "bailian/qwen3.8-27b": {
     "context_window": 1131072,
     "max_output": 131072
    },
    "bailian/qwen3.5-27b": {
     "context_window": 262144,
     "max_output": 65536
    },
    "bailian/qwen-max": {
     "context_window": 32768,
     "max_output": 8192
    },
    "bailian/qwen3.8-max": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "bailian/qwen3-coder-next": {
     "context_window": 262144,
     "max_output": 65536
    },
    "bailian/qwen3.5-plus": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "bailian/qwen-plus": {
     "context_window": 1000000,
     "max_output": 32768
    },
    "bailian/qwen3-max": {
     "context_window": 262144,
     "max_output": 65536
    },
    "bailian/qwen-turbo": {
     "context_window": 128000,
     "max_output": 16384
    },
    "bailian/qwen-vl-max": {
     "context_window": 131072,
     "max_output": 8192
    },
    "bailian/qwen3.5-122b-a10b": {
     "context_window": 256000,
     "max_output": 64000
    },
    "bailian/qwen3.6-flash": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "bailian/qwen3-coder-flash": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "bailian/qwen3-coder-plus": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "bailian/qwen3.8-flash": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "bailian/qwen3.5-35b-a3b": {
     "context_window": 262144,
     "max_output": 65536
    },
    "bailian/qwen3.6-max-preview": {
     "context_window": 262144,
     "max_output": 65536
    },
    "bailian/qwen3.5-397b-a17b": {
     "context_window": 256000,
     "max_output": 64000
    },
    "bailian/qwen3.6-27b": {
     "context_window": 256000,
     "max_output": 64000
    },
    "bailian/qwen3.6-plus": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "bailian/qwen3.7-plus": {
     "context_window": 1000000,
     "max_output": 64000
    },
    "bailian/qwen3.8-max-0902": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "anthropic/claude-opus-4.5": {
     "context_window": 200000,
     "max_output": 64000
    },
    "anthropic/claude-opus-4.6": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-opus-4.7": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-opus-4.8": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-haiku-4.5": {
     "context_window": 200000,
     "max_output": 64000
    },
    "anthropic/claude-opus-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-sonnet-5.5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-fable-5.1": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-sonnet-4.5": {
     "context_window": 200000,
     "max_output": 64000
    },
    "anthropic/claude-fable-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-sonnet-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-sonnet-4.6": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-opus-5.5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "deepseek/deepseek-v4-flash-0731": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "deepseek/deepseek-v4-flash-0423": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "deepseek/deepseek-v4.1-flash": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "deepseek/deepseek-v4-flash-vision-exp": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "deepseek/deepseek-v4-pro-0813": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "deepseek/deepseek-v4-pro-0423": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "deepseek/deepseek-v4-pro": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "deepseek/deepseek-v3.2": {
     "context_window": 128000,
     "max_output": 32000
    },
    "deepseek/deepseek-v4-flash": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "z-ai/glm-5v-turbo": {
     "context_window": 200000,
     "max_output": 131072
    },
    "z-ai/glm-5.3-flash": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "z-ai/glm-4.6": {
     "context_window": 204800,
     "max_output": 131072
    },
    "z-ai/glm-5": {
     "context_window": 204800,
     "max_output": 131072
    },
    "z-ai/glm-5.3-flashx": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "z-ai/glm-4.7": {
     "context_window": 204800,
     "max_output": 131072
    },
    "z-ai/glm-5.2": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "z-ai/glm-5.1": {
     "context_window": 200000,
     "max_output": 131072
    },
    "z-ai/glm-4.7-flashx": {
     "context_window": 200000,
     "max_output": 128000
    },
    "z-ai/glm-5-turbo": {
     "context_window": 200000,
     "max_output": 131072
    },
    "z-ai/glm-5.3": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "x-ai/grok-4.7": {
     "context_window": 500000,
     "max_output": 65536
    },
    "x-ai/grok-4.3": {
     "context_window": 1000000,
     "max_output": 30000
    },
    "x-ai/grok-4.5": {
     "context_window": 500000,
     "max_output": 65536
    },
    "x-ai/grok-4.20": {
     "context_window": 2000000,
     "max_output": 128000
    },
    "x-ai/grok-4.1-fast": {
     "context_window": 2000000,
     "max_output": 30000
    },
    "x-ai/grok-4.6": {
     "context_window": 500000,
     "max_output": 65536
    },
    "volcengine/doubao-seed-2.0-mini": {
     "context_window": 256000,
     "max_output": 32000
    },
    "volcengine/doubao-seed-1-6-flash": {
     "context_window": 256000,
     "max_output": 32000
    },
    "volcengine/doubao-seed-2.0-lite": {
     "context_window": 256000,
     "max_output": 32000
    },
    "volcengine/doubao-seed-1-8": {
     "context_window": 256000,
     "max_output": 64000
    },
    "volcengine/doubao-seed-1-6": {
     "context_window": 256000,
     "max_output": 64000
    },
    "volcengine/doubao-seed-2.0-pro": {
     "context_window": 256000,
     "max_output": 128000
    },
    "volcengine/doubao-seed-1-6-vision": {
     "context_window": 256000,
     "max_output": 32000
    },
    "volcengine/doubao-seed-2.1-turbo": {
     "context_window": 256000,
     "max_output": 256000
    },
    "volcengine/doubao-seed-2.1-pro": {
     "context_window": 256000,
     "max_output": 256000
    },
    "volcengine/doubao-seed-character": {
     "context_window": 256000,
     "max_output": 256000
    },
    "volcengine/doubao-seed-evolving": {
     "context_window": 256000,
     "max_output": 256000
    },
    "volcengine/doubao-seed-2.0-code": {
     "context_window": 256000,
     "max_output": 128000
    },
    "google/gemini-3.6-flash": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemini-3.5-flash-lite": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemini-3.1-pro-preview": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemini-3.5-flash": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemini-2.5-pro": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemini-2.5-flash": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemini-3.7-flash": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemini-3-flash-preview": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemini-3.8-flash": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "google/gemini-2.5-flash-lite": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemini-3.1-flash-lite": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "moonshotai/kimi-k3": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "moonshotai/kimi-k2.7-code-highspeed": {
     "context_window": 262144,
     "max_output": 262144
    },
    "moonshotai/kimi-k2.6": {
     "context_window": 262144,
     "max_output": 262144
    },
    "moonshotai/kimi-k2.5": {
     "context_window": 262144,
     "max_output": 262144
    },
    "moonshotai/kimi-k2.7-code": {
     "context_window": 262144,
     "max_output": 262144
    },
    "minimax/minimax-m2.5-lightning": {
     "context_window": 204800,
     "max_output": 131072
    },
    "minimax/minimax-m2.5": {
     "context_window": 204800,
     "max_output": 131072
    },
    "minimax/minimax-m2.1-lightning": {
     "context_window": 204800,
     "max_output": 131072
    },
    "minimax/minimax-m2.7": {
     "context_window": 204800,
     "max_output": 131072
    },
    "minimax/minimax-m3": {
     "context_window": 1048576,
     "max_output": 512000
    },
    "minimax/minimax-m2.7-highspeed": {
     "context_window": 204800,
     "max_output": 131072
    },
    "minimax/m2-her": {
     "context_window": 65536,
     "max_output": 2048
    },
    "minimax/minimax-m2.1": {
     "context_window": 204800,
     "max_output": 131072
    },
    "minimax/minimax-m2": {
     "context_window": 204800,
     "max_output": 131072
    },
    "qwen/qwen-flash": {
     "context_window": 1000000,
     "max_output": 32000
    },
    "qwen/qwen3.5-flash": {
     "context_window": 1000000,
     "max_output": 64000
    },
    "qwen/qwen3.7-max": {
     "context_window": 1064000,
     "max_output": 64000
    },
    "qwen/qwen3.8-27b": {
     "context_window": 1131072,
     "max_output": 131072
    },
    "qwen/qwen3.5-27b": {
     "context_window": 256000,
     "max_output": 64000
    },
    "qwen/qwen-max": {
     "context_window": 32000,
     "max_output": 8000
    },
    "qwen/qwen3.8-max": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "qwen/qwen3-coder-next": {
     "context_window": 256000,
     "max_output": 64000
    },
    "qwen/qwen3.5-plus": {
     "context_window": 1000000,
     "max_output": 64000
    },
    "qwen/qwen-plus": {
     "context_window": 1000000,
     "max_output": 32000
    },
    "qwen/qwen3-max": {
     "context_window": 256000,
     "max_output": 64000
    },
    "qwen/qwen-turbo": {
     "context_window": 128000,
     "max_output": 16000
    },
    "qwen/qwen-vl-max": {
     "context_window": 128000,
     "max_output": 8000
    },
    "qwen/qwen3.5-122b-a10b": {
     "context_window": 256000,
     "max_output": 64000
    },
    "qwen/qwen3.6-flash": {
     "context_window": 1000000,
     "max_output": 64000
    },
    "qwen/qwen3-coder-flash": {
     "context_window": 1000000,
     "max_output": 64000
    },
    "qwen/qwen3-coder-plus": {
     "context_window": 1000000,
     "max_output": 64000
    },
    "qwen/qwen3.8-flash": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "qwen/qwen3.5-35b-a3b": {
     "context_window": 256000,
     "max_output": 64000
    },
    "qwen/qwen3.6-max-preview": {
     "context_window": 256000,
     "max_output": 64000
    },
    "qwen/qwen3.5-397b-a17b": {
     "context_window": 256000,
     "max_output": 64000
    },
    "qwen/qwen3.6-27b": {
     "context_window": 256000,
     "max_output": 64000
    },
    "qwen/qwen3.6-plus": {
     "context_window": 1000000,
     "max_output": 64000
    },
    "qwen/qwen3.7-plus": {
     "context_window": 1064000,
     "max_output": 64000
    },
    "qwen/qwen3.8-max-0902": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "openai/gpt-5.4": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-5.4-pro": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-5.4-nano": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-5.2-codex": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-4o": {
     "context_window": 128000,
     "max_output": 16384
    },
    "openai/gpt-5-mini": {
     "context_window": 256000,
     "max_output": 32768
    },
    "openai/gpt-5.3-codex": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-5-nano": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-6.1-sol": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-6-astra": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-5.1": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-4o-mini": {
     "context_window": 128000,
     "max_output": 16384
    },
    "openai/gpt-5.4-mini": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-5.6-luna": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-5.1-codex-max": {
     "context_window": 256000,
     "max_output": 128000
    },
    "openai/gpt-5.2": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-5.5": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-4.1": {
     "context_window": 1047576,
     "max_output": 32768
    },
    "openai/gpt-4.1-mini": {
     "context_window": 1047576,
     "max_output": 32768
    },
    "openai/gpt-6-luna": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-5.6-terra": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-5.1-codex-mini": {
     "context_window": 256000,
     "max_output": 65536
    },
    "openai/gpt-5": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-5.6-sol": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-6-sol": {
     "context_window": 1050000,
     "max_output": 128000
    }
   }
  },
  "neon": {
   "api": "${NEON_AI_GATEWAY_BASE_URL}/v1",
   "models": {
    "gpt-5-4-mini": {
     "context_window": 400000,
     "max_output": 128000
    },
    "claude-haiku-4-5": {
     "context_window": 200000,
     "max_output": 64000
    },
    "gpt-5-6-luna": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "glm-5-3-flash": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "gpt-5-6-terra": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "kimi-k3": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "llama-4-maverick": {
     "context_window": 1000000,
     "max_output": 8192
    },
    "gpt-5-mini": {
     "context_window": 400000,
     "max_output": 128000
    },
    "claude-opus-4-5": {
     "context_window": 200000,
     "max_output": 64000
    },
    "gpt-5-nano": {
     "context_window": 400000,
     "max_output": 128000
    },
    "claude-sonnet-4-5": {
     "context_window": 200000,
     "max_output": 64000
    },
    "claude-opus-5-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "claude-fable-5-1": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "gpt-5-4-nano": {
     "context_window": 400000,
     "max_output": 128000
    },
    "gpt-5-6-sol": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "claude-opus-4-1": {
     "context_window": 200000,
     "max_output": 32000
    },
    "gpt-5-5-pro": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "gemini-3-1-pro": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "glm-5-2": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "gpt-6-astra": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "claude-opus-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "qwen3-next-80b-a3b-instruct": {
     "context_window": 131072,
     "max_output": 10000
    },
    "gemini-3-flash": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "gpt-oss-20b": {
     "context_window": 131072,
     "max_output": 25000
    },
    "gpt-5-4": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "claude-fable-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "inkling": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "claude-opus-4-8": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "claude-sonnet-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "claude-opus-4-6": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "gemini-3-1-flash-lite": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "gpt-5-5": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "grok-4-6": {
     "context_window": 500000,
     "max_output": 524288
    },
    "qwen35-122b-a10b": {
     "context_window": 262144,
     "max_output": 25000
    },
    "gemini-3-6-flash": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "meta-llama-3-3-70b-instruct": {
     "context_window": 128000,
     "max_output": 8192
    },
    "gpt-5-2": {
     "context_window": 400000,
     "max_output": 128000
    },
    "claude-sonnet-4-6": {
     "context_window": 1000000,
     "max_output": 64000
    },
    "gpt-5-3-codex": {
     "context_window": 400000,
     "max_output": 128000
    },
    "gemma-3-12b": {
     "context_window": 131072,
     "max_output": 8192
    },
    "gemini-3-5-flash-lite": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "gemini-3-5-flash": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "gpt-5-1": {
     "context_window": 400000,
     "max_output": 128000
    },
    "gpt-oss-120b": {
     "context_window": 131072,
     "max_output": 25000
    },
    "claude-opus-4-7": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "gpt-5": {
     "context_window": 400000,
     "max_output": 128000
    },
    "meta-llama-3-1-8b-instruct": {
     "context_window": 131072,
     "max_output": 8192
    }
   }
  },
  "aihubmix": {
   "api": null,
   "models": {
    "glm-4.6v": {
     "context_window": 128000,
     "max_output": 32768
    },
    "qwen3.5-flash": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "gpt-5.4": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "claude-haiku-4-5": {
     "context_window": 200000,
     "max_output": 64000
    },
    "mimo-v2.6-pro": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "coding-minimax-m2.7-free": {
     "context_window": 204800,
     "max_output": 128100
    },
    "qwen3.7-max": {
     "context_window": 991000,
     "max_output": 64000
    },
    "muse-spark-1.3": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "deep-deepseek-v4-pro": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "mimo-v2.5": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "gpt-5.5-pro": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "grok-4.7": {
     "context_window": 500000,
     "max_output": 500000
    },
    "gpt-5.4-nano": {
     "context_window": 400000,
     "max_output": 128000
    },
    "qwen3.8-2.4t-a95b": {
     "context_window": 262000,
     "max_output": 262000
    },
    "gpt-5.2-codex": {
     "context_window": 400000,
     "max_output": 128000
    },
    "gpt-5.1-codex": {
     "context_window": 400000,
     "max_output": 128000
    },
    "glm-5v-turbo": {
     "context_window": 200000,
     "max_output": 128000
    },
    "gemini-2.5-flash-image": {
     "context_window": 32768,
     "max_output": 32768
    },
    "qwen3-vl-plus": {
     "context_window": 262144,
     "max_output": 32768
    },
    "glm-5.3-flash": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "qwen3.5-27b": {
     "context_window": 262144,
     "max_output": 65536
    },
    "glm-4.6": {
     "context_window": 204800,
     "max_output": 131072
    },
    "deepseek-v4-flash-0731": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "qwen3.8-max": {
     "context_window": 991000,
     "max_output": 128000
    },
    "kimi-k3": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "doubao-seed-2-0-lite-260428": {
     "context_window": 256000,
     "max_output": 128000
    },
    "claude-sonnet-4-6-think": {
     "context_window": 1000000,
     "max_output": 64000
    },
    "qwen3.5-plus": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "o4-mini": {
     "context_window": 200000,
     "max_output": 100000
    },
    "deepseek-v4-flash-0731-fast": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "claude-opus-4-5": {
     "context_window": 200000,
     "max_output": 64000
    },
    "hy3-preview": {
     "context_window": 256000,
     "max_output": 128000
    },
    "alicloud-deepseek-v4-pro": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "zai-glm-5.1": {
     "context_window": 200000,
     "max_output": 128000
    },
    "deepseek-v4.1-flash": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "gpt-5.3-codex": {
     "context_window": 400000,
     "max_output": 128000
    },
    "qwen3.8-max-preview": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "coding-minimax-m2.7-highspeed": {
     "context_window": 204800,
     "max_output": 128100
    },
    "muse-spark-1.1": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "deepseek-v4-flash-vision-exp": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "kimi-k2.7-code-highspeed": {
     "context_window": 262144,
     "max_output": 32768
    },
    "qwen3.7-flash": {
     "context_window": 991000,
     "max_output": 64000
    },
    "kimi-k2.6": {
     "context_window": 262144,
     "max_output": 32768
    },
    "claude-sonnet-4-5": {
     "context_window": 1000000,
     "max_output": 64000
    },
    "qwen3-max": {
     "context_window": 262144,
     "max_output": 65536
    },
    "claude-opus-5-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "claude-opus-4-8-think": {
     "context_window": 200000,
     "max_output": 32000
    },
    "doubao-seed-2-0-pro": {
     "context_window": 256000,
     "max_output": 128000
    },
    "xiaomi-mimo-v2.5": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "glm-4.5v": {
     "context_window": 64000,
     "max_output": 16384
    },
    "claude-fable-5-1": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "gemini-3.6-flash": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "step-5-preview": {
     "context_window": 1000000,
     "max_output": 1000000
    },
    "longcat-2.0": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "mimo-v2.6-pro-ultraspeed": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "doubao-seed-2-0-code-preview": {
     "context_window": 256000,
     "max_output": 128000
    },
    "grok-4.3": {
     "context_window": 1000000,
     "max_output": 1000000
    },
    "qwen3.8-omni-flash": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "doubao-seed-2-0-mini-260428": {
     "context_window": 256000,
     "max_output": 128000
    },
    "xiaomi-mimo-v2.5-pro-free": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "gemini-3.5-flash-lite": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "gemini-3.1-flash-image": {
     "context_window": 131072,
     "max_output": 32768
    },
    "gpt-6-astra": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "gemini-3.1-pro-preview": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "grok-4.5": {
     "context_window": 1000000,
     "max_output": 1000000
    },
    "qwen3.5-122b-a10b": {
     "context_window": 262144,
     "max_output": 65536
    },
    "kimi-k2.5": {
     "context_window": 262144,
     "max_output": 32768
    },
    "gpt-5.1": {
     "context_window": 400000,
     "max_output": 128000
    },
    "claude-opus-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "coding-minimax-m2.7": {
     "context_window": 204800,
     "max_output": 128100
    },
    "qwen3.6-35b-a3b": {
     "context_window": 262144,
     "max_output": 65536
    },
    "minimax-m2.7": {
     "context_window": 204800,
     "max_output": 128000
    },
    "gemini-3.5-flash": {
     "context_window": 1000000,
     "max_output": 64000
    },
    "gemini-2.5-pro": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "deep-deepseek-v4-flash": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "qwen3.6-flash": {
     "context_window": 991000,
     "max_output": 64000
    },
    "gemini-3-pro-image": {
     "context_window": 65536,
     "max_output": 32768
    },
    "coding-glm-5.1": {
     "context_window": 200000,
     "max_output": 128000
    },
    "gemini-2.5-flash": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "xiaomi-mimo-v2.5-free": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "claude-fable-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "deepseek-v4-pro-0813": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "mimo-v2.5-pro": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "muse-spark-1.2": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "gemini-3.1-flash-lite-image": {
     "context_window": 65536,
     "max_output": 4096
    },
    "mimo-v2.6-flash": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "gpt-5.4-mini": {
     "context_window": 400000,
     "max_output": 128000
    },
    "glm-4.7": {
     "context_window": 204800,
     "max_output": 131072
    },
    "minimax-m3": {
     "context_window": 1048576,
     "max_output": 512000
    },
    "gpt-5.6-luna": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "qwen3.8-flash": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "claude-opus-4-6-think": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "coding-xiaomi-mimo-v2.5": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "gpt-5.2": {
     "context_window": 400000,
     "max_output": 128000
    },
    "claude-opus-4-8": {
     "context_window": 200000,
     "max_output": 32000
    },
    "gpt-5.5": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "claude-sonnet-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "ox-alpha": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "qwen3.5-35b-a3b": {
     "context_window": 262144,
     "max_output": 65536
    },
    "qwen3.6-max-preview": {
     "context_window": 240000,
     "max_output": 64000
    },
    "qwen3.5-397b-a17b": {
     "context_window": 262144,
     "max_output": 65536
    },
    "claude-opus-4-6": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "gemini-3.7-flash": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "glm-5.2": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "hy3": {
     "context_window": 256000,
     "max_output": 128000
    },
    "gemini-3.1-pro-preview-customtools": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "gemini-3-flash-preview": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "grok-build-0.1": {
     "context_window": 256000,
     "max_output": 256000
    },
    "claude-opus-4-7-think": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "alicloud-deepseek-v4-flash": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "coding-xiaomi-mimo-v2.5-pro": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "gemini-3.8-flash": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "gpt-6-luna": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "step-3.7-flash": {
     "context_window": 256000,
     "max_output": 256000
    },
    "alicloud-glm-5.1": {
     "context_window": 200000,
     "max_output": 128000
    },
    "gemini-2.5-flash-lite": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "claude-sonnet-4-6": {
     "context_window": 1000000,
     "max_output": 64000
    },
    "coding-glm-5.1-free": {
     "context_window": 200000,
     "max_output": 128000
    },
    "qwen3.6-plus": {
     "context_window": 991000,
     "max_output": 64000
    },
    "gpt-5.6-terra": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "hy4-preview": {
     "context_window": 1024000,
     "max_output": 64000
    },
    "gpt-5.1-codex-mini": {
     "context_window": 400000,
     "max_output": 128000
    },
    "o3": {
     "context_window": 200000,
     "max_output": 100000
    },
    "glm-5.3": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "claude-opus-4-7": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "kimi-k2.7-code": {
     "context_window": 262144,
     "max_output": 32768
    },
    "gpt-5": {
     "context_window": 400000,
     "max_output": 128000
    },
    "grok-4.6": {
     "context_window": 500000,
     "max_output": 500000
    },
    "xiaomi-mimo-v2.5-pro": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "qwen3.7-plus": {
     "context_window": 991000,
     "max_output": 64000
    },
    "gpt-5.6-sol": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "gpt-6-sol": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "gemini-3.1-flash-lite": {
     "context_window": 1048576,
     "max_output": 65536
    }
   }
  },
  "merge-gateway": {
   "api": "https://api-gateway.merge.dev/v1/ai-sdk",
   "models": {
    "zai/glm-4.5": {
     "context_window": 128000,
     "max_output": 98304
    },
    "zai/glm-5.3-flash": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "zai/glm-4.6": {
     "context_window": 200000,
     "max_output": 131072
    },
    "zai/glm-5": {
     "context_window": 200000,
     "max_output": 131072
    },
    "zai/glm-4.5v": {
     "context_window": 128000,
     "max_output": 32000
    },
    "zai/glm-4.7-flash": {
     "context_window": 200000,
     "max_output": 128000
    },
    "zai/glm-4.7": {
     "context_window": 200000,
     "max_output": 131072
    },
    "zai/glm-5.2": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "zai/glm-5.1": {
     "context_window": 200000,
     "max_output": 131072
    },
    "zai/glm-4.7-flashx": {
     "context_window": 200000,
     "max_output": 131072
    },
    "zai/glm-5-turbo": {
     "context_window": 200000,
     "max_output": 131072
    },
    "zai/glm-4.5-air": {
     "context_window": 128000,
     "max_output": 98304
    },
    "zai/glm-5.3": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "anthropic/claude-3-7-sonnet-20250219": {
     "context_window": 200000,
     "max_output": 64000
    },
    "anthropic/claude-opus-5-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-opus-4-20250514": {
     "context_window": 200000,
     "max_output": 32000
    },
    "anthropic/claude-fable-5-1": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-opus-4-1-20250805": {
     "context_window": 200000,
     "max_output": 32000
    },
    "anthropic/claude-opus-4-5-20251101": {
     "context_window": 200000,
     "max_output": 64000
    },
    "anthropic/claude-opus-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-fable-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-opus-4-8": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-sonnet-4-5-20250929": {
     "context_window": 200000,
     "max_output": 64000
    },
    "anthropic/claude-sonnet-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-opus-4-6": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-haiku-4-5-20251001": {
     "context_window": 200000,
     "max_output": 64000
    },
    "anthropic/claude-sonnet-4-6": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-sonnet-4-20250514": {
     "context_window": 200000,
     "max_output": 64000
    },
    "anthropic/claude-sonnet-5-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-opus-4-7": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "cohere/command-r-08-2024": {
     "context_window": 128000,
     "max_output": 4000
    },
    "cohere/command-a-03-2025": {
     "context_window": 256000,
     "max_output": 8000
    },
    "cohere/command-r7b-12-2024": {
     "context_window": 128000,
     "max_output": 4000
    },
    "cohere/command-r-plus-08-2024": {
     "context_window": 128000,
     "max_output": 4000
    },
    "deepseek/deepseek-v4-flash-0731": {
     "context_window": 1048576,
     "max_output": 384000
    },
    "deepseek/deepseek-v4-flash-0423": {
     "context_window": 131072,
     "max_output": 32768
    },
    "deepseek/deepseek-v4-flash-0731-fast": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "deepseek/deepseek-v4.1-flash": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "deepseek/deepseek-v3": {
     "context_window": 163840,
     "max_output": 81920
    },
    "deepseek/deepseek-v4-pro-0813": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "deepseek/deepseek-v4-pro-0423": {
     "context_window": 1000000,
     "max_output": 393216
    },
    "deepseek/deepseek-v3.1": {
     "context_window": 164000,
     "max_output": 41000
    },
    "deepseek/deepseek-r1": {
     "context_window": 163840,
     "max_output": 40960
    },
    "deepseek/deepseek-v4-pro": {
     "context_window": 1000000,
     "max_output": 262000
    },
    "deepseek/deepseek-v3.2": {
     "context_window": 128000,
     "max_output": 32768
    },
    "deepseek/deepseek-v4-flash": {
     "context_window": 1048576,
     "max_output": 384000
    },
    "thinkingmachines/inkling": {
     "context_window": 1048000,
     "max_output": 32000
    },
    "meta/muse-spark-1.1": {
     "context_window": 1048576,
     "max_output": 262144
    },
    "meta/llama-3.3-70b-instruct": {
     "context_window": 131072,
     "max_output": 32768
    },
    "meta/muse-spark-1.2": {
     "context_window": 1048576,
     "max_output": 262144
    },
    "meta/llama-3.1-8b-instruct": {
     "context_window": 128000,
     "max_output": 2048
    },
    "meta/llama-3.1-70b-instruct": {
     "context_window": 128000,
     "max_output": 2048
    },
    "bytedance/dola-seed-2.0-code-preview": {
     "context_window": 131072,
     "max_output": 32768
    },
    "bytedance/dola-seed-2.0-code": {
     "context_window": 256000,
     "max_output": 128000
    },
    "bytedance/dola-seed-2.0-mini": {
     "context_window": 131072,
     "max_output": 32768
    },
    "bytedance/dola-seed-2.0-lite": {
     "context_window": 131072,
     "max_output": 32768
    },
    "bytedance/dola-seed-2.0-pro": {
     "context_window": 131072,
     "max_output": 32768
    },
    "google/gemini-flash-latest": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemma-4-31b-it": {
     "context_window": 262144,
     "max_output": 65536
    },
    "google/gemma-3-27b-it": {
     "context_window": 131072,
     "max_output": 32768
    },
    "google/gemini-3-pro-preview": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemini-2.5-flash-image": {
     "context_window": 32768,
     "max_output": 32768
    },
    "google/gemini-flash-lite-latest": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemini-3.6-flash": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemma-4-26b-a4b-it": {
     "context_window": 262144,
     "max_output": 65536
    },
    "google/gemini-3.5-flash-lite": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemini-3.1-flash-image": {
     "context_window": 32768,
     "max_output": 32768
    },
    "google/gemini-3.1-pro-preview": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemma-3-12b-it": {
     "context_window": 128000,
     "max_output": 8192
    },
    "google/gemini-2.5-computer-use-preview-10-2025": {
     "context_window": 128000,
     "max_output": 64000
    },
    "google/gemini-3.5-flash": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemini-2.5-pro": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemini-3-pro-image": {
     "context_window": 65536,
     "max_output": 65536
    },
    "google/gemini-2.5-flash": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemini-3.7-flash": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemini-3.1-pro-preview-customtools": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemini-3-flash-preview": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemini-3.8-flash": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemma-3-4b-it": {
     "context_window": 128000,
     "max_output": 8192
    },
    "google/gemini-2.5-flash-lite": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "google/gemini-embedding-001": {
     "context_window": 2048,
     "max_output": 4096
    },
    "google/gemini-3.1-flash-lite-preview": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemini-3.1-flash-lite": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "writer/palmyra-x4": {
     "context_window": 128000,
     "max_output": 32000
    },
    "writer/palmyra-x5": {
     "context_window": 1000000,
     "max_output": 250000
    },
    "xai/grok-4.7": {
     "context_window": 500000,
     "max_output": 500000
    },
    "xai/grok-4.3": {
     "context_window": 1000000,
     "max_output": 1000000
    },
    "xai/grok-4.20-0309-reasoning": {
     "context_window": 1000000,
     "max_output": 1000000
    },
    "xai/grok-4.5": {
     "context_window": 500000,
     "max_output": 500000
    },
    "xai/grok-4.20-0309-non-reasoning": {
     "context_window": 1000000,
     "max_output": 1000000
    },
    "xai/grok-build-0.1": {
     "context_window": 256000,
     "max_output": 256000
    },
    "xai/grok-4.6": {
     "context_window": 500000,
     "max_output": 500000
    },
    "sakana/fugu-ultra": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "sakana/sakana-namazu": {
     "context_window": 262144,
     "max_output": 65536
    },
    "moonshotai/kimi-k2-thinking": {
     "context_window": 262144,
     "max_output": 262144
    },
    "nvidia/nemotron-3-nano-30b-a3b": {
     "context_window": 256000,
     "max_output": 32000
    },
    "nvidia/nemotron-3.5-lightning-30b-a3b": {
     "context_window": 1000000,
     "max_output": 262144
    },
    "nvidia/nemotron-nano-9b-v2": {
     "context_window": 128000,
     "max_output": 8192
    },
    "minimax/minimax-m2.5": {
     "context_window": 204800,
     "max_output": 8192
    },
    "minimax/minimax-m2.7": {
     "context_window": 204800,
     "max_output": 8192
    },
    "minimax/minimax-m3": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "minimax/minimax-m2.7-highspeed": {
     "context_window": 204800,
     "max_output": 8192
    },
    "minimax/minimax-m2.5-highspeed": {
     "context_window": 204800,
     "max_output": 8192
    },
    "minimax/minimax-m2.1": {
     "context_window": 204800,
     "max_output": 8192
    },
    "minimax/minimax-m2": {
     "context_window": 204800,
     "max_output": 8192
    },
    "mistral/codestral-latest": {
     "context_window": 256000,
     "max_output": 4096
    },
    "mistral/mistral-large-2411": {
     "context_window": 131072,
     "max_output": 16384
    },
    "mistral/mistral-large-latest": {
     "context_window": 262144,
     "max_output": 262144
    },
    "mistral/mistral-small-latest": {
     "context_window": 256000,
     "max_output": 256000
    },
    "mistral/devstral-medium-latest": {
     "context_window": 262144,
     "max_output": 262144
    },
    "mistral/devstral-2512": {
     "context_window": 256000,
     "max_output": 256000
    },
    "mistral/mistral-medium-2505": {
     "context_window": 128000,
     "max_output": 128000
    },
    "mistral/magistral-medium-latest": {
     "context_window": 128000,
     "max_output": 16384
    },
    "mistral/devstral-medium-2507": {
     "context_window": 128000,
     "max_output": 128000
    },
    "mistral/mistral-large-2512": {
     "context_window": 256000,
     "max_output": 256000
    },
    "mistral/devstral-small-2507": {
     "context_window": 128000,
     "max_output": 128000
    },
    "mistral/pixtral-large-latest": {
     "context_window": 128000,
     "max_output": 128000
    },
    "mistral/mistral-medium-latest": {
     "context_window": 262144,
     "max_output": 262144
    },
    "qwen/qwen-flash": {
     "context_window": 1000000,
     "max_output": 250000
    },
    "qwen/qwen3.5-flash": {
     "context_window": 1000000,
     "max_output": 250000
    },
    "qwen/qwen3-vl-235b-a22b-instruct": {
     "context_window": 131072,
     "max_output": 32768
    },
    "qwen/qwen3.7-max": {
     "context_window": 1000000,
     "max_output": 250000
    },
    "qwen/qwen3-vl-235b-a22b-thinking": {
     "context_window": 131072,
     "max_output": 32768
    },
    "qwen/qwen3.8-2.4t-a95b": {
     "context_window": 262144,
     "max_output": 1010000
    },
    "qwen/qwen3-vl-plus": {
     "context_window": 262144,
     "max_output": 65536
    },
    "qwen/qwen3.5-27b": {
     "context_window": 131072,
     "max_output": 32768
    },
    "qwen/qwen3-235b-a22b-instruct-2507": {
     "context_window": 131072,
     "max_output": 32768
    },
    "qwen/qwen3-next-80b-a3b-thinking": {
     "context_window": 131072,
     "max_output": 32768
    },
    "qwen/qwen3.8-max": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "qwen/qwen3-coder-next": {
     "context_window": 262144,
     "max_output": 65536
    },
    "qwen/qwen3.5-plus": {
     "context_window": 1000000,
     "max_output": 250000
    },
    "qwen/qwen3-32b": {
     "context_window": 131072,
     "max_output": 32768
    },
    "qwen/qwen-plus": {
     "context_window": 1000000,
     "max_output": 250000
    },
    "qwen/qwen3-max": {
     "context_window": 262144,
     "max_output": 65536
    },
    "qwen/qwen3-coder-480b-a35b-instruct": {
     "context_window": 131072,
     "max_output": 32768
    },
    "qwen/qwen3-235b-a22b": {
     "context_window": 131072,
     "max_output": 32768
    },
    "qwen/qwen3.5-122b-a10b": {
     "context_window": 131072,
     "max_output": 32768
    },
    "qwen/qwen3.6-35b-a3b": {
     "context_window": 262144,
     "max_output": 65536
    },
    "qwen/qwen3-next-80b-a3b-instruct": {
     "context_window": 131072,
     "max_output": 32768
    },
    "qwen/qwen3.6-flash": {
     "context_window": 1000000,
     "max_output": 250000
    },
    "qwen/qwen3-coder-flash": {
     "context_window": 1000000,
     "max_output": 250000
    },
    "qwen/qwen3-coder-plus": {
     "context_window": 1000000,
     "max_output": 250000
    },
    "qwen/qwen3.5-9b": {
     "context_window": 262144,
     "max_output": 32768
    },
    "qwen/qwen3.8-flash": {
     "context_window": 977000,
     "max_output": 128000
    },
    "qwen/qwen3.5-35b-a3b": {
     "context_window": 131072,
     "max_output": 32768
    },
    "qwen/qwen3.6-max-preview": {
     "context_window": 256000,
     "max_output": 65536
    },
    "qwen/qwen3-30b-a3b": {
     "context_window": 131072,
     "max_output": 32768
    },
    "qwen/qwen3.5-397b-a17b": {
     "context_window": 131072,
     "max_output": 32768
    },
    "qwen/qwen3.6-27b": {
     "context_window": 131072,
     "max_output": 32768
    },
    "qwen/qwen3.6-plus": {
     "context_window": 1000000,
     "max_output": 250000
    },
    "qwen/qwen3.7-plus": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "openai/gpt-5.4": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-oss-safeguard-120b": {
     "context_window": 4096,
     "max_output": 4096
    },
    "openai/gpt-3.5-turbo": {
     "context_window": 16385,
     "max_output": 4096
    },
    "openai/gpt-5.4-nano": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-4o-2024-05-13": {
     "context_window": 128000,
     "max_output": 4096
    },
    "openai/gpt-4o": {
     "context_window": 128000,
     "max_output": 16384
    },
    "openai/gpt-5-mini": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/o4-mini": {
     "context_window": 200000,
     "max_output": 100000
    },
    "openai/o3-mini": {
     "context_window": 200000,
     "max_output": 100000
    },
    "openai/gpt-4": {
     "context_window": 8192,
     "max_output": 8192
    },
    "openai/gpt-4.1-nano": {
     "context_window": 1047576,
     "max_output": 32768
    },
    "openai/gpt-5-nano": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-5.2-chat-latest": {
     "context_window": 128000,
     "max_output": 16384
    },
    "openai/gpt-5.1-chat-latest": {
     "context_window": 128000,
     "max_output": 16384
    },
    "openai/o1": {
     "context_window": 200000,
     "max_output": 100000
    },
    "openai/gpt-6.1-sol": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-5-chat-latest": {
     "context_window": 128000,
     "max_output": 16384
    },
    "openai/gpt-4o-2024-08-06": {
     "context_window": 128000,
     "max_output": 16384
    },
    "openai/gpt-6-astra": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-5.1": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-4o-mini": {
     "context_window": 128000,
     "max_output": 16384
    },
    "openai/gpt-oss-20b": {
     "context_window": 128000,
     "max_output": 32000
    },
    "openai/gpt-oss-safeguard-20b": {
     "context_window": 4096,
     "max_output": 4096
    },
    "openai/gpt-5.4-mini": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-5.6-luna": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-5.2": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-5.5": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-4.1": {
     "context_window": 1047576,
     "max_output": 32768
    },
    "openai/gpt-4o-2024-11-20": {
     "context_window": 128000,
     "max_output": 16384
    },
    "openai/gpt-4.1-mini": {
     "context_window": 1047576,
     "max_output": 32768
    },
    "openai/gpt-6-luna": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-5.3-chat-latest": {
     "context_window": 128000,
     "max_output": 16384
    },
    "openai/gpt-5.6-terra": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-4-turbo": {
     "context_window": 128000,
     "max_output": 4096
    },
    "openai/gpt-oss-120b": {
     "context_window": 128000,
     "max_output": 32000
    },
    "openai/o3": {
     "context_window": 200000,
     "max_output": 100000
    },
    "openai/gpt-5": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-5.6-sol": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-6-sol": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "moonshot/kimi-k3": {
     "context_window": 1048576,
     "max_output": 1048576
    },
    "moonshot/kimi-k2.7-code-highspeed": {
     "context_window": 262144,
     "max_output": 32768
    },
    "moonshot/kimi-k2.6": {
     "context_window": 262144,
     "max_output": 262144
    },
    "moonshot/kimi-k2.5": {
     "context_window": 262144,
     "max_output": 262144
    },
    "moonshot/kimi-k2.7-code": {
     "context_window": 262144,
     "max_output": 32768
    }
   }
  },
  "opper": {
   "api": "https://api.opper.ai/v3/compat",
   "models": {
    "gpt-5.4": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "claude-haiku-4-5": {
     "context_window": 200000,
     "max_output": 64000
    },
    "gpt-5.4-pro": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "gemma-4-31b-it": {
     "context_window": 256000,
     "max_output": 8192
    },
    "muse-spark-1.3": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "qwen3.8-27b": {
     "context_window": 262144,
     "max_output": 32768
    },
    "gpt-5.5-pro": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "gpt-5.4-nano": {
     "context_window": 400000,
     "max_output": 128000
    },
    "qwen3.8-2.4t-a95b": {
     "context_window": 262144,
     "max_output": 131072
    },
    "glm-5.3-flash": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "qwen3.8-max": {
     "context_window": 983616,
     "max_output": 131072
    },
    "kimi-k3": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "qwen3-coder-next": {
     "context_window": 262144,
     "max_output": 65536
    },
    "claude-opus-4-5": {
     "context_window": 200000,
     "max_output": 64000
    },
    "gpt-5.3-codex": {
     "context_window": 400000,
     "max_output": 128000
    },
    "claude-sonnet-4-5": {
     "context_window": 200000,
     "max_output": 64000
    },
    "claude-fable-5-1": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "devstral-2512": {
     "context_window": 256000,
     "max_output": 8192
    },
    "sonar-pro": {
     "context_window": 200000,
     "max_output": 8000
    },
    "grok-4.3": {
     "context_window": 1000000,
     "max_output": 30000
    },
    "gemini-3.5-flash-lite": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "gpt-6-astra": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "gemini-3.1-pro-preview": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "grok-4.5": {
     "context_window": 500000,
     "max_output": 500000
    },
    "claude-opus-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "qwen3.6-35b-a3b": {
     "context_window": 262144,
     "max_output": 65536
    },
    "gpt-oss-20b": {
     "context_window": 128000,
     "max_output": 8192
    },
    "minimax-m2.7": {
     "context_window": 196608,
     "max_output": 131072
    },
    "gemini-3.5-flash": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "claude-fable-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "muse-spark-1.2": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "gpt-5.4-mini": {
     "context_window": 400000,
     "max_output": 128000
    },
    "minimax-m3": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "gpt-5.6-luna": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "mistral-small-2603": {
     "context_window": 256000,
     "max_output": 8192
    },
    "claude-opus-4-8": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "gpt-5.5": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "claude-sonnet-5": {
     "context_window": 1000000,
     "max_output": 64000
    },
    "claude-opus-4-6": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "gemini-3.7-flash": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "glm-5.2": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "gemini-3-flash-preview": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "grok-build-0.1": {
     "context_window": 256000,
     "max_output": 256000
    },
    "sonar": {
     "context_window": 128000,
     "max_output": 4096
    },
    "mistral-large-2512": {
     "context_window": 256000,
     "max_output": 8192
    },
    "gemini-3.8-flash": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "deepseek-v4-pro": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "claude-sonnet-4-6": {
     "context_window": 1000000,
     "max_output": 64000
    },
    "gpt-5.3-chat-latest": {
     "context_window": 128000,
     "max_output": 16384
    },
    "sonar-reasoning-pro": {
     "context_window": 128000,
     "max_output": 4096
    },
    "gpt-5.6-terra": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "gpt-oss-120b": {
     "context_window": 128000,
     "max_output": 8192
    },
    "glm-5.3": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "claude-opus-4-7": {
     "context_window": 1000000,
     "max_output": 64000
    },
    "grok-4.6": {
     "context_window": 500000,
     "max_output": 500000
    },
    "gpt-5.6-sol": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "deepseek-v4-flash": {
     "context_window": 1000000,
     "max_output": 384000
    }
   }
  },
  "nvidia": {
   "api": "https://integrate.api.nvidia.com/v1",
   "models": {
    "baai/bge-m3": {
     "context_window": 8192,
     "max_output": 1024
    },
    "poolside/laguna-xs-2.1": {
     "context_window": 262144,
     "max_output": 16384
    },
    "abacusai/dracarys-llama-3.1-70b-instruct": {
     "context_window": 128000,
     "max_output": 8192
    },
    "z-ai/glm-5.3-flash": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "z-ai/glm-5.2": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "z-ai/glm-5.3": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "thinkingmachines/inkling": {
     "context_window": 1048576,
     "max_output": 16384
    },
    "black-forest-labs/flux.1-dev": {
     "context_window": 4096
    },
    "black-forest-labs/flux_1-kontext-dev": {
     "context_window": 40960,
     "max_output": 40960
    },
    "black-forest-labs/flux_2-klein-4b": {
     "context_window": 40960,
     "max_output": 40960
    },
    "meta/llama-guard-4-12b": {
     "context_window": 128000,
     "max_output": 16384
    },
    "meta/muse-glimmer-30b": {
     "context_window": 131072,
     "max_output": 131072
    },
    "meta/esmfold": {
     "context_window": 128000,
     "max_output": 8192
    },
    "meta/llama-3.3-70b-instruct": {
     "context_window": 128000,
     "max_output": 4096
    },
    "meta/llama-3.2-90b-vision-instruct": {
     "context_window": 128000,
     "max_output": 8192
    },
    "meta/llama-4-maverick-17b-128e-instruct": {
     "context_window": 128000,
     "max_output": 4096
    },
    "meta/llama-3.1-8b-instruct": {
     "context_window": 16000,
     "max_output": 4096
    },
    "meta/llama-3.2-11b-vision-instruct": {
     "context_window": 128000,
     "max_output": 4096
    },
    "meta/llama-3.2-1b-instruct": {
     "context_window": 128000,
     "max_output": 4096
    },
    "meta/llama-3.2-3b-instruct": {
     "context_window": 32768,
     "max_output": 32000
    },
    "meta/llama-3.1-70b-instruct": {
     "context_window": 128000,
     "max_output": 4096
    },
    "meta/esm2-650m": {
     "context_window": 128000,
     "max_output": 8192
    },
    "upstage/solar-10.7b-instruct": {
     "context_window": 128000,
     "max_output": 8192
    },
    "bytedance/seed-oss-36b-instruct": {
     "context_window": 262000,
     "max_output": 262000
    },
    "google/diffusiongemma-26b-a4b-it": {
     "context_window": 250000,
     "max_output": 32768
    },
    "google/gemma-4-31b-it": {
     "context_window": 256000,
     "max_output": 16384
    },
    "google/gemma-2-2b-it": {
     "context_window": 128000,
     "max_output": 4096
    },
    "google/gemma-3-12b-it": {
     "context_window": 131072,
     "max_output": 16384
    },
    "google/gemma-3n-e2b-it": {
     "context_window": 128000,
     "max_output": 4096
    },
    "google/google-paligemma": {
     "context_window": 128000,
     "max_output": 8192
    },
    "google/gemma-3n-e4b-it": {
     "context_window": 128000,
     "max_output": 4096
    },
    "google/gemma-3-4b-it": {
     "context_window": 131072,
     "max_output": 16384
    },
    "minimaxai/minimax-m2.7": {
     "context_window": 204800,
     "max_output": 131072
    },
    "minimaxai/minimax-m3": {
     "context_window": 1000000,
     "max_output": 16384
    },
    "deepseek-ai/deepseek-v4-flash-0731": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "deepseek-ai/deepseek-v4.1-flash": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "deepseek-ai/deepseek-v4-pro-0813": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "deepseek-ai/deepseek-v4-pro": {
     "context_window": 1048576,
     "max_output": 393216
    },
    "deepseek-ai/deepseek-v4-flash": {
     "context_window": 1048576,
     "max_output": 393216
    },
    "stepfun-ai/step-3.5-flash": {
     "context_window": 256000,
     "max_output": 16384
    },
    "stepfun-ai/step-3.7-flash": {
     "context_window": 256000,
     "max_output": 16384
    },
    "mistralai/mistral-nemotron": {
     "context_window": 128000,
     "max_output": 8192
    },
    "mistralai/mistral-7b-instruct-v0.3": {
     "context_window": 65536,
     "max_output": 65536
    },
    "mistralai/mistral-large-3-675b-instruct-2512": {
     "context_window": 262144,
     "max_output": 262144
    },
    "mistralai/magistral-small-2506": {
     "context_window": 32768,
     "max_output": 32768
    },
    "mistralai/mistral-small-4-119b-2603": {
     "context_window": 128000,
     "max_output": 8192
    },
    "mistralai/mixtral-8x7b-instruct": {
     "context_window": 32768,
     "max_output": 16384
    },
    "mistralai/mistral-medium-3.5-128b": {
     "context_window": 262144,
     "max_output": 32768
    },
    "mistralai/ministral-14b-instruct-2512": {
     "context_window": 262144,
     "max_output": 16384
    },
    "mistralai/mixtral-8x22b-instruct": {
     "context_window": 65536,
     "max_output": 13108
    },
    "mistralai/mistral-medium-3-instruct": {
     "context_window": 131072,
     "max_output": 32768
    },
    "moonshotai/kimi-k3": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "moonshotai/kimi-k2.6": {
     "context_window": 262144,
     "max_output": 262144
    },
    "sarvamai/sarvam-m": {
     "context_window": 128000,
     "max_output": 8192
    },
    "nvidia/nvidia-nemotron-nano-9b-v2": {
     "context_window": 131072,
     "max_output": 131072
    },
    "nvidia/llama-3.1-nemotron-ultra-253b-v1": {
     "context_window": 128000,
     "max_output": 16384
    },
    "nvidia/sparsedrive": {
     "context_window": 128000,
     "max_output": 8192
    },
    "nvidia/nemotron-3-nano-30b-a3b": {
     "context_window": 131072,
     "max_output": 131072
    },
    "nvidia/nemotron-3.5-lightning-30b-a3b": {
     "context_window": 262144,
     "max_output": 262144
    },
    "nvidia/llama-nemotron-embed-vl-1b-v2": {
     "context_window": 32768,
     "max_output": 2048
    },
    "nvidia/nv-embedcode-7b-v1": {
     "context_window": 32768,
     "max_output": 2048
    },
    "nvidia/nemotron-voicechat": {
     "context_window": 128000,
     "max_output": 8192
    },
    "nvidia/bevformer": {
     "context_window": 128000,
     "max_output": 8192
    },
    "nvidia/cosmos-transfer1-7b": {
     "max_output": 4096
    },
    "nvidia/cosmos-predict1-5b": {
     "max_output": 4096
    },
    "nvidia/llama-3.1-nemotron-nano-vl-8b-v1": {
     "context_window": 32768,
     "max_output": 16384
    },
    "nvidia/nemotron-3-super-120b-a12b": {
     "context_window": 262144,
     "max_output": 262144
    },
    "nvidia/studiovoice": {
     "context_window": 128000,
     "max_output": 8192
    },
    "nvidia/nemotron-content-safety-reasoning-4b": {
     "context_window": 128000,
     "max_output": 4096
    },
    "nvidia/llama-3.1-nemotron-safety-guard-8b-v3": {
     "context_window": 128000,
     "max_output": 4096
    },
    "nvidia/nv-embed-v1": {
     "context_window": 32768,
     "max_output": 2048
    },
    "nvidia/synthetic-video-detector": {
     "max_output": 4096
    },
    "nvidia/cosmos-transfer2_5-2b": {
     "max_output": 4096
    },
    "nvidia/nemotron-3-ultra-550b-a55b": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "nvidia/nemotron-3-nano-omni-30b-a3b-reasoning": {
     "context_window": 256000,
     "max_output": 65536
    },
    "nvidia/llama-3.1-nemotron-nano-8b-v1": {
     "context_window": 131072,
     "max_output": 16384
    },
    "nvidia/active-speaker-detection": {
     "max_output": 4096
    },
    "nvidia/streampetr": {
     "context_window": 128000,
     "max_output": 8192
    },
    "nvidia/llama-nemotron-rerank-vl-1b-v2": {
     "context_window": 128000,
     "max_output": 4096
    },
    "nvidia/nemotron-mini-4b-instruct": {
     "context_window": 128000,
     "max_output": 8192
    },
    "nvidia/cosmos-reason2-8b": {
     "context_window": 131072,
     "max_output": 16384
    },
    "nvidia/nemotron-3-content-safety": {
     "context_window": 128000,
     "max_output": 4096
    },
    "nvidia/llama-3.3-nemotron-super-49b-v1": {
     "context_window": 131072,
     "max_output": 65536
    },
    "nvidia/magpie-tts-zeroshot": {
     "max_output": 4096
    },
    "nvidia/riva-translate-4b-instruct-v1.1": {
     "context_window": 128000,
     "max_output": 4096
    },
    "nvidia/nemotron-nano-12b-v2-vl": {
     "context_window": 128000,
     "max_output": 128000
    },
    "nvidia/nemotron-3.5-content-safety": {
     "context_window": 128000,
     "max_output": 8192
    },
    "nvidia/llama-3.3-nemotron-super-49b-v1.5": {
     "context_window": 131072,
     "max_output": 65536
    },
    "nvidia/llama-3_2-nemoretriever-300m-embed-v1": {
     "context_window": 32768,
     "max_output": 2048
    },
    "nvidia/gliner-pii": {
     "context_window": 128000,
     "max_output": 4096
    },
    "nvidia/usdcode": {
     "context_window": 128000,
     "max_output": 4096
    },
    "nvidia/usdvalidate": {
     "max_output": 4096
    },
    "nvidia/llama-3.1-nemotron-70b-instruct": {
     "context_window": 128000,
     "max_output": 8192
    },
    "nvidia/rerank-qa-mistral-4b": {
     "context_window": 128000,
     "max_output": 4096
    },
    "qwen/qwen3-coder-480b-a35b-instruct": {
     "context_window": 262144,
     "max_output": 66536
    },
    "qwen/qwen3.5-122b-a10b": {
     "context_window": 262144,
     "max_output": 65536
    },
    "qwen/qwen3-next-80b-a3b-instruct": {
     "context_window": 262144,
     "max_output": 16384
    },
    "qwen/qwen3.5-397b-a17b": {
     "context_window": 262144,
     "max_output": 8192
    },
    "qwen/qwen2.5-coder-32b-instruct": {
     "context_window": 128000,
     "max_output": 4096
    },
    "openai/whisper-large-v3": {
     "max_output": 4096
    },
    "openai/gpt-oss-20b": {
     "context_window": 131072,
     "max_output": 32768
    },
    "microsoft/phi-4-mini-instruct": {
     "context_window": 131072,
     "max_output": 8192
    },
    "microsoft/phi-4-multimodal-instruct": {
     "context_window": 128000,
     "max_output": 16384
    }
   }
  },
  "pioneer": {
   "api": "https://api.fastino.ai/v1",
   "models": {
    "gpt-5.4": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "claude-haiku-4-5": {
     "context_window": 200000,
     "max_output": 64000
    },
    "qwen3.7-max": {
     "context_window": 991000,
     "max_output": 64000
    },
    "gpt-5.4-nano": {
     "context_window": 1047576,
     "max_output": 128000
    },
    "gpt-4o": {
     "context_window": 128000,
     "max_output": 16384
    },
    "ministral-3b": {
     "context_window": 128000,
     "max_output": 4000
    },
    "magistral-medium": {
     "context_window": 128000,
     "max_output": 64000
    },
    "gpt-5-mini": {
     "context_window": 400000,
     "max_output": 128000
    },
    "claude-opus-4-5": {
     "context_window": 200000,
     "max_output": 64000
    },
    "claude-3-7-sonnet-latest": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "gpt-5.3-codex": {
     "context_window": 400000,
     "max_output": 128000
    },
    "gpt-4.1-nano": {
     "context_window": 1047576,
     "max_output": 32768
    },
    "mistral-medium-3.5": {
     "context_window": 256000,
     "max_output": 131072
    },
    "gpt-5-nano": {
     "context_window": 400000,
     "max_output": 128000
    },
    "claude-sonnet-4-5": {
     "context_window": 1000000,
     "max_output": 64000
    },
    "gemini-3.6-flash": {
     "context_window": 1000000,
     "max_output": 64000
    },
    "gemini-3.5-flash-lite": {
     "context_window": 1000000,
     "max_output": 65000
    },
    "claude-opus-4-1": {
     "context_window": 200000,
     "max_output": 32000
    },
    "grok-4.5": {
     "context_window": 500000,
     "max_output": 131072
    },
    "gpt-5.1": {
     "context_window": 400000,
     "max_output": 131072
    },
    "claude-opus-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "gpt-4o-mini": {
     "context_window": 128000,
     "max_output": 16384
    },
    "gemini-3-flash": {
     "context_window": 1000000,
     "max_output": 65000
    },
    "gemini-3.5-flash": {
     "context_window": 1000000,
     "max_output": 64000
    },
    "qwen3.6-flash": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "mistral-large-3": {
     "context_window": 256000,
     "max_output": 131072
    },
    "claude-fable-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "gpt-5.4-mini": {
     "context_window": 400000,
     "max_output": 128000
    },
    "gpt-5.6-luna": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "devstral-small-2": {
     "context_window": 256000,
     "max_output": 131072
    },
    "devstral-2": {
     "context_window": 256000,
     "max_output": 131072
    },
    "claude-opus-4-8": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "gpt-5.5": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "gpt-4.1": {
     "context_window": 1047576,
     "max_output": 32768
    },
    "mistral-medium": {
     "context_window": 128000,
     "max_output": 64000
    },
    "claude-sonnet-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "qwen3.6-max-preview": {
     "context_window": 240000,
     "max_output": 64000
    },
    "claude-opus-4-6": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "gpt-4.1-mini": {
     "context_window": 1047576,
     "max_output": 32768
    },
    "claude-sonnet-4-6": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "claude-opus-5-fast": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "qwen3.6-plus": {
     "context_window": 1000000,
     "max_output": 64000
    },
    "gpt-5.6-terra": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "claude-opus-4-7": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "ministral-14b": {
     "context_window": 256000,
     "max_output": 131072
    },
    "gemini-3.1-pro": {
     "context_window": 1000000,
     "max_output": 64000
    },
    "qwen3.7-plus": {
     "context_window": 1000000,
     "max_output": 64000
    },
    "gpt-5.6-sol": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "gemini-3.1-flash-lite": {
     "context_window": 1000000,
     "max_output": 65000
    },
    "poolside/laguna-s-2.1": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "meta-llama/Llama-3.2-1B-Instruct": {
     "context_window": 131072,
     "max_output": 60000
    },
    "meta-llama/Llama-3.2-3B-Instruct": {
     "context_window": 131072,
     "max_output": 80000
    },
    "meta-llama/Llama-3.1-8B-Instruct": {
     "context_window": 128000,
     "max_output": 8192
    },
    "meta-llama/Llama-3.2-3B": {
     "context_window": 131072,
     "max_output": 131072
    },
    "meta-llama/Llama-3.2-1B": {
     "context_window": 131072,
     "max_output": 131072
    },
    "meta-llama/Llama-3.3-70B-Instruct": {
     "context_window": 16384,
     "max_output": 16384
    },
    "XiaomiMiMo/MiMo-V2.5-Pro": {
     "context_window": 1050000,
     "max_output": 131000
    },
    "XiaomiMiMo/MiMo-V2.5": {
     "context_window": 1050000,
     "max_output": 131072
    },
    "thinkingmachines/inkling-small": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "meta/muse-spark-1.1": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "HuggingFaceTB/SmolLM3-3B-Base": {
     "context_window": 32768,
     "max_output": 32768
    },
    "google/diffusiongemma-26B-A4B-it": {
     "context_window": 262144,
     "max_output": 131072
    },
    "google/gemma-4-12B-it": {
     "context_window": 32768,
     "max_output": 32768
    },
    "google/gemma-4-E2B-it": {
     "context_window": 32768,
     "max_output": 32768
    },
    "google/gemma-3-4b-pt": {
     "context_window": 32768,
     "max_output": 32768
    },
    "google/gemma-4-31B-it": {
     "context_window": 32768,
     "max_output": 32768
    },
    "google/gemma-4-E4B-it": {
     "context_window": 32768,
     "max_output": 32768
    },
    "Qwen/Qwen3-4B-Instruct-2507": {
     "context_window": 32768,
     "max_output": 32768
    },
    "Qwen/Qwen2.5-Coder-0.5B": {
     "context_window": 32768,
     "max_output": 32768
    },
    "Qwen/Qwen3-1.7B-Base": {
     "context_window": 32768,
     "max_output": 32768
    },
    "Qwen/Qwen3.6-35B-A3B": {
     "context_window": 262144,
     "max_output": 131072
    },
    "Qwen/Qwen3-235B-A22B-Instruct-2507": {
     "context_window": 262144,
     "max_output": 131072
    },
    "Qwen/Qwen3-8B": {
     "context_window": 40960,
     "max_output": 40960
    },
    "Qwen/Qwen3-4B-Base": {
     "context_window": 32768,
     "max_output": 32768
    },
    "Qwen/Qwen3-32B": {
     "context_window": 131072,
     "max_output": 8192
    },
    "Qwen/Qwen3.5-9B": {
     "context_window": 32768,
     "max_output": 32768
    },
    "Qwen/Qwen3.6-27B": {
     "context_window": 32768,
     "max_output": 32768
    },
    "LiquidAI/LFM2-24B-A2B": {
     "context_window": 32768,
     "max_output": 32768
    },
    "deepseek-ai/DeepSeek-V3.1": {
     "context_window": 163840,
     "max_output": 131072
    },
    "deepseek-ai/DeepSeek-V4-Flash": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "deepseek-ai/DeepSeek-V4-Pro": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "deepseek-ai/DeepSeek-V3": {
     "context_window": 163840,
     "max_output": 8192
    },
    "MiniMaxAI/MiniMax-M3": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "MiniMaxAI/MiniMax-M2.7": {
     "context_window": 204800,
     "max_output": 131000
    },
    "mistralai/Mistral-Small-4-119B-2603": {
     "context_window": 32000,
     "max_output": 32000
    },
    "mistralai/Pixtral-12B-2409": {
     "context_window": 128000,
     "max_output": 4000
    },
    "mistralai/Mistral-Nemo-Instruct-2407": {
     "context_window": 128000,
     "max_output": 128000
    },
    "mistralai/Magistral-Small-2506": {
     "context_window": 128000,
     "max_output": 64000
    },
    "mistralai/Ministral-8B-Instruct-2410": {
     "context_window": 128000,
     "max_output": 4000
    },
    "mistralai/Codestral-22B-v0.1": {
     "context_window": 128000,
     "max_output": 4000
    },
    "mistralai/Mistral-7B-Instruct-v0.3": {
     "context_window": 32768,
     "max_output": 32768
    },
    "sakana/fugu-ultra": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "moonshotai/Kimi-K2.6": {
     "context_window": 262000,
     "max_output": 131072
    },
    "moonshotai/Kimi-K3": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "moonshotai/Kimi-K3-Fast": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "moonshotai/Kimi-K2.7-Code": {
     "context_window": 256000,
     "max_output": 32768
    },
    "zai-org/GLM-5.1": {
     "context_window": 202000,
     "max_output": 131072
    },
    "zai-org/GLM-5.2": {
     "context_window": 1040000,
     "max_output": 128000
    },
    "zai-org/GLM-5.2-Fast": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-BF16": {
     "context_window": 262144,
     "max_output": 131072
    },
    "nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-BF16": {
     "context_window": 8192,
     "max_output": 4096
    },
    "nvidia/NVIDIA-Nemotron-3-Ultra-550B-A55B-BF16": {
     "context_window": 1000000,
     "max_output": 65000
    },
    "nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-FP8": {
     "context_window": 256000,
     "max_output": 32000
    },
    "pioneer/auto": {
     "context_window": 1048576,
     "max_output": 4096
    },
    "fastino/gliner2-multi-v1": {
     "context_window": 8192,
     "max_output": 8192
    },
    "fastino/gliner2.5-base-v1": {
     "context_window": 4096,
     "max_output": 4096
    },
    "fastino/gliner2-privacy-filter-PII-multi": {
     "context_window": 8192,
     "max_output": 8192
    },
    "fastino/gliner2.5-multi-v1": {
     "context_window": 4096,
     "max_output": 4096
    },
    "fastino/gliguard-LLMGuardrails-300M": {
     "context_window": 8192,
     "max_output": 8192
    },
    "fastino/gliner2-large-v1": {
     "context_window": 8192,
     "max_output": 8192
    },
    "fastino/gliner2-base-v1": {
     "context_window": 8192,
     "max_output": 8192
    },
    "fastino/gliguard-PII-multi": {
     "context_window": 8192,
     "max_output": 8192
    },
    "fastino/gliner2-multi-large-v1": {
     "context_window": 8192,
     "max_output": 8192
    },
    "fastino/GLiNER-2.5-Decide": {
     "context_window": 8192,
     "max_output": 8192
    },
    "openai/gpt-oss-20b": {
     "context_window": 131072,
     "max_output": 8192
    },
    "openai/gpt-oss-120b": {
     "context_window": 131072,
     "max_output": 131072
    }
   }
  },
  "xiaomi": {
   "api": "https://api.xiaomimimo.com/v1",
   "models": {
    "mimo-v2.6-pro": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "mimo-v2-flash": {
     "context_window": 262144,
     "max_output": 65536
    },
    "mimo-v2.5": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "mimo-v2-omni": {
     "context_window": 262144,
     "max_output": 131072
    },
    "mimo-v2.6-pro-ultraspeed": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "mimo-v2-pro": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "mimo-v2.5-pro": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "mimo-v2.6-flash": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "mimo-v2.5-pro-ultraspeed": {
     "context_window": 1048576,
     "max_output": 131072
    }
   }
  },
  "xiaomi-token-plan-sgp": {
   "api": "https://token-plan-sgp.xiaomimimo.com/v1",
   "models": {
    "mimo-v2.6-pro": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "mimo-v2.6-flash": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "mimo-v2.5-tts-voiceclone": {
     "context_window": 8192,
     "max_output": 8192
    },
    "mimo-v2.5-pro": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "mimo-v2-tts": {
     "context_window": 8192,
     "max_output": 8192
    },
    "mimo-v2-pro": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "mimo-v2.5-tts": {
     "context_window": 8192,
     "max_output": 8192
    },
    "mimo-v2.5-tts-voicedesign": {
     "context_window": 8192,
     "max_output": 8192
    },
    "mimo-v2.5": {
     "context_window": 1048576,
     "max_output": 131072
    }
   }
  },
  "minimax": {
   "api": "https://api.minimax.io/anthropic/v1",
   "models": {
    "MiniMax-M3": {
     "context_window": 1000000,
     "max_output": 512000
    },
    "MiniMax-M2.1": {
     "context_window": 204800,
     "max_output": 131072
    },
    "MiniMax-M2.5": {
     "context_window": 204800,
     "max_output": 131072
    },
    "MiniMax-M2.7": {
     "context_window": 204800,
     "max_output": 131072
    },
    "MiniMax-M2.7-highspeed": {
     "context_window": 204800,
     "max_output": 131072
    },
    "MiniMax-M2": {
     "context_window": 204800,
     "max_output": 131072
    },
    "MiniMax-M2.5-highspeed": {
     "context_window": 204800,
     "max_output": 131072
    }
   }
  },
  "github-copilot": {
   "api": "https://api.githubcopilot.com",
   "models": {
    "gpt-5.4": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "grok-4.7": {
     "context_window": 500000,
     "max_output": 128000
    },
    "gpt-5.4-nano": {
     "context_window": 400000,
     "max_output": 128000
    },
    "claude-opus-4.7": {
     "context_window": 200000,
     "max_output": 32000
    },
    "kimi-k3": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "gpt-5-mini": {
     "context_window": 264000,
     "max_output": 64000
    },
    "claude-opus-4.8": {
     "context_window": 200000,
     "max_output": 64000
    },
    "gpt-5.3-codex": {
     "context_window": 400000,
     "max_output": 128000
    },
    "gemini-3.6-flash": {
     "context_window": 1000000,
     "max_output": 64000
    },
    "mai-code-1-flash-picker": {
     "context_window": 256000,
     "max_output": 128000
    },
    "mai-code-1.1-flash": {
     "context_window": 256000,
     "max_output": 128000
    },
    "gpt-6.1-sol": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "claude-haiku-4.5": {
     "context_window": 200000,
     "max_output": 64000
    },
    "gpt-6-astra": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "grok-4.5": {
     "context_window": 500000,
     "max_output": 128000
    },
    "claude-opus-5": {
     "context_window": 1000000,
     "max_output": 64000
    },
    "claude-sonnet-5.5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "gemini-3.5-flash": {
     "context_window": 200000,
     "max_output": 64000
    },
    "claude-fable-5.1": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "claude-fable-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "gpt-5.4-mini": {
     "context_window": 400000,
     "max_output": 128000
    },
    "gpt-5.6-luna": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "gpt-5.5": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "claude-sonnet-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "gemini-3.7-flash": {
     "context_window": 1000000,
     "max_output": 64000
    },
    "claude-sonnet-4.6": {
     "context_window": 200000,
     "max_output": 32000
    },
    "gemini-3.8-flash": {
     "context_window": 1000000,
     "max_output": 64000
    },
    "gpt-6-luna": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "claude-opus-5.5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "gpt-5.6-terra": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "kimi-k2.7-code": {
     "context_window": 256000,
     "max_output": 32000
    },
    "grok-4.6": {
     "context_window": 500000,
     "max_output": 128000
    },
    "gpt-5.6-sol": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "gpt-6-sol": {
     "context_window": 1050000,
     "max_output": 128000
    }
   }
  },
  "inferx": {
   "api": "https://model.inferx.net/endpoints/v1",
   "models": {
    "gemma-4-31B-it-fp8": {
     "context_window": 262144,
     "max_output": 32768
    },
    "Qwen3.6-35B-A3B-fp8-no-thinking": {
     "context_window": 262000,
     "max_output": 65536
    },
    "Devstral-2-123B-Instruct-2512-int4-AutoRound": {
     "context_window": 128000,
     "max_output": 128000
    },
    "Qwen3.6-27B-FP8": {
     "context_window": 262144,
     "max_output": 65536
    },
    "Qwen3-Coder-Next-FP8": {
     "context_window": 256144,
     "max_output": 65536
    },
    "Qwen3-Coder-Next-FP8-no-thinking": {
     "context_window": 260000,
     "max_output": 65536
    },
    "mimo-v25": {
     "context_window": 1000000,
     "max_output": 100000
    },
    "Qwen3-Embedding-8B": {
     "context_window": 32768
    },
    "Qwen3.6-35B-A3B-FP8": {
     "context_window": 262000,
     "max_output": 65536
    },
    "Ornith-1.0-35B-FP8": {
     "context_window": 262000,
     "max_output": 100000
    },
    "Agents-A1": {
     "context_window": 262000,
     "max_output": 100000
    },
    "deepseek-v4-flash": {
     "context_window": 1000000,
     "max_output": 100000
    }
   }
  },
  "opencode-go": {
   "api": "https://opencode.ai/zen/go/v1",
   "models": {
    "mimo-v2.6-pro": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "qwen3.7-max": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "mimo-v2.5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "grok-4.7": {
     "context_window": 500000,
     "max_output": 500000
    },
    "longcat-2.5-preview-free": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "glm-5.3-flash": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "qwen3.8-max": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "kimi-k3": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "deepseek-v4.1-flash": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "deepseek-v4-flash-vision-exp": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "kimi-k2.6": {
     "context_window": 262144,
     "max_output": 65536
    },
    "longcat-2.0": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "grok-4.5": {
     "context_window": 500000,
     "max_output": 500000
    },
    "minimax-m2.7": {
     "context_window": 204800,
     "max_output": 131072
    },
    "space-bunny-free": {
     "context_window": 1048576,
     "max_output": 524288
    },
    "mimo-v2.5-pro": {
     "context_window": 1048576,
     "max_output": 128000
    },
    "mimo-v2.6-flash": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "minimax-m3": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "gpt-5.6-luna": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "qwen3.8-flash": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "glm-5.2": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "hy3": {
     "context_window": 256000,
     "max_output": 128000
    },
    "muse-spark-1.2-contributor": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "gpt-6-luna": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "deepseek-v4-pro": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "qwen3.6-plus": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "hy4-preview": {
     "context_window": 1024000,
     "max_output": 64000
    },
    "muse-spark-1.3-contributor": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "glm-5.3": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "kimi-k2.7-code": {
     "context_window": 262144,
     "max_output": 262144
    },
    "grok-4.6": {
     "context_window": 500000,
     "max_output": 500000
    },
    "qwen3.7-plus": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "deepseek-v4-flash": {
     "context_window": 1000000,
     "max_output": 384000
    }
   }
  },
  "openreason": {
   "api": "https://api.openreason.app/v1",
   "models": {
    "deepseek-ai/deepseek-v4-flash-0731": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "moonshotai/kimi-k2.7-code": {
     "context_window": 262144,
     "max_output": 262144
    },
    "openai/gpt-oss-120b": {
     "context_window": 131072,
     "max_output": 32768
    }
   }
  },
  "lmstudio": {
   "api": "http://127.0.0.1:1234/v1",
   "models": {
    "qwen/qwen3-30b-a3b-2507": {
     "context_window": 262144,
     "max_output": 16384
    },
    "qwen/qwen3-coder-30b": {
     "context_window": 262144,
     "max_output": 65536
    },
    "openai/gpt-oss-20b": {
     "context_window": 131072,
     "max_output": 32768
    }
   }
  },
  "aki-io": {
   "api": "https://aki.io/v1",
   "models": {
    "qwen3.8-27b": {
     "context_window": 262144,
     "max_output": 32768
    },
    "deepseek-v4-flash-0731-284b": {
     "context_window": 1048576,
     "max_output": 81920
    },
    "qwen3.6-35b": {
     "context_window": 256000,
     "max_output": 32768
    },
    "glm5.3-754b": {
     "context_window": 524288,
     "max_output": 81920
    },
    "mistral4-119b": {
     "context_window": 262144,
     "max_output": 81920
    },
    "gpt-oss-120b": {
     "context_window": 128000,
     "max_output": 32768
    },
    "gemma4-26b": {
     "context_window": 256000,
     "max_output": 32768
    }
   }
  },
  "tensorx": {
   "api": "https://api.tensorx.ai/v1",
   "models": {
    "deepseek/deepseek-v4-flash-0731": {
     "context_window": 1048576,
     "max_output": 384000
    },
    "deepseek/deepseek-v4.1-flash": {
     "context_window": 1048576,
     "max_output": 384000
    },
    "deepseek/deepseek-v4-pro-0813": {
     "context_window": 1048576,
     "max_output": 64000
    },
    "deepseek/deepseek-v4-pro": {
     "context_window": 1048576,
     "max_output": 384000
    },
    "deepseek/deepseek-r1-0528": {
     "context_window": 164000,
     "max_output": 8192
    },
    "deepseek/deepseek-v3.2": {
     "context_window": 163840,
     "max_output": 163840
    },
    "z-ai/glm-5v-turbo": {
     "context_window": 202752,
     "max_output": 131072
    },
    "z-ai/glm-5.3-flash": {
     "context_window": 1048576,
     "max_output": 64000
    },
    "z-ai/glm-5": {
     "context_window": 202752,
     "max_output": 202752
    },
    "z-ai/glm-5.2": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "z-ai/glm-5.1": {
     "context_window": 202752,
     "max_output": 202752
    },
    "z-ai/glm-5-turbo": {
     "context_window": 202752,
     "max_output": 131072
    },
    "z-ai/glm-5.3": {
     "context_window": 1048576,
     "max_output": 64000
    },
    "moonshotai/kimi-k3": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "moonshotai/kimi-k2.6": {
     "context_window": 262144,
     "max_output": 262144
    },
    "moonshotai/kimi-k2.5": {
     "context_window": 262144,
     "max_output": 262144
    },
    "moonshotai/kimi-k2.7-code": {
     "context_window": 262144,
     "max_output": 262144
    },
    "minimax/minimax-m2.5": {
     "context_window": 196608,
     "max_output": 65536
    },
    "minimax/minimax-m3": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "qwen/qwen3-235b-a22b-2507": {
     "context_window": 131000,
     "max_output": 262144
    },
    "qwen/qwen3.8-27b": {
     "context_window": 262144,
     "max_output": 32768
    },
    "qwen/qwen3.8-2.4t-a95b": {
     "context_window": 262144,
     "max_output": 64000
    },
    "qwen/qwen3.5-122b-a10b": {
     "context_window": 262144,
     "max_output": 262144
    },
    "qwen/qwen3.5-9b": {
     "context_window": 262144,
     "max_output": 65536
    },
    "qwen/qwen3.8-flash-next": {
     "context_window": 262144,
     "max_output": 64000
    }
   }
  },
  "longcat": {
   "api": "https://api.longcat.chat/openai",
   "models": {
    "LongCat-2.0": {
     "context_window": 1000000,
     "max_output": 131072
    }
   }
  },
  "pareto": {
   "api": "https://api.paretoinference.com/v1",
   "models": {
    "z-ai/glm-5.3-flash": {
     "context_window": 1000000,
     "max_output": 131072
    }
   }
  },
  "chutes": {
   "api": "https://llm.chutes.ai/v1",
   "models": {
    "Nemotron-3-Nano-Omni-30B-TEE": {
     "context_window": 131072
    },
    "unsloth/Mistral-Nemo-Instruct-2407-TEE": {
     "context_window": 131072,
     "max_output": 131072
    },
    "google/gemma-4-31B-turbo-TEE": {
     "context_window": 131072,
     "max_output": 65536
    },
    "Qwen/Qwen3-32B-TEE": {
     "context_window": 40960,
     "max_output": 40960
    },
    "Qwen/Qwen3.6-27B-TEE": {
     "context_window": 262144,
     "max_output": 65536
    },
    "Qwen/Qwen3-235B-A22B-Thinking-2507-TEE": {
     "context_window": 262144,
     "max_output": 262144
    },
    "Qwen/Qwen3.8-27B-TEE": {
     "context_window": 262144,
     "max_output": 65536
    },
    "Qwen/Qwen3.5-397B-A17B-TEE": {
     "context_window": 262144,
     "max_output": 65536
    },
    "deepseek-ai/DeepSeek-V4-Flash-0731-TEE": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "deepseek-ai/DeepSeek-V3.2-TEE": {
     "context_window": 131072,
     "max_output": 65536
    },
    "moonshotai/Kimi-K3-TEE": {
     "context_window": 1048576,
     "max_output": 65535
    },
    "moonshotai/Kimi-K2.6-TEE": {
     "context_window": 262144,
     "max_output": 65535
    },
    "zai-org/GLM-5.2-TEE": {
     "context_window": 1048576,
     "max_output": 65535
    },
    "zai-org/GLM-5.1-TEE": {
     "context_window": 202752,
     "max_output": 65535
    }
   }
  },
  "edenai": {
   "api": "https://api.edenai.run/v3",
   "models": {
    "deepinfra/nemotron-3-ultra-550b-a55b": {
     "context_window": 262144,
     "max_output": 128000
    },
    "deepinfra/meta-models/Muse-Glimmer-30B": {
     "context_window": 131072,
     "max_output": 131072
    },
    "deepinfra/tencent/Hy3": {
     "context_window": 262144,
     "max_output": 128000
    },
    "deepinfra/tencent/Hy4-preview": {
     "context_window": 1048576,
     "max_output": 64000
    },
    "deepinfra/meta-llama/Llama-Guard-3-8B": {
     "context_window": 131072,
     "max_output": 4096
    },
    "deepinfra/meta-llama/Llama-3.2-11B-Vision-Instruct": {
     "context_window": 131072,
     "max_output": 4096
    },
    "deepinfra/meta-llama/Llama-3.3-70B-Instruct": {
     "context_window": 131072,
     "max_output": 4096
    },
    "deepinfra/thinkingmachines/Inkling-Small": {
     "context_window": 524288,
     "max_output": 1048576
    },
    "deepinfra/thinkingmachines/Inkling": {
     "context_window": 524288,
     "max_output": 1048576
    },
    "deepinfra/google/gemma-3-27b-it": {
     "context_window": 131072,
     "max_output": 131072
    },
    "deepinfra/google/gemma-3-12b-it": {
     "context_window": 131072,
     "max_output": 131072
    },
    "deepinfra/google/gemma-3-4b-it": {
     "context_window": 131072,
     "max_output": 131072
    },
    "deepinfra/deepseek-ai/DeepSeek-V4-Flash-0731": {
     "context_window": 1048576,
     "max_output": 384000
    },
    "deepinfra/deepseek-ai/DeepSeek-R1": {
     "context_window": 163840,
     "max_output": 32768
    },
    "deepinfra/deepseek-ai/DeepSeek-V4-Pro-0813": {
     "context_window": 1048576,
     "max_output": 384000
    },
    "deepinfra/deepseek-ai/DeepSeek-V4.1-Flash": {
     "context_window": 1048576,
     "max_output": 384000
    },
    "deepinfra/deepseek-ai/DeepSeek-V3": {
     "context_window": 163840,
     "max_output": 8192
    },
    "deepinfra/deepseek-ai/DeepSeek-V3-0324": {
     "context_window": 163840,
     "max_output": 163840
    },
    "deepinfra/stepfun-ai/Step-3.7-Flash": {
     "context_window": 262144,
     "max_output": 256000
    },
    "deepinfra/stepfun-ai/Step-3.5-Flash": {
     "context_window": 262144,
     "max_output": 256000
    },
    "deepinfra/moonshotai/Kimi-K2.5": {
     "context_window": 262144,
     "max_output": 262144
    },
    "deepinfra/zai-org/GLM-4.7-Flash": {
     "context_window": 202752,
     "max_output": 131072
    },
    "deepinfra/nvidia/Nemotron-3-Nano-30B-A3B": {
     "context_window": 262144,
     "max_output": 262144
    },
    "deepinfra/nvidia/Llama-3.1-Nemotron-70B-Instruct": {
     "context_window": 131072,
     "max_output": 8192
    },
    "deepinfra/ByteDance/Seed-2.0-code": {
     "context_window": 256000,
     "max_output": 131072
    },
    "deepinfra/ByteDance/Seed-2.0-mini": {
     "context_window": 256000,
     "max_output": 32000
    },
    "deepinfra/openai/gpt-oss-20b": {
     "context_window": 131072,
     "max_output": 32768
    },
    "deepinfra/openai/gpt-oss-120b": {
     "context_window": 131072,
     "max_output": 32768
    },
    "cerebras/gpt-oss-120b": {
     "context_window": 131072,
     "max_output": 32768
    },
    "groq/openai/gpt-oss-20b": {
     "context_window": 131072,
     "max_output": 32768
    },
    "groq/openai/gpt-oss-safeguard-20b": {
     "context_window": 131072,
     "max_output": 131072
    },
    "groq/openai/gpt-oss-120b": {
     "context_window": 131072,
     "max_output": 32768
    },
    "zai/glm-4.6v": {
     "context_window": 131072,
     "max_output": 32768
    },
    "zai/glm-5v-turbo": {
     "context_window": 202752,
     "max_output": 131072
    },
    "zai/glm-5.3-flash": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "zai/glm-4.6": {
     "context_window": 202752,
     "max_output": 131072
    },
    "zai/glm-5": {
     "context_window": 202752,
     "max_output": 131072
    },
    "zai/glm-4.7": {
     "context_window": 202752,
     "max_output": 131072
    },
    "zai/glm-5.2": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "zai/glm-5.1": {
     "context_window": 202752,
     "max_output": 131072
    },
    "zai/glm-5-turbo": {
     "context_window": 202752,
     "max_output": 131072
    },
    "zai/glm-5.3": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "anthropic/claude-opus-latest": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-opus-4-5": {
     "context_window": 200000,
     "max_output": 64000
    },
    "anthropic/claude-opus-5-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-fable-5-1": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-sonnet-latest": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-opus-4-5-20251101": {
     "context_window": 200000,
     "max_output": 64000
    },
    "anthropic/claude-opus-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-fable-latest": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-fable-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-opus-4-8": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-sonnet-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-opus-4-6": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-sonnet-4-6": {
     "context_window": 1000000,
     "max_output": 64000
    },
    "anthropic/claude-sonnet-5-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-opus-4-7": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "cohere/command-r-08-2024": {
     "context_window": 128000,
     "max_output": 4000
    },
    "cohere/command-a-03-2025": {
     "context_window": 288000,
     "max_output": 8000
    },
    "cohere/command-r7b-12-2024": {
     "context_window": 132000,
     "max_output": 4000
    },
    "cohere/command-r-plus-08-2024": {
     "context_window": 128000,
     "max_output": 4000
    },
    "cohere/c4ai-aya-expanse-32b": {
     "context_window": 128000,
     "max_output": 4000
    },
    "deepseek/deepseek-v4-flash-vision-exp": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "deepseek/deepseek-chat": {
     "context_window": 131072,
     "max_output": 384000
    },
    "deepseek/deepseek-v4-pro": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "deepseek/deepseek-v4-flash": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "databricks/databricks-inkling": {
     "context_window": 1000000,
     "max_output": 1048576
    },
    "databricks/databricks-gpt-oss-20b": {
     "context_window": 131072,
     "max_output": 32768
    },
    "databricks/databricks-deepseek-v4-flash-0731": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "databricks/databricks-gpt-oss-120b@eu": {
     "context_window": 131072,
     "max_output": 32768
    },
    "databricks/databricks-gpt-oss-120b": {
     "context_window": 131072,
     "max_output": 32768
    },
    "databricks/databricks-deepseek-v4-pro-0813": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "databricks/databricks-gpt-oss-20b@eu": {
     "context_window": 131072,
     "max_output": 32768
    },
    "tencent/step-5-preview": {
     "context_window": 1000000,
     "max_output": 1000000
    },
    "tencent/deepseek-v4-pro-0813": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "tencent/hy3": {
     "context_window": 256000,
     "max_output": 128000
    },
    "tencent/hy4-preview": {
     "context_window": 1000000,
     "max_output": 64000
    },
    "together_ai/meta-models/Muse-Glimmer-30B": {
     "context_window": 131072,
     "max_output": 131072
    },
    "together_ai/thinkingmachines/Inkling": {
     "context_window": 524288,
     "max_output": 1048576
    },
    "together_ai/deepseek-ai/DeepSeek-V4-Flash-0731": {
     "context_window": 1048576,
     "max_output": 384000
    },
    "together_ai/deepseek-ai/DeepSeek-V4-Pro-0813": {
     "context_window": 1048576,
     "max_output": 384000
    },
    "together_ai/deepseek-ai/DeepSeek-V4.1-Flash": {
     "context_window": 1048576,
     "max_output": 384000
    },
    "together_ai/openai/gpt-oss-120b": {
     "context_window": 131072,
     "max_output": 32768
    },
    "azure/gpt-5.2-codex": {
     "context_window": 272000,
     "max_output": 128000
    },
    "azure/gpt-5.1-codex": {
     "context_window": 272000,
     "max_output": 128000
    },
    "azure/gpt-5.1-codex-max": {
     "context_window": 272000,
     "max_output": 128000
    },
    "azure/gpt-5.1-codex-mini": {
     "context_window": 272000,
     "max_output": 128000
    },
    "flexai/Step-3.7-Flash": {
     "context_window": 262144,
     "max_output": 256000
    },
    "flexai/DeepSeek-V4-Flash-0731": {
     "context_window": 1048576,
     "max_output": 384000
    },
    "flexai/DeepSeek-V4.1-Flash": {
     "context_window": 1048576,
     "max_output": 384000
    },
    "flexai/gpt-oss-20b": {
     "context_window": 131072,
     "max_output": 32768
    },
    "flexai/gpt-oss-120b": {
     "context_window": 131072,
     "max_output": 32768
    },
    "google/gemini-flash-latest": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemini-3.1-flash-image-preview": {
     "context_window": 65536,
     "max_output": 65536
    },
    "google/gemini-2.5-flash-image": {
     "context_window": 32768,
     "max_output": 32768
    },
    "google/gemini-3.6-flash": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemini-3-pro-image-preview": {
     "context_window": 65536,
     "max_output": 32768
    },
    "google/gemini-3.5-flash-lite": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemini-3.1-flash-image": {
     "context_window": 65536,
     "max_output": 32768
    },
    "google/gemini-3.1-pro-preview": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemini-3.5-flash": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemini-3-pro-image": {
     "context_window": 65536,
     "max_output": 32768
    },
    "google/gemini-3.1-flash-lite-image": {
     "context_window": 65536,
     "max_output": 4096
    },
    "google/gemini-3.7-flash": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemini-3.1-pro-preview-customtools": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemini-3-flash-preview": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemini-pro-latest": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemini-3.8-flash": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemini-3.1-flash-lite-preview": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemini-3.1-flash-lite": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "xai/grok-latest": {
     "context_window": 500000,
     "max_output": 500000
    },
    "xai/grok-4.7": {
     "context_window": 500000,
     "max_output": 500000
    },
    "xai/grok-4.3": {
     "context_window": 1000000,
     "max_output": 30000
    },
    "xai/grok-4.20-0309-reasoning": {
     "context_window": 1000000,
     "max_output": 30000
    },
    "xai/grok-4.5": {
     "context_window": 500000,
     "max_output": 500000
    },
    "xai/grok-4.20-0309-non-reasoning": {
     "context_window": 1000000,
     "max_output": 30000
    },
    "xai/grok-build-0.1": {
     "context_window": 256000,
     "max_output": 256000
    },
    "xai/grok-4.6": {
     "context_window": 500000,
     "max_output": 500000
    },
    "nebius/google/gemma-3-27b-it": {
     "context_window": 110000,
     "max_output": 131072
    },
    "nebius/deepseek-ai/DeepSeek-V4-Flash-0731": {
     "context_window": 1024000,
     "max_output": 384000
    },
    "nebius/deepseek-ai/DeepSeek-V4-Pro-0813": {
     "context_window": 979000,
     "max_output": 384000
    },
    "nebius/deepseek-ai/DeepSeek-V4.1-Flash": {
     "context_window": 1048000,
     "max_output": 384000
    },
    "nebius/nvidia/nemotron-3-super-120b-a12b": {
     "context_window": 262144,
     "max_output": 262144
    },
    "nebius/nvidia/Nemotron-3-Ultra-550b-a55b": {
     "context_window": 1048576,
     "max_output": 128000
    },
    "nebius/openai/gpt-oss-120b": {
     "context_window": 131072,
     "max_output": 32768
    },
    "scaleway/gemma-3-27b-it": {
     "context_window": 40000,
     "max_output": 131072
    },
    "scaleway/deepseek-v4-flash-0731": {
     "context_window": 256000,
     "max_output": 384000
    },
    "scaleway/llama-3.3-70b-instruct": {
     "context_window": 128000,
     "max_output": 4096
    },
    "scaleway/gpt-oss-120b": {
     "context_window": 128000,
     "max_output": 32768
    },
    "ionos/meta-llama/Llama-3.3-70B-Instruct": {
     "context_window": 128000,
     "max_output": 4096
    },
    "ionos/openai/gpt-oss-120b": {
     "context_window": 131072,
     "max_output": 32768
    },
    "vertex/gemini-flash-latest": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "vertex/gemini-2.5-flash-image": {
     "context_window": 32768,
     "max_output": 32768
    },
    "vertex/gemini-3.1-flash-lite@eu": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "vertex/gemini-3.5-flash-lite@eu": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "vertex/gemini-3.6-flash@eu": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "vertex/gemini-3.6-flash": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "vertex/gemini-3.5-flash-lite": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "vertex/gemini-3.1-flash-image": {
     "context_window": 131072,
     "max_output": 32768
    },
    "vertex/gemini-3.1-pro-preview": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "vertex/gemini-3.5-flash": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "vertex/gemini-3-pro-image": {
     "context_window": 65536,
     "max_output": 32768
    },
    "vertex/gemini-3.7-flash@us": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "vertex/gemini-3.7-flash@eu": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "vertex/gemini-3.1-flash-lite-image": {
     "context_window": 65536,
     "max_output": 4096
    },
    "vertex/gemini-3.8-flash@eu": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "vertex/gemini-3.7-flash": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "vertex/gemini-3.6-flash@us": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "vertex/gemini-3.5-flash-lite@us": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "vertex/gemini-3-flash-preview": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "vertex/gemini-3.1-flash-lite@us": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "vertex/gemini-pro-latest": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "vertex/gemini-3.8-flash": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "vertex/gemini-3.5-flash@eu": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "vertex/gemini-3.8-flash@us": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "vertex/gemini-3.5-flash@us": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "vertex/gemini-3.1-flash-lite": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "greenference/gpt-oss-20b": {
     "context_window": 32768,
     "max_output": 32768
    },
    "perplexityai/sonar-pro": {
     "context_window": 200000,
     "max_output": 8192
    },
    "perplexityai/sonar-deep-research": {
     "context_window": 128000,
     "max_output": 32768
    },
    "perplexityai/sonar": {
     "context_window": 127072,
     "max_output": 4096
    },
    "perplexityai/sonar-reasoning-pro": {
     "context_window": 128000,
     "max_output": 4096
    },
    "cloudflare/@cf/meta/llama-guard-3-8b": {
     "context_window": 131072,
     "max_output": 4096
    },
    "cloudflare/@cf/aisingapore/gemma-sea-lion-v4-27b-it": {
     "context_window": 128000,
     "max_output": 128000
    },
    "cloudflare/@cf/deepseek-ai/deepseek-v4-flash-0731": {
     "context_window": 1048576,
     "max_output": 384000
    },
    "cloudflare/@cf/deepseek-ai/deepseek-v4-pro-0813": {
     "context_window": 1048576,
     "max_output": 384000
    },
    "cloudflare/@cf/zai-org/glm-4.7-flash": {
     "context_window": 131072,
     "max_output": 131072
    },
    "cloudflare/@cf/qwen/qwen2.5-coder-32b-instruct": {
     "context_window": 32768,
     "max_output": 8192
    },
    "cloudflare/@cf/openai/gpt-oss-20b": {
     "context_window": 128000,
     "max_output": 32768
    },
    "cloudflare/@cf/openai/gpt-oss-120b": {
     "context_window": 128000,
     "max_output": 32768
    },
    "minimax/MiniMax-M3": {
     "context_window": 524288,
     "max_output": 512000
    },
    "minimax/MiniMax-M2.1": {
     "context_window": 204800,
     "max_output": 131072
    },
    "minimax/MiniMax-M2.5": {
     "context_window": 204800,
     "max_output": 131072
    },
    "minimax/MiniMax-M2.7": {
     "context_window": 204800,
     "max_output": 131072
    },
    "minimax/MiniMax-M2": {
     "context_window": 204800,
     "max_output": 131072
    },
    "tensorx/deepseek/deepseek-v4-flash-0731": {
     "context_window": 1048576,
     "max_output": 384000
    },
    "tensorx/deepseek/deepseek-v4.1-flash": {
     "context_window": 1048576,
     "max_output": 384000
    },
    "tensorx/deepseek/deepseek-v4-pro-0813": {
     "context_window": 1048576,
     "max_output": 384000
    },
    "tensorx/moonshotai/kimi-k2.5": {
     "context_window": 262144,
     "max_output": 262144
    },
    "amazon/google.gemma-3-12b-it": {
     "context_window": 128000,
     "max_output": 131072
    },
    "amazon/google.gemma-3-4b-it": {
     "context_window": 128000,
     "max_output": 131072
    },
    "amazon/openai.gpt-oss-safeguard-20b@us": {
     "context_window": 128000,
     "max_output": 131072
    },
    "amazon/openai.gpt-oss-safeguard-20b": {
     "context_window": 128000,
     "max_output": 131072
    },
    "amazon/amazon.nova-lite-v1:0@us": {
     "context_window": 300000,
     "max_output": 10000
    },
    "amazon/mistral.voxtral-mini-3b-2507@us": {
     "context_window": 128000,
     "max_output": 32768
    },
    "amazon/amazon.nova-micro-v1:0": {
     "context_window": 128000,
     "max_output": 10000
    },
    "amazon/amazon.nova-pro-v1:0": {
     "context_window": 300000,
     "max_output": 10000
    },
    "amazon/mistral.voxtral-small-24b-2507": {
     "context_window": 128000,
     "max_output": 32768
    },
    "amazon/amazon.nova-lite-v1:0": {
     "context_window": 300000,
     "max_output": 10000
    },
    "amazon/mistral.voxtral-small-24b-2507@us": {
     "context_window": 128000,
     "max_output": 32768
    },
    "amazon/google.gemma-3-12b-it@us": {
     "context_window": 128000,
     "max_output": 131072
    },
    "amazon/google.gemma-3-27b-it": {
     "context_window": 128000,
     "max_output": 131072
    },
    "amazon/google.gemma-3-27b-it@us": {
     "context_window": 128000,
     "max_output": 131072
    },
    "amazon/mistral.pixtral-large-2502-v1:0": {
     "context_window": 128000,
     "max_output": 8192
    },
    "amazon/amazon.nova-micro-v1:0@us": {
     "context_window": 128000,
     "max_output": 10000
    },
    "amazon/zai.glm-4.7-flash@us": {
     "context_window": 203000,
     "max_output": 131072
    },
    "amazon/moonshotai.kimi-k2.5": {
     "context_window": 262144,
     "max_output": 262144
    },
    "amazon/amazon.nova-pro-v1:0@us": {
     "context_window": 300000,
     "max_output": 10000
    },
    "amazon/mistral.pixtral-large-2502-v1:0@us": {
     "context_window": 128000,
     "max_output": 8192
    },
    "amazon/zai.glm-4.7-flash": {
     "context_window": 203000,
     "max_output": 131072
    },
    "amazon/moonshot.kimi-k2-thinking": {
     "context_window": 256000,
     "max_output": 262144
    },
    "amazon/google.gemma-3-4b-it@us": {
     "context_window": 128000,
     "max_output": 131072
    },
    "amazon/mistral.voxtral-mini-3b-2507": {
     "context_window": 128000,
     "max_output": 32768
    },
    "ovhcloud/gpt-oss-20b": {
     "context_window": 131072,
     "max_output": 32768
    },
    "ovhcloud/gpt-oss-120b": {
     "context_window": 131072,
     "max_output": 32768
    },
    "fireworks_ai/gpt-oss-120b": {
     "context_window": 131072,
     "max_output": 32768
    },
    "fireworks_ai/accounts/fireworks/models/inkling": {
     "context_window": 1048576,
     "max_output": 1048576
    },
    "fireworks_ai/accounts/fireworks/models/gpt-oss-120b": {
     "context_window": 131072,
     "max_output": 32768
    },
    "mistral/codestral-latest": {
     "context_window": 256000,
     "max_output": 4096
    },
    "mistral/mistral-large-latest": {
     "context_window": 262144,
     "max_output": 262144
    },
    "mistral/mistral-small-latest": {
     "context_window": 262144,
     "max_output": 256000
    },
    "mistral/devstral-medium-latest": {
     "context_window": 262144,
     "max_output": 262144
    },
    "mistral/devstral-2512": {
     "context_window": 262144,
     "max_output": 262144
    },
    "mistral/mistral-medium-2505": {
     "context_window": 131072,
     "max_output": 131072
    },
    "mistral/magistral-medium-latest": {
     "context_window": 262144,
     "max_output": 16384
    },
    "mistral/mistral-small-2603": {
     "context_window": 262144,
     "max_output": 256000
    },
    "mistral/mistral-large-2512": {
     "context_window": 262144,
     "max_output": 262144
    },
    "mistral/voxtral-small-latest": {
     "context_window": 32768,
     "max_output": 32000
    },
    "mistral/mistral-medium-2604": {
     "context_window": 262144,
     "max_output": 262144
    },
    "mistral/mistral-medium-latest": {
     "context_window": 262144,
     "max_output": 262144
    },
    "qwen/qwen3-vl-235b-a22b-instruct": {
     "context_window": 131072,
     "max_output": 32768
    },
    "qwen/qwq-plus": {
     "context_window": 131072,
     "max_output": 8192
    },
    "qwen/qwen3.8-27b": {
     "context_window": 1000000,
     "max_output": 32768
    },
    "qwen/qwen3-vl-235b-a22b-thinking": {
     "context_window": 131072,
     "max_output": 32768
    },
    "qwen/qwen3.8-2.4t-a95b": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "qwen/deepseek-v4-flash-0731": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "qwen/qwen3-235b-a22b-instruct-2507": {
     "context_window": 131072,
     "max_output": 16384
    },
    "qwen/qwen-max": {
     "context_window": 32768,
     "max_output": 8192
    },
    "qwen/qwen3-next-80b-a3b-thinking": {
     "context_window": 131072,
     "max_output": 32768
    },
    "qwen/qwen3.8-max": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "qwen/qwen3-coder-next": {
     "context_window": 262144,
     "max_output": 65536
    },
    "qwen/deepseek-v4.1-flash": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "qwen/qwen3-coder-next@eu": {
     "context_window": 262144,
     "max_output": 65536
    },
    "qwen/qwen3-max": {
     "context_window": 262144,
     "max_output": 65536
    },
    "qwen/qwen3-coder-480b-a35b-instruct": {
     "context_window": 262144,
     "max_output": 65536
    },
    "qwen/qwen3-coder-30b-a3b-instruct": {
     "context_window": 262144,
     "max_output": 65536
    },
    "qwen/qwen3.8-omni-flash": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "qwen/qwen-vl-max": {
     "context_window": 131072,
     "max_output": 8192
    },
    "qwen/qwen3-max@eu": {
     "context_window": 262144,
     "max_output": 65536
    },
    "qwen/qwen3-next-80b-a3b-instruct": {
     "context_window": 131072,
     "max_output": 32768
    },
    "qwen/qwen-vl-plus": {
     "context_window": 131072,
     "max_output": 8192
    },
    "qwen/qwen3-coder-flash": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "qwen/deepseek-v4-pro-0813": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "qwen/qwen3-coder-plus": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "qwen/qwen3.8-flash": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "qwen/qwen3.8-max-0902": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "openai/gpt-5.4": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-5.4-pro": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-3.5-turbo": {
     "context_window": 16385,
     "max_output": 4096
    },
    "openai/gpt-5.5-pro": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-5.4-nano": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-4o": {
     "context_window": 128000,
     "max_output": 16384
    },
    "openai/gpt-5-mini": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-5.2-pro": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/o4-mini": {
     "context_window": 200000,
     "max_output": 100000
    },
    "openai/o3-mini": {
     "context_window": 200000,
     "max_output": 100000
    },
    "openai/gpt-4": {
     "context_window": 8191,
     "max_output": 8192
    },
    "openai/gpt-5.3-codex": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-4.1-nano": {
     "context_window": 1047576,
     "max_output": 32768
    },
    "openai/gpt-5-nano": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/o1": {
     "context_window": 200000,
     "max_output": 100000
    },
    "openai/gpt-latest": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-5-pro": {
     "context_window": 400000,
     "max_output": 272000
    },
    "openai/gpt-6.1-sol": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-4o-2024-08-06": {
     "context_window": 128000,
     "max_output": 16384
    },
    "openai/gpt-6-astra": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-5.1": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-4o-mini": {
     "context_window": 128000,
     "max_output": 16384
    },
    "openai/o3-pro": {
     "context_window": 200000,
     "max_output": 100000
    },
    "openai/gpt-5.4-mini": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-5.6-luna": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-5.2": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-5.5": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-4.1": {
     "context_window": 1047576,
     "max_output": 32768
    },
    "openai/gpt-4o-2024-11-20": {
     "context_window": 128000,
     "max_output": 16384
    },
    "openai/gpt-mini-latest": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-4.1-mini": {
     "context_window": 1047576,
     "max_output": 32768
    },
    "openai/gpt-6-luna": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-5.6-terra": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-4-turbo": {
     "context_window": 128000,
     "max_output": 4096
    },
    "openai/o3": {
     "context_window": 200000,
     "max_output": 100000
    },
    "openai/gpt-5": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-5.6-sol": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-6-sol": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/o1-pro": {
     "context_window": 200000,
     "max_output": 100000
    },
    "openai/gpt-pro-latest": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "infomaniak/mistralai/Ministral-3-14B-Instruct-2512": {
     "context_window": 100000,
     "max_output": 262144
    },
    "moonshot/kimi-k3": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "moonshot/kimi-k2.7-code-highspeed": {
     "context_window": 262144,
     "max_output": 262144
    },
    "moonshot/kimi-k2.6": {
     "context_window": 262144,
     "max_output": 262144
    },
    "moonshot/kimi-k2.7-code": {
     "context_window": 262144,
     "max_output": 262144
    }
   }
  },
  "stepfun": {
   "api": "https://api.stepfun.com/v1",
   "models": {
    "step-1-32k": {
     "context_window": 32768,
     "max_output": 32768
    },
    "step-5-preview": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "step-3.5-flash-2603": {
     "context_window": 256000,
     "max_output": 256000
    },
    "step-2-16k": {
     "context_window": 16384,
     "max_output": 8192
    },
    "step-3.5-flash": {
     "context_window": 256000,
     "max_output": 256000
    },
    "step-3.7-flash": {
     "context_window": 256000,
     "max_output": 256000
    }
   }
  },
  "hpc-ai": {
   "api": "https://api.hpc-ai.com/inference/v1",
   "models": {
    "anthropic/claude-opus-4.7": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "deepseek/deepseek-v4-pro": {
     "context_window": 1002000,
     "max_output": 128000
    },
    "deepseek/deepseek-v4-flash": {
     "context_window": 1048576,
     "max_output": 128000
    },
    "moonshotai/kimi-k2.5": {
     "context_window": 256000,
     "max_output": 256000
    },
    "moonshotai/kimi-k2.7-code": {
     "context_window": 256000,
     "max_output": 256000
    },
    "zai-org/glm-5.2": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "zai-org/glm-5.1": {
     "context_window": 202000,
     "max_output": 202000
    },
    "minimax/minimax-m2.5": {
     "context_window": 196000,
     "max_output": 195000
    },
    "openai/gpt-5.5": {
     "context_window": 1050000,
     "max_output": 128000
    }
   }
  },
  "v0": {
   "api": null,
   "models": {
    "v0-1.5-lg": {
     "context_window": 512000,
     "max_output": 32000
    },
    "v0-1.5-md": {
     "context_window": 128000,
     "max_output": 32000
    },
    "v0-1.0-md": {
     "context_window": 128000,
     "max_output": 32000
    }
   }
  },
  "tencent-coding-plan": {
   "api": "https://api.lkeap.cloud.tencent.com/coding/v3",
   "models": {
    "hunyuan-2.0-thinking": {
     "context_window": 131072,
     "max_output": 16384
    },
    "glm-5": {
     "context_window": 202752,
     "max_output": 16384
    },
    "minimax-m2.5": {
     "context_window": 204800,
     "max_output": 32768
    },
    "hunyuan-2.0-instruct": {
     "context_window": 131072,
     "max_output": 16384
    },
    "kimi-k2.5": {
     "context_window": 262144,
     "max_output": 32768
    },
    "tc-code-latest": {
     "context_window": 131072,
     "max_output": 16384
    },
    "hunyuan-turbos": {
     "context_window": 131072,
     "max_output": 16384
    },
    "hunyuan-t1": {
     "context_window": 131072,
     "max_output": 16384
    }
   }
  },
  "tempr": {
   "api": "https://api.temprhq.io/v1",
   "models": {
    "xiaomi-mimo/mimo-v2.6-pro": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "xiaomi-mimo/mimo-v2.6-pro-ultraspeed": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "xiaomi-mimo/mimo-v2.6-flash": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "cerebras/qwen-3.8-27b": {
     "context_window": 131072,
     "max_output": 40960
    },
    "cerebras/gpt-oss-120b": {
     "context_window": 131072,
     "max_output": 40960
    },
    "groq/allam-2-7b": {
     "context_window": 4096,
     "max_output": 4096
    },
    "groq/qwen/qwen3.8-27b": {
     "context_window": 131042,
     "max_output": 16384
    },
    "groq/openai/gpt-oss-20b": {
     "context_window": 131072,
     "max_output": 65536
    },
    "groq/openai/gpt-oss-120b": {
     "context_window": 131072,
     "max_output": 65536
    },
    "zai/glm-4.6v": {
     "context_window": 128000,
     "max_output": 32768
    },
    "zai/glm-4.5": {
     "context_window": 131072,
     "max_output": 98304
    },
    "zai/glm-5v-turbo": {
     "context_window": 200000,
     "max_output": 131072
    },
    "zai/glm-5.3-flash": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "zai/glm-4.6": {
     "context_window": 204800,
     "max_output": 131072
    },
    "zai/glm-5": {
     "context_window": 204800,
     "max_output": 131072
    },
    "zai/glm-4.6v-flash": {
     "context_window": 128000,
     "max_output": 32768
    },
    "zai/glm-4.5v": {
     "context_window": 64000,
     "max_output": 16384
    },
    "zai/glm-5.3-flashx": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "zai/glm-4.7-flash": {
     "context_window": 200000,
     "max_output": 131072
    },
    "zai/glm-4.7": {
     "context_window": 204800,
     "max_output": 131072
    },
    "zai/glm-4.5-flash": {
     "context_window": 131072,
     "max_output": 98304
    },
    "zai/glm-5.2": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "zai/glm-5.1": {
     "context_window": 200000,
     "max_output": 131072
    },
    "zai/glm-4.7-flashx": {
     "context_window": 200000,
     "max_output": 131072
    },
    "zai/glm-5-turbo": {
     "context_window": 200000,
     "max_output": 131072
    },
    "zai/glm-4.5-air": {
     "context_window": 131072,
     "max_output": 98304
    },
    "zai/glm-5.3": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "anthropic/claude-haiku-4-5": {
     "context_window": 200000,
     "max_output": 64000
    },
    "anthropic/claude-opus-4-5": {
     "context_window": 200000,
     "max_output": 64000
    },
    "anthropic/claude-sonnet-4-5": {
     "context_window": 200000,
     "max_output": 64000
    },
    "anthropic/claude-fable-5-1": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-opus-4-5-20251101": {
     "context_window": 200000,
     "max_output": 64000
    },
    "anthropic/claude-opus-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-fable-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-opus-4-8": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-sonnet-4-5-20250929": {
     "context_window": 200000,
     "max_output": 64000
    },
    "anthropic/claude-sonnet-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-opus-4-6": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-haiku-4-5-20251001": {
     "context_window": 200000,
     "max_output": 64000
    },
    "anthropic/claude-sonnet-4-6": {
     "context_window": 1000000,
     "max_output": 64000
    },
    "anthropic/claude-opus-4-7": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "deepseek/deepseek-flash": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "deepseek/deepseek-v4-pro": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "google/gemini-flash-latest": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemma-4-31b-it": {
     "context_window": 262144,
     "max_output": 32768
    },
    "google/gemini-flash-lite-latest": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemini-embedding-2": {
     "context_window": 8192
    },
    "google/gemini-3.6-flash": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemma-4-26b-a4b-it": {
     "context_window": 262144,
     "max_output": 32768
    },
    "google/gemini-3.5-flash-lite": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemini-3.1-pro-preview": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemini-3.5-flash": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemini-3.7-flash": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemini-3.1-pro-preview-customtools": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemini-3-flash-preview": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemini-3.8-flash": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "google/gemini-embedding-001": {
     "context_window": 2048
    },
    "google/gemini-3.1-flash-lite": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "xai/grok-4.7": {
     "context_window": 500000,
     "max_output": 500000
    },
    "xai/grok-4.3": {
     "context_window": 1000000,
     "max_output": 30000
    },
    "xai/grok-4.20-0309-reasoning": {
     "context_window": 1000000,
     "max_output": 30000
    },
    "xai/grok-4.5": {
     "context_window": 500000,
     "max_output": 500000
    },
    "xai/grok-4.20-0309-non-reasoning": {
     "context_window": 1000000,
     "max_output": 30000
    },
    "xai/grok-build-0.1": {
     "context_window": 256000,
     "max_output": 256000
    },
    "xai/grok-4.6": {
     "context_window": 500000,
     "max_output": 500000
    },
    "minimax/MiniMax-M3": {
     "context_window": 1048576,
     "max_output": 512000
    },
    "minimax/MiniMax-M2.7": {
     "context_window": 204800,
     "max_output": 131072
    },
    "minimax/MiniMax-M2.7-highspeed": {
     "context_window": 204800,
     "max_output": 131072
    },
    "mistral/mistral-large-latest": {
     "context_window": 262144,
     "max_output": 262144
    },
    "mistral/mistral-small-latest": {
     "context_window": 256000,
     "max_output": 256000
    },
    "mistral/zai-glm-5-2": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "mistral/mistral-embed": {
     "context_window": 8000,
     "max_output": 3072
    },
    "mistral/mistral-small-2603": {
     "context_window": 256000,
     "max_output": 256000
    },
    "mistral/mistral-large-2512": {
     "context_window": 262144,
     "max_output": 262144
    },
    "mistral/voxtral-small-latest": {
     "context_window": 32000,
     "max_output": 32000
    },
    "mistral/zai-glm-5-3": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "mistral/mistral-medium-2604": {
     "context_window": 262144,
     "max_output": 262144
    },
    "mistral/mistral-medium-latest": {
     "context_window": 262144,
     "max_output": 262144
    },
    "moonshot/kimi-k3": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "moonshot/kimi-k2.7-code-highspeed": {
     "context_window": 262144,
     "max_output": 262144
    },
    "moonshot/kimi-k2.6": {
     "context_window": 262144,
     "max_output": 262144
    },
    "moonshot/kimi-k2.7-code": {
     "context_window": 262144,
     "max_output": 262144
    }
   }
  },
  "inception": {
   "api": "https://api.inceptionlabs.ai/v1/",
   "models": {
    "mercury-edit-2": {
     "context_window": 32000,
     "max_output": 8192
    },
    "mercury-2.5": {
     "context_window": 260000,
     "max_output": 65536
    },
    "mercury-2": {
     "context_window": 128000,
     "max_output": 50000
    }
   }
  },
  "modelis": {
   "api": "https://modelishub.com/v1",
   "models": {
    "gemini-2.5-pro": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "gemini-2.5-flash": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "claude-fable-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "claude-opus-4-8": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "deepseek-v4-pro": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "claude-sonnet-4-6": {
     "context_window": 1000000,
     "max_output": 64000
    },
    "deepseek-v4-flash": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "qwen/qwen3.7-max": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "qwen/qwen3.7-plus": {
     "context_window": 1000000,
     "max_output": 64000
    }
   }
  },
  "opencode": {
   "api": "https://opencode.ai/zen/v1",
   "models": {
    "ling-3.0-flash-fin-free": {
     "context_window": 262144,
     "max_output": 32768
    },
    "gpt-5.4": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "fledge-alpha-free": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "qwen3.6-plus-free": {
     "context_window": 262144,
     "max_output": 65536
    },
    "claude-haiku-4-5": {
     "context_window": 200000,
     "max_output": 64000
    },
    "gpt-5.4-pro": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "mimo-v2-pro-free": {
     "context_window": 1048576,
     "max_output": 64000
    },
    "muse-spark-1.2-contributor-free": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "ling-3.1-flash-free": {
     "context_window": 262144,
     "max_output": 32768
    },
    "muse-spark-1.3": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "glm-5-free": {
     "context_window": 204800,
     "max_output": 131072
    },
    "trinity-large-preview-free": {
     "context_window": 131072,
     "max_output": 131072
    },
    "gpt-5.5-pro": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "grok-4.7": {
     "context_window": 500000,
     "max_output": 500000
    },
    "longcat-2.5-preview-free": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "gpt-5.4-nano": {
     "context_window": 400000,
     "max_output": 128000
    },
    "gpt-5.2-codex": {
     "context_window": 400000,
     "max_output": 128000
    },
    "ling-3.0-tiny-free": {
     "context_window": 262144,
     "max_output": 32768
    },
    "gpt-5.1-codex": {
     "context_window": 400000,
     "max_output": 128000
    },
    "glm-5.3-flash": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "kimi-k2.5-free": {
     "context_window": 262144,
     "max_output": 262144
    },
    "glm-4.7-free": {
     "context_window": 204800,
     "max_output": 131072
    },
    "glm-4.6": {
     "context_window": 204800,
     "max_output": 131072
    },
    "laguna-s-2.1-free": {
     "context_window": 256000,
     "max_output": 32000
    },
    "qwen3.8-max": {
     "context_window": 262144,
     "max_output": 131072
    },
    "kimi-k3": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "gpt-5-codex": {
     "context_window": 400000,
     "max_output": 128000
    },
    "qwen3-coder": {
     "context_window": 262144,
     "max_output": 65536
    },
    "minimax-m3-free": {
     "context_window": 200000,
     "max_output": 32000
    },
    "qwen3.5-plus": {
     "context_window": 262144,
     "max_output": 65536
    },
    "claude-opus-4-5": {
     "context_window": 200000,
     "max_output": 64000
    },
    "glm-5": {
     "context_window": 204800,
     "max_output": 131072
    },
    "deepseek-v4.1-flash": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "gpt-5.3-codex": {
     "context_window": 400000,
     "max_output": 128000
    },
    "minimax-m2.5": {
     "context_window": 204800,
     "max_output": 131072
    },
    "gpt-5-nano": {
     "context_window": 400000,
     "max_output": 128000
    },
    "deepseek-v4-flash-vision-exp": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "kimi-k2.6": {
     "context_window": 262144,
     "max_output": 65536
    },
    "claude-sonnet-4-5": {
     "context_window": 1000000,
     "max_output": 64000
    },
    "claude-opus-5-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "claude-fable-5-1": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "gemini-3.6-flash": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "kimi-k2-thinking": {
     "context_window": 262144,
     "max_output": 262144
    },
    "minimax-m2.5-free": {
     "context_window": 204800,
     "max_output": 131072
    },
    "gpt-5.3-codex-spark": {
     "context_window": 128000,
     "max_output": 128000
    },
    "gpt-6.1-sol": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "gemini-3.5-flash-lite": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "claude-opus-4-1": {
     "context_window": 200000,
     "max_output": 32000
    },
    "gpt-6-astra": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "grok-4.5": {
     "context_window": 500000,
     "max_output": 500000
    },
    "ring-2.6-1t-free": {
     "context_window": 262000,
     "max_output": 66000
    },
    "kimi-k2.5": {
     "context_window": 262144,
     "max_output": 65536
    },
    "longcat-2.0-free": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "gpt-5.1": {
     "context_window": 400000,
     "max_output": 128000
    },
    "claude-opus-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "claude-3-5-haiku": {
     "context_window": 200000,
     "max_output": 8192
    },
    "hy3-preview-free": {
     "context_window": 256000,
     "max_output": 64000
    },
    "gemini-3-flash": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "minimax-m2.7": {
     "context_window": 204800,
     "max_output": 131072
    },
    "gemini-3.5-flash": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "space-bunny-free": {
     "context_window": 1048576,
     "max_output": 524288
    },
    "claude-fable-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "nemotron-3-super-free": {
     "context_window": 204800,
     "max_output": 128000
    },
    "minimax-m2.1-free": {
     "context_window": 204800,
     "max_output": 131072
    },
    "mimo-v2.6-flash-free": {
     "context_window": 200000,
     "max_output": 32000
    },
    "gemini-3-pro": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "nemotron-3-ultra-free": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "claude-sonnet-4": {
     "context_window": 1000000,
     "max_output": 64000
    },
    "muse-spark-1.2": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "gpt-5.4-mini": {
     "context_window": 400000,
     "max_output": 128000
    },
    "glm-4.7": {
     "context_window": 204800,
     "max_output": 131072
    },
    "minimax-m3": {
     "context_window": 512000,
     "max_output": 128000
    },
    "gpt-5.6-luna": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "qwen3.8-flash": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "gpt-5.1-codex-max": {
     "context_window": 400000,
     "max_output": 128000
    },
    "mimo-v2.5-free": {
     "context_window": 200000,
     "max_output": 32000
    },
    "grok-code": {
     "context_window": 256000,
     "max_output": 256000
    },
    "gpt-5.2": {
     "context_window": 400000,
     "max_output": 128000
    },
    "claude-opus-4-8": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "gpt-5.5": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "ling-2.6-flash-free": {
     "context_window": 262100,
     "max_output": 32800
    },
    "claude-sonnet-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "deepseek-v4-flash-free": {
     "context_window": 200000,
     "max_output": 128000
    },
    "hy3-free": {
     "context_window": 190000,
     "max_output": 64000
    },
    "nemotron-3.5-lightning-free": {
     "context_window": 262144,
     "max_output": 262144
    },
    "claude-opus-4-6": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "gemini-3.7-flash": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "glm-5.2": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "kimi-k2": {
     "context_window": 262144,
     "max_output": 262144
    },
    "glm-5.1": {
     "context_window": 204800,
     "max_output": 131072
    },
    "mimo-v2-omni-free": {
     "context_window": 262144,
     "max_output": 64000
    },
    "grok-build-0.1": {
     "context_window": 256000,
     "max_output": 256000
    },
    "ling-3.0-flash-free": {
     "context_window": 262144,
     "max_output": 32768
    },
    "gemini-3.8-flash": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "north-mini-code-free": {
     "context_window": 256000,
     "max_output": 64000
    },
    "gpt-6-luna": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "deepseek-v4-pro": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "claude-sonnet-4-6": {
     "context_window": 1000000,
     "max_output": 64000
    },
    "big-pickle": {
     "context_window": 200000,
     "max_output": 32000
    },
    "claude-sonnet-5-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "qwen3.6-plus": {
     "context_window": 262144,
     "max_output": 65536
    },
    "gpt-5.6-terra": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "mimo-v2-flash-free": {
     "context_window": 262144,
     "max_output": 65536
    },
    "gpt-5.1-codex-mini": {
     "context_window": 400000,
     "max_output": 128000
    },
    "glm-5.3": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "claude-opus-4-7": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "kimi-k2.7-code": {
     "context_window": 262144,
     "max_output": 262144
    },
    "gpt-5": {
     "context_window": 400000,
     "max_output": 128000
    },
    "grok-4.6": {
     "context_window": 500000,
     "max_output": 500000
    },
    "gemini-3.1-pro": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "minimax-m2.1": {
     "context_window": 204800,
     "max_output": 131072
    },
    "gpt-5.6-sol": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "x-preview-f-free": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "muse-spark-1.3-contributor-free": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "deepseek-v4-flash": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "gpt-6-sol": {
     "context_window": 1050000,
     "max_output": 128000
    }
   }
  },
  "kenari": {
   "api": "https://kenari.id/v1",
   "models": {
    "gpt-5-4-mini": {
     "context_window": 400000,
     "max_output": 128000
    },
    "gpt-5-6-luna": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "gemma-4-31b-it": {
     "context_window": 262144,
     "max_output": 32768
    },
    "grok-4-5": {
     "context_window": 500000,
     "max_output": 500000
    },
    "gemini-2-5-flash": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "nemotron-3-nano-30b-a3b": {
     "context_window": 262144,
     "max_output": 262144
    },
    "glm-5-3-flash": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "kimi-k2-7-code": {
     "context_window": 262144,
     "max_output": 262144
    },
    "gpt-5-6-terra": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "gemini-2-5-flash-lite": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "mimo-v2-5": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "grok-build-0-1": {
     "context_window": 256000,
     "max_output": 256000
    },
    "kimi-k3": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "glm-4-7-flash:free": {
     "context_window": 200000,
     "max_output": 131072
    },
    "gpt-image-2": {
     "context_window": 272000,
     "max_output": 16384
    },
    "qwen3-8-max": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "minimax-m2-7-highspeed": {
     "context_window": 204800,
     "max_output": 131072
    },
    "mimo-v2-5-pro": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "nemotron-3-super-120b-a12b": {
     "context_window": 262144,
     "max_output": 262144
    },
    "gemini-3-7-flash": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "step-3-7-flash:free": {
     "context_window": 256000,
     "max_output": 256000
    },
    "kimi-k2-6:free": {
     "context_window": 262144,
     "max_output": 262144
    },
    "gpt-5-6-sol": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "nemotron-3-ultra-550b-a55b": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "gemini-3-1-pro": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "glm-5-2": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "mistral-large:free": {
     "context_window": 262144,
     "max_output": 262144
    },
    "mimo-v2-5:free": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "claude-opus-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "gpt-oss-20b": {
     "context_window": 131072,
     "max_output": 32768
    },
    "minimax-m2-7": {
     "context_window": 204800,
     "max_output": 131072
    },
    "claude-fable-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "hy3:free": {
     "context_window": 256000,
     "max_output": 128000
    },
    "kimi-k2-6": {
     "context_window": 262144,
     "max_output": 262144
    },
    "mistral-medium-3-5:free": {
     "context_window": 262144,
     "max_output": 262144
    },
    "minimax-m3": {
     "context_window": 1048576,
     "max_output": 512000
    },
    "claude-opus-4-8": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "glm-5-3": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "claude-sonnet-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "deepseek-v4-1-flash": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "qwen3-7-plus": {
     "context_window": 1000000,
     "max_output": 64000
    },
    "gemini-3-1-flash-lite": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "hy3": {
     "context_window": 256000,
     "max_output": 128000
    },
    "glm-5-1": {
     "context_window": 200000,
     "max_output": 131072
    },
    "nemotron-3-super-120b-a12b:free": {
     "context_window": 262144,
     "max_output": 262144
    },
    "gpt-5-5": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "grok-imagine-image-2-0": {
     "context_window": 8000
    },
    "deepseek-v4-flash:free": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "grok-4-6": {
     "context_window": 500000,
     "max_output": 500000
    },
    "whisper-large-v3-turbo": {
     "max_output": 448
    },
    "gemini-3-6-flash": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "gemini-3-1-flash-tts": {
     "context_window": 8192,
     "max_output": 16384
    },
    "deepseek-v4-pro": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "claude-sonnet-4-6": {
     "context_window": 1000000,
     "max_output": 64000
    },
    "kimi-k2-7-code:free": {
     "context_window": 262144,
     "max_output": 262144
    },
    "gemini-3-5-flash": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "gpt-oss-120b": {
     "context_window": 131072,
     "max_output": 32768
    },
    "claude-opus-4-7": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "step-3-7-flash": {
     "context_window": 256000,
     "max_output": 256000
    },
    "deepseek-v4-flash": {
     "context_window": 1000000,
     "max_output": 384000
    }
   }
  },
  "kimi-code-plan-global": {
   "api": "https://api.kimi.ai/coding/v1",
   "models": {
    "kimi-for-coding-highspeed": {
     "context_window": 262144,
     "max_output": 32768
    },
    "kimi-for-coding": {
     "context_window": 1048576,
     "max_output": 32768
    },
    "k3-256k": {
     "context_window": 262144,
     "max_output": 131072
    },
    "k3": {
     "context_window": 1048576,
     "max_output": 131072
    }
   }
  },
  "trustedrouter": {
   "api": "https://api.trustedrouter.com/v1",
   "models": {
    "trustedrouter/cheap": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "trustedrouter/synth-code": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "trustedrouter/e2e": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "trustedrouter/zdr": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "trustedrouter/fast": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "trustedrouter/synth": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "trustedrouter/auto": {
     "context_window": 1000000,
     "max_output": 131072
    }
   }
  },
  "wafer.ai": {
   "api": "https://pass.wafer.ai/v1",
   "models": {
    "Kimi-K2.6": {
     "context_window": 262144,
     "max_output": 65536
    },
    "MiniMax-M3": {
     "context_window": 1048576,
     "max_output": 512000
    },
    "GLM-5.1": {
     "context_window": 202752,
     "max_output": 131072
    },
    "GLM-5.2": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "glm5.2-fast": {
     "context_window": 1048576,
     "max_output": 131072
    }
   }
  },
  "zhipuai": {
   "api": "https://open.bigmodel.cn/api/paas/v4",
   "models": {
    "glm-5v-turbo": {
     "context_window": 200000,
     "max_output": 131072
    },
    "glm-5.3-flash": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "glm-5": {
     "context_window": 204800,
     "max_output": 131072
    },
    "glm-5.3-flashx": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "glm-5.2": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "glm-5.1": {
     "context_window": 200000,
     "max_output": 131072
    },
    "glm-5.3": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "glm-4.5-air": {
     "context_window": 131072,
     "max_output": 98304
    },
    "glm-4.7-flashx": {
     "context_window": 200000,
     "max_output": 131072
    },
    "glm-4.5-flash": {
     "context_window": 131072,
     "max_output": 98304
    },
    "glm-4.7": {
     "context_window": 204800,
     "max_output": 131072
    },
    "glm-4.7-flash": {
     "context_window": 200000,
     "max_output": 131072
    },
    "glm-4.5v": {
     "context_window": 64000,
     "max_output": 16384
    },
    "glm-4.6v-flash": {
     "context_window": 128000,
     "max_output": 32768
    },
    "glm-4.6": {
     "context_window": 204800,
     "max_output": 131072
    },
    "glm-4.5": {
     "context_window": 131072,
     "max_output": 98304
    },
    "glm-4.6v": {
     "context_window": 128000,
     "max_output": 32768
    }
   }
  },
  "lynkr": {
   "api": "http://127.0.0.1:8081/v1",
   "models": {
    "lynkr-auto": {
     "context_window": 128000,
     "max_output": 8192
    }
   }
  },
  "meganova": {
   "api": "https://api.meganova.ai/v1",
   "models": {
    "meta-llama/Llama-3.3-70B-Instruct": {
     "context_window": 131072,
     "max_output": 16384
    },
    "XiaomiMiMo/MiMo-V2-Flash": {
     "context_window": 262144,
     "max_output": 32000
    },
    "Qwen/Qwen3.5-Plus": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "Qwen/Qwen3-235B-A22B-Instruct-2507": {
     "context_window": 262000,
     "max_output": 262000
    },
    "Qwen/Qwen2.5-VL-32B-Instruct": {
     "context_window": 16384,
     "max_output": 16384
    },
    "deepseek-ai/DeepSeek-V3.1": {
     "context_window": 164000,
     "max_output": 164000
    },
    "deepseek-ai/DeepSeek-V3.2": {
     "context_window": 164000,
     "max_output": 164000
    },
    "deepseek-ai/DeepSeek-R1-0528": {
     "context_window": 163840,
     "max_output": 64000
    },
    "deepseek-ai/DeepSeek-V3-0324": {
     "context_window": 163840,
     "max_output": 163840
    },
    "deepseek-ai/DeepSeek-V3.2-Exp": {
     "context_window": 164000,
     "max_output": 164000
    },
    "MiniMaxAI/MiniMax-M2.1": {
     "context_window": 196608,
     "max_output": 131072
    },
    "MiniMaxAI/MiniMax-M2.5": {
     "context_window": 204800,
     "max_output": 131072
    },
    "mistralai/Mistral-Nemo-Instruct-2407": {
     "context_window": 131072,
     "max_output": 65536
    },
    "mistralai/Mistral-Small-3.2-24B-Instruct-2506": {
     "context_window": 32768,
     "max_output": 8192
    },
    "moonshotai/Kimi-K2.5": {
     "context_window": 262144,
     "max_output": 262144
    },
    "moonshotai/Kimi-K2-Thinking": {
     "context_window": 262144,
     "max_output": 262144
    },
    "zai-org/GLM-4.7": {
     "context_window": 202752,
     "max_output": 131072
    },
    "zai-org/GLM-5": {
     "context_window": 202752,
     "max_output": 131072
    },
    "zai-org/GLM-4.6": {
     "context_window": 202752,
     "max_output": 131072
    }
   }
  },
  "ovhcloud": {
   "api": "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1",
   "models": {
    "qwen3.8-27b": {
     "context_window": 262144,
     "max_output": 262144
    },
    "qwen3guard-gen-8b": {
     "context_window": 32768,
     "max_output": 16384
    },
    "mistral-7b-instruct-v0.3": {
     "context_window": 65536,
     "max_output": 65536
    },
    "qwen3-coder-30b-a3b-instruct": {
     "context_window": 262144,
     "max_output": 262144
    },
    "qwen3guard-gen-0.6b": {
     "context_window": 32768,
     "max_output": 16384
    },
    "gpt-oss-20b": {
     "context_window": 131072,
     "max_output": 131072
    },
    "qwen3.5-9b": {
     "context_window": 262144,
     "max_output": 262144
    },
    "meta-llama-3_3-70b-instruct": {
     "context_window": 131072,
     "max_output": 131072
    },
    "qwen3.5-397b-a17b": {
     "context_window": 262144,
     "max_output": 262144
    },
    "qwen2.5-vl-72b-instruct": {
     "context_window": 32768,
     "max_output": 32768
    },
    "qwen3.6-27b": {
     "context_window": 262144,
     "max_output": 262144
    },
    "mistral-small-3.2-24b-instruct-2506": {
     "context_window": 131072,
     "max_output": 131072
    },
    "gpt-oss-120b": {
     "context_window": 131072,
     "max_output": 131072
    },
    "mistral-nemo-instruct-2407": {
     "context_window": 65536,
     "max_output": 65536
    }
   }
  },
  "requesty": {
   "api": "https://router.requesty.ai/v1",
   "models": {
    "ring-2.6-1t": {
     "context_window": 262144,
     "max_output": 262144
    },
    "gpt-5.4": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "nemotron-3-ultra-nvfp4": {
     "context_window": 262144,
     "max_output": 262144
    },
    "gpt-6.1-sol@eu": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "claude-haiku-4-5": {
     "context_window": 200000,
     "max_output": 64000
    },
    "gpt-5.4-pro": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "claude-opus-5@eu": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "mimo-v2.6-pro": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "gemma-4-31b-it": {
     "context_window": 262144,
     "max_output": 8192
    },
    "ling-2.6-1t": {
     "context_window": 262144,
     "max_output": 262144
    },
    "gpt-4o-mini@eu": {
     "context_window": 128000,
     "max_output": 16000
    },
    "qwen3.7-max": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "nemotron-3.5-lightning-30b-a3b": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "mimo-v2.5": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "gpt-5.5-pro": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "grok-4.7": {
     "context_window": 500000,
     "max_output": 500000
    },
    "mistral-medium-3-5@eu": {
     "context_window": 262144,
     "max_output": 262144
    },
    "gpt-5.4-nano": {
     "context_window": 400000,
     "max_output": 128000
    },
    "gpt-5@eu": {
     "context_window": 400000,
     "max_output": 128000
    },
    "deepseek-v4-flash-0731@eu": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "seed-2.0-pro": {
     "context_window": 256000,
     "max_output": 256000
    },
    "kimi-k3@eu": {
     "context_window": 1048576,
     "max_output": 262144
    },
    "seed-1.8": {
     "context_window": 256000,
     "max_output": 256000
    },
    "glm-5.3-flash": {
     "context_window": 1000000,
     "max_output": 262144
    },
    "qwen3.5-27b": {
     "context_window": 262144,
     "max_output": 262144
    },
    "mistral-medium-latest@eu": {
     "context_window": 131072,
     "max_output": 131072
    },
    "glm-5.2-fast": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "deepseek-v4-flash-0731": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "deepseek-v4-pro-0813@eu": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "inkling-256k": {
     "context_window": 262144,
     "max_output": 32768
    },
    "muse-glimmer-30b": {
     "context_window": 131072,
     "max_output": 20480
    },
    "claude-opus-4-8@eu": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "qwen3.8-max": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "kimi-k3": {
     "context_window": 1048576,
     "max_output": 262144
    },
    "claude-fable-5@eu": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "nemotron-3-nano-omni@eu": {
     "context_window": 300000,
     "max_output": 300000
    },
    "gpt-4.1@eu": {
     "context_window": 1047576,
     "max_output": 32768
    },
    "gemini-3.1-flash-lite@eu": {
     "context_window": 1048576,
     "max_output": 65535
    },
    "nvidia-nemotron-3-super-120b-a12b": {
     "context_window": 262144,
     "max_output": 262144
    },
    "gemini-3.5-flash-lite@eu": {
     "context_window": 1048576,
     "max_output": 65535
    },
    "claude-opus-4-5": {
     "context_window": 200000,
     "max_output": 64000
    },
    "kimi-k2.7-code@eu": {
     "context_window": 262144,
     "max_output": 262144
    },
    "deepseek-v4.1-flash": {
     "context_window": 1048576,
     "max_output": 393216
    },
    "glm-5.1@eu": {
     "context_window": 200000,
     "max_output": 200000
    },
    "gpt-5.3-codex": {
     "context_window": 400000,
     "max_output": 128000
    },
    "claude-haiku-4-5@eu": {
     "context_window": 200000,
     "max_output": 64000
    },
    "claude-sonnet-4-5@eu": {
     "context_window": 1000000,
     "max_output": 64000
    },
    "laguna-xs.2": {
     "context_window": 32768,
     "max_output": 32768
    },
    "leanstral-1-5@eu": {
     "context_window": 262144,
     "max_output": 32768
    },
    "claude-sonnet-5-5@eu": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "kimi-k2.6": {
     "context_window": 262144,
     "max_output": 262144
    },
    "claude-sonnet-4-5": {
     "context_window": 1000000,
     "max_output": 64000
    },
    "nemotron-3-super-120b-a12b": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "claude-opus-5-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "claude-sonnet-4-6@eu": {
     "context_window": 1000000,
     "max_output": 64000
    },
    "gemini-3.6-flash": {
     "context_window": 1048576,
     "max_output": 65535
    },
    "gpt-5.5@eu": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "ling-3.0-tiny": {
     "context_window": 262144,
     "max_output": 32768
    },
    "claude-opus-5-5@eu": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "gpt-5-mini@eu": {
     "context_window": 200000,
     "max_output": 100000
    },
    "mistral-medium-3-5": {
     "context_window": 262144,
     "max_output": 262144
    },
    "grok-4.3": {
     "context_window": 1000000,
     "max_output": 1000000
    },
    "nemotron-3-ultra-550b-a55b": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "nemotron-3-nano-omni-30b-a3b-reasoning": {
     "context_window": 131072,
     "max_output": 20480
    },
    "gpt-6.1-sol": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "gemma-4-26b-a4b-it": {
     "context_window": 262144,
     "max_output": 262144
    },
    "gemini-3.5-flash-lite": {
     "context_window": 1048576,
     "max_output": 65535
    },
    "gpt-5.4@eu": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "claude-opus-4-1": {
     "context_window": 200000,
     "max_output": 32000
    },
    "grok-4.2-beta": {
     "context_window": 2000000,
     "max_output": 2000000
    },
    "gemini-3.1-flash-image": {
     "context_window": 131072,
     "max_output": 32768
    },
    "nemotron-lightning-3.5-30b-a3b": {
     "context_window": 262144,
     "max_output": 262144
    },
    "gpt-5-nano@eu": {
     "context_window": 200000,
     "max_output": 100000
    },
    "gpt-6-astra": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "gemini-3.1-pro-preview": {
     "context_window": 1048576,
     "max_output": 65535
    },
    "grok-4.5": {
     "context_window": 500000,
     "max_output": 500000
    },
    "seed-2.0-mini": {
     "context_window": 256000,
     "max_output": 256000
    },
    "claude-opus-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "kimi-k2.6@eu": {
     "context_window": 256000,
     "max_output": 128000
    },
    "qwen3.5-2b": {
     "context_window": 262144,
     "max_output": 262144
    },
    "fugu-ultra": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "minimax-m2.7": {
     "context_window": 200000,
     "max_output": 128000
    },
    "gemini-3.5-flash": {
     "context_window": 1048576,
     "max_output": 65535
    },
    "ling-2.6-flash": {
     "context_window": 262144,
     "max_output": 262144
    },
    "gemini-3-pro-image": {
     "context_window": 1048576,
     "max_output": 32768
    },
    "gemini-3.7-flash@eu": {
     "context_window": 1048576,
     "max_output": 65535
    },
    "claude-fable-5.1": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "claude-fable-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "deepseek-v4-pro-0813": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "gpt-4.1-nano@eu": {
     "context_window": 1047576,
     "max_output": 32768
    },
    "mimo-v2.5-pro": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "gpt-5.1@eu": {
     "context_window": 400000,
     "max_output": 128000
    },
    "gemini-2.5-flash-lite@eu": {
     "context_window": 1048576,
     "max_output": 65535
    },
    "nemotron-3-nano-omni": {
     "context_window": 300000,
     "max_output": 300000
    },
    "claude-sonnet-4@eu": {
     "context_window": 1000000,
     "max_output": 64000
    },
    "inkling": {
     "context_window": 65536,
     "max_output": 32768
    },
    "mimo-v2.6-flash": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "gpt-5.4-mini": {
     "context_window": 400000,
     "max_output": 128000
    },
    "deepseek-v4.1-flash@eu": {
     "context_window": 1048576,
     "max_output": 393216
    },
    "minimax-m3": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "gpt-5.6-luna": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "qwen3.8-2.4T-A95B@eu": {
     "context_window": 1000000,
     "max_output": 262144
    },
    "qwen3.8-flash": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "qwen3.8-flash-next": {
     "context_window": 262144,
     "max_output": 262144
    },
    "qwen3.8-flash-next@eu": {
     "context_window": 262144,
     "max_output": 262144
    },
    "mistral-small-2603": {
     "context_window": 256000,
     "max_output": 256000
    },
    "claude-opus-4-8": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "gpt-5.5": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "claude-sonnet-5@eu": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "gemini-3.8-flash@eu": {
     "context_window": 1048576,
     "max_output": 65535
    },
    "claude-sonnet-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "qwen3.5-35b-a3b": {
     "context_window": 262144,
     "max_output": 262144
    },
    "glm-5.3@eu": {
     "context_window": 1048576,
     "max_output": 1048576
    },
    "gemini-2.5-flash@eu": {
     "context_window": 1048576,
     "max_output": 65535
    },
    "claude-opus-4-6": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "gemini-3.7-flash": {
     "context_window": 1048576,
     "max_output": 65535
    },
    "glm-5.2": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "hy3": {
     "context_window": 262144,
     "max_output": 262144
    },
    "glm-5.2@eu": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "gpt-5.6-sol@eu": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "seed-2.0-code": {
     "context_window": 256000,
     "max_output": 256000
    },
    "devstral-latest@eu": {
     "context_window": 256000,
     "max_output": 256000
    },
    "glm-5.1": {
     "context_window": 200000,
     "max_output": 128000
    },
    "gemini-2.5-pro@eu": {
     "context_window": 1048576,
     "max_output": 65535
    },
    "gpt-5.6-terra@eu": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "grok-build-0.1": {
     "context_window": 256000,
     "max_output": 256000
    },
    "glm-5.3-flash@eu": {
     "context_window": 1000000,
     "max_output": 262144
    },
    "minimax-m2.7-highspeed": {
     "context_window": 200000,
     "max_output": 128000
    },
    "deepseek-v4-pro@eu": {
     "context_window": 1048576,
     "max_output": 1048576
    },
    "devstral-latest": {
     "context_window": 256000,
     "max_output": 256000
    },
    "o4-mini@eu": {
     "context_window": 200000,
     "max_output": 100000
    },
    "mistral-small-2603@eu": {
     "context_window": 256000,
     "max_output": 256000
    },
    "qwen3.8-2.4T-A95B": {
     "context_window": 262144,
     "max_output": 262144
    },
    "gemini-3.8-flash": {
     "context_window": 1048576,
     "max_output": 65535
    },
    "gemini-3.5-flash@eu": {
     "context_window": 1048576,
     "max_output": 65535
    },
    "gpt-6-luna": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "nemotron-3.5-content-safety": {
     "context_window": 131072,
     "max_output": 8192
    },
    "deepseek-v4-pro": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "nvidia-nemotron-3-ultra": {
     "context_window": 262144,
     "max_output": 131072
    },
    "claude-fable-5.1@eu": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "step-3.7-flash": {
     "context_window": 262144,
     "max_output": 256000
    },
    "gpt-6-luna@eu": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "claude-opus-4-6@eu": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "claude-sonnet-4-6": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "leanstral-1-5": {
     "context_window": 262144,
     "max_output": 32768
    },
    "claude-sonnet-5-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "qwen3.6-plus": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "gpt-5.6-luna@eu": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "claude-opus-4-7@eu": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "gpt-5.6-terra": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "kat-coder-pro": {
     "context_window": 256000,
     "max_output": 256000
    },
    "laguna-m.1": {
     "context_window": 32768,
     "max_output": 32768
    },
    "gpt-6-sol@eu": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "glm-5.3": {
     "context_window": 1048576,
     "max_output": 1048576
    },
    "claude-opus-4-7": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "kimi-k2.7-code": {
     "context_window": 262144,
     "max_output": 262144
    },
    "grok-4.6": {
     "context_window": 500000,
     "max_output": 500000
    },
    "minimax-m3@eu": {
     "context_window": 1048576,
     "max_output": 1048576
    },
    "qwen3.7-plus": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "gpt-4.1-mini@eu": {
     "context_window": 1047576,
     "max_output": 32768
    },
    "gpt-5.6-sol": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "claude-opus-4-5@eu": {
     "context_window": 200000,
     "max_output": 64000
    },
    "deepseek-v4-flash": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "mistral-medium-latest": {
     "context_window": 131072,
     "max_output": 131072
    },
    "gpt-6-sol": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "gemini-3.1-flash-lite": {
     "context_window": 1048576,
     "max_output": 65535
    }
   }
  },
  "mistral": {
   "api": null,
   "models": {
    "open-mistral-nemo": {
     "context_window": 128000,
     "max_output": 128000
    },
    "codestral-latest": {
     "context_window": 256000,
     "max_output": 4096
    },
    "mistral-large-2411": {
     "context_window": 131072,
     "max_output": 16384
    },
    "mistral-nemo": {
     "context_window": 128000,
     "max_output": 128000
    },
    "mistral-medium-2508": {
     "context_window": 262144,
     "max_output": 262144
    },
    "mistral-large-latest": {
     "context_window": 262144,
     "max_output": 262144
    },
    "mistral-small-latest": {
     "context_window": 256000,
     "max_output": 256000
    },
    "zai-glm-5-2": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "ministral-8b-latest": {
     "context_window": 128000,
     "max_output": 128000
    },
    "devstral-medium-latest": {
     "context_window": 262144,
     "max_output": 262144
    },
    "open-mixtral-8x22b": {
     "context_window": 64000,
     "max_output": 64000
    },
    "devstral-2512": {
     "context_window": 262144,
     "max_output": 262144
    },
    "mistral-medium-2505": {
     "context_window": 131072,
     "max_output": 131072
    },
    "magistral-medium-latest": {
     "context_window": 128000,
     "max_output": 16384
    },
    "pixtral-12b": {
     "context_window": 128000,
     "max_output": 128000
    },
    "mistral-embed": {
     "context_window": 8000,
     "max_output": 3072
    },
    "devstral-small-2505": {
     "context_window": 128000,
     "max_output": 128000
    },
    "mistral-small-2603": {
     "context_window": 256000,
     "max_output": 256000
    },
    "devstral-medium-2507": {
     "context_window": 128000,
     "max_output": 128000
    },
    "labs-devstral-small-2512": {
     "context_window": 256000,
     "max_output": 256000
    },
    "mistral-large-2512": {
     "context_window": 262144,
     "max_output": 262144
    },
    "devstral-latest": {
     "context_window": 262144,
     "max_output": 262144
    },
    "devstral-small-2507": {
     "context_window": 128000,
     "max_output": 128000
    },
    "pixtral-large-latest": {
     "context_window": 128000,
     "max_output": 128000
    },
    "voxtral-small-latest": {
     "context_window": 32000,
     "max_output": 32000
    },
    "open-mixtral-8x7b": {
     "context_window": 32000,
     "max_output": 32000
    },
    "mistral-small-2506": {
     "context_window": 128000,
     "max_output": 16384
    },
    "zai-glm-5-3": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "mistral-medium-2604": {
     "context_window": 262144,
     "max_output": 262144
    },
    "open-mistral-7b": {
     "context_window": 8000,
     "max_output": 8000
    },
    "ministral-3b-latest": {
     "context_window": 128000,
     "max_output": 128000
    },
    "mistral-medium-latest": {
     "context_window": 262144,
     "max_output": 262144
    }
   }
  },
  "amazon-bedrock": {
   "api": null,
   "models": {
    "google.gemma-3-12b-it": {
     "context_window": 131072,
     "max_output": 8192
    },
    "google.gemma-3-4b-it": {
     "context_window": 131072,
     "max_output": 4096
    },
    "eu.anthropic.claude-fable-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "qwen.qwen3-coder-480b-a35b-v1:0": {
     "context_window": 131072,
     "max_output": 65536
    },
    "google.gemma-4-31b": {
     "context_window": 262144,
     "max_output": 32768
    },
    "us.writer.palmyra-x5-v1:0": {
     "context_window": 1040000,
     "max_output": 8192
    },
    "google.gemma-4-e2b": {
     "context_window": 131072,
     "max_output": 8192
    },
    "us.anthropic.claude-opus-4-7": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "global.openai.gpt-6-astra": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "us.openai.gpt-6.1-sol": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "eu.amazon.nova-lite-v1:0": {
     "context_window": 300000,
     "max_output": 10000
    },
    "global.anthropic.claude-opus-5-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "deepseek.r1-v1:0": {
     "context_window": 128000,
     "max_output": 32768
    },
    "openai.gpt-oss-safeguard-20b": {
     "context_window": 128000,
     "max_output": 16384
    },
    "anthropic.claude-opus-5-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "global.anthropic.claude-haiku-4-5-20251001-v1:0": {
     "context_window": 200000,
     "max_output": 64000
    },
    "eu.amazon.nova-2-lite-v1:0": {
     "context_window": 1000000,
     "max_output": 65535
    },
    "us.amazon.nova-pro-v1:0": {
     "context_window": 300000,
     "max_output": 10000
    },
    "jp.anthropic.claude-opus-5-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic.claude-sonnet-5-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "global.anthropic.claude-sonnet-5-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "openai.gpt-5.6-luna": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "us.meta.llama4-maverick-17b-instruct-v1:0": {
     "context_window": 1000000,
     "max_output": 8192
    },
    "apac.amazon.nova-micro-v1:0": {
     "context_window": 128000,
     "max_output": 10000
    },
    "eu.anthropic.claude-sonnet-4-20250514-v1:0": {
     "context_window": 200000,
     "max_output": 64000
    },
    "eu.anthropic.claude-opus-4-5-20251101-v1:0": {
     "context_window": 200000,
     "max_output": 64000
    },
    "global.openai.gpt-6-sol": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "qwen.qwen3-coder-30b-a3b-v1:0": {
     "context_window": 262144,
     "max_output": 131072
    },
    "us.amazon.nova-premier-v1:0": {
     "context_window": 1000000,
     "max_output": 10000
    },
    "anthropic.claude-sonnet-4-6": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "meta.llama3-1-70b-instruct-v1:0": {
     "context_window": 128000,
     "max_output": 4096
    },
    "us.writer.palmyra-x4-v1:0": {
     "context_window": 122880,
     "max_output": 8192
    },
    "apac.amazon.nova-pro-v1:0": {
     "context_window": 300000,
     "max_output": 10000
    },
    "global.anthropic.claude-fable-5-1": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "us.anthropic.claude-sonnet-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "amazon.nova-micro-v1:0": {
     "context_window": 128000,
     "max_output": 10000
    },
    "minimax.minimax-m2.5": {
     "context_window": 196608,
     "max_output": 98304
    },
    "xai.grok-4.3": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "us.amazon.nova-lite-v1:0": {
     "context_window": 300000,
     "max_output": 10000
    },
    "amazon.nova-pro-v1:0": {
     "context_window": 300000,
     "max_output": 10000
    },
    "qwen.qwen3-32b-v1:0": {
     "context_window": 32768,
     "max_output": 16384
    },
    "openai.gpt-5.5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "mistral.voxtral-small-24b-2507": {
     "context_window": 32768,
     "max_output": 8192
    },
    "global.amazon.nova-2-lite-v1:0": {
     "context_window": 1000000,
     "max_output": 65535
    },
    "us.openai.gpt-5.6-terra": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "mistral.devstral-2-123b": {
     "context_window": 262144,
     "max_output": 8192
    },
    "us.xai.grok-4.6": {
     "context_window": 500000,
     "max_output": 500000
    },
    "jp.anthropic.claude-sonnet-4-5-20250929-v1:0": {
     "context_window": 200000,
     "max_output": 64000
    },
    "anthropic.claude-fable-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic.claude-sonnet-4-5-20250929-v1:0": {
     "context_window": 200000,
     "max_output": 64000
    },
    "jp.anthropic.claude-opus-4-8": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "us.openai.gpt-5.6-luna": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "in.anthropic.claude-opus-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "us.anthropic.claude-sonnet-4-5-20250929-v1:0": {
     "context_window": 200000,
     "max_output": 64000
    },
    "au.anthropic.claude-opus-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "nvidia.nemotron-nano-12b-v2": {
     "context_window": 131072,
     "max_output": 8192
    },
    "openai.gpt-6.1-sol": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "us.amazon.nova-2-lite-v1:0": {
     "context_window": 1000000,
     "max_output": 65535
    },
    "us.openai.gpt-6-astra": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai.gpt-5.6-terra": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "global.openai.gpt-6.1-sol": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "anthropic.claude-opus-4-6-v1": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "us.anthropic.claude-opus-4-1-20250805-v1:0": {
     "context_window": 200000,
     "max_output": 32000
    },
    "us.meta.llama3-1-8b-instruct-v1:0": {
     "context_window": 128000,
     "max_output": 4096
    },
    "eu.anthropic.claude-haiku-4-5-20251001-v1:0": {
     "context_window": 200000,
     "max_output": 64000
    },
    "global.anthropic.claude-opus-4-7": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "apac.anthropic.claude-sonnet-4-20250514-v1:0": {
     "context_window": 200000,
     "max_output": 64000
    },
    "deepseek.v3.2": {
     "context_window": 163840,
     "max_output": 81920
    },
    "qwen.qwen3-235b-a22b-2507-v1:0": {
     "context_window": 262144,
     "max_output": 131072
    },
    "amazon.nova-lite-v1:0": {
     "context_window": 300000,
     "max_output": 10000
    },
    "global.anthropic.claude-opus-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "openai.gpt-oss-20b-1:0": {
     "context_window": 131072,
     "max_output": 128000
    },
    "anthropic.claude-opus-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "meta.llama3-3-70b-instruct-v1:0": {
     "context_window": 128000,
     "max_output": 4096
    },
    "minimax.minimax-m2": {
     "context_window": 204608,
     "max_output": 128000
    },
    "mistral.mistral-large-3-675b-instruct": {
     "context_window": 262144,
     "max_output": 8192
    },
    "in.openai.gpt-5.6-luna": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "eu.anthropic.claude-opus-4-8": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "global.anthropic.claude-sonnet-4-5-20250929-v1:0": {
     "context_window": 200000,
     "max_output": 64000
    },
    "zai.glm-4.7": {
     "context_window": 202752,
     "max_output": 131072
    },
    "au.anthropic.claude-sonnet-4-5-20250929-v1:0": {
     "context_window": 200000,
     "max_output": 64000
    },
    "eu.anthropic.claude-opus-5-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "global.anthropic.claude-sonnet-4-6": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "jp.anthropic.claude-sonnet-4-6": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "google.gemma-3-27b-it": {
     "context_window": 131072,
     "max_output": 8192
    },
    "eu.anthropic.claude-opus-4-6-v1": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "us.anthropic.claude-opus-5-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "us.anthropic.claude-opus-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "global.xai.grok-4.7": {
     "context_window": 500000,
     "max_output": 500000
    },
    "us.openai.gpt-5.6-sol": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "us.moonshotai.kimi-k3": {
     "context_window": 1048576,
     "max_output": 128000
    },
    "anthropic.claude-sonnet-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "mistral.magistral-small-2509": {
     "context_window": 128000,
     "max_output": 40000
    },
    "mistral.pixtral-large-2502-v1:0": {
     "context_window": 128000,
     "max_output": 8192
    },
    "anthropic.claude-opus-4-5-20251101-v1:0": {
     "context_window": 200000,
     "max_output": 64000
    },
    "nvidia.nemotron-nano-9b-v2": {
     "context_window": 131072,
     "max_output": 8192
    },
    "eu.amazon.nova-micro-v1:0": {
     "context_window": 128000,
     "max_output": 10000
    },
    "zai.glm-5": {
     "context_window": 202752,
     "max_output": 131072
    },
    "us.meta.llama3-1-70b-instruct-v1:0": {
     "context_window": 128000,
     "max_output": 4096
    },
    "jp.anthropic.claude-haiku-4-5-20251001-v1:0": {
     "context_window": 200000,
     "max_output": 64000
    },
    "nvidia.nemotron-nano-3-30b": {
     "context_window": 262144,
     "max_output": 8192
    },
    "mistral.ministral-3-3b-instruct": {
     "context_window": 256000,
     "max_output": 8192
    },
    "us.xai.grok-4.7": {
     "context_window": 500000,
     "max_output": 500000
    },
    "us.openai.gpt-6-luna": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "global.openai.gpt-5.6-sol": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "google.gemma-4-26b-a4b": {
     "context_window": 262144,
     "max_output": 32768
    },
    "xai.grok-4.6": {
     "context_window": 500000,
     "max_output": 500000
    },
    "global.xai.grok-4.6": {
     "context_window": 500000,
     "max_output": 500000
    },
    "au.anthropic.claude-opus-4-6-v1": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "qwen.qwen3-vl-235b-a22b": {
     "context_window": 262144,
     "max_output": 262000
    },
    "anthropic.claude-fable-5-1": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "jp.anthropic.claude-sonnet-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "us.anthropic.claude-sonnet-5-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "qwen.qwen3-coder-next": {
     "context_window": 262144,
     "max_output": 65536
    },
    "anthropic.claude-opus-4-8": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "au.anthropic.claude-sonnet-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "meta.llama4-scout-17b-instruct-v1:0": {
     "context_window": 10000000,
     "max_output": 8192
    },
    "openai.gpt-oss-safeguard-120b": {
     "context_window": 128000,
     "max_output": 16384
    },
    "us.meta.llama3-3-70b-instruct-v1:0": {
     "context_window": 128000,
     "max_output": 4096
    },
    "global.openai.gpt-5.6-luna": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "au.anthropic.claude-sonnet-4-6": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "openai.gpt-oss-120b": {
     "context_window": 131072,
     "max_output": 131072
    },
    "deepseek.v3-v1:0": {
     "context_window": 163840,
     "max_output": 81920
    },
    "moonshotai.kimi-k2.5": {
     "context_window": 262144,
     "max_output": 16384
    },
    "eu.anthropic.claude-sonnet-4-6": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "us-gov.openai.gpt-oss-120b-1:0": {
     "context_window": 128000,
     "max_output": 16384
    },
    "us.anthropic.claude-fable-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "openai.gpt-6-sol": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "us.deepseek.r1-v1:0": {
     "context_window": 128000,
     "max_output": 32768
    },
    "eu.anthropic.claude-opus-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "ca.amazon.nova-lite-v1:0": {
     "context_window": 300000,
     "max_output": 10000
    },
    "us.openai.gpt-6-sol": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "au.anthropic.claude-opus-4-7": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "us.meta.llama4-scout-17b-instruct-v1:0": {
     "context_window": 10000000,
     "max_output": 8192
    },
    "global.anthropic.claude-sonnet-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "global.anthropic.claude-fable-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "apac.amazon.nova-lite-v1:0": {
     "context_window": 300000,
     "max_output": 10000
    },
    "in.anthropic.claude-sonnet-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "us.anthropic.claude-opus-4-8": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "nvidia.nemotron-super-3-120b": {
     "context_window": 262144,
     "max_output": 131072
    },
    "global.openai.gpt-6-luna": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "us-gov.openai.gpt-oss-20b-1:0": {
     "context_window": 128000,
     "max_output": 16384
    },
    "us.anthropic.claude-opus-4-6-v1": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "meta.llama3-1-8b-instruct-v1:0": {
     "context_window": 128000,
     "max_output": 4096
    },
    "writer.palmyra-x5-v1:0": {
     "context_window": 1040000,
     "max_output": 8192
    },
    "anthropic.claude-opus-4-1-20250805-v1:0": {
     "context_window": 200000,
     "max_output": 32000
    },
    "us.anthropic.claude-sonnet-4-6": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "global.anthropic.claude-opus-4-6-v1": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "eu.anthropic.claude-sonnet-4-5-20250929-v1:0": {
     "context_window": 200000,
     "max_output": 64000
    },
    "jp.anthropic.claude-opus-4-7": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "au.anthropic.claude-opus-5-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "openai.gpt-6-luna": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "writer.palmyra-x4-v1:0": {
     "context_window": 122880,
     "max_output": 8192
    },
    "global.anthropic.claude-opus-4-5-20251101-v1:0": {
     "context_window": 200000,
     "max_output": 64000
    },
    "anthropic.claude-opus-4-7": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "us.anthropic.claude-sonnet-4-20250514-v1:0": {
     "context_window": 200000,
     "max_output": 64000
    },
    "anthropic.claude-haiku-4-5-20251001-v1:0": {
     "context_window": 200000,
     "max_output": 64000
    },
    "eu.anthropic.claude-sonnet-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "zai.glm-4.7-flash": {
     "context_window": 202752,
     "max_output": 131072
    },
    "moonshot.kimi-k2-thinking": {
     "context_window": 262144,
     "max_output": 16000
    },
    "eu.amazon.nova-pro-v1:0": {
     "context_window": 300000,
     "max_output": 10000
    },
    "global.openai.gpt-5.6-terra": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai.gpt-6-astra": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "us.anthropic.claude-haiku-4-5-20251001-v1:0": {
     "context_window": 200000,
     "max_output": 64000
    },
    "meta.llama4-maverick-17b-instruct-v1:0": {
     "context_window": 1000000,
     "max_output": 8192
    },
    "qwen.qwen3-next-80b-a3b": {
     "context_window": 262144,
     "max_output": 262000
    },
    "eu.mistral.pixtral-large-2502-v1:0": {
     "context_window": 128000,
     "max_output": 8192
    },
    "au.anthropic.claude-opus-4-8": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "us.anthropic.claude-fable-5-1": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "global.moonshotai.kimi-k3": {
     "context_window": 1048576,
     "max_output": 128000
    },
    "in.openai.gpt-5.6-terra": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai.gpt-oss-20b": {
     "context_window": 131072,
     "max_output": 131072
    },
    "mistral.ministral-3-14b-instruct": {
     "context_window": 128000,
     "max_output": 4096
    },
    "au.anthropic.claude-haiku-4-5-20251001-v1:0": {
     "context_window": 200000,
     "max_output": 64000
    },
    "openai.gpt-5.6-sol": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "minimax.minimax-m2.1": {
     "context_window": 196608,
     "max_output": 131072
    },
    "us.anthropic.claude-opus-4-5-20251101-v1:0": {
     "context_window": 200000,
     "max_output": 64000
    },
    "eu.anthropic.claude-opus-4-7": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "jp.amazon.nova-2-lite-v1:0": {
     "context_window": 1000000,
     "max_output": 65535
    },
    "us.mistral.pixtral-large-2502-v1:0": {
     "context_window": 128000,
     "max_output": 8192
    },
    "jp.anthropic.claude-opus-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "global.anthropic.claude-sonnet-4-20250514-v1:0": {
     "context_window": 200000,
     "max_output": 64000
    },
    "global.anthropic.claude-opus-4-8": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "openai.gpt-5.4": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "mistral.voxtral-mini-3b-2507": {
     "context_window": 32768,
     "max_output": 4096
    },
    "openai.gpt-oss-120b-1:0": {
     "context_window": 131072,
     "max_output": 128000
    },
    "amazon.nova-2-lite-v1:0": {
     "context_window": 1000000,
     "max_output": 65535
    },
    "eu.anthropic.claude-sonnet-5-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "us.amazon.nova-micro-v1:0": {
     "context_window": 128000,
     "max_output": 10000
    },
    "mistral.ministral-3-8b-instruct": {
     "context_window": 128000,
     "max_output": 4096
    },
    "in.anthropic.claude-haiku-4-5-20251001-v1:0": {
     "context_window": 200000,
     "max_output": 64000
    }
   }
  },
  "synthetic": {
   "api": "https://api.synthetic.new/openai/v1",
   "models": {
    "hf:moonshotai/Kimi-K3": {
     "context_window": 524288,
     "max_output": 65536
    },
    "hf:moonshotai/Kimi-K2.7-Code": {
     "context_window": 262144,
     "max_output": 65536
    },
    "hf:nvidia/NVIDIA-Nemotron-3-Super-120B-A12B-NVFP4": {
     "context_window": 262144,
     "max_output": 65536
    },
    "hf:zai-org/GLM-5.2": {
     "context_window": 524288,
     "max_output": 65536
    },
    "hf:zai-org/GLM-5.3-Flash": {
     "context_window": 524288,
     "max_output": 65536
    },
    "hf:zai-org/GLM-4.7-Flash": {
     "context_window": 196608,
     "max_output": 65536
    },
    "hf:zai-org/GLM-5.3": {
     "context_window": 524288,
     "max_output": 65536
    },
    "hf:deepseek-ai/DeepSeek-V4.1-Flash": {
     "context_window": 524288,
     "max_output": 65536
    },
    "hf:Qwen/Qwen3.6-27B": {
     "context_window": 262144,
     "max_output": 65536
    },
    "hf:openai/gpt-oss-120b": {
     "context_window": 131072,
     "max_output": 32768
    },
    "hf:MiniMaxAI/MiniMax-M3": {
     "context_window": 524288,
     "max_output": 65536
    }
   }
  },
  "llmgateway": {
   "api": "https://api.llmgateway.io/v1",
   "models": {
    "grok-4-1-fast-reasoning": {
     "context_window": 2000000,
     "max_output": 30000
    },
    "glm-4.6v": {
     "context_window": 131072,
     "max_output": 32768
    },
    "qwen-flash": {
     "context_window": 1000000,
     "max_output": 32768
    },
    "gpt-5.4": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "glm-4.5": {
     "context_window": 131000,
     "max_output": 98304
    },
    "claude-haiku-4-5": {
     "context_window": 200000,
     "max_output": 64000
    },
    "gpt-5.4-pro": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "mimo-v2.6-pro": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "gemma-4-31b-it": {
     "context_window": 262144,
     "max_output": 32768
    },
    "grok-4-5": {
     "context_window": 500000,
     "max_output": 500000
    },
    "gpt-3.5-turbo": {
     "context_window": 16385,
     "max_output": 4096
    },
    "grok-4-1-fast-non-reasoning": {
     "context_window": 2000000,
     "max_output": 2000000
    },
    "qwen3-vl-235b-a22b-instruct": {
     "context_window": 262144,
     "max_output": 8192
    },
    "seed-1-6-flash-250715": {
     "context_window": 256000,
     "max_output": 8192
    },
    "qwen3.7-max": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "muse-spark-1.3": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "Qwen3.8-27B": {
     "context_window": 262000,
     "max_output": 32768
    },
    "gpt-4o-transcribe": {
     "context_window": 16000,
     "max_output": 16000
    },
    "mimo-v2.5": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "gpt-5.5-pro": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "gpt-5.4-nano": {
     "context_window": 400000,
     "max_output": 128000
    },
    "mistral-large-latest": {
     "context_window": 128000,
     "max_output": 262144
    },
    "seed-2-0-code-preview-260328": {
     "context_window": 262144,
     "max_output": 262144
    },
    "qwen3-vl-235b-a22b-thinking": {
     "context_window": 131072,
     "max_output": 8192
    },
    "qwen3.8-2.4t-a95b": {
     "context_window": 1010000,
     "max_output": 131072
    },
    "gpt-5.2-codex": {
     "context_window": 400000,
     "max_output": 128000
    },
    "gpt-5.1-codex": {
     "context_window": 400000,
     "max_output": 128000
    },
    "qwen-coder-plus": {
     "context_window": 131072,
     "max_output": 8192
    },
    "glm-5v-turbo": {
     "context_window": 200000,
     "max_output": 131072
    },
    "gpt-4o": {
     "context_window": 128000,
     "max_output": 16384
    },
    "qwen3-vl-plus": {
     "context_window": 262144,
     "max_output": 32768
    },
    "glm-5.3-flash": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "fugu-max": {
     "context_window": 1000000,
     "max_output": 1000000
    },
    "ministral-8b-2512": {
     "context_window": 262144,
     "max_output": 8192
    },
    "qwen3.5-27b": {
     "context_window": 262144,
     "max_output": 65536
    },
    "glm-4.6": {
     "context_window": 204800,
     "max_output": 131072
    },
    "glm-5.2-fast": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "muse-glimmer-30b": {
     "context_window": 131072,
     "max_output": 131072
    },
    "grok-build-0-1": {
     "context_window": 256000,
     "max_output": 256000
    },
    "qwen3-235b-a22b-instruct-2507": {
     "context_window": 262144,
     "max_output": 8192
    },
    "qwen-max": {
     "context_window": 32768,
     "max_output": 8192
    },
    "qwen3-next-80b-a3b-thinking": {
     "context_window": 131072,
     "max_output": 32768
    },
    "qwen3.8-max": {
     "context_window": 1000000,
     "max_output": 1000000
    },
    "kimi-k3": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "qwen3-coder-next": {
     "context_window": 262144,
     "max_output": 65536
    },
    "glm-4.5-x": {
     "context_window": 128000,
     "max_output": 16384
    },
    "grok-4": {
     "context_window": 256000,
     "max_output": 256000
    },
    "gpt-5-mini": {
     "context_window": 400000,
     "max_output": 128000
    },
    "llama-4-maverick-17b-instruct": {
     "context_window": 1048576,
     "max_output": 2048
    },
    "gpt-5.2-pro": {
     "context_window": 400000,
     "max_output": 128000
    },
    "o4-mini": {
     "context_window": 200000,
     "max_output": 100000
    },
    "o3-mini": {
     "context_window": 200000,
     "max_output": 100000
    },
    "glm-5": {
     "context_window": 203000,
     "max_output": 131072
    },
    "fugu-ultra-v2.0": {
     "context_window": 1000000,
     "max_output": 1000000
    },
    "gpt-4": {
     "context_window": 8192,
     "max_output": 8192
    },
    "deepseek-v4.1-flash": {
     "context_window": 1050000,
     "max_output": 384000
    },
    "gpt-5.3-codex": {
     "context_window": 400000,
     "max_output": 128000
    },
    "gpt-4.1-nano": {
     "context_window": 1000000,
     "max_output": 32768
    },
    "minimax-m2.5": {
     "context_window": 228700,
     "max_output": 131072
    },
    "kimi-k3-fast": {
     "context_window": 1040384,
     "max_output": 131072
    },
    "qwen3-32b": {
     "context_window": 40960,
     "max_output": 16384
    },
    "muse-spark-1.1": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "gpt-5-nano": {
     "context_window": 400000,
     "max_output": 128000
    },
    "qwen-plus": {
     "context_window": 131072,
     "max_output": 32768
    },
    "kimi-k2.7-code-highspeed": {
     "context_window": 262144,
     "max_output": 262144
    },
    "qwen3.7-flash": {
     "context_window": 983616,
     "max_output": 1000000
    },
    "kimi-k2.6": {
     "context_window": 262144,
     "max_output": 262144
    },
    "minimax-m2.1-lightning": {
     "context_window": 196608,
     "max_output": 131072
    },
    "claude-sonnet-4-5": {
     "context_window": 200000,
     "max_output": 64000
    },
    "qwen3-max": {
     "context_window": 262144,
     "max_output": 65536
    },
    "claude-opus-5-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "glm-4.5-airx": {
     "context_window": 128000,
     "max_output": 16384
    },
    "glm-4.5v": {
     "context_window": 128000,
     "max_output": 16384
    },
    "claude-fable-5-1": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "devstral-2512": {
     "context_window": 262144,
     "max_output": 262144
    },
    "llama-4-scout-17b-instruct": {
     "context_window": 131072,
     "max_output": 2048
    },
    "gemini-3.6-flash": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "qwen3-235b-a22b-fp8": {
     "context_window": 40960,
     "max_output": 8192
    },
    "o1": {
     "context_window": 200000,
     "max_output": 100000
    },
    "glm-4-32b-0414-128k": {
     "context_window": 128000,
     "max_output": 16384
    },
    "qwen3-coder-480b-a35b-instruct": {
     "context_window": 262144,
     "max_output": 65536
    },
    "qwen3-coder-30b-a3b-instruct": {
     "context_window": 262000,
     "max_output": 65536
    },
    "mistral-medium-3-5": {
     "context_window": 262144,
     "max_output": 262144
    },
    "ling-3.0-flash": {
     "context_window": 262144,
     "max_output": 262144
    },
    "kimi-k2-thinking": {
     "context_window": 262144,
     "max_output": 262144
    },
    "claude-opus-4-1-20250805": {
     "context_window": 200000,
     "max_output": 32000
    },
    "gpt-5-pro": {
     "context_window": 400000,
     "max_output": 272000
    },
    "qwen3-vl-30b-a3b-instruct": {
     "context_window": 262144,
     "max_output": 8192
    },
    "gpt-6.1-sol": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "seed-1-6-250915": {
     "context_window": 256000,
     "max_output": 8192
    },
    "seed-2-0-mini-260428": {
     "context_window": 262144,
     "max_output": 262144
    },
    "gemma-4-26b-a4b-it": {
     "context_window": 262144,
     "max_output": 32768
    },
    "claude-opus-4-5-20251101": {
     "context_window": 200000,
     "max_output": 64000
    },
    "gemini-3.5-flash-lite": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "llama-3-70b-instruct": {
     "context_window": 8192,
     "max_output": 8000
    },
    "qwen3-vl-flash": {
     "context_window": 262144,
     "max_output": 32000
    },
    "seed-2-0-pro-260328": {
     "context_window": 262144,
     "max_output": 262144
    },
    "ling-3.0-flash-vl": {
     "context_window": 131072,
     "max_output": 131072
    },
    "qwen3-235b-a22b-thinking-2507": {
     "context_window": 262000,
     "max_output": 8192
    },
    "gpt-6-astra": {
     "context_window": 1050000,
     "max_output": 1050000
    },
    "minimax-text-01": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "gemini-3.1-pro-preview": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "glm-4.6v-flashx": {
     "context_window": 128000,
     "max_output": 16000
    },
    "qwen3.5-122b-a10b": {
     "context_window": 262144,
     "max_output": 65536
    },
    "grok-4-20-beta-0309-non-reasoning": {
     "context_window": 2000000,
     "max_output": 30000
    },
    "kimi-k2.5": {
     "context_window": 262144,
     "max_output": 262144
    },
    "gpt-5.1": {
     "context_window": 400000,
     "max_output": 128000
    },
    "claude-opus-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "llama-3.3-70b-instruct": {
     "context_window": 131072,
     "max_output": 4096
    },
    "gpt-4o-mini": {
     "context_window": 128000,
     "max_output": 16384
    },
    "qwen3.6-35b-a3b": {
     "context_window": 262144,
     "max_output": 65536
    },
    "qwen3-next-80b-a3b-instruct": {
     "context_window": 131072,
     "max_output": 32768
    },
    "granite-4.2-8b": {
     "context_window": 131072,
     "max_output": 131072
    },
    "fugu-ultra": {
     "context_window": 1000000,
     "max_output": 1000000
    },
    "gpt-oss-20b": {
     "context_window": 131072,
     "max_output": 32766
    },
    "minimax-m2.7": {
     "context_window": 204800,
     "max_output": 131072
    },
    "gemini-3.5-flash": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "gemini-2.5-pro": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "qwen3.6-flash": {
     "context_window": 983616,
     "max_output": 65536
    },
    "gemini-2.5-flash": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "qwen3-coder-flash": {
     "context_window": 997952,
     "max_output": 65536
    },
    "nemotron-3-ultra-550b": {
     "context_window": 1048576,
     "max_output": 128000
    },
    "llama-3.2-11b-instruct": {
     "context_window": 128000,
     "max_output": 8192
    },
    "claude-fable-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "mimo-v2.5-pro": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "qwen3-coder-plus": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "glm-4.7-flash": {
     "context_window": 200000,
     "max_output": 131072
    },
    "qwen3.5-9b": {
     "context_window": 262144,
     "max_output": 65536
    },
    "inkling": {
     "context_window": 524288,
     "max_output": 1048576
    },
    "muse-spark-1.2": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "mimo-v2.6-flash": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "gpt-5.4-mini": {
     "context_window": 400000,
     "max_output": 128000
    },
    "seed-1-8-251228": {
     "context_window": 256000,
     "max_output": 8192
    },
    "glm-4.7": {
     "context_window": 204800,
     "max_output": 131072
    },
    "minimax-m3": {
     "context_window": 1048576,
     "max_output": 512000
    },
    "gpt-5.6-luna": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "qwen3.8-flash": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "mistral-small-2603": {
     "context_window": 262144,
     "max_output": 256000
    },
    "gpt-5.2": {
     "context_window": 400000,
     "max_output": 128000
    },
    "claude-opus-4-8": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "seed-1-6-250615": {
     "context_window": 256000,
     "max_output": 8192
    },
    "gpt-5.5": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "claude-sonnet-4-5-20250929": {
     "context_window": 200000,
     "max_output": 64000
    },
    "qwen35-397b-a17b": {
     "context_window": 262144,
     "max_output": 65536
    },
    "gpt-4.1": {
     "context_window": 1000000,
     "max_output": 32768
    },
    "claude-sonnet-5": {
     "context_window": 1000000,
     "max_output": 1000000
    },
    "qwen3.5-35b-a3b": {
     "context_window": 262144,
     "max_output": 65536
    },
    "qwen3.6-max-preview": {
     "context_window": 262144,
     "max_output": 65536
    },
    "claude-opus-4-6": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "gemini-3.7-flash": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "glm-5.2": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "ernie-4.5-vl-424b-a47b": {
     "context_window": 123000,
     "max_output": 123000
    },
    "hy3": {
     "context_window": 262144,
     "max_output": 128000
    },
    "seed-2-0-lite-260428": {
     "context_window": 262144,
     "max_output": 262144
    },
    "kimi-k2": {
     "context_window": 256000,
     "max_output": 16384
    },
    "qwen-omni-turbo": {
     "context_window": 32768,
     "max_output": 2048
    },
    "hy-mt2-plus": {
     "context_window": 8192,
     "max_output": 8192
    },
    "grok-4-3": {
     "context_window": 1000000,
     "max_output": 30000
    },
    "glm-5.1": {
     "context_window": 204800,
     "max_output": 131072
    },
    "grok-4-20-non-reasoning": {
     "context_window": 2000000,
     "max_output": 30000
    },
    "gemini-3-flash-preview": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "grok-4-20-beta-0309-reasoning": {
     "context_window": 2000000,
     "max_output": 30000
    },
    "minimax-m2.7-highspeed": {
     "context_window": 204800,
     "max_output": 131072
    },
    "claude-haiku-4-5-20251001": {
     "context_window": 200000,
     "max_output": 64000
    },
    "glm-4.7-flashx": {
     "context_window": 200000,
     "max_output": 131072
    },
    "muse-spark-1.2-contributor": {
     "context_window": 1048576,
     "max_output": 1048576
    },
    "sonar": {
     "context_window": 130000,
     "max_output": 4096
    },
    "mistral-large-2512": {
     "context_window": 262144,
     "max_output": 262144
    },
    "grok-4-6": {
     "context_window": 500000,
     "max_output": 500000
    },
    "gemini-pro-latest": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "gpt-4.1-mini": {
     "context_window": 1000000,
     "max_output": 32768
    },
    "minimax-m2.5-highspeed": {
     "context_window": 204800,
     "max_output": 131072
    },
    "gemini-3.8-flash": {
     "context_window": 1048576,
     "max_output": 1048576
    },
    "ministral-14b-2512": {
     "context_window": 262144,
     "max_output": 8192
    },
    "glm-5-turbo": {
     "context_window": 200000,
     "max_output": 131072
    },
    "gpt-6-luna": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "deepseek-v4-pro": {
     "context_window": 1050000,
     "max_output": 384000
    },
    "step-3.7-flash": {
     "context_window": 262144,
     "max_output": 256000
    },
    "gemini-2.5-flash-lite": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "claude-sonnet-4-6": {
     "context_window": 1000000,
     "max_output": 64000
    },
    "claude-sonnet-5-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "gpt-4o-mini-transcribe": {
     "context_window": 16000,
     "max_output": 16000
    },
    "llama-3.2-3b-instruct": {
     "context_window": 32768,
     "max_output": 32000
    },
    "qwen3.6-plus": {
     "context_window": 983616,
     "max_output": 65536
    },
    "mistral-small-2506": {
     "context_window": 128000,
     "max_output": 16384
    },
    "grok-4-20-reasoning": {
     "context_window": 2000000,
     "max_output": 30000
    },
    "grok-4-7": {
     "context_window": 524288,
     "max_output": 500000
    },
    "gpt-5.6-terra": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "deepseek-v3.2": {
     "context_window": 163840,
     "max_output": 16384
    },
    "gpt-4-turbo": {
     "context_window": 128000,
     "max_output": 4096
    },
    "atria-dawn-preview": {
     "context_window": 262144,
     "max_output": 262144
    },
    "hy4-preview": {
     "context_window": 1000000,
     "max_output": 64000
    },
    "muse-spark-1.3-contributor": {
     "context_window": 1048576,
     "max_output": 1048576
    },
    "glm-4.5-air": {
     "context_window": 131000,
     "max_output": 98304
    },
    "qwen-plus-latest": {
     "context_window": 1000000,
     "max_output": 8192
    },
    "gpt-oss-120b": {
     "context_window": 131072,
     "max_output": 32766
    },
    "gpt-5.1-codex-mini": {
     "context_window": 400000,
     "max_output": 128000
    },
    "ministral-3b-2512": {
     "context_window": 131072,
     "max_output": 8192
    },
    "o3": {
     "context_window": 200000,
     "max_output": 100000
    },
    "glm-5.3": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "claude-opus-4-7": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "kimi-k2.7-code": {
     "context_window": 262144,
     "max_output": 262144
    },
    "gpt-5": {
     "context_window": 400000,
     "max_output": 128000
    },
    "qwen3.7-plus": {
     "context_window": 983616,
     "max_output": 64000
    },
    "minimax-m2.1": {
     "context_window": 204800,
     "max_output": 131072
    },
    "gpt-5.6-sol": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "auto": {
     "context_window": 128000,
     "max_output": 16384
    },
    "llama-3.1-70b-instruct": {
     "context_window": 128000,
     "max_output": 2048
    },
    "minimax-m2": {
     "context_window": 196608,
     "max_output": 131072
    },
    "custom": {
     "context_window": 128000,
     "max_output": 16384
    },
    "codestral-2508": {
     "context_window": 256000,
     "max_output": 16384
    },
    "deepseek-v4-flash": {
     "context_window": 1050000,
     "max_output": 384000
    },
    "gpt-6-sol": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "gemini-3.1-flash-lite": {
     "context_window": 1048576,
     "max_output": 65536
    }
   }
  },
  "sap-ai-core": {
   "api": null,
   "models": {
    "anthropic--claude-4-opus": {
     "context_window": 200000,
     "max_output": 32000
    },
    "gpt-5.4": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "nvidia--llama-3.2-nv-embedqa-1b": {
     "context_window": 8192,
     "max_output": 4096
    },
    "text-embedding-3-small": {
     "context_window": 8191,
     "max_output": 1536
    },
    "sap-abap-1": {
     "context_window": 32768,
     "max_output": 4096
    },
    "anthropic--claude-4.8-opus": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "gpt-5-mini": {
     "context_window": 400000,
     "max_output": 128000
    },
    "anthropic--claude-3-haiku": {
     "context_window": 200000,
     "max_output": 4096
    },
    "gpt-4.1-nano": {
     "context_window": 1047576,
     "max_output": 32768
    },
    "gpt-5-nano": {
     "context_window": 400000,
     "max_output": 128000
    },
    "anthropic--claude-4.5-haiku": {
     "context_window": 200000,
     "max_output": 64000
    },
    "anthropic--claude-4.7-opus": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "gemini-embedding": {
     "context_window": 2048
    },
    "gemini-embedding-2": {
     "context_window": 8192,
     "max_output": 3072
    },
    "amazon--nova-pro": {
     "context_window": 300000,
     "max_output": 8192
    },
    "amazon--nova-lite": {
     "context_window": 1000000,
     "max_output": 64000
    },
    "sonar-pro": {
     "context_window": 200000,
     "max_output": 8192
    },
    "anthropic--claude-3.5-sonnet": {
     "context_window": 200000,
     "max_output": 8192
    },
    "text-embedding-3-large": {
     "context_window": 8191,
     "max_output": 3072
    },
    "gemini-3.5-flash-lite": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "amazon--nova-micro": {
     "context_window": 128000,
     "max_output": 8192
    },
    "anthropic--claude-4.5-opus": {
     "context_window": 200000,
     "max_output": 64000
    },
    "anthropic--claude-4-sonnet": {
     "context_window": 200000,
     "max_output": 64000
    },
    "gemini-3.5-flash": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "gemini-2.5-pro": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "anthropic--claude-3-sonnet": {
     "context_window": 200000,
     "max_output": 4096
    },
    "sonar-deep-research": {
     "context_window": 128000,
     "max_output": 32768
    },
    "mistralai--mistral-small": {
     "context_window": 128000,
     "max_output": 128000
    },
    "gemini-2.5-flash": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "anthropic--claude-3.7-sonnet": {
     "context_window": 200000,
     "max_output": 64000
    },
    "gpt-5.6-luna": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "gpt-5.2": {
     "context_window": 400000,
     "max_output": 128000
    },
    "gpt-5.5": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "anthropic--claude-4.6-opus": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "mistralai--mistral-medium-instruct": {
     "context_window": 128000,
     "max_output": 128000
    },
    "gpt-4.1": {
     "context_window": 1047576,
     "max_output": 32768
    },
    "anthropic--claude-3-opus": {
     "context_window": 200000,
     "max_output": 4096
    },
    "anthropic--claude-4.6-sonnet": {
     "context_window": 1000000,
     "max_output": 64000
    },
    "sonar": {
     "context_window": 128000,
     "max_output": 4096
    },
    "amazon--titan-embed-text": {
     "context_window": 8192,
     "max_output": 1536
    },
    "gpt-4.1-mini": {
     "context_window": 1047576,
     "max_output": 32768
    },
    "gemini-3.8-flash": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "gemini-2.5-flash-lite": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "gpt-5.6-terra": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "mistralai--mistral-medium": {
     "context_window": 262144,
     "max_output": 262144
    },
    "gpt-5": {
     "context_window": 400000,
     "max_output": 128000
    },
    "anthropic--claude-4.5-sonnet": {
     "context_window": 200000,
     "max_output": 64000
    },
    "gpt-5.6-sol": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "cohere--command-a-reasoning": {
     "context_window": 256000,
     "max_output": 32000
    },
    "gemini-3.1-flash-lite": {
     "context_window": 1048576,
     "max_output": 65536
    }
   }
  },
  "vivgrid": {
   "api": "https://api.vivgrid.com/v1",
   "models": {
    "viv-fast": {
     "context_window": 1000000,
     "max_output": 256000
    },
    "gpt-5.4": {
     "context_window": 400000,
     "max_output": 128000
    },
    "gpt-5.4-nano": {
     "context_window": 400000,
     "max_output": 128000
    },
    "gpt-5.2-codex": {
     "context_window": 400000,
     "max_output": 128000
    },
    "gpt-5.1-codex": {
     "context_window": 400000,
     "max_output": 128000
    },
    "glm-5.3-flash": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "kimi-k3": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "gpt-5-mini": {
     "context_window": 272000,
     "max_output": 128000
    },
    "deepseek-v4.1-flash": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "gpt-5.3-codex": {
     "context_window": 400000,
     "max_output": 128000
    },
    "claude-opus-5-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "claude-fable-5-1": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "gpt-6.1-sol": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "gpt-6-astra": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "gemini-3.1-pro-preview": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "claude-opus-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "claude-fable-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "deepseek-v4-pro-0813": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "gpt-5.4-mini": {
     "context_window": 400000,
     "max_output": 128000
    },
    "gpt-5.6-luna": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "gpt-5.1-codex-max": {
     "context_window": 400000,
     "max_output": 128000
    },
    "gpt-5.5": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "claude-sonnet-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "gemini-3.7-flash": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "glm-5.2": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "gemini-3.8-flash": {
     "context_window": 1048576,
     "max_output": 128000
    },
    "gpt-6-luna": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "deepseek-v4-pro": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "claude-sonnet-5-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "gpt-5.6-terra": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "deepseek-v3.2": {
     "context_window": 128000,
     "max_output": 128000
    },
    "glm-5.3": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "gemini-3.1-flash-lite-preview": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "gpt-5.6-sol": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "deepseek-v4-flash": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "gpt-6-sol": {
     "context_window": 1050000,
     "max_output": 128000
    }
   }
  },
  "klokintegration": {
   "api": "https://api-gw.klok.ipaas.se/proxy/kloker-key/v1",
   "models": {
    "Kloker-Integration-Developer": {
     "context_window": 200000,
     "max_output": 50000
    },
    "Kloker": {
     "context_window": 200000,
     "max_output": 50000
    },
    "Kloker-Integration-Architect": {
     "context_window": 200000,
     "max_output": 50000
    }
   }
  },
  "google-vertex": {
   "api": null,
   "models": {
    "claude-opus-4-8@default": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "gemini-2.5-flash-tts": {
     "context_window": 32768,
     "max_output": 16384
    },
    "gemini-flash-latest": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "claude-sonnet-4-5@20250929": {
     "context_window": 200000,
     "max_output": 64000
    },
    "gemini-2.5-flash-image": {
     "context_window": 32768,
     "max_output": 32768
    },
    "claude-opus-4-6@default": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "claude-opus-4@20250514": {
     "context_window": 200000,
     "max_output": 32000
    },
    "gemini-flash-lite-latest": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "claude-sonnet-5-5@default": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "claude-opus-5-5@default": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "gemini-3.6-flash": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "claude-opus-5@default": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "claude-sonnet-4-6@default": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "claude-haiku-4-5@20251001": {
     "context_window": 200000,
     "max_output": 64000
    },
    "gemini-3.5-flash-lite": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "gemini-3.1-flash-image": {
     "context_window": 131072,
     "max_output": 32768
    },
    "gemini-3.1-pro-preview": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "claude-opus-4-1@20250805": {
     "context_window": 200000,
     "max_output": 32000
    },
    "claude-opus-4-5@20251101": {
     "context_window": 200000,
     "max_output": 64000
    },
    "claude-opus-4-7@default": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "gemini-3.5-flash": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "gemini-2.5-pro": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "gemini-3-pro-image": {
     "context_window": 65536,
     "max_output": 32768
    },
    "gemini-2.5-flash": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "claude-fable-5-1@default": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "gemini-3.7-flash": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "gemini-3.1-pro-preview-customtools": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "gemini-3-flash-preview": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "claude-fable-5@default": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "gemini-3.8-flash": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "gemini-2.5-flash-lite": {
     "context_window": 1048576,
     "max_output": 65535
    },
    "gemini-2.5-pro-tts": {
     "context_window": 32768,
     "max_output": 16384
    },
    "gemini-embedding-001": {
     "context_window": 2048
    },
    "claude-sonnet-4@20250514": {
     "context_window": 200000,
     "max_output": 64000
    },
    "gemini-3.1-flash-lite-preview": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "claude-sonnet-5@default": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "gemini-3.1-flash-lite": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "meta/llama-4-maverick-17b-128e-instruct-maas": {
     "context_window": 524288,
     "max_output": 8192
    },
    "meta/llama-3.3-70b-instruct-maas": {
     "context_window": 128000,
     "max_output": 8192
    },
    "xai/grok-4.20-reasoning": {
     "context_window": 2000000,
     "max_output": 30000
    },
    "xai/grok-4.20-non-reasoning": {
     "context_window": 2000000,
     "max_output": 30000
    },
    "xai/grok-4.1-fast-reasoning": {
     "context_window": 128000,
     "max_output": 30000
    },
    "xai/grok-4.3": {
     "context_window": 200000,
     "max_output": 30000
    },
    "xai/grok-4.1-fast-non-reasoning": {
     "context_window": 128000,
     "max_output": 30000
    },
    "xai/grok-4.6": {
     "context_window": 524288,
     "max_output": 500000
    },
    "deepseek-ai/deepseek-v3.1-maas": {
     "context_window": 163840,
     "max_output": 32768
    },
    "deepseek-ai/deepseek-v3.2-maas": {
     "context_window": 163840,
     "max_output": 65536
    },
    "moonshotai/kimi-k2-thinking-maas": {
     "context_window": 262144,
     "max_output": 262144
    },
    "zai-org/glm-5-maas": {
     "context_window": 200000,
     "max_output": 128000
    },
    "zai-org/glm-4.7-maas": {
     "context_window": 200000,
     "max_output": 128000
    },
    "zai-org/glm-5.2-maas": {
     "context_window": 1000000,
     "max_output": 64000
    },
    "qwen/qwen3-235b-a22b-instruct-2507-maas": {
     "context_window": 262144,
     "max_output": 16384
    },
    "openai/gpt-oss-20b-maas": {
     "context_window": 131072,
     "max_output": 32768
    },
    "openai/gpt-oss-120b-maas": {
     "context_window": 131072,
     "max_output": 131072
    }
   }
  },
  "evroc": {
   "api": "https://models.think.evroc.com/v1",
   "models": {
    "google/gemma-4-26B-A4B-it": {
     "context_window": 262144,
     "max_output": 32768
    },
    "intfloat/multilingual-e5-large-instruct": {
     "max_output": 512
    },
    "Qwen/Qwen3.8-27B": {
     "context_window": 262144,
     "max_output": 262144
    },
    "Qwen/Qwen3-Reranker-4B": {
     "context_window": 32000,
     "max_output": 4096
    },
    "Qwen/Qwen3.6-35B-A3B": {
     "context_window": 262144,
     "max_output": 65536
    },
    "Qwen/Qwen3-Embedding-8B": {
     "context_window": 40960,
     "max_output": 4096
    },
    "mistralai/Mistral-Medium-3.5-128B": {
     "context_window": 262144,
     "max_output": 262144
    },
    "mistralai/Voxtral-Small-24B-2507": {
     "context_window": 32000,
     "max_output": 32000
    },
    "moonshotai/Kimi-K2.6": {
     "context_window": 262144,
     "max_output": 262144
    },
    "zai-org/GLM-5.2": {
     "context_window": 524288,
     "max_output": 131072
    },
    "nvidia/Llama-3.3-70B-Instruct-FP8": {
     "context_window": 128000,
     "max_output": 4096
    },
    "KBLab/kb-whisper-large": {
     "max_output": 448
    },
    "evroc/roc": {
     "context_window": 262144,
     "max_output": 262144
    },
    "openai/whisper-large-v3": {
     "max_output": 4096
    },
    "openai/whisper-large-v3-turbo": {
     "max_output": 448
    },
    "openai/gpt-oss-120b": {
     "context_window": 65536,
     "max_output": 65536
    }
   }
  },
  "tokengo": {
   "api": "https://api.tokengo.com/v1",
   "models": {
    "deepseek/deepseek-v3.1": {
     "context_window": 131072,
     "max_output": 8192
    },
    "deepseek/deepseek-v4-pro": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "deepseek/deepseek-v3.2": {
     "context_window": 128000,
     "max_output": 64000
    },
    "deepseek/deepseek-v4-flash": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "z-ai/glm-5.3-flash": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "z-ai/glm-5": {
     "context_window": 204800,
     "max_output": 131072
    },
    "z-ai/glm-5.2": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "z-ai/glm-5.1": {
     "context_window": 200000,
     "max_output": 131072
    },
    "z-ai/glm-5.3": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "moonshotai/kimi-k3": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "moonshotai/kimi-k2.6": {
     "context_window": 262144,
     "max_output": 262144
    },
    "minimax/minimax-m2.5": {
     "context_window": 204800,
     "max_output": 131072
    },
    "qwen/qwen3.5-397b-a17b": {
     "context_window": 262144,
     "max_output": 65536
    }
   }
  },
  "submodel": {
   "api": "https://llm.submodel.ai/v1",
   "models": {
    "Qwen/Qwen3-235B-A22B-Thinking-2507": {
     "context_window": 262144,
     "max_output": 131072
    },
    "Qwen/Qwen3-235B-A22B-Instruct-2507": {
     "context_window": 262144,
     "max_output": 131072
    },
    "Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8": {
     "context_window": 262144,
     "max_output": 262144
    },
    "deepseek-ai/DeepSeek-V3.1": {
     "context_window": 75000,
     "max_output": 163840
    },
    "deepseek-ai/DeepSeek-R1-0528": {
     "context_window": 75000,
     "max_output": 163840
    },
    "deepseek-ai/DeepSeek-V3-0324": {
     "context_window": 75000,
     "max_output": 163840
    },
    "zai-org/GLM-4.5-FP8": {
     "context_window": 131072,
     "max_output": 131072
    },
    "zai-org/GLM-4.5-Air": {
     "context_window": 131072,
     "max_output": 131072
    },
    "openai/gpt-oss-120b": {
     "context_window": 131072,
     "max_output": 32768
    }
   }
  },
  "kosmik": {
   "api": "https://api.koscompute.com/v1",
   "models": {
    "qwen/qwen3.8-27b": {
     "context_window": 262144,
     "max_output": 32768
    }
   }
  },
  "tencent-token-plan": {
   "api": "https://api.lkeap.cloud.tencent.com/plan/v3",
   "models": {
    "hy3": {
     "context_window": 256000,
     "max_output": 128000
    },
    "hy4-preview": {
     "context_window": 1024000,
     "max_output": 64000
    }
   }
  },
  "togetherai": {
   "api": null,
   "models": {
    "meta-llama/Llama-3.3-70B-Instruct-Turbo": {
     "context_window": 131072,
     "max_output": 131072
    },
    "thinkingmachines/Inkling": {
     "context_window": 524288,
     "max_output": 131072
    },
    "essentialai/Rnj-1-Instruct": {
     "context_window": 32768,
     "max_output": 32768
    },
    "Qwen/Qwen3.7-Max": {
     "context_window": 1000000,
     "max_output": 500000
    },
    "Qwen/Qwen2.5-7B-Instruct-Turbo": {
     "context_window": 32768,
     "max_output": 32768
    },
    "Qwen/Qwen3-Coder-Next-FP8": {
     "context_window": 262144,
     "max_output": 262144
    },
    "Qwen/Qwen3-235B-A22B-Instruct-2507-tput": {
     "context_window": 262144,
     "max_output": 262144
    },
    "Qwen/Qwen3.5-9B": {
     "context_window": 262144,
     "max_output": 65536
    },
    "Qwen/Qwen3.5-397B-A17B": {
     "context_window": 262144,
     "max_output": 130000
    },
    "Qwen/Qwen3-Coder-480B-A35B-Instruct-FP8": {
     "context_window": 262144,
     "max_output": 262144
    },
    "Qwen/Qwen3.6-Plus": {
     "context_window": 1000000,
     "max_output": 500000
    },
    "LiquidAI/LFM2-24B-A2B": {
     "context_window": 32768,
     "max_output": 32768
    },
    "deepseek-ai/DeepSeek-V4-Flash-0731": {
     "context_window": 1048576,
     "max_output": 384000
    },
    "deepseek-ai/DeepSeek-R1": {
     "context_window": 163839,
     "max_output": 163839
    },
    "deepseek-ai/DeepSeek-V4-Pro-0813": {
     "context_window": 1048576,
     "max_output": 384000
    },
    "deepseek-ai/DeepSeek-V4.1-Flash": {
     "context_window": 1048576,
     "max_output": 384000
    },
    "deepseek-ai/DeepSeek-V3-1": {
     "context_window": 131072,
     "max_output": 131072
    },
    "deepseek-ai/DeepSeek-V3": {
     "context_window": 131072,
     "max_output": 131072
    },
    "MiniMaxAI/MiniMax-M3": {
     "context_window": 524288,
     "max_output": 250000
    },
    "MiniMaxAI/MiniMax-M2.5": {
     "context_window": 204800,
     "max_output": 131072
    },
    "MiniMaxAI/MiniMax-M2.7": {
     "context_window": 196608,
     "max_output": 131072
    },
    "moonshotai/Kimi-K3": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "zai-org/GLM-5.1": {
     "context_window": 202752,
     "max_output": 131072
    },
    "zai-org/GLM-5.2": {
     "context_window": 1048575,
     "max_output": 164000
    },
    "zai-org/GLM-5": {
     "context_window": 202752,
     "max_output": 131072
    },
    "zai-org/GLM-5.3-Flash": {
     "context_window": 1048575,
     "max_output": 400000
    },
    "zai-org/GLM-5.3": {
     "context_window": 1048576,
     "max_output": 262144
    },
    "nvidia/nemotron-3-ultra-550b-a55b": {
     "context_window": 512300,
     "max_output": 512300
    },
    "openai/gpt-oss-120b": {
     "context_window": 131072,
     "max_output": 131072
    }
   }
  },
  "helicone": {
   "api": "https://ai-gateway.helicone.ai/v1",
   "models": {
    "grok-4-1-fast-reasoning": {
     "context_window": 2000000,
     "max_output": 2000000
    },
    "grok-3": {
     "context_window": 131072,
     "max_output": 131072
    },
    "llama-4-scout": {
     "context_window": 131072,
     "max_output": 8192
    },
    "llama-guard-4": {
     "context_window": 131072,
     "max_output": 1024
    },
    "mistral-large-2411": {
     "context_window": 128000,
     "max_output": 32768
    },
    "grok-4-1-fast-non-reasoning": {
     "context_window": 2000000,
     "max_output": 30000
    },
    "qwen3-vl-235b-a22b-instruct": {
     "context_window": 256000,
     "max_output": 16384
    },
    "mistral-nemo": {
     "context_window": 128000,
     "max_output": 16400
    },
    "gpt-5.1-codex": {
     "context_window": 400000,
     "max_output": 128000
    },
    "gemini-3-pro-preview": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "gpt-4o": {
     "context_window": 128000,
     "max_output": 16384
    },
    "gpt-4.1-mini-2025-04-14": {
     "context_window": 1047576,
     "max_output": 32768
    },
    "glm-4.6": {
     "context_window": 204800,
     "max_output": 131072
    },
    "claude-3.5-haiku": {
     "context_window": 200000,
     "max_output": 8192
    },
    "o1-mini": {
     "context_window": 128000,
     "max_output": 65536
    },
    "grok-4": {
     "context_window": 256000,
     "max_output": 256000
    },
    "gpt-5-codex": {
     "context_window": 400000,
     "max_output": 128000
    },
    "llama-4-maverick": {
     "context_window": 131072,
     "max_output": 8192
    },
    "qwen3-coder": {
     "context_window": 262144,
     "max_output": 16384
    },
    "gpt-5-mini": {
     "context_window": 400000,
     "max_output": 128000
    },
    "o4-mini": {
     "context_window": 200000,
     "max_output": 100000
    },
    "o3-mini": {
     "context_window": 200000,
     "max_output": 100000
    },
    "kimi-k2-0711": {
     "context_window": 131072,
     "max_output": 16384
    },
    "gpt-4.1-nano": {
     "context_window": 1047576,
     "max_output": 32768
    },
    "grok-4-fast-reasoning": {
     "context_window": 2000000,
     "max_output": 2000000
    },
    "qwen3-32b": {
     "context_window": 131072,
     "max_output": 40960
    },
    "gpt-5-nano": {
     "context_window": 400000,
     "max_output": 128000
    },
    "claude-3.5-sonnet-v2": {
     "context_window": 200000,
     "max_output": 8192
    },
    "gpt-5.1-chat-latest": {
     "context_window": 128000,
     "max_output": 16384
    },
    "claude-4.5-sonnet": {
     "context_window": 200000,
     "max_output": 64000
    },
    "deepseek-tng-r1t2-chimera": {
     "context_window": 130000,
     "max_output": 163840
    },
    "deepseek-v3": {
     "context_window": 128000,
     "max_output": 8192
    },
    "deepseek-r1-distill-llama-70b": {
     "context_window": 128000,
     "max_output": 4096
    },
    "o1": {
     "context_window": 200000,
     "max_output": 100000
    },
    "mistral-small": {
     "context_window": 128000,
     "max_output": 16384
    },
    "chatgpt-4o-latest": {
     "context_window": 128000,
     "max_output": 16384
    },
    "qwen3-coder-30b-a3b-instruct": {
     "context_window": 262144,
     "max_output": 262144
    },
    "sonar-pro": {
     "context_window": 200000,
     "max_output": 4096
    },
    "kimi-k2-thinking": {
     "context_window": 256000,
     "max_output": 262144
    },
    "grok-4-fast-non-reasoning": {
     "context_window": 2000000,
     "max_output": 2000000
    },
    "claude-opus-4-1-20250805": {
     "context_window": 200000,
     "max_output": 32000
    },
    "gpt-5-pro": {
     "context_window": 128000,
     "max_output": 32768
    },
    "gpt-5-chat-latest": {
     "context_window": 128000,
     "max_output": 16384
    },
    "deepseek-v3.1-terminus": {
     "context_window": 128000,
     "max_output": 16384
    },
    "claude-opus-4-1": {
     "context_window": 200000,
     "max_output": 32000
    },
    "gpt-5.1": {
     "context_window": 400000,
     "max_output": 128000
    },
    "llama-3.3-70b-versatile": {
     "context_window": 131072,
     "max_output": 32678
    },
    "llama-3.3-70b-instruct": {
     "context_window": 128000,
     "max_output": 16400
    },
    "grok-3-mini": {
     "context_window": 131072,
     "max_output": 131072
    },
    "gemma-3-12b-it": {
     "context_window": 131072,
     "max_output": 8192
    },
    "qwen2.5-coder-7b-fast": {
     "context_window": 32000,
     "max_output": 8192
    },
    "gpt-4o-mini": {
     "context_window": 128000,
     "max_output": 16384
    },
    "qwen3-next-80b-a3b-instruct": {
     "context_window": 262000,
     "max_output": 16384
    },
    "o3-pro": {
     "context_window": 200000,
     "max_output": 100000
    },
    "gpt-oss-20b": {
     "context_window": 131072,
     "max_output": 131072
    },
    "gemini-2.5-pro": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "sonar-deep-research": {
     "context_window": 127000,
     "max_output": 4096
    },
    "gemini-2.5-flash": {
     "context_window": 1048576,
     "max_output": 65535
    },
    "claude-4.5-haiku": {
     "context_window": 200000,
     "max_output": 8192
    },
    "gemma2-9b-it": {
     "context_window": 8192,
     "max_output": 8192
    },
    "claude-3.7-sonnet": {
     "context_window": 200000,
     "max_output": 64000
    },
    "hermes-2-pro-llama-3-8b": {
     "context_window": 131072,
     "max_output": 131072
    },
    "claude-sonnet-4": {
     "context_window": 200000,
     "max_output": 64000
    },
    "qwen3-235b-a22b-thinking": {
     "context_window": 262144,
     "max_output": 81920
    },
    "grok-code-fast-1": {
     "context_window": 256000,
     "max_output": 10000
    },
    "claude-sonnet-4-5-20250929": {
     "context_window": 200000,
     "max_output": 64000
    },
    "gpt-4.1": {
     "context_window": 1047576,
     "max_output": 32768
    },
    "qwen3-30b-a3b": {
     "context_window": 41000,
     "max_output": 41000
    },
    "kimi-k2-0905": {
     "context_window": 262144,
     "max_output": 16384
    },
    "llama-3.1-8b-instruct": {
     "context_window": 16384,
     "max_output": 16384
    },
    "llama-3.1-8b-instruct-turbo": {
     "context_window": 128000,
     "max_output": 128000
    },
    "claude-haiku-4-5-20251001": {
     "context_window": 200000,
     "max_output": 8192
    },
    "sonar": {
     "context_window": 127000,
     "max_output": 4096
    },
    "deepseek-reasoner": {
     "context_window": 128000,
     "max_output": 64000
    },
    "gpt-4.1-mini": {
     "context_window": 1047576,
     "max_output": 32768
    },
    "ernie-4.5-21b-a3b-thinking": {
     "context_window": 128000,
     "max_output": 8000
    },
    "claude-4.5-opus": {
     "context_window": 200000,
     "max_output": 64000
    },
    "gemini-2.5-flash-lite": {
     "context_window": 1048576,
     "max_output": 65535
    },
    "claude-3-haiku-20240307": {
     "context_window": 200000,
     "max_output": 4096
    },
    "sonar-reasoning-pro": {
     "context_window": 127000,
     "max_output": 4096
    },
    "deepseek-v3.2": {
     "context_window": 163840,
     "max_output": 65536
    },
    "gpt-oss-120b": {
     "context_window": 131072,
     "max_output": 131072
    },
    "gpt-5.1-codex-mini": {
     "context_window": 400000,
     "max_output": 128000
    },
    "o3": {
     "context_window": 200000,
     "max_output": 100000
    },
    "gpt-5": {
     "context_window": 400000,
     "max_output": 128000
    },
    "llama-3.1-8b-instant": {
     "context_window": 131072,
     "max_output": 32678
    },
    "sonar-reasoning": {
     "context_window": 127000,
     "max_output": 4096
    },
    "claude-opus-4": {
     "context_window": 200000,
     "max_output": 32000
    }
   }
  },
  "cortecs": {
   "api": "https://api.cortecs.ai/v1",
   "models": {
    "gpt-5.4": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "claude-haiku-4-5": {
     "context_window": 200000,
     "max_output": 64000
    },
    "gpt-oss-safeguard-120b": {
     "context_window": 128000,
     "max_output": 128000
    },
    "gemma-4-31b-it": {
     "context_window": 262000,
     "max_output": 262000
    },
    "qwen3.8-27b": {
     "context_window": 1000000,
     "max_output": 500000
    },
    "gemma-3-27b-it": {
     "context_window": 131000,
     "max_output": 110000
    },
    "qwen3.8-2.4t-a95b": {
     "context_window": 262144,
     "max_output": 262144
    },
    "mistral-large-2402": {
     "context_window": 32000,
     "max_output": 8192
    },
    "gpt-4o": {
     "context_window": 128000,
     "max_output": 16000
    },
    "qwen3guard-gen-8b": {
     "context_window": 32000,
     "max_output": 32000
    },
    "glm-5.3-flash": {
     "context_window": 1048576,
     "max_output": 1048576
    },
    "ministral-8b-2512": {
     "context_window": 256000,
     "max_output": 256000
    },
    "deepseek-v4-flash-0731": {
     "context_window": 1048576,
     "max_output": 1048576
    },
    "mistral-7b-instruct-v0.2": {
     "context_window": 32000,
     "max_output": 8192
    },
    "qwen3-235b-a22b-instruct-2507": {
     "context_window": 262000,
     "max_output": 262000
    },
    "kimi-k3": {
     "context_window": 1048576,
     "max_output": 1048576
    },
    "qwen3-coder-next": {
     "context_window": 256000,
     "max_output": 256000
    },
    "nova-lite-v1": {
     "context_window": 300000,
     "max_output": 10000
    },
    "apertus-70b": {
     "context_window": 65536,
     "max_output": 16384
    },
    "gpt-5-mini": {
     "context_window": 400000,
     "max_output": 128000
    },
    "deepseek-v4.1-flash": {
     "context_window": 1048576,
     "max_output": 1048576
    },
    "gpt-4.1-nano": {
     "context_window": 1047576,
     "max_output": 32768
    },
    "minimax-m2.5": {
     "context_window": 196000,
     "max_output": 196000
    },
    "qwen3-32b": {
     "context_window": 16384,
     "max_output": 16384
    },
    "mistral-medium-3.5": {
     "context_window": 256000,
     "max_output": 256000
    },
    "gpt-5-nano": {
     "context_window": 400000,
     "max_output": 128000
    },
    "claude-4-6-sonnet": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "kimi-k2.6": {
     "context_window": 256000,
     "max_output": 256000
    },
    "claude-4-5-sonnet": {
     "context_window": 200000,
     "max_output": 64000
    },
    "devstral-2512": {
     "context_window": 256000,
     "max_output": 256000
    },
    "gemini-3.6-flash": {
     "context_window": 1048576,
     "max_output": 65535
    },
    "mistral-7b-instruct-v0.3": {
     "context_window": 127000,
     "max_output": 127000
    },
    "qwen3-coder-30b-a3b-instruct": {
     "context_window": 262144,
     "max_output": 262144
    },
    "mixtral-8x7B-instruct-v0.1": {
     "context_window": 32000,
     "max_output": 4096
    },
    "gpt-6.1-sol": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "gemma-4-26b-a4b-it": {
     "context_window": 262000,
     "max_output": 81920
    },
    "gemini-3.5-flash-lite": {
     "context_window": 1048576,
     "max_output": 65535
    },
    "voxtral-small-2507": {
     "context_window": 32000,
     "max_output": 32000
    },
    "gpt-5.1": {
     "context_window": 400000,
     "max_output": 128000
    },
    "claude-opus-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "llama-3.3-70b-instruct": {
     "context_window": 131000,
     "max_output": 131000
    },
    "qwen3guard-gen-0.6b": {
     "context_window": 32000,
     "max_output": 32000
    },
    "gpt-4o-mini": {
     "context_window": 128000,
     "max_output": 16000
    },
    "qwen3.6-35b-a3b": {
     "context_window": 262000,
     "max_output": 32768
    },
    "pixtral-12b-2409": {
     "context_window": 128000,
     "max_output": 4096
    },
    "gpt-oss-20b": {
     "context_window": 131000,
     "max_output": 131000
    },
    "gemini-3.5-flash": {
     "context_window": 1048576,
     "max_output": 65535
    },
    "gemini-2.5-pro": {
     "context_window": 1048576,
     "max_output": 65535
    },
    "hermes-4-405b": {
     "context_window": 128000,
     "max_output": 128000
    },
    "gemini-2.5-flash": {
     "context_window": 1048576,
     "max_output": 65535
    },
    "qwen3-vl-235b-a22b": {
     "context_window": 256000,
     "max_output": 256000
    },
    "deepseek-v4-pro-0813": {
     "context_window": 1048576,
     "max_output": 64000
    },
    "glm-4.7-flash": {
     "context_window": 203000,
     "max_output": 203000
    },
    "qwen3.5-9b": {
     "context_window": 262000,
     "max_output": 262000
    },
    "claude-opus4-6": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "claude-sonnet-4": {
     "context_window": 200000,
     "max_output": 65000
    },
    "minimax-m3": {
     "context_window": 1048576,
     "max_output": 1048576
    },
    "gpt-5.6-luna": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "qwen3.8-flash-next": {
     "context_window": 262144,
     "max_output": 64000
    },
    "mistral-small-2603": {
     "context_window": 262144,
     "max_output": 256000
    },
    "nemotron-nano-v2-12b": {
     "context_window": 128000,
     "max_output": 128000
    },
    "mistral-small-2503": {
     "context_window": 128000,
     "max_output": 128000
    },
    "gpt-4.1": {
     "context_window": 1047576,
     "max_output": 32768
    },
    "claude-sonnet-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "qwen3.5-397b-a17b": {
     "context_window": 262000,
     "max_output": 262000
    },
    "gemini-3.7-flash": {
     "context_window": 1048576,
     "max_output": 65535
    },
    "glm-5.2": {
     "context_window": 1048576,
     "max_output": 1000000
    },
    "pixtral-large-2502": {
     "context_window": 128000,
     "max_output": 128000
    },
    "claude-opus4-7": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "minicpm-v-4.5": {
     "context_window": 32000,
     "max_output": 32000
    },
    "llama-3.1-8b-instruct": {
     "context_window": 128000,
     "max_output": 128000
    },
    "glm-5.1": {
     "context_window": 202752,
     "max_output": 202752
    },
    "qwen3-30b-a3b-instruct-2507": {
     "context_window": 262000,
     "max_output": 262000
    },
    "qwen2.5-vl-72b-instruct": {
     "context_window": 32000,
     "max_output": 32000
    },
    "mistral-large-2512": {
     "context_window": 256000,
     "max_output": 256000
    },
    "gpt-4.1-mini": {
     "context_window": 1047576,
     "max_output": 32768
    },
    "gemini-3.8-flash": {
     "context_window": 1048576,
     "max_output": 65535
    },
    "ministral-14b-2512": {
     "context_window": 256000,
     "max_output": 256000
    },
    "gpt-6-luna": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "deepseek-v4-pro": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "claude-opus-5.5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "qwen3.6-27b": {
     "context_window": 262000,
     "max_output": 262000
    },
    "claude-opus4-8": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "mistral-small-3.2-24b-instruct-2506": {
     "context_window": 131000,
     "max_output": 131000
    },
    "gpt-5.6-terra": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "deepseek-v3.2": {
     "context_window": 163840,
     "max_output": 65536
    },
    "nova-2-lite": {
     "context_window": 1000000,
     "max_output": 65535
    },
    "nova-pro-v1": {
     "context_window": 300000,
     "max_output": 10000
    },
    "gpt-oss-120b": {
     "context_window": 131000,
     "max_output": 131000
    },
    "ministral-3b-2512": {
     "context_window": 256000,
     "max_output": 256000
    },
    "claude-opus4-5": {
     "context_window": 200000,
     "max_output": 64000
    },
    "glm-5.3": {
     "context_window": 1048576,
     "max_output": 1048576
    },
    "kimi-k2.7-code": {
     "context_window": 262144,
     "max_output": 262144
    },
    "gpt-5": {
     "context_window": 400000,
     "max_output": 128000
    },
    "minimax-m2.1": {
     "context_window": 196000,
     "max_output": 196000
    },
    "gpt-5.6-sol": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "mistral-nemo-instruct-2407": {
     "context_window": 128000,
     "max_output": 128000
    },
    "minimax-m2": {
     "context_window": 400000,
     "max_output": 196000
    },
    "nova-micro-v1": {
     "context_window": 128000,
     "max_output": 10000
    },
    "codestral-2508": {
     "context_window": 256000,
     "max_output": 256000
    },
    "gpt-6-sol": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "nvidia-nemotron-3-nano-30b-a3b": {
     "context_window": 256000,
     "max_output": 256000
    },
    "gemini-3.1-flash-lite": {
     "context_window": 1048576,
     "max_output": 65535
    }
   }
  },
  "agnes": {
   "api": "https://apihub.agnes-ai.com/v1",
   "models": {
    "agnes-2.5-pro-alpha": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "agnes-2.0-flash": {
     "context_window": 512000,
     "max_output": 65536
    },
    "agnes-2.5-flash": {
     "context_window": 512000,
     "max_output": 65536
    }
   }
  },
  "daoxe": {
   "api": "https://daoxe.com/v1",
   "models": {
    "gpt-5.4": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "grok-4.3": {
     "context_window": 1000000,
     "max_output": 30000
    },
    "gemini-3.1-pro-preview": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "grok-4.5": {
     "context_window": 500000,
     "max_output": 500000
    },
    "kimi-k2.5": {
     "context_window": 262144,
     "max_output": 262144
    },
    "claude-opus-4-8": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "gpt-5.5": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "claude-haiku-4-5-20251001": {
     "context_window": 200000,
     "max_output": 64000
    },
    "claude-sonnet-4-6": {
     "context_window": 1000000,
     "max_output": 64000
    }
   }
  },
  "morph": {
   "api": "https://api.morphllm.com/v1",
   "models": {
    "morph-v3-large": {
     "context_window": 32000,
     "max_output": 32000
    },
    "morph-v3-fast": {
     "context_window": 16000,
     "max_output": 16000
    },
    "auto": {
     "context_window": 32000,
     "max_output": 32000
    }
   }
  },
  "openai": {
   "api": null,
   "models": {
    "gpt-5.4": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "gpt-5.4-pro": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "gpt-3.5-turbo": {
     "context_window": 16385,
     "max_output": 4096
    },
    "gpt-5.5-pro": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "text-embedding-3-small": {
     "context_window": 8191,
     "max_output": 1536
    },
    "gpt-5.4-nano": {
     "context_window": 400000,
     "max_output": 128000
    },
    "gpt-realtime-2.1": {
     "context_window": 128000,
     "max_output": 32000
    },
    "gpt-4o-2024-05-13": {
     "context_window": 128000,
     "max_output": 4096
    },
    "gpt-4o": {
     "context_window": 128000,
     "max_output": 16384
    },
    "gpt-5-mini": {
     "context_window": 400000,
     "max_output": 128000
    },
    "gpt-5.2-pro": {
     "context_window": 400000,
     "max_output": 128000
    },
    "o4-mini": {
     "context_window": 200000,
     "max_output": 100000
    },
    "o3-mini": {
     "context_window": 200000,
     "max_output": 100000
    },
    "text-embedding-ada-002": {
     "context_window": 8192,
     "max_output": 1536
    },
    "gpt-4": {
     "context_window": 8192,
     "max_output": 8192
    },
    "gpt-5.3-codex": {
     "context_window": 400000,
     "max_output": 128000
    },
    "gpt-4.1-nano": {
     "context_window": 1047576,
     "max_output": 32768
    },
    "gpt-5-nano": {
     "context_window": 400000,
     "max_output": 128000
    },
    "gpt-5.6": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "gpt-5.2-chat-latest": {
     "context_window": 128000,
     "max_output": 16384
    },
    "o1": {
     "context_window": 200000,
     "max_output": 100000
    },
    "gpt-5-pro": {
     "context_window": 400000,
     "max_output": 272000
    },
    "gpt-5.3-codex-spark": {
     "context_window": 128000,
     "max_output": 32000
    },
    "gpt-6.1-sol": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "text-embedding-3-large": {
     "context_window": 8191,
     "max_output": 3072
    },
    "gpt-4o-2024-08-06": {
     "context_window": 128000,
     "max_output": 16384
    },
    "gpt-6-astra": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "gpt-5.1": {
     "context_window": 400000,
     "max_output": 128000
    },
    "gpt-4o-mini": {
     "context_window": 128000,
     "max_output": 16384
    },
    "o3-pro": {
     "context_window": 200000,
     "max_output": 100000
    },
    "gpt-daybreak-blue-latest": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "gpt-5.4-mini": {
     "context_window": 400000,
     "max_output": 128000
    },
    "gpt-5.6-luna": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "gpt-5.2": {
     "context_window": 400000,
     "max_output": 128000
    },
    "gpt-5.5": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "gpt-4.1": {
     "context_window": 1047576,
     "max_output": 32768
    },
    "gpt-4o-2024-11-20": {
     "context_window": 128000,
     "max_output": 16384
    },
    "gpt-4.1-mini": {
     "context_window": 1047576,
     "max_output": 32768
    },
    "gpt-6-luna": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "gpt-5.3-chat-latest": {
     "context_window": 128000,
     "max_output": 16384
    },
    "gpt-5.6-terra": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "gpt-4-turbo": {
     "context_window": 128000,
     "max_output": 4096
    },
    "gpt-daybreak-red-latest": {
     "context_window": 400000,
     "max_output": 128000
    },
    "o3": {
     "context_window": 200000,
     "max_output": 100000
    },
    "gpt-5": {
     "context_window": 400000,
     "max_output": 128000
    },
    "gpt-5.6-sol": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "gpt-6-sol": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "o1-pro": {
     "context_window": 200000,
     "max_output": 100000
    }
   }
  },
  "alibaba-coding-plan-cn": {
   "api": "https://coding.dashscope.aliyuncs.com/v1",
   "models": {
    "qwen3-coder-next": {
     "context_window": 262144,
     "max_output": 65536
    },
    "qwen3.5-plus": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "glm-5": {
     "context_window": 202752,
     "max_output": 16384
    },
    "kimi-k2.5": {
     "context_window": 262144,
     "max_output": 32768
    },
    "qwen3-max-2026-01-23": {
     "context_window": 262144,
     "max_output": 32768
    },
    "qwen3-coder-plus": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "MiniMax-M2.5": {
     "context_window": 196608,
     "max_output": 24576
    },
    "glm-4.7": {
     "context_window": 202752,
     "max_output": 16384
    },
    "qwen3.6-plus": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "qwen3.7-plus": {
     "context_window": 1000000,
     "max_output": 64000
    }
   }
  },
  "io-net": {
   "api": "https://api.intelligence.io.solutions/api/v1",
   "models": {
    "meta-llama/Llama-3.2-90B-Vision-Instruct": {
     "context_window": 16000,
     "max_output": 4096
    },
    "meta-llama/Llama-3.3-70B-Instruct": {
     "context_window": 128000,
     "max_output": 4096
    },
    "meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8": {
     "context_window": 430000,
     "max_output": 4096
    },
    "Qwen/Qwen3-Next-80B-A3B-Instruct": {
     "context_window": 262144,
     "max_output": 4096
    },
    "Qwen/Qwen3-235B-A22B-Thinking-2507": {
     "context_window": 262144,
     "max_output": 4096
    },
    "Qwen/Qwen2.5-VL-32B-Instruct": {
     "context_window": 32000,
     "max_output": 4096
    },
    "deepseek-ai/DeepSeek-R1-0528": {
     "context_window": 128000,
     "max_output": 4096
    },
    "mistralai/Mistral-Nemo-Instruct-2407": {
     "context_window": 128000,
     "max_output": 4096
    },
    "mistralai/Magistral-Small-2506": {
     "context_window": 128000,
     "max_output": 4096
    },
    "mistralai/Devstral-Small-2505": {
     "context_window": 128000,
     "max_output": 4096
    },
    "mistralai/Mistral-Large-Instruct-2411": {
     "context_window": 128000,
     "max_output": 4096
    },
    "Intel/Qwen3-Coder-480B-A35B-Instruct-int4-mixed-ar": {
     "context_window": 106000,
     "max_output": 4096
    },
    "moonshotai/Kimi-K2-Thinking": {
     "context_window": 32768,
     "max_output": 4096
    },
    "moonshotai/Kimi-K2-Instruct-0905": {
     "context_window": 32768,
     "max_output": 4096
    },
    "zai-org/GLM-4.6": {
     "context_window": 200000,
     "max_output": 4096
    },
    "openai/gpt-oss-20b": {
     "context_window": 64000,
     "max_output": 4096
    },
    "openai/gpt-oss-120b": {
     "context_window": 131072,
     "max_output": 4096
    }
   }
  },
  "infomaniak": {
   "api": "https://api.infomaniak.com/2/ai/${INFOMANIAK_PRODUCT_ID}/openai/v1",
   "models": {
    "mini_lm_l12_v2": {
     "max_output": 384
    },
    "bge_multilingual_gemma2": {
     "context_window": 8000,
     "max_output": 3584
    },
    "swiss-ai/Apertus-v1.5-70B": {
     "context_window": 100000,
     "max_output": 8192
    },
    "google/gemma-4-31B-it": {
     "context_window": 100000,
     "max_output": 32768
    },
    "Qwen/Qwen3.5-122B-A10B-FP8": {
     "context_window": 200000,
     "max_output": 65536
    },
    "Qwen/Qwen3.5-397B-A17B-FP8": {
     "context_window": 200000,
     "max_output": 65536
    },
    "mistralai/Mistral-Small-4-119B-2603": {
     "context_window": 256000,
     "max_output": 256000
    },
    "mistralai/Ministral-3-14B-Instruct-2512": {
     "context_window": 100000,
     "max_output": 25600
    },
    "moonshotai/Kimi-K2.6": {
     "context_window": 256000,
     "max_output": 256000
    },
    "nvidia/NVIDIA-Nemotron-3-Nano-30B-A3B-FP8": {
     "context_window": 1000000,
     "max_output": 262144
    }
   }
  },
  "llmtech": {
   "api": "https://api.llmtech.eu/v1",
   "models": {
    "nvidia/Qwen3.8-27B-NVFP4": {
     "context_window": 262144,
     "max_output": 32768
    }
   }
  },
  "crossmodel": {
   "api": "https://api.crossmodel.ai/v1",
   "models": {
    "anthropic/claude-haiku-4-5": {
     "context_window": 200000,
     "max_output": 64000
    },
    "anthropic/claude-opus-5-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-fable-5-1": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-opus-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-fable-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-opus-4-8": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-sonnet-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-sonnet-4-6": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-sonnet-5-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "anthropic/claude-opus-4-7": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "deepseek/deepseek-v4.1-flash": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "deepseek/deepseek-v4-flash-vision-exp": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "deepseek/deepseek-v4-pro": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "deepseek/deepseek-v4-flash": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "tencent/hy3": {
     "context_window": 262144,
     "max_output": 131072
    },
    "tencent/hy4-preview": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "z-ai/glm-5.3-flash": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "z-ai/glm-5": {
     "context_window": 200000,
     "max_output": 128000
    },
    "z-ai/glm-4.7": {
     "context_window": 200000,
     "max_output": 128000
    },
    "z-ai/glm-5.2": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "z-ai/glm-5.1": {
     "context_window": 200000,
     "max_output": 128000
    },
    "z-ai/glm-5-turbo": {
     "context_window": 200000,
     "max_output": 128000
    },
    "z-ai/glm-5.3": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "x-ai/grok-4.7": {
     "context_window": 500000,
     "max_output": 500000
    },
    "x-ai/grok-4.3": {
     "context_window": 1000000,
     "max_output": 1000000
    },
    "x-ai/grok-4.5": {
     "context_window": 500000,
     "max_output": 500000
    },
    "x-ai/grok-build-0.1": {
     "context_window": 256000,
     "max_output": 256000
    },
    "x-ai/grok-4.6": {
     "context_window": 500000,
     "max_output": 500000
    },
    "xiaomi/mimo-v2.6-pro": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "xiaomi/mimo-v2.5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "xiaomi/mimo-v2.5-pro": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "xiaomi/mimo-v2.6-flash": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "minimax/minimax-m2.7": {
     "context_window": 204800,
     "max_output": 131072
    },
    "minimax/minimax-m3": {
     "context_window": 1024000,
     "max_output": 512000
    },
    "gemini/gemini-3.6-flash": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "gemini/gemini-3.5-flash-lite": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "gemini/gemini-3.1-pro-preview": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "gemini/gemini-3.5-flash": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "gemini/gemini-2.5-pro": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "gemini/gemini-2.5-flash": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "gemini/gemini-3.7-flash": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "gemini/gemini-3-flash-preview": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "gemini/gemini-3.8-flash": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "gemini/gemini-2.5-flash-lite": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "qwen/qwen3.7-max": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "qwen/qwen3.8-max": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "qwen/qwen3.7-flash": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "qwen/qwen3.8-omni-flash": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "qwen/qwen3.6-flash": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "qwen/qwen3.8-flash": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "qwen/qwen3.6-plus": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "qwen/qwen3.7-plus": {
     "context_window": 1000000,
     "max_output": 64000
    },
    "openai/gpt-5.4": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-5.5-pro": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-5.4-nano": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-6.1-sol": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-6-astra": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-4o-mini": {
     "context_window": 128000,
     "max_output": 16384
    },
    "openai/gpt-5.4-mini": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai/gpt-5.6-luna": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-5.5": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-6-luna": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-5.6-terra": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-5.6-sol": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai/gpt-6-sol": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "moonshot/kimi-k3": {
     "context_window": 1048576,
     "max_output": 1048576
    },
    "moonshot/kimi-k2.6": {
     "context_window": 262000,
     "max_output": 262000
    },
    "moonshot/kimi-k2.7-code": {
     "context_window": 262000,
     "max_output": 262000
    }
   }
  },
  "arcee": {
   "api": "https://api.arcee.ai/api/v1",
   "models": {
    "trinity-large-thinking": {
     "context_window": 262144,
     "max_output": 262144
    },
    "deepseek/deepseek-v4-pro-0813": {
     "context_window": 1048576,
     "max_output": 384000
    },
    "deepseek/deepseek-v4-pro": {
     "context_window": 512000,
     "max_output": 384000
    },
    "deepseek/deepseek-v4-flash-latest": {
     "context_window": 1048576,
     "max_output": 384000
    },
    "thinkingmachines/inkling-small": {
     "context_window": 262144,
     "max_output": 262144
    },
    "moonshotai/kimi-k3": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "zai-org/glm-5.2": {
     "context_window": 262144,
     "max_output": 131072
    }
   }
  },
  "drun": {
   "api": "https://chat.d.run/v1",
   "models": {
    "public/deepseek-v3": {
     "context_window": 131072,
     "max_output": 8192
    },
    "public/minimax-m25": {
     "context_window": 204800,
     "max_output": 131072
    },
    "public/deepseek-r1": {
     "context_window": 131072,
     "max_output": 32000
    }
   }
  },
  "amd": {
   "api": "https://developer.amd.com.cn/radeon/api/v1",
   "models": {
    "Qwen3.8-27B": {
     "context_window": 131072,
     "max_output": 32768
    },
    "DeepSeek-V4.1-Flash": {
     "context_window": 1048576,
     "max_output": 384000
    },
    "DeepSeek-V4-Flash": {
     "context_window": 1048576,
     "max_output": 384000
    },
    "Qwen3.8-Flash-Next": {
     "context_window": 262144,
     "max_output": 131072
    },
    "MiniCPM5-2B": {
     "context_window": 131072,
     "max_output": 131072
    },
    "DeepSeek-V4-Flash-Vision-Exp": {
     "context_window": 1000000,
     "max_output": 384000
    }
   }
  },
  "qvac": {
   "api": null,
   "models": {
    "qwen3.5-0.8b": {
     "context_window": 32768,
     "max_output": 8192
    },
    "gemma4-31b": {
     "context_window": 262144,
     "max_output": 32768
    },
    "qwen3.6-35b-a3b": {
     "context_window": 262144,
     "max_output": 65536
    },
    "qwen3.5-2b": {
     "context_window": 32768,
     "max_output": 8192
    },
    "gpt-oss-20b": {
     "context_window": 131072,
     "max_output": 32768
    },
    "qwen3.5-9b": {
     "context_window": 32768,
     "max_output": 8192
    },
    "qwen3.5-4b": {
     "context_window": 32768,
     "max_output": 8192
    },
    "qwen3.6-27b": {
     "context_window": 262144,
     "max_output": 65536
    },
    "gpt-oss-120b": {
     "context_window": 131072,
     "max_output": 32768
    }
   }
  },
  "claudinio": {
   "api": "https://api.claudin.io/v1",
   "models": {
    "claudinio": {
     "context_window": 256000,
     "max_output": 64000
    },
    "claudius": {
     "context_window": 256000,
     "max_output": 64000
    }
   }
  },
  "runinfra": {
   "api": "https://api.runinfra.ai/v1",
   "models": {
    "Inferact/Qwen3.8-2.4T-A95B-NVFP4": {
     "context_window": 262144,
     "max_output": 32768
    },
    "Qwen/Qwen3.8-27B": {
     "context_window": 262144,
     "max_output": 32768
    },
    "deepseek-ai/DeepSeek-V4-Flash-0731": {
     "context_window": 1048576,
     "max_output": 32768
    },
    "deepseek-ai/DeepSeek-V4-Pro-0813": {
     "context_window": 1048576,
     "max_output": 32768
    },
    "zai-org/GLM-5.3-Flash": {
     "context_window": 1048576,
     "max_output": 32768
    },
    "nvidia/NVIDIA-Nemotron-3.5-Lightning-30B-A3B-BF16": {
     "context_window": 262144,
     "max_output": 32768
    },
    "ornith-ai/Ornith-1.5-35B-A3B": {
     "context_window": 262144,
     "max_output": 32768
    }
   }
  },
  "hetzner": {
   "api": "https://inference.hetzner.com/api/v1",
   "models": {
    "Qwen3.8-27B": {
     "context_window": 262144,
     "max_output": 262144
    },
    "Qwen/Qwen3.6-35B-A3B-FP8": {
     "context_window": 262144,
     "max_output": 262144
    }
   }
  },
  "digitalocean": {
   "api": "https://inference.do-ai.run/v1",
   "models": {
    "deepseek-3.2": {
     "context_window": 163840,
     "max_output": 163840
    },
    "openai-gpt-5.5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "openai-gpt-5.2-pro": {
     "context_window": 400000,
     "max_output": 128000
    },
    "all-mini-lm-l6-v2": {
     "max_output": 384
    },
    "multi-qa-mpnet-base-dot-v1": {
     "max_output": 768
    },
    "anthropic-claude-3-opus": {
     "context_window": 200000,
     "max_output": 4096
    },
    "anthropic-claude-4.6-sonnet": {
     "context_window": 200000,
     "max_output": 8192
    },
    "anthropic-claude-haiku-4.5": {
     "context_window": 200000,
     "max_output": 8192
    },
    "glm-5.3-flash": {
     "context_window": 1048576,
     "max_output": 1048576
    },
    "openai-o1": {
     "context_window": 200000,
     "max_output": 100000
    },
    "deepseek-v4-flash-0731": {
     "context_window": 1048576,
     "max_output": 1048576
    },
    "anthropic-claude-opus-4.7": {
     "context_window": 200000,
     "max_output": 8192
    },
    "openai-gpt-6-luna": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "qwen3.8-max": {
     "context_window": 1000000,
     "max_output": 262144
    },
    "kimi-k3": {
     "context_window": 1048576,
     "max_output": 131072
    },
    "anthropic-claude-opus-5.5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "openai-gpt-6-1-sol": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "llama-4-maverick": {
     "context_window": 128000,
     "max_output": 16384
    },
    "openai-o3-mini": {
     "context_window": 200000,
     "max_output": 100000
    },
    "glm-5": {
     "context_window": 64000,
     "max_output": 64000
    },
    "deepseek-v4.1-flash": {
     "context_window": 1048576,
     "max_output": 1048576
    },
    "minimax-m2.5": {
     "context_window": 65536,
     "max_output": 65536
    },
    "anthropic-claude-4.1-opus": {
     "context_window": 200000,
     "max_output": 8192
    },
    "anthropic-claude-sonnet-5.5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "openai-gpt-4o": {
     "context_window": 128000,
     "max_output": 16384
    },
    "anthropic-claude-fable-5.1": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "kimi-k2.6": {
     "context_window": 262144,
     "max_output": 262144
    },
    "deepseek-v3": {
     "context_window": 163840,
     "max_output": 131072
    },
    "deepseek-r1-distill-llama-70b": {
     "context_window": 32678,
     "max_output": 8192
    },
    "openai-gpt-5-nano": {
     "context_window": 400000,
     "max_output": 128000
    },
    "qwen3-embedding-0.6b": {
     "context_window": 8000,
     "max_output": 1024
    },
    "mistral-7b-instruct-v0.3": {
     "context_window": 32768,
     "max_output": 32768
    },
    "qwen-2.5-14b-instruct": {
     "context_window": 131072,
     "max_output": 131072
    },
    "openai-o3": {
     "context_window": 200000,
     "max_output": 100000
    },
    "openai-gpt-5": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai-gpt-4.1": {
     "context_window": 1047576,
     "max_output": 32768
    },
    "openai-gpt-5.1-codex-max": {
     "context_window": 400000,
     "max_output": 128000
    },
    "anthropic-claude-3.5-haiku": {
     "context_window": 200000,
     "max_output": 8192
    },
    "anthropic-claude-3.5-sonnet": {
     "context_window": 200000,
     "max_output": 8192
    },
    "kimi-k2.5": {
     "context_window": 262144,
     "max_output": 262144
    },
    "anthropic-claude-opus-4": {
     "context_window": 200000,
     "max_output": 32000
    },
    "openai-gpt-6-astra": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "openai-gpt-image-2": {
     "max_output": 16384
    },
    "openai-gpt-image-1.5": {
     "max_output": 16384
    },
    "openai-gpt-4o-mini": {
     "context_window": 128000,
     "max_output": 16384
    },
    "qwen3-coder-flash": {
     "context_window": 262144,
     "max_output": 262144
    },
    "deepseek-4-flash": {
     "context_window": 1048576,
     "max_output": 384000
    },
    "nemotron-3-ultra-550b": {
     "context_window": 131072,
     "max_output": 131072
    },
    "openai-gpt-5.2": {
     "context_window": 400000,
     "max_output": 128000
    },
    "nvidia-nemotron-3-super-120b": {
     "context_window": 1000000,
     "max_output": 32768
    },
    "deepseek-v4-pro-0813": {
     "context_window": 1048576,
     "max_output": 1048576
    },
    "mimo-v2.5-pro": {
     "context_window": 262144,
     "max_output": 262144
    },
    "mistral-3-14B": {
     "context_window": 262144,
     "max_output": 128000
    },
    "anthropic-claude-opus-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "nemotron-3-nano-omni": {
     "context_window": 65536,
     "max_output": 65536
    },
    "nemotron-3-nano-30b": {
     "context_window": 262144,
     "max_output": 262144
    },
    "arcee-trinity-large-thinking": {
     "context_window": 128000,
     "max_output": 32000
    },
    "anthropic-claude-5-sonnet": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "openai-gpt-5.4-pro": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "llama3-8b-instruct": {
     "context_window": 131072,
     "max_output": 131072
    },
    "llama3.3-70b-instruct": {
     "context_window": 128000,
     "max_output": 4096
    },
    "openai-gpt-oss-120b": {
     "context_window": 128000,
     "max_output": 4096
    },
    "alibaba-qwen3-32b": {
     "context_window": 32768,
     "max_output": 32768
    },
    "openai-gpt-5.3-codex": {
     "context_window": 400000,
     "max_output": 128000
    },
    "qwen3.5-397b-a17b": {
     "context_window": 131072,
     "max_output": 131072
    },
    "anthropic-claude-3.7-sonnet": {
     "context_window": 200000,
     "max_output": 64000
    },
    "anthropic-claude-opus-4.8": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "openai-gpt-5.6-luna": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "qwen3-tts-voicedesign": {
     "context_window": 32768
    },
    "glm-5.2": {
     "context_window": 262144,
     "max_output": 262144
    },
    "openai-gpt-6-sol": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "anthropic-claude-4.5-sonnet": {
     "context_window": 200000,
     "max_output": 64000
    },
    "bge-m3": {
     "context_window": 8192,
     "max_output": 1024
    },
    "ministral-3-8b-instruct-2512": {
     "context_window": 262144,
     "max_output": 262144
    },
    "openai-gpt-5.6-sol": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "glm-5.1": {
     "context_window": 163840,
     "max_output": 163840
    },
    "openai-gpt-5.4-nano": {
     "context_window": 400000,
     "max_output": 128000
    },
    "bge-reranker-v2-m3": {
     "context_window": 8192
    },
    "nemotron-nano-12b-v2-vl": {
     "context_window": 128000,
     "max_output": 16384
    },
    "openai-gpt-5.4-mini": {
     "context_window": 400000,
     "max_output": 128000
    },
    "openai-gpt-5-mini": {
     "context_window": 400000,
     "max_output": 128000
    },
    "anthropic-claude-opus-4.6": {
     "context_window": 200000,
     "max_output": 8192
    },
    "e5-large-v2": {
     "max_output": 1024
    },
    "anthropic-claude-opus-4.5": {
     "context_window": 200000,
     "max_output": 8192
    },
    "deepseek-v4-pro": {
     "context_window": 1048576,
     "max_output": 384000
    },
    "gemma-4-31B-it": {
     "context_window": 256000,
     "max_output": 8192
    },
    "openai-gpt-5.6-terra": {
     "context_window": 1050000,
     "max_output": 128000
    },
    "glm-5.3": {
     "context_window": 1048576,
     "max_output": 128000
    },
    "gte-large-en-v1.5": {
     "context_window": 8192,
     "max_output": 1024
    },
    "anthropic-claude-fable-5": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "openai-gpt-oss-20b": {
     "context_window": 128000,
     "max_output": 4096
    },
    "openai-gpt-5.4": {
     "context_window": 400000,
     "max_output": 128000
    },
    "mistral-nemo-instruct-2407": {
     "context_window": 128000,
     "max_output": 16384
    },
    "anthropic-claude-sonnet-4": {
     "context_window": 1000000,
     "max_output": 64000
    }
   }
  },
  "aixy": {
   "api": "https://api.aixy-gateway.com/v1",
   "models": {
    "openai/gpt-4.1-mini": {
     "context_window": 1047576,
     "max_output": 32768
    }
   }
  },
  "alibaba-cn": {
   "api": "https://dashscope.aliyuncs.com/compatible-mode/v1",
   "models": {
    "qwen-flash": {
     "context_window": 1000000,
     "max_output": 32768
    },
    "qwen3.5-flash": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "qwen2-5-coder-32b-instruct": {
     "context_window": 131072,
     "max_output": 8192
    },
    "deepseek-v3-2-exp": {
     "context_window": 131072,
     "max_output": 65536
    },
    "deepseek-r1-distill-qwen-14b": {
     "context_window": 32768,
     "max_output": 16384
    },
    "qwen-math-plus": {
     "context_window": 4096,
     "max_output": 3072
    },
    "qwen-deep-research": {
     "context_window": 1000000,
     "max_output": 32768
    },
    "qwen3.7-max": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "qwen2-5-32b-instruct": {
     "context_window": 131072,
     "max_output": 8192
    },
    "qwq-plus": {
     "context_window": 131072,
     "max_output": 8192
    },
    "qwq-32b": {
     "context_window": 131072,
     "max_output": 8192
    },
    "qwen2-5-vl-72b-instruct": {
     "context_window": 131072,
     "max_output": 8192
    },
    "deepseek-v3-1": {
     "context_window": 131072,
     "max_output": 65536
    },
    "qwen3-vl-plus": {
     "context_window": 262144,
     "max_output": 32768
    },
    "qwen-plus-character": {
     "context_window": 32768,
     "max_output": 4096
    },
    "qwen-max": {
     "context_window": 131072,
     "max_output": 8192
    },
    "qwen3-next-80b-a3b-thinking": {
     "context_window": 131072,
     "max_output": 32768
    },
    "qwen3.8-max": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "kimi-k3": {
     "context_window": 1048576,
     "max_output": 1048576
    },
    "qwen2-5-math-7b-instruct": {
     "context_window": 4096,
     "max_output": 3072
    },
    "qwen3.5-plus": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "qwen2-5-72b-instruct": {
     "context_window": 131072,
     "max_output": 8192
    },
    "glm-5": {
     "context_window": 202752,
     "max_output": 16384
    },
    "deepseek-v4.1-flash": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "deepseek-r1-distill-llama-8b": {
     "context_window": 32768,
     "max_output": 16384
    },
    "qwen3-32b": {
     "context_window": 131072,
     "max_output": 16384
    },
    "qwen2-5-coder-7b-instruct": {
     "context_window": 131072,
     "max_output": 8192
    },
    "qwen-plus": {
     "context_window": 1000000,
     "max_output": 32768
    },
    "qwen3.7-flash": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "kimi-k2.6": {
     "context_window": 262144,
     "max_output": 16384
    },
    "qwen3-max": {
     "context_window": 262144,
     "max_output": 65536
    },
    "qwen-omni-turbo-realtime": {
     "context_window": 32768,
     "max_output": 2048
    },
    "deepseek-v3": {
     "context_window": 65536,
     "max_output": 8192
    },
    "deepseek-r1-distill-llama-70b": {
     "context_window": 32768,
     "max_output": 16384
    },
    "qwen3-coder-480b-a35b-instruct": {
     "context_window": 262144,
     "max_output": 65536
    },
    "qwen-turbo": {
     "context_window": 1000000,
     "max_output": 16384
    },
    "deepseek-r1-distill-qwen-7b": {
     "context_window": 32768,
     "max_output": 16384
    },
    "qwen2-5-math-72b-instruct": {
     "context_window": 4096,
     "max_output": 3072
    },
    "qwen3-coder-30b-a3b-instruct": {
     "context_window": 262144,
     "max_output": 65536
    },
    "qwen-doc-turbo": {
     "context_window": 131072,
     "max_output": 8192
    },
    "kimi-k2-thinking": {
     "context_window": 262144,
     "max_output": 16384
    },
    "qwen3.8-omni-flash": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "qvq-max": {
     "context_window": 131072,
     "max_output": 8192
    },
    "qwen2-5-7b-instruct": {
     "context_window": 131072,
     "max_output": 8192
    },
    "qwen3-omni-flash": {
     "context_window": 65536,
     "max_output": 16384
    },
    "qwen-vl-max": {
     "context_window": 131072,
     "max_output": 8192
    },
    "qwen3-235b-a22b": {
     "context_window": 131072,
     "max_output": 16384
    },
    "qwen3-vl-30b-a3b": {
     "context_window": 131072,
     "max_output": 32768
    },
    "kimi-k2.5": {
     "context_window": 262144,
     "max_output": 32768
    },
    "qwen3-next-80b-a3b-instruct": {
     "context_window": 131072,
     "max_output": 32768
    },
    "qwen-vl-plus": {
     "context_window": 131072,
     "max_output": 8192
    },
    "deepseek-r1-distill-qwen-1-5b": {
     "context_window": 32768,
     "max_output": 16384
    },
    "qwen3.6-flash": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "qwen3-coder-flash": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "qwen2-5-omni-7b": {
     "context_window": 32768,
     "max_output": 2048
    },
    "qwen-mt-plus": {
     "context_window": 16384,
     "max_output": 8192
    },
    "tongyi-intent-detect-v3": {
     "context_window": 8192,
     "max_output": 1024
    },
    "qwen3-vl-235b-a22b": {
     "context_window": 131072,
     "max_output": 32768
    },
    "qwen3-coder-plus": {
     "context_window": 1048576,
     "max_output": 65536
    },
    "moonshot-kimi-k2-instruct": {
     "context_window": 131072,
     "max_output": 8192
    },
    "MiniMax-M2.5": {
     "context_window": 204800,
     "max_output": 131072
    },
    "qwen2-5-14b-instruct": {
     "context_window": 131072,
     "max_output": 8192
    },
    "qwen3.8-flash": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "qwen2-5-vl-7b-instruct": {
     "context_window": 131072,
     "max_output": 8192
    },
    "qwen-math-turbo": {
     "context_window": 4096,
     "max_output": 3072
    },
    "qwen-long": {
     "context_window": 10000000,
     "max_output": 8192
    },
    "qwen3.6-max-preview": {
     "context_window": 245800,
     "max_output": 65536
    },
    "qwen-mt-turbo": {
     "context_window": 16384,
     "max_output": 8192
    },
    "qwen3.5-397b-a17b": {
     "context_window": 262144,
     "max_output": 65536
    },
    "qwen3-8b": {
     "context_window": 131072,
     "max_output": 8192
    },
    "glm-5.2": {
     "context_window": 1000000,
     "max_output": 128000
    },
    "qwen-omni-turbo": {
     "context_window": 32768,
     "max_output": 2048
    },
    "glm-5.1": {
     "context_window": 202752,
     "max_output": 128000
    },
    "qwen3-omni-flash-realtime": {
     "context_window": 65536,
     "max_output": 16384
    },
    "qwen3-asr-flash": {
     "context_window": 53248,
     "max_output": 4096
    },
    "deepseek-r1-distill-qwen-32b": {
     "context_window": 32768,
     "max_output": 16384
    },
    "deepseek-r1": {
     "context_window": 131072,
     "max_output": 16384
    },
    "deepseek-v4-pro": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "deepseek-r1-0528": {
     "context_window": 131072,
     "max_output": 16384
    },
    "qwen3.6-plus": {
     "context_window": 1000000,
     "max_output": 65536
    },
    "qwen3-14b": {
     "context_window": 131072,
     "max_output": 8192
    },
    "glm-5.3": {
     "context_window": 1000000,
     "max_output": 131072
    },
    "qwen3.7-plus": {
     "context_window": 1000000,
     "max_output": 64000
    },
    "deepseek-v4-flash": {
     "context_window": 1000000,
     "max_output": 384000
    },
    "qwen-vl-ocr": {
     "context_window": 34096,
     "max_output": 4096
    },
    "siliconflow/deepseek-v3-0324": {
     "context_window": 163840,
     "max_output": 163840
    },
    "siliconflow/deepseek-v3.1-terminus": {
     "context_window": 163840,
     "max_output": 65536
    },
    "siliconflow/deepseek-r1-0528": {
     "context_window": 163840,
     "max_output": 32768
    },
    "siliconflow/deepseek-v3.2": {
     "context_window": 163840,
     "max_output": 65536
    },
    "kimi/kimi-k2.5": {
     "context_window": 262144,
     "max_output": 262144
    },
    "MiniMax/MiniMax-M2.7": {
     "context_window": 204800,
     "max_output": 131072
    }
   }
  }
 }
}
