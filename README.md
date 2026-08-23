# ai-media-mcp

A single-file, zero-dependency MCP server for **image & video generation** across **GPT-Image / Gemini / Grok / Jimeng**, with **zero base64** — everything is saved to disk and only file paths are returned.

> Node.js 18+ required. No `npm install`, no build step. Just run the `.mjs`.

---

## ✨ Features

- **🖼 Image generation** — `generate_image`: one OpenAI-compatible path, model name pass-through (`gpt-image-2` / `gemini-3-pro-image` / `grok-imagine-image-quality` / `doubao-seedream` / Jimeng image models …)
- **🎬 Video generation** — `generate_video` (submit only) / `get_video_status` (poll) / `generate_video_and_wait` (submit → poll → download). Auto-routes Grok video & Jimeng video.
- **🔑 Multi-key routing** — different models automatically use their own API key & base URL (common with relay/aggregator gateways).
- **🚫 Zero base64** — images/videos are saved to local disk; responses only contain `Saved to: ...` (~350 bytes vs ~3 MB with typical MCP wrappers).
- **📚 Capability lookup** — `list_model_capabilities`: query supported resolutions / aspect ratios / durations per model; reverse-lookup (`size: "720p"`, `aspect_ratio: "21:9"`). Zero cost.
- **🖼 Multi-reference images (image-to-image)** — `images` array (up to 5): Gemini native multi-image via multiple `inlineData`; GPT/Grok arrays with automatic `edits → generations` fallback. The requested model is preserved; GPT, Gemini, and Grok have each passed two-reference gateway tests.
- **🎬 Reference-image video (image-to-video)** — single `image` (Grok `image_url`, Jimeng `first_frame_url`) or multiple `images` (Jimeng `reference_image_urls` up to 9, Grok `image_url` array fallback).
- **✍️ Auto prompt enhancement** — `auto_prompt: true` (default): if the prompt is < 15 chars **and** reference images are present, an internal "seamless fusion" template is applied (lighting / perspective / color grading / anti-cutout instructions verified on real generations).
- **🧪 `@chatbox-latest`** — pass `image: "@chatbox-latest"` to auto-read the most recent image dragged into the Chatbox window (`chatbox-blobs\pictureinput-*`). Repeated aliases in `images` preserve the UI attachment order.
- **🔎 Verifiable references** — every generated image reports ordered `reference_images` metadata derived from the exact bytes sent upstream: safe source label, MIME, byte count, dimensions, and SHA-256.
- **📥 Sandbox delivery** — callers can pass their writable sandbox as `output_dir`, keep `return_mode: "path"`, and turn returned files into download cards without moving files from unrelated external directories.

---

## 📦 Install

```bash
# Just clone/copy the mjs and run it directly
node ai-media-mcp.mjs
```

No npm dependencies. Add it to your MCP client (e.g. Chatbox / Claude Desktop) as a stdio server:

```json
{
  "command": "node",
  "args": ["/path/to/ai-media-mcp.mjs"],
  "env": { "...": "see .env.example" }
}
```

---

## ⚙️ Configuration

All variables are **optional**. A group falls back to the unified `AI_MEDIA_API_KEY` / `AI_MEDIA_BASE_URL` only when its group variable is absent. If a group key is explicitly present but empty (for example `AI_MEDIA_JIMENG_API_KEY=`), that group is disabled and will not reuse another provider's key.

| Variable | Group | Description |
|---|---|---|
| `AI_MEDIA_GPT_API_KEY` / `AI_MEDIA_GPT_BASE_URL` | GPT | `gpt-image-2` / `doubao-*` / Jimeng image |
| `AI_MEDIA_GEMINI_API_KEY` / `AI_MEDIA_GEMINI_BASE_URL` | Gemini | native Gemini API (`/v1beta/models/...:generateContent`) |
| `AI_MEDIA_GROK_API_KEY` / `AI_MEDIA_GROK_BASE_URL` | Grok | `grok-imagine-image-quality` / `grok-imagine-video` |
| `AI_MEDIA_JIMENG_API_KEY` / `AI_MEDIA_JIMENG_BASE_URL` | Jimeng | `as-sd2.0-fast` / `video-ds-2.0` |
| `AI_MEDIA_API_KEY` / `AI_MEDIA_BASE_URL` | unified | fallback for all groups |
| `AI_MEDIA_IMAGE_MODEL` | — | default image model (`gpt-image-2`) |
| `AI_MEDIA_VIDEO_MODEL` | — | default video model (`grok-imagine-video`) |
| `AI_MEDIA_IMAGE_OUTPUT_DIR` / `AI_MEDIA_VIDEO_OUTPUT_DIR` | — | output dirs |
| `AI_MEDIA_RETURN_MODE` | — | `path` (default, zero base64) / `inline` / `both` |
| `AI_MEDIA_AUTO_PROMPT` | — | `auto` (default) / `never` |
| `AI_MEDIA_TIMEOUT_MS` / `AI_MEDIA_POLL_INTERVAL_MS` | — | timeouts |

---

## 🧭 Routing

By model name prefix:

| Model prefix | Group | API |
|---|---|---|
| `gemini-*` / `imagen-*` | Gemini | native `/v1beta/models/{model}:generateContent` |
| `grok-*` | Grok | OpenAI-compatible |
| `video-ds*` / `as-sd*` | Jimeng | task-based `/videos` |
| others (`gpt-*`, `doubao-*`, Jimeng image) | GPT | OpenAI-compatible |

---

## 🛠 Tools

| Tool | Purpose |
|---|---|
| `generate_image` | Generate images (n, size/aspect_ratio/quality, `image`/`images` references, `auto_prompt`) |
| `generate_video` | Submit a video task only (Grok/Jimeng auto-route, `image`/`images` supported) |
| `get_video_status` | Query task status |
| `generate_video_and_wait` | Submit → poll → download to `output_dir` (or the configured default), return file path |
| `list_model_capabilities` | Query model capabilities (resolutions/ratios/durations), reverse-lookup by size or ratio |
| `probe_capabilities` | Probe actual supported sizes/ratios via minimal real calls, cache results |

---

## 📄 License

MIT
