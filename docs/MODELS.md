# Models

xMonkey ships with four entries. Two run on this machine, two are DeepSeek's API.

| alias | where | model id | notes |
|---|---|---|---|
| `local` | Ollama | `gemma4:12b-it-qat` | default; fast, good at tool use |
| `qwen-uncensored` | Ollama | `qwen3.8-27b-abliterated` | 27B, abliterated (uncensored), 32k ctx |
| `deepseek-flash` | DeepSeek API | `deepseek-v4-flash` | 1M ctx, fast |
| `deepseek-pro` | DeepSeek API | `deepseek-v4-pro` | 1M ctx, strongest |

```bash
xmonkey --list-models          # what is configured
xmonkey doctor                 # does each endpoint actually answer?
xmonkey -m qwen-uncensored     # pick one
xmonkey -m deepseek-pro
```

## The local uncensored Qwen

The official Ollama library has `qwen3.8:27b`, which keeps its safety filtering.
The uncensored build is an **abliterated GGUF on Hugging Face**, so it is created
locally rather than pulled:

```bash
# 1. runtime: GGUF is `qwen35` architecture, needs Ollama >= 0.40
brew upgrade ollama

# 2. weights (~15.4 GB, Q4_K_M)
mkdir -p .models && cd .models
curl -L -o qwen38-27b-abliterated-Q4_K_M.gguf \
  "https://huggingface.co/huihui-ai/Huihui-Qwen3.8-27B-abliterated-GGUF/resolve/main/Huihui-Qwen3.8-27B-abliterated-UD-DW-Q4_K_M.gguf"

# 3. import. Do NOT write a TEMPLATE: the GGUF carries the authoritative Qwen
#    chat template, and Ollama uses it to split reasoning into `thinking` and the
#    answer into `content`. A hand-written template silently leaks the model's
#    reasoning into the visible reply.
cat > Modelfile <<'MF'
FROM ./qwen38-27b-abliterated-Q4_K_M.gguf
PARAMETER num_ctx 32768
PARAMETER temperature 0.7
PARAMETER top_p 0.95
PARAMETER repeat_penalty 1.05
MF
ollama create qwen3.8-27b-abliterated -f Modelfile
```

Verify the split before trusting it:

```bash
curl -s http://127.0.0.1:11434/api/chat -H 'content-type: application/json' \
  -d '{"model":"qwen3.8-27b-abliterated","stream":false,
       "messages":[{"role":"user","content":"Reply with exactly: OK"}]}' \
  | python3 -c "import sys,json;m=json.load(sys.stdin)['message'];print('thinking:',bool(m.get('thinking')),'content:',m.get('content'))"
```

## DeepSeek keys

Keys are **never** stored in `xmonkey.config.json` (which is committed). They live
in `~/.xmonkey/auth.json`, mode `0600`:

```bash
xmonkey setup          # hidden prompt, writes auth.json
```

Resolution order for every provider: `--api-key` → `DEEPSEEK_API_KEY` (or
`ANTHROPIC_API_KEY` / `OPENAI_API_KEY`) → `~/.xmonkey/auth.json`.

`xmonkey doctor` reports `401` until a key is present; that is expected, not a
configuration error.

## Adding any other endpoint

Anything OpenAI-compatible works without new code:

```json
{
  "models": {
    "mine": { "kind": "openai", "baseUrl": "http://127.0.0.1:8000/v1", "model": "whatever" }
  }
}
```

`kind` may be `openai`, `lmstudio`, `llama.cpp`, `vllm`, `openrouter`, `groq`,
`deepseek`, `ollama`, or `anthropic`.
