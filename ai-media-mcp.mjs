#!/usr/bin/env node
/**
 * AI Media MCP
 * 单文件、零第三方依赖；需要 Node.js 18+。
 *
 * 统一封装多供应商媒体生成（图片 + 视频），默认保存到本地文件并只返回
 * 文件路径（零 base64 进对话上下文，可显式开启 inline 返回）。
 *
 * 图片（OpenAI 兼容 /images/generations，模型名透传）：
 *   gpt-image-2 / gemini-3-pro-image / grok-imagine-image-quality / 即梦 / doubao-seedream ...
 * 视频（自动路由）：
 *   Grok:  /videos/generations 任务式（grok-imagine-video / grok-imagine-video-1.5）
 *   即梦:  /videos 任务式（as-sd2.0-fast / video-ds-2.0 / video-ds-2.0-fast）
 */

import fs from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { gzip as gzipCallback } from "node:zlib";
import { promisify } from "node:util";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const SERVER_NAME = "ai-media-mcp";
const SERVER_VERSION = "1.3.1";
const gzip = promisify(gzipCallback);
const DEFAULT_PROTOCOL_VERSION = "2024-11-05";

/* ----------------------------- 配置 ----------------------------- */

function readPositiveInt(name, fallback) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`环境变量 ${name} 必须是正整数，当前值：${raw}`);
  }
  return value;
}

function normalizeBase(value) {
  const baseUrl = String(value || "").replace(/\/+$/, "");
  if (!baseUrl) return null;
  let parsed;
  try {
    parsed = new URL(baseUrl);
  } catch {
    throw new Error(`无效的 Base URL：${baseUrl}`);
  }
  if (!/^https?:$/.test(parsed.protocol)) {
    throw new Error("Base URL 必须使用 http 或 https 协议");
  }
  return baseUrl;
}

/**
 * 多 Provider 配置：不同模型/平台可绑定不同 key 与 base URL。
 * 优先级：AI_MEDIA_<GROUP>_API_KEY > 统一 AI_MEDIA_API_KEY/OPENAI_API_KEY/JIMENG_API_KEY
 * 组：gpt（OpenAI 兼容图片+GPT视频）、grok（Grok 图片/视频）、gemini（Google 原生）、jimeng（即梦视频/图片）
 */
function getConfig() {
  const fallbackKey = process.env.AI_MEDIA_API_KEY || process.env.OPENAI_API_KEY || process.env.JIMENG_API_KEY || "";
  const fallbackBase = normalizeBase(process.env.AI_MEDIA_BASE_URL || "https://sui-xiang.com/v1");
  const groupKey = (name) => Object.prototype.hasOwnProperty.call(process.env, name)
    ? String(process.env[name] || "").trim()
    : fallbackKey;

  const providers = {
    gpt: {
      key: groupKey("AI_MEDIA_GPT_API_KEY"),
      base: normalizeBase(process.env.AI_MEDIA_GPT_BASE_URL || fallbackBase),
    },
    grok: {
      key: groupKey("AI_MEDIA_GROK_API_KEY"),
      base: normalizeBase(process.env.AI_MEDIA_GROK_BASE_URL || fallbackBase),
    },
    gemini: {
      key: groupKey("AI_MEDIA_GEMINI_API_KEY"),
      base: normalizeBase(process.env.AI_MEDIA_GEMINI_BASE_URL || fallbackBase),
    },
    jimeng: {
      key: groupKey("AI_MEDIA_JIMENG_API_KEY"),
      base: normalizeBase(process.env.AI_MEDIA_JIMENG_BASE_URL || fallbackBase),
    },
  };

  const returnMode = (process.env.AI_MEDIA_RETURN_MODE || "path").trim().toLowerCase();
  if (!["path", "inline", "both"].includes(returnMode)) {
    throw new Error("AI_MEDIA_RETURN_MODE 只能是 path / inline / both");
  }

  const config = {
    providers,
    imageModel: process.env.AI_MEDIA_IMAGE_MODEL || "gpt-image-2",
    autoPrompt: process.env.AI_MEDIA_AUTO_PROMPT || "on",
    requestGzip: (process.env.AI_MEDIA_REQUEST_GZIP || "on").trim().toLowerCase() !== "off",
    videoModel: process.env.AI_MEDIA_VIDEO_MODEL || "grok-imagine-video",
    imageOutputDir: path.resolve(process.env.AI_MEDIA_IMAGE_OUTPUT_DIR || path.join(os.homedir(), "Pictures", "AI-Media")),
    videoOutputDir: path.resolve(process.env.AI_MEDIA_VIDEO_OUTPUT_DIR || path.join(os.homedir(), "Videos", "AI-Media")),
    timeoutMs: readPositiveInt("AI_MEDIA_TIMEOUT_MS", 900000),
    pollIntervalMs: readPositiveInt("AI_MEDIA_POLL_INTERVAL_MS", 5000),
    returnMode,
    extraJimengModels: (process.env.AI_MEDIA_JIMENG_MODELS || "")
      .split(",").map((s) => s.trim()).filter(Boolean),
    capabilitiesCachePath: path.resolve(process.env.AI_MEDIA_CAPABILITIES_CACHE || path.join(os.homedir(), ".ai-media-mcp", "capabilities.json")),
    autoProbe: (process.env.AI_MEDIA_AUTO_PROBE || "off").trim().toLowerCase() === "on",
  };
  return config;
}

/** 按模型名路由到 Provider 组（图片）。 */
function imageProviderOf(config, modelName) {
  const m = String(modelName || "").toLowerCase();
  if (m.startsWith("gemini") || m.startsWith("imagen")) return config.providers.gemini;
  if (m.includes("grok")) return config.providers.grok;
  return config.providers.gpt;
}

/** 按模型名路由到 Provider 组（视频）。 */
function videoProviderOf(config, modelName) {
  const m = String(modelName || "").toLowerCase();
  if (m.includes("video-ds") || m.startsWith("as-sd") || config.extraJimengModels.some((s) => s.toLowerCase() === m)) {
    return config.providers.jimeng;
  }
  return config.providers.grok;
}

function providerOf(config, name) {
  return config.providers[name] || config.providers.gpt;
}

function requireApiKey(provider) {
  if (!provider || !provider.key) {
    throw new Error("缺少 API Key。请设置对应组的 AI_MEDIA_<GROUP>_API_KEY（或统一 AI_MEDIA_API_KEY）");
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function truncate(value, max = 4000) {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.length <= max ? text : `${text.slice(0, max)}…（已截断）`;
}

/* ----------------------------- HTTP ----------------------------- */

class HttpError extends Error {
  constructor(message, status, body, url) {
    super(message);
    this.name = "HttpError";
    this.status = status;
    this.body = body;
    this.url = url;
  }
}

async function fetchWithTimeout(url, options = {}, timeoutMs = 120000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`请求超时（${timeoutMs} ms）：${url}`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function isRequestGzipEnabled() {
  return (process.env.AI_MEDIA_REQUEST_GZIP || "on").trim().toLowerCase() !== "off";
}

function shouldRetryUncompressed(result) {
  if (![400, 406, 415, 422].includes(result.response.status)) return false;
  const text = String(result.text || "").toLowerCase();
  return /gzip|content[-_ ]encoding|compressed|decompress|encoding|invalid json|malformed body|request body/.test(text);
}

async function apiJson(provider, method, url, body, timeoutMs, extraHeaders = {}) {
  requireApiKey(provider);
  const serialized = body === undefined ? undefined : JSON.stringify(body);

  async function send(useGzip) {
    const headers = {
      Authorization: `Bearer ${provider.key}`,
      Accept: "application/json",
      "Accept-Encoding": "gzip",
      ...extraHeaders,
    };
    let requestBody = serialized;
    if (serialized !== undefined) {
      headers["Content-Type"] = "application/json";
      if (useGzip) {
        requestBody = await gzip(Buffer.from(serialized, "utf8"));
        headers["Content-Encoding"] = "gzip";
      }
    }
    const response = await fetchWithTimeout(url, {
      method,
      headers,
      body: requestBody,
    }, timeoutMs ?? 120000);
    const text = await response.text();
    let data;
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      data = { raw_text: text };
    }
    return { response, text, data };
  }

  let result = await send(serialized !== undefined && isRequestGzipEnabled());
  // Third-party relays may support gzip responses but not compressed request bodies.
  if (!result.response.ok && serialized !== undefined && (result.response.status === 415 || shouldRetryUncompressed(result))) {
    result = await send(false);
  }
  if (!result.response.ok) {
    throw new HttpError(
      `上游接口返回 HTTP ${result.response.status}：${truncate(result.text || result.response.statusText)}`,
      result.response.status,
      result.data,
      url,
    );
  }
  return result.data;
}

async function fetchBytes(url, headers = {}, timeoutMs = 300000) {
  headers = { ...headers, "Accept-Encoding": "gzip" };
  const response = await fetchWithTimeout(url, { headers, redirect: "follow" }, timeoutMs);
  if (!response.ok) {
    throw new Error(`下载失败：HTTP ${response.status} ${truncate(await response.text(), 1000)}`);
  }
  const buffer = Buffer.from(await response.arrayBuffer());
  if (!buffer.length) throw new Error(`下载内容为空: ${url}`);
  return { buffer, contentType: response.headers.get("content-type") || "" };
}

/* ------------------------- 通用提取工具 ------------------------- */

function valueAt(obj, keys) {
  let current = obj;
  for (const key of keys) {
    if (current == null || typeof current !== "object") return undefined;
    current = current[key];
  }
  return current;
}

function firstValue(obj, paths) {
  for (const keys of paths) {
    const value = valueAt(obj, keys);
    if (value !== undefined && value !== null && value !== "") return value;
  }
  return undefined;
}

function extractTaskId(data) {
  return firstValue(data, [
    ["request_id"], ["id"], ["task_id"],
    ["data", "request_id"], ["data", "id"], ["data", "task_id"],
    ["result", "request_id"], ["result", "id"], ["result", "task_id"],
  ]);
}

function extractVideoUrl(data) {
  const direct = firstValue(data, [
    ["url"], ["video_url"], ["content_url"], ["file_url"],
    ["data", "url"], ["data", "video_url"], ["data", "content_url"], ["data", "file_url"],
    ["output", "url"], ["output", "video_url"], ["result", "url"],
    ["result", "video_url"], ["video", "url"],
  ]);
  if (direct) return direct;
  if (Array.isArray(data?.data)) {
    for (const item of data.data) {
      const found = item?.url || item?.video_url || item?.content_url;
      if (found) return found;
    }
  }
  return undefined;
}

function extractVideoBase64(data) {
  return firstValue(data, [
    ["video_base64"], ["b64_json"], ["base64"],
    ["data", "video_base64"], ["data", "b64_json"], ["data", "base64"],
    ["output", "video_base64"], ["output", "b64_json"],
    ["result", "video_base64"], ["result", "b64_json"],
  ]);
}

function extractProgress(data) {
  const value = firstValue(data, [
    ["progress"], ["percent"], ["data", "progress"], ["data", "percent"], ["result", "progress"],
  ]);
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function extractErrorMessage(data) {
  const value = firstValue(data, [
    ["error", "message"], ["error"], ["message"],
    ["data", "error", "message"], ["data", "message"],
    ["result", "error", "message"], ["result", "message"],
  ]);
  if (typeof value === "string") return value;
  return value ? truncate(value) : "上游未提供失败原因";
}

function normalizeStatus(data) {
  const raw = firstValue(data, [
    ["status"], ["state"], ["task_status"],
    ["data", "status"], ["data", "state"], ["result", "status"], ["result", "state"],
  ]);
  const status = String(raw || "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  if (["pending", "queued", "waiting", "submitted", "created", "not_started"].includes(status)) return "pending";
  if (["processing", "in_progress", "running", "generating", "rendering", "started"].includes(status)) return "processing";
  if (["completed", "succeeded", "success", "done", "finished", "ready"].includes(status)) return "completed";
  if (["failed", "failure", "error", "cancelled", "canceled", "rejected", "expired"].includes(status)) return status === "expired" ? "expired" : "failed";
  if (!status && (extractVideoUrl(data) || extractVideoBase64(data))) return "completed";
  return "unknown";
}

/* --------------------------- 文件工具 --------------------------- */

function mimeFromBuffer(buffer, ext = "") {
  if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return "image/png";
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return "image/jpeg";
  if (buffer.length >= 12 && buffer.toString("ascii", 0, 4) === "RIFF" && buffer.toString("ascii", 8, 12) === "WEBP") return "image/webp";
  if (buffer.length >= 6 && /^GIF8[79]a$/.test(buffer.toString("ascii", 0, 6))) return "image/gif";
  const map = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif", ".mp4": "video/mp4", ".webm": "video/webm", ".mov": "video/quicktime" };
  return map[ext.toLowerCase()];
}

function safePart(value, fallback) {
  const result = String(value || "").replace(/[^a-zA-Z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48);
  return result || fallback;
}

function timestampPart() {
  return new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}Z$/, "Z");
}

async function writeBuffer(outputDir, filename, buffer) {
  await fs.mkdir(outputDir, { recursive: true });
  const outputPath = path.join(outputDir, filename);
  await fs.writeFile(outputPath, buffer);
  return outputPath;
}

function looksLikeBase64(text) {
  const compact = text.replace(/\s+/g, "");
  return compact.length >= 16 && compact.length % 4 === 0 && /^[A-Za-z0-9+/]+={0,2}$/.test(compact);
}

function imageDimensions(buffer, mime = "") {
  try {
    if (mime === "image/png" && buffer.length >= 24) {
      return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
    }
    if (mime === "image/gif" && buffer.length >= 10) {
      return { width: buffer.readUInt16LE(6), height: buffer.readUInt16LE(8) };
    }
    if (mime === "image/webp" && buffer.length >= 30) {
      const kind = buffer.toString("ascii", 12, 16);
      if (kind === "VP8X") {
        return { width: 1 + buffer.readUIntLE(24, 3), height: 1 + buffer.readUIntLE(27, 3) };
      }
      if (kind === "VP8 ") {
        return { width: buffer.readUInt16LE(26) & 0x3fff, height: buffer.readUInt16LE(28) & 0x3fff };
      }
      if (kind === "VP8L" && buffer.length >= 25) {
        const bits = buffer.readUInt32LE(21);
        return { width: (bits & 0x3fff) + 1, height: ((bits >>> 14) & 0x3fff) + 1 };
      }
    }
    if (mime === "image/jpeg") {
      let offset = 2;
      while (offset + 9 < buffer.length) {
        if (buffer[offset] !== 0xff) { offset++; continue; }
        const marker = buffer[offset + 1];
        if (marker === 0xd8 || marker === 0xd9 || marker === 0x01) { offset += 2; continue; }
        if (offset + 4 > buffer.length) break;
        const length = buffer.readUInt16BE(offset + 2);
        if (length < 2) break;
        if ((marker >= 0xc0 && marker <= 0xc3) || (marker >= 0xc5 && marker <= 0xc7)
          || (marker >= 0xc9 && marker <= 0xcb) || (marker >= 0xcd && marker <= 0xcf)) {
          return { width: buffer.readUInt16BE(offset + 7), height: buffer.readUInt16BE(offset + 5) };
        }
        offset += 2 + length;
      }
    }
  } catch {}
  return { width: null, height: null };
}

function referenceFromBuffer(buffer, mime, sourceType, sourceLabel) {
  const detectedMime = mimeFromBuffer(buffer) || mime || "image/png";
  const dimensions = imageDimensions(buffer, detectedMime);
  return {
    value: `data:${detectedMime};base64,${buffer.toString("base64")}`,
    diagnostic: {
      source_type: sourceType,
      source_label: sourceLabel,
      mime_type: detectedMime,
      bytes: buffer.length,
      width: dimensions.width,
      height: dimensions.height,
      sha256: createHash("sha256").update(buffer).digest("hex"),
    },
  };
}

/** 将图片输入归一化为 Data URL（用于图生视频）。 */
/* Chatbox 最近拖入的图片（pictureinput blob）自动解析 */
async function resolveChatboxLatestReference(offset = 0) {
  const home = typeof process.env.USERPROFILE === "string" ? process.env.USERPROFILE : "";
  if (!home) throw new Error("无法确定用户主目录（USERPROFILE 未设置），请直接传图片路径/URL/Base64");
  const blobDir = path.join(home, "AppData", "Roaming", "xyz.chatboxapp.app", "chatbox-blobs");
  let entries = [];
  try {
    entries = await fs.readdir(blobDir);
  } catch (error) {
    throw new Error(`Chatbox 图片目录不可读: ${error.message}。请直接传图片路径/URL/Base64`);
  }
  const candidates = [];
  for (const name of entries) {
    if (!name.startsWith("pictureinput-")) continue;
    const full = path.join(blobDir, name);
    try {
      const stat = await fs.stat(full);
      if (stat.isFile()) candidates.push({ name, full, mtime: stat.mtimeMs });
    } catch {}
  }
  if (!candidates.length) throw new Error("Chatbox 里还没有找到拖入的图片，请先拖一张图到聊天框");
  candidates.sort((a, b) => b.mtime - a.mtime);
  const latest = candidates[offset];
  if (!latest) throw new Error(`Chatbox 中没有第 ${offset + 1} 张最近拖入的图片`);
  const text = await fs.readFile(latest.full, "utf8");
  const match = text.match(/^data:image\/([a-zA-Z0-9.+-]+);base64,([A-Za-z0-9+/=]+)/);
  const raw = match ? Buffer.from(match[2], "base64") : Buffer.from(text.replace(/^\s*data:[^,]+,/, ""), "base64");
  const kind = match ? match[1] : "png";
  const mime = kind.includes("jpeg") || kind.includes("jpg") ? "image/jpeg" : `image/${kind}`;
  if (!mimeFromBuffer(raw)) throw new Error(`Chatbox 图片内容无法识别：${latest.name}`);
  console.error(`[ai-media] 已从 Chatbox 自动读取参考图: ${latest.name} (${(raw.length / 1024).toFixed(0)}KB)`);
  return referenceFromBuffer(raw, mime, "chatbox_attachment", latest.name);
}

async function resolveChatboxLatestImage(offset = 0) {
  return (await resolveChatboxLatestReference(offset)).value;
}

async function normalizeImageReference(image) {
  if (typeof image !== "string" || !image.trim()) throw new Error("image 必须是非空字符串");
  const input = image.trim();
  const latestMatch = input.match(/^@(chatbox-latest|latest)(?:-(\d+))?$/i);
  if (latestMatch) {
    const explicitOffset = latestMatch[2] ? Math.max(0, Number(latestMatch[2]) - 1) : 0;
    return await resolveChatboxLatestReference(explicitOffset);
  }
  if (/^https?:\/\//i.test(input)) {
    const parsed = new URL(input);
    return {
      value: input,
      diagnostic: {
        source_type: "public_url",
        source_label: `${parsed.hostname}${path.basename(parsed.pathname) ? `/${path.basename(parsed.pathname)}` : ""}`,
        mime_type: null,
        bytes: null,
        width: null,
        height: null,
        sha256: null,
      },
    };
  }
  if (/^data:image\/[a-z0-9.+-]+;base64,/i.test(input)) {
    const parsed = stripDataUri(input);
    const buffer = Buffer.from(parsed.data.replace(/\s+/g, ""), "base64");
    if (!buffer.length || !mimeFromBuffer(buffer)) throw new Error("Data URL 内容不是可识别的图片");
    return referenceFromBuffer(buffer, parsed.mime, "data_url", "inline-data-url");
  }

  try {
    const stat = await fs.stat(input);
    if (!stat.isFile()) throw new Error(`图片路径不是文件：${input}`);
    const ext = path.extname(input).toLowerCase();
    const allowed = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif", ".bmp"]);
    if (!allowed.has(ext)) throw new Error(`不支持的图片格式 ${ext || "（无扩展名）"}；支持 JPG、PNG、WebP、GIF、BMP`);
    const buffer = await fs.readFile(input);
    const mime = mimeFromBuffer(buffer, ext);
    if (!mime) throw new Error("无法识别本地图片格式");
    return referenceFromBuffer(buffer, mime, "local_file", path.basename(input));
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }

  if (looksLikeBase64(input)) {
    const compact = input.replace(/\s+/g, "");
    const buffer = Buffer.from(compact, "base64");
    const mime = mimeFromBuffer(buffer);
    if (!mime) throw new Error("Base64 内容不是可识别的 JPG、PNG、WebP、GIF 或 BMP 图片");
    return referenceFromBuffer(buffer, mime, "base64", "inline-base64");
  }
  throw new Error(`图片既不是 HTTP(S)/Data URL、有效 Base64，也不是可读取的本地文件：${input}`);
}

async function normalizeImageInput(image) {
  return (await normalizeImageReference(image)).value;
}

/* --------------------------- 图片生成 --------------------------- */

function imageExt(mimeType, url, fallback = "png") {
  const type = String(mimeType || "").toLowerCase();
  if (type.includes("jpeg") || type.includes("jpg")) return "jpg";
  if (type.includes("webp")) return "webp";
  if (type.includes("gif")) return "gif";
  try {
    const ext = path.extname(new URL(url).pathname).toLowerCase();
    if ([".jpg", ".jpeg", ".png", ".webp", ".gif"].includes(ext)) return ext.slice(1);
  } catch {}
  return fallback;
}

function stripDataUri(value) {
  const text = String(value || "");
  const match = text.match(/^data:([a-z0-9.+-]+\/[a-z0-9.+-]+);base64,(.+)$/is);
  if (match) return { mime: match[1], data: match[2] };
  const match2 = text.match(/^data:[^,]+,([A-Za-z0-9+/=]+)$/);
  if (match2) return { mime: "image/png", data: match2[1] };
  return { mime: "image/png", data: text };
}

async function normalizeReferenceList(values) {
  return (await normalizeReferenceListDetailed(values)).map((item) => item.value);
}

async function normalizeReferenceListDetailed(values) {
  const items = Array.isArray(values) ? values.filter((x) => typeof x === "string" && x.trim()) : [];
  const implicitLatestTotals = new Map();
  for (const item of items) {
    const match = item.trim().match(/^@(chatbox-latest|latest)$/i);
    if (!match) continue;
    const key = match[1].toLowerCase();
    implicitLatestTotals.set(key, (implicitLatestTotals.get(key) || 0) + 1);
  }

  const latestUseCount = new Map();
  const result = [];
  for (const item of items) {
    const value = item.trim();
    const latestMatch = value.match(/^@(chatbox-latest|latest)$/i);
    if (latestMatch) {
      const key = latestMatch[1].toLowerCase();
      const used = latestUseCount.get(key) || 0;
      latestUseCount.set(key, used + 1);
      // Chatbox writes attachments in UI order, while the cache scan is newest-first.
      // Reverse only the selected group so repeated aliases preserve image 1, image 2, ... order.
      const offset = implicitLatestTotals.get(key) - used - 1;
      result.push(await resolveChatboxLatestReference(offset));
    } else {
      result.push(await normalizeImageReference(value));
    }
  }
  return result.map((item, index) => ({
    ...item,
    diagnostic: { index: index + 1, ...item.diagnostic },
  }));
}

async function saveImageItem(outputDir, item, index, total) {
  let buffer;
  let mime = item?.mime_type || "";
  if (item?.b64_json || (typeof item?.data === "string" && looksLikeBase64(item.data))) {
    const source = item.b64_json || item.data;
    const parsed = stripDataUri(source);
    buffer = Buffer.from(parsed.data.replace(/\s+/g, ""), "base64");
    if (!buffer.length) throw new Error("上游返回的图片 Base64 为空或无效");
    mime = mime || parsed.mime;
  } else if (item?.url) {
    const downloaded = await fetchBytes(item.url);
    buffer = downloaded.buffer;
    mime = downloaded.contentType || mime;
  } else {
    throw new Error(`图片项 #${index + 1} 缺少 b64_json/url 数据`);
  }
  const ext = imageExt(mime, item?.url);
  const suffix = total > 1 ? `-${index + 1}` : "";
  const filename = `ai-img-${timestampPart()}-${safePart(item?.model ?? item?.id ?? "img", "img")}${suffix}.${ext}`;
  return writeBuffer(outputDir, filename, buffer);
}

function shouldRetryWithoutBadField(error, field) {
  if (!(error instanceof HttpError) || ![400, 422].includes(error.status)) return false;
  const text = JSON.stringify(error.body || "").toLowerCase();
  const mentions = text.includes(field.toLowerCase());
  const schemaProblem = /unknown|unrecognized|unexpected|unsupported field|extra input|additional propert|not permitted|invalid.*field|field.*invalid/.test(text);
  return mentions && schemaProblem;
}

function geminiEndpoint(provider, modelName) {
  let base = (provider.base || "https://sui-xiang.com").replace(/\/+$/, "");
  // 归一化常见 base 写法（纯域名 / 带 /v1/beta / 带 /v1beta / 带 /v1），统一生成 <base>/v1beta/models/<model>:generateContent
  // 注意：若配置成 https://sui-xiang.com/v1（与 GPT/Grok 同值）也会归一化，避免拼出 /v1/v1beta 错误
  base = base.replace(/\/(v1\/)?beta$/i, "").replace(/\/v1beta$/i, "").replace(/\/v1$/i, "");
  return `${base}/v1beta/models/${encodeURIComponent(modelName)}:generateContent`;
}

async function generateGeminiImage(provider, args, modelName) {
  // Gemini 原生 API：POST {base}/models/{model}:generateContent
  // 与 assets-gen-mcp 行为对齐：aspect_ratio 拼入 prompt 文本（sui-xiang 中转站约定）
  const aspectRatio = args.aspect_ratio || "1:1";
  const promptText = aspectRatio !== "1:1" && !args.size
    ? `${args.prompt.trim()} (aspect ratio: ${aspectRatio})`
    : args.prompt.trim();

  const body = {
    contents: [{ role: "user", parts: [{ text: promptText }] }],
  };

  // 参考图：转 inlineData（Gemini 原生支持多模态输入，支持多张）。
  // 调用方可传入已归一化对象，确保诊断与实际 payload 使用同一份字节。
  const normalizedReferences = Array.isArray(args._normalizedReferences)
    ? args._normalizedReferences
    : await normalizeReferenceListDetailed([
      ...(Array.isArray(args.images) ? args.images : []),
      ...(typeof args.image === "string" && args.image.trim() ? [args.image] : []),
    ]);
  for (const reference of normalizedReferences) {
    const { mime, data } = stripDataUri(reference.value);
    body.contents[0].parts.push({ inlineData: { mimeType: mime, data } });
  }

  // size 映射为 aspectRatio 提示（1024x1024 → 1:1 等）
  if (args.size && !args.aspect_ratio && /^(\d+)x(\d+)$/.test(args.size)) {
    const [, w, h] = args.size.match(/^(\d+)x(\d+)$/);
    const ratio = normalizeRatio(Number(w), Number(h));
    if (ratio) {
      body.contents[0].parts[0].text = `${args.prompt.trim()} (aspect ratio: ${ratio})`;
    }
  }

  const endpoint = geminiEndpoint(provider, modelName);
  const headers = {
    Authorization: `Bearer ${provider.key}`,
    "x-goog-api-key": provider.key,
    "Content-Type": "application/json",
    "Accept-Encoding": "gzip",
  };
  const data = await apiJson(provider, "POST", endpoint, body, 300000, {
    "x-goog-api-key": provider.key,
  });

  const items = extractGeminiItems(data);
  if (!items.length) throw new Error(`Gemini 生成成功但无图片数据：${truncate(data, 1500)}`);
  return items;
}

function normalizeRatio(width, height) {
  const gcd = (a, b) => (b === 0 ? a : gcd(b, a % b));
  const d = gcd(width, height);
  if (d === 0) return null;
  const w = width / d, h = height / d;
  const map = { "1:1": "1:1", "4:3": "4:3", "3:4": "3:4", "16:9": "16:9", "9:16": "9:16", "2:3": "2:3", "3:2": "3:2" };
  return map[`${w}:${h}`] || null;
}

function extractGeminiItems(data) {
  const items = [];
  const candidates = data?.candidates || [];
  for (const candidate of candidates) {
    for (const part of candidate?.content?.parts || []) {
      const inline = part?.inlineData;
      if (inline && inline.data) {
        items.push({ b64_json: inline.data, mime_type: inline.mimeType || "image/png" });
      } else if (part?.fileData?.fileUri) {
        items.push({ url: part.fileData.fileUri, mime_type: part.fileData.mimeType || "image/png" });
      }
    }
  }
  if (!items.length) {
    const fileUri = data?.candidates?.[0]?.content?.parts?.[0]?.fileData?.fileUri;
    if (fileUri) items.push({ url: fileUri, mime_type: "image/png" });
  }
  return items;
}

// —— 内置提示词增强模板（2026-08 实测验证有效）—— 解决"参考图贴图感"
function buildSeamlessPrompt(userPrompt, refCount) {
  const theme = String(userPrompt || "").trim();
  const parts = [
    "Create a photorealistic cinematic composite where the reference " + (refCount >= 2 ? "images" : "image") + " " + (refCount >= 2 ? "are" : "is") + " seamlessly integrated into a well-composed, coherent photograph.",
    "",
    "ABSOLUTE REQUIREMENTS:",
    "1. Subject fidelity: preserve the exact appearance, face, hairstyle, figure, outfit and pose of the reference subject(s) — do not redesign them.",
    "2. Physical presence (critical): the subject must STAND INSIDE the scene with correct perspective, scale and vanishing point. Same directional light source: shadows fall consistently, the subject's clothing reflects ambient colors, and there is a believable contact shadow on the ground. Add subtle rim light and environmental reflections.",
    "3. Unified color: single white balance, matched contrast and saturation between subject and background. The subject must not look brighter or more saturated than the scene.",
    "4. NO CUT-OUT: no visible seams, no floating figure, no plastic look, no pasted-on edges. It must look like the subject was photographed at that location.",
    "5. Cinematic rendering: 85mm lens, shallow depth of field, subject in sharp focus with natural foreground/background blur, film-grade color grading, golden-hour mood.",
    "",
  ];
  if (theme && theme.length < 15) {
    parts.push("USER INTENT: " + theme);
    parts.push("Interpret the user's short intent above as the core theme of the composite. Keep it simple and faithful — do not invent extra features beyond it.");
    parts.push("");
  }
  parts.push("Output: ONE composite image only, no text, no watermark.");
  return parts.join("\n");
}

async function generateImage(config, args) {
  if (typeof args.prompt !== "string" || !args.prompt.trim()) throw new Error("prompt 必须是非空字符串");

  // —— 多图参考路由策略（2026-08-27 实测取消自动切换）——
  // 此前：多图（≥2张）自动强制切 Gemini（实测 Grok/GPT 网关多图参考失效）。
  // 2026-08-27 用两张原图测试结论：sui-xiang GPT / Gemini / Grok + akile GPT 四个通道均可正常多图参考
  // → 取消自动切换，尊重用户指定模型，仅保留软提示（multi_ref_hint）。
  const refCountForRoute = (Array.isArray(args.images) ? args.images.filter(x => typeof x === "string" && x.trim()).length : 0)
    + (typeof args.image === "string" && args.image.trim() ? 1 : 0);
  const autoPrompted = config.autoPrompt !== "never"
    && args.auto_prompt !== false
    && refCountForRoute >= 1
    && args.prompt.trim().length < 15;
  const effectivePrompt = autoPrompted
    ? buildSeamlessPrompt(args.prompt.trim(), refCountForRoute)
    : args.prompt.trim();
  let modelName = args.model || config.imageModel;
  let provider = imageProviderOf(config, modelName);
  let routedUpgrade = null;
  // 仅提示，不切换：多图 + 用户未显式指定 Gemini 时，在返回里给出建议
  if (refCountForRoute >= 2 && provider === config.providers.gpt && config.providers.gemini && config.providers.gemini.key) {
    // 不强制切 Gemini，只留提示
    routedUpgrade = null; // 保留变量，避免下游报错
    // 注意：以下不再改变 modelName/provider；仅记录软提示
  }
  requireApiKey(provider);

  const normalizedReferences = await normalizeReferenceListDetailed([
    ...(Array.isArray(args.images) ? args.images : []),
    ...(typeof args.image === "string" && args.image.trim() ? [args.image] : []),
  ]);
  const referenceDiagnostics = normalizedReferences.map((item) => item.diagnostic);

  // Gemini 原生 API 路由
  if (provider === config.providers.gemini) {
    const items = await generateGeminiImage(provider, {
      ...args,
      prompt: effectivePrompt,
      _normalizedReferences: normalizedReferences,
    }, modelName);
    const outputDir = path.resolve(args.output_dir || config.imageOutputDir);
    const savedPaths = [];
    for (let i = 0; i < items.length; i++) {
      savedPaths.push(await saveImageItem(outputDir, items[i], i, items.length));
    }
    return {
      ok: true,
      provider: "gemini-native",
      model: modelName,
      routed_upgrade: routedUpgrade,
      auto_prompted: autoPrompted,
      reference_count: normalizedReferences.length,
      reference_images: referenceDiagnostics,
      image_to_image: normalizedReferences.length > 0,
      endpoint: geminiEndpoint(provider, modelName),
      count: savedPaths.length,
      files: savedPaths,
      output_dir: outputDir,
      base_url: provider.base,
    };
  }

  // 参考图：使用上面同一次归一化的结果，避免附件顺序或字节在请求前发生变化。
  const refImages = normalizedReferences.map((item) => item.value);

  const payload = {
    model: modelName,
    prompt: effectivePrompt,
  };
  if (args.n !== undefined) {
    if (!Number.isInteger(args.n) || args.n < 1 || args.n > 10) throw new Error("n 必须是 1 到 10 的整数");
    payload.n = args.n;
  }
  if (args.size) payload.size = String(args.size);
  if (args.quality) payload.quality = String(args.quality);
  if (args.aspect_ratio && !args.size) payload.aspect_ratio = String(args.aspect_ratio);
  if (args.resolution) payload.resolution = String(args.resolution);
  payload.response_format = "b64_json";

  let raw;
  let usedEndpoint = `${provider.base}/images/generations`;
  if (refImages.length > 0) {
    // —— 图生图：优先标准 /images/edits（OpenAI 官方编辑接口，支持多张参考图） ——
    const editPayload = {
      model: modelName,
      prompt: effectivePrompt,
      // sui-xiang 的历史实测格式：images:[{ image_url: <dataURL> }]。
      // 保留对象包装，避免网关把裸 data URL 数组当作无效字段而静默丢弃。

      images: refImages.map((item) => ({ image_url: item })),
      response_format: "b64_json",
    };
    if (args.n !== undefined) editPayload.n = payload.n;
    if (args.size) editPayload.size = payload.size;
    if (args.quality) editPayload.quality = payload.quality;
    try {
      raw = await apiJson(provider, "POST", `${provider.base}/images/edits`, editPayload, 300000);
      usedEndpoint = `${provider.base}/images/edits`;
    } catch (editError) {
      // edits 不可用（404/405/不支持）→ 回退 generations + image_url
      const okToFallback = editError instanceof HttpError
        ? [404, 405, 400, 422].includes(editError.status)
        : true;
      if (!okToFallback) throw editError;
      if (refImages.length === 1) {
        payload.image_url = refImages[0];
      } else {
        // 修复：回退 generations 时也用网关认可的 { image_url } 格式（原裸 dataURL 数组会被忽略 → 丢图）
        payload.images = refImages.map((item) => ({ image_url: item }));
      }
      try {
        raw = await apiJson(provider, "POST", `${provider.base}/images/generations`, payload, 300000);
        usedEndpoint = `${provider.base}/images/generations?image_url`;
      } catch (generationError) {
        if (shouldFallbackImageField(generationError)) {
          if (refImages.length === 1) {
            payload.image = refImages[0];
            delete payload.image_url;
          } else {
            payload.image = refImages;
            delete payload.images;
          }
          raw = await apiJson(provider, "POST", `${provider.base}/images/generations`, payload, 300000);
          usedEndpoint = `${provider.base}/images/generations?image`;
        } else {
          throw generationError;
        }
      }
    }
  } else {
    try {
      raw = await apiJson(provider, "POST", `${provider.base}/images/generations`, payload, 300000);
    } catch (error) {
      // 部分网关拒绝 response_format，去掉后重试一次
      if (shouldRetryWithoutBadField(error, "response_format")) {
        delete payload.response_format;
        raw = await apiJson(provider, "POST", `${provider.base}/images/generations`, payload, 300000);
      } else {
        throw error;
      }
    }
  }

  let items = Array.isArray(raw?.data) ? raw.data : [];
  if (Array.isArray(raw)) items = raw;
  if (!items.length) throw new Error(`生成成功但响应中没有图片数据：${truncate(raw, 1500)}`);

  const outputDir = path.resolve(args.output_dir || config.imageOutputDir);
  const savedPaths = [];
  for (let i = 0; i < items.length; i++) {
    savedPaths.push(await saveImageItem(outputDir, items[i], i, items.length));
  }

  return {
    ok: true,
    provider: "openai-compatible",
    model: payload.model,
    count: savedPaths.length,
    files: savedPaths,
    output_dir: outputDir,
    base_url: provider.base,
    endpoint: usedEndpoint,
    image_to_image: refImages.length > 0,
    reference_count: refImages.length,
    reference_images: referenceDiagnostics,
    auto_prompted: autoPrompted,
  };
}

/* --------------------------- 视频生成 --------------------------- */

const JIMENG_MODELS = new Set(["as-sd2.0-fast", "video-ds-2.0-fast", "video-ds-2.0"]);
const JIMENG_ASPECTS = new Set(["9:16", "16:9"]);

function isJimengModel(model, config) {
  const m = String(model || "").toLowerCase();
  if (m.includes("video-ds") || m.startsWith("as-sd")) return true;
  return config.extraJimengModels.some((s) => s.toLowerCase() === m);
}

function videoExt(contentType, sourceUrl) {
  const type = String(contentType || "").toLowerCase();
  if (type.includes("webm")) return ".webm";
  if (type.includes("quicktime")) return ".mov";
  if (type.includes("matroska")) return ".mkv";
  try {
    const ext = path.extname(new URL(sourceUrl).pathname).toLowerCase();
    if ([".mp4", ".webm", ".mov", ".mkv"].includes(ext)) return ext;
  } catch {}
  return ".mp4";
}

async function saveVideoBuffer(config, mode, taskId, buffer, contentType, outputDir = null) {
  const ext = videoExt(contentType, "");
  const filename = `ai-vid-${timestampPart()}-${safePart(mode, "video")}-${safePart(taskId, "task")}${ext}`;
  return writeBuffer(path.resolve(outputDir || config.videoOutputDir), filename, buffer);
}

function validateCommonVideoArgs(args) {
  if (args.duration !== undefined && (!Number.isInteger(args.duration) || args.duration <= 0)) {
    throw new Error("duration 必须是正整数秒");
  }
  for (const name of ["aspect_ratio", "resolution"]) {
    if (args[name] !== undefined && (typeof args[name] !== "string" || !args[name].trim())) {
      throw new Error(`${name} 必须是非空字符串`);
    }
  }
}

/* ---- Grok 视频（/videos/generations） ---- */

function makeGrokPayload(model, prompt, args) {
  const payload = { model };
  if (prompt !== undefined && prompt !== null && String(prompt).trim()) payload.prompt = String(prompt).trim();
  if (args.duration !== undefined) payload.duration = args.duration;
  if (args.aspect_ratio !== undefined) payload.aspect_ratio = args.aspect_ratio.trim();
  if (args.resolution !== undefined) payload.resolution = args.resolution.trim();
  return payload;
}

function shouldFallbackImageField(error) {
  if (!(error instanceof HttpError) || ![400, 422].includes(error.status)) return false;
  const text = JSON.stringify(error.body || "").toLowerCase();
  const fieldMentioned = /image|image_url|input_image/.test(text);
  const schemaProblem = /unknown|unrecognized|unexpected|unsupported field|extra input|additional propert|not permitted|required|missing/.test(text);
  const invalidContent = /invalid image|decode|corrupt|too large|format|mime/.test(text);
  return fieldMentioned && schemaProblem && !invalidContent;
}

async function submitGrokVideo(config, args) {
  validateCommonVideoArgs(args);
  const model = args.model || config.videoModel;
  const provider = videoProviderOf(config, model);
  const hasImage = typeof args.image === "string" && args.image.trim().length > 0;
  const imagesArg = Array.isArray(args.images) ? args.images.filter((x) => typeof x === "string" && x.trim()) : [];
  const useMultiple = !hasImage && imagesArg.length > 0;
  let payload;
  let usedField = null;

  if (hasImage || useMultiple) {
    const imgList = [];
    if (hasImage) imgList.push(args.image);
    for (const img of imagesArg) imgList.push(img);
    const normalizedImages = await normalizeReferenceList(imgList);
    const basePayload = makeGrokPayload(model, args.prompt, args);
    const fields = ["image_url", "image", "input_image"];
    let lastError;
    for (let index = 0; index < fields.length; index++) {
      // Grok 单图或多图均用同一字段：数组或字符串
      const fieldValue = normalizedImages.length === 1 ? normalizedImages[0] : normalizedImages;
      payload = { ...basePayload, [fields[index]]: fieldValue };
      try {
        const raw = await apiJson(provider, "POST", `${provider.base}/videos/generations`, payload, Math.min(config.timeoutMs, 120000));
        usedField = fields[index];
        const mode = normalizedImages.length > 1 ? "reference-to-video" : "image-to-video";
        return { ...summarizeGrok(raw, model, mode, usedField), reference_count: normalizedImages.length, raw };
      } catch (error) {
        lastError = error;
        if (index === fields.length - 1 || !shouldFallbackImageField(error)) throw error;
      }
    }
    throw lastError;
  }

  if (typeof args.prompt !== "string" || !args.prompt.trim()) throw new Error("文生视频必须提供非空 prompt");
  payload = makeGrokPayload(model, args.prompt, args);
  const raw = await apiJson(provider, "POST", `${provider.base}/videos/generations`, payload, Math.min(config.timeoutMs, 120000));
  return { ...summarizeGrok(raw, model, "text-to-video", null), raw };
}

function summarizeGrok(raw, model, mode, imageField) {
  return {
    route: "grok",
    task_id: extractTaskId(raw) ?? null,
    status: normalizeStatus(raw),
    model,
    mode,
    image_field: imageField ?? undefined,
    video_url: extractVideoUrl(raw) ?? null,
  };
}

async function getGrokStatus(config, taskId, provider) {
  if (typeof taskId !== "string" || !taskId.trim()) throw new Error("request_id 必须是非空字符串");
  const id = encodeURIComponent(taskId.trim());
  const providerRef = provider || videoProviderOf(config, config.videoModel);
  const paths = [`${providerRef.base}/videos/${id}`, `${providerRef.base}/videos/generations/${id}`];
  let raw;
  for (const endpoint of paths) {
    try {
      raw = await apiJson(providerRef, "GET", endpoint, undefined, 120000);
      return {
        route: "grok",
        task_id: extractTaskId(raw) ?? taskId,
        status: normalizeStatus(raw),
        progress: extractProgress(raw),
        video_url: extractVideoUrl(raw) ?? null,
        error: extractErrorMessage(raw),
      };
    } catch (error) {
      if (!(error instanceof HttpError) || ![404, 405].includes(error.status)) throw error;
    }
  }
  throw new Error(`无法查询任务状态（${taskId}）：两个接口路径均返回 404/405`);
}

/* ---- 即梦视频（/videos 任务式） ---- */

function validateJimengArgs(args) {
  const model = args.model === undefined ? "as-sd2.0-fast" : args.model;
  if (typeof model !== "string" || (!JIMENG_MODELS.has(model) && !/^(video\-ds|as\-sd)/.test(model))) {
    throw new Error(`即梦 model 必须是 as-sd2.0-fast / video-ds-2.0 / video-ds-2.0-fast 之一（或通过 AI_MEDIA_JIMENG_MODELS 扩展）；收到：${model}`);
  }
  const seconds = args.seconds === undefined ? "15" : args.seconds;
  if (typeof seconds !== "string" || !/^\d+$/.test(seconds) || Number(seconds) <= 0) {
    throw new Error('即梦 seconds 必须是正整数形式的字符串，例如 "15"');
  }
  const aspectRatio = args.aspect_ratio === undefined ? "9:16" : args.aspect_ratio;
  if (typeof aspectRatio !== "string" || !JIMENG_ASPECTS.has(aspectRatio)) {
    throw new Error('即梦 aspect_ratio 必须是 "9:16" 或 "16:9"');
  }
  if (typeof args.prompt !== "string" || !args.prompt.trim()) throw new Error("即梦视频必须提供非空 prompt");
  return { model, seconds, aspect_ratio: aspectRatio, prompt: args.prompt.trim() };
}

async function submitJimengVideo(config, args) {
  const valid = validateJimengArgs(args);
  const provider = videoProviderOf(config, valid.model);
  // 显式白名单：只发送即梦接口接受的字段
  const payload = {
    model: valid.model,
    prompt: valid.prompt,
    seconds: valid.seconds,
    aspect_ratio: valid.aspect_ratio,
  };
  // ——图生视频支持：单图 first_frame_url；多图 reference_image_urls（最多9张）——
  const hasSingleImage = typeof args.image === "string" && args.image.trim().length > 0;
  const imagesArg = Array.isArray(args.images) ? args.images.filter((x) => typeof x === "string" && x.trim()) : [];
  if (hasSingleImage || imagesArg.length > 0) {
    const images = [];
    if (hasSingleImage) images.push(args.image);
    for (const img of imagesArg) images.push(img);
    const refs = (await normalizeReferenceList(images)).slice(0, 9);
    if (refs.length === 1) {
      payload.first_frame_url = refs[0];
    } else {
      payload.reference_image_urls = refs;
    }
  }
  const raw = await apiJson(provider, "POST", `${provider.base}/videos`, payload, Math.min(config.timeoutMs, 120000));
  const taskId = extractTaskId(raw);
  if (!taskId) throw new Error(`创建任务成功但返回中没有找到任务号：${truncate(raw)}`);
  return {
    route: "jimeng",
    task_id: taskId,
    status: normalizeStatus(raw),
    model: valid.model,
    mode: hasSingleImage || imagesArg.length > 0 ? (imagesArg.length > 1 ? "reference-to-video" : "image-to-video") : "text-to-video",
    video_url: extractVideoUrl(raw) ?? null,
    raw,
  };
}

async function getJimengStatus(config, taskId, provider) {
  if (typeof taskId !== "string" || !taskId.trim()) throw new Error("task_id 必须是非空字符串");
  const id = encodeURIComponent(taskId.trim());
  const providerRef = provider || videoProviderOf(config, "as-sd2.0-fast");
  const raw = await apiJson(providerRef, "GET", `${providerRef.base}/videos/${id}`, undefined, 120000);
  return {
    route: "jimeng",
    task_id: extractTaskId(raw) ?? taskId,
    status: normalizeStatus(raw),
    progress: extractProgress(raw),
    video_url: extractVideoUrl(raw) ?? null,
    error: extractErrorMessage(raw),
  };
}

/* ---- 统一视频入口 ---- */

async function submitVideo(config, args) {
  const model = args.model || config.videoModel;
  if (isJimengModel(model, config)) {
    const result = await submitJimengVideo(config, args);
    return { ...result, model };
  }
  return submitGrokVideo(config, args);
}

async function getVideoStatus(config, taskId) {
  const id = String(taskId || "").trim();
  if (!id) throw new Error("task_id 必须是非空字符串");
  // 尝试两种服务路由：即梦 style 用 GET /videos/{taskId}；grok 兼容两路径
  try {
    return await getJimengStatus(config, id);
  } catch (error) {
    if (error instanceof HttpError && error.status === 404) {
      return await getGrokStatus(config, id);
    }
    // 某些网关 status 返回 400 表示"未知任务"，仍尝试 grok 路径
    return await getGrokStatus(config, id);
  }
}

async function downloadJimengVideo(config, taskId, videoUrl, outputDir = null) {
  const provider = providerOf(config, "jimeng");
  const id = encodeURIComponent(taskId);
  let buffer;
  let contentType = "";
  try {
    const downloaded = await fetchBytes(videoUrl, {}, 300000);
    buffer = downloaded.buffer;
    contentType = downloaded.contentType;
  } catch (error) {
    if (!videoUrl || error instanceof HttpError) {
      // 【TODO/备注】即梦视频下载兜底：mp4 为二进制，gzip 压缩率低（无收益）。
      // 若日后即梦支持返回 JSON 或需要优化，可把此请求并入 fetchBytes（已带 Accept-Encoding: gzip）。
      const response = await fetchWithTimeout(`${provider.base}/videos/${id}/content`, {
        method: "GET",
        headers: { Authorization: `Bearer ${provider.key}`, Accept: "video/mp4, application/octet-stream, */*" },
        redirect: "follow",
      }, 300000);
      if (!response.ok) {
        throw new Error(`即梦视频下载失败，HTTP ${response.status}：${truncate(await response.text(), 1000)}`);
      }
      buffer = Buffer.from(await response.arrayBuffer());
      contentType = response.headers.get("content-type") || "";
    } else {
      throw error;
    }
  }
  if (!buffer.length) throw new Error("视频下载结果为空");
  return saveVideoBuffer(config, "jimeng", taskId, buffer, contentType, outputDir);
}

async function downloadGrokVideo(config, taskId, mode, videoUrl, videoBase64, outputDir = null) {
  const provider = providerOf(config, "grok");
  let buffer;
  let contentType = "";
  if (videoBase64) {
    let text = String(videoBase64);
    const dataMatch = text.match(/^data:(video\/[a-z0-9.+-]+);base64,(.+)$/is);
    if (dataMatch) {
      contentType = dataMatch[1];
      text = dataMatch[2];
    }
    buffer = Buffer.from(text.replace(/\s+/g, ""), "base64");
    if (!buffer.length) throw new Error("上游返回的视频 Base64 为空或无效");
  } else if (videoUrl) {
    // videoUrl 可能是绝对 URL，也可能是相对路径（如 /v1/videos/xxx/content）
    const absoluteUrl = videoUrl.startsWith("http") ? videoUrl : new URL(videoUrl, `${provider.base}/`).toString();
    const headers = { Accept: "video/*,application/octet-stream;q=0.9,*/*;q=0.1" };
    try {
      const parsed = new URL(absoluteUrl);
      // 同源（含相对路径拼接后）一律带鉴权头
      if (parsed.origin === new URL(provider.base).origin) headers.Authorization = `Bearer ${provider.key}`;
    } catch {}
    const downloaded = await fetchBytes(absoluteUrl, headers, 300000);
    buffer = downloaded.buffer;
    contentType = downloaded.contentType;
  } else {
    throw new Error("任务已完成，但响应中未找到视频 URL 或 Base64 视频数据");
  }
  return saveVideoBuffer(config, mode, taskId, buffer, contentType, outputDir);
}

async function generateVideoAndWait(config, args) {
  const submission = await submitVideo(config, args);
  let latest = submission;
  const deadline = Date.now() + config.timeoutMs;

  if (latest.status !== "completed") {
    if (!latest.task_id) throw new Error("任务已提交，但上游响应中没有 request_id/id/task_id，无法轮询");
    while (true) {
      if (Date.now() >= deadline) {
        throw new Error(`视频生成超时（${config.timeoutMs} ms），任务 ID：${latest.task_id}（视频不会重复扣费）`);
      }
      await sleep(Math.min(config.pollIntervalMs, Math.max(1000, deadline - Date.now())));
      latest = await getVideoStatus(config, String(latest.task_id));
      if (["failed", "expired"].includes(latest.status)) {
        throw new Error(`视频生成${latest.status === "expired" ? "已过期" : "失败"}，任务 ID：${latest.task_id}；原因：${latest.error || "未知"}`);
      }
      if (latest.status === "completed") break;
    }
  }

  const taskId = latest.task_id || submission.task_id;
  const videoUrl = latest.video_url || submission.video_url;
  const videoBase64 = extractVideoBase64(latest.raw ?? {}) || extractVideoBase64(submission.raw ?? {});
  const mode = submission.mode || "video";
  const route = submission.route || "unknown";

  let localPath = null;
  let downloadError = null;
  try {
    if (route === "jimeng") localPath = await downloadJimengVideo(config, taskId, videoUrl, args.output_dir);
    else if (videoBase64) localPath = await downloadGrokVideo(config, taskId, mode, videoUrl, videoBase64, args.output_dir);
    else localPath = await downloadGrokVideo(config, taskId, mode, videoUrl, null, args.output_dir);
  } catch (error) {
    downloadError = error.message;
  }

  return {
    ok: true,
    route,
    task_id: taskId,
    status: "completed",
    model: submission.model,
    mode,
    video_url: videoUrl || null,
    file: localPath,
    download_error: downloadError,
  };
}

/* --------------------------- MCP 工具 --------------------------- */

const TOOLS = [
  {
    name: "list_model_capabilities",
    description: "查询各模型支持的图片/视频分辨率、宽高比、时长等能力清单（纯本地查询，不调用 API、不收费）。可指定 model 精确查询某模型，或传 aspect_ratio/size/resolution 反查可用模型。",
    inputSchema: {
      type: "object",
      properties: {
        model: { type: "string", description: "可选，精确查询某个模型（如 gpt-image-2、gemini-3-pro-image、grok-imagine-image-quality、grok-imagine-video、as-sd2.0-fast）。不传则返回全部。" },
        kind: { type: "string", enum: ["image", "video"], description: "可选，只看图片或视频。" },
        size: { type: "string", description: "可选，反查：哪些模型支持这个分辨率（如 1536x1024、1024x1536、1k、2k、720p、1080p）。" },
        aspect_ratio: { type: "string", description: "可选，反查：哪些模型支持这个比例（如 16:9、9:16、1:1、21:9）。" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "probe_capabilities",
    description: "实测各模型当前支持的分辨率/宽高比（真实调用试探，会消耗少量生成配额，默认只试探少量组合）。结果写入本地缓存，list_model_capabilities 自动合并。可选 model 只探测指定模型。",
    inputSchema: {
      type: "object",
      properties: {
        model: { type: "string", description: "可选，只探测某个模型（如 gemini-3-pro-image、gpt-image-2、grok-imagine-image-quality、grok-imagine-video、as-sd2.0-fast）。不传则探测全部已配置模型。" },
        note: { type: "string", description: "提示：探测会真实调用生成接口（少量费用），视频仅提交不等待。" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "generate_image",
    description: "生成/编辑图片（OpenAI 兼容 /images/generations，模型名透传：gpt-image-2、gemini-3-pro-image、grok-imagine-image-quality、即梦、doubao-seedream 等）。默认保存到本地并只返回文件路径（零 base64）。",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "图片内容描述，越具体效果越好。" },
    auto_prompt: { type: "boolean", description: "自动提示词增强（默认开启）。当你只上传了参考图、提示词不足 15 字时，自动套用内置'无缝融合'增强模板（光影/透视/色调一致性，解决贴图感）。false=关闭。" },
        image: { type: "string", description: "可选，参考图（单张）：公网 URL、Data URL、Base64、本地图片路径，或 @chatbox-latest（自动读取 Chatbox 最近拖入的图片）。提供后为图生图（部分模型支持）。" },
        images: { type: "array", maxItems: 5, items: { type: "string" }, description: "可选，多张参考图（图生图/多模态）：每项为公网 URL、Data URL、Base64、本地图片路径或 @chatbox-latest（自动取最新拖入图）。例：[\"D:\\a.png\", \"https://...\"]。" },
        model: { type: "string", description: "可选，默认取 AI_MEDIA_IMAGE_MODEL。模型名透传。" },
        size: { type: "string", description: "可选，例如 1024x1024、1536x1024。" },
        quality: { type: "string", description: "可选，standard/hd/high/medium/low。" },
        n: { type: "integer", minimum: 1, maximum: 10, description: "可选，生成数量（部分供应商支持）。" },
        aspect_ratio: { type: "string", description: "可选，如 1:1、16:9、9:16（仅当未指定 size 时发送）。" },
        resolution: { type: "string", description: "可选，如 1k、2k（部分 xAI/grok 网关支持）。" },
        output_dir: { type: "string", description: "可选，保存目录（默认 AI_MEDIA_IMAGE_OUTPUT_DIR）。" },
        return_mode: { type: "string", enum: ["path", "inline", "both"], description: "path=仅返回路径（默认）；inline=返回图片数据；both=两者。注意 inline 会把 base64 带入对话上下文。" },
      },
      required: ["prompt"],
      additionalProperties: false,
    },
  },
  {
    name: "generate_video",
    description: "提交视频生成任务（不等待）。grok-imagine-video* 走 /videos/generations；即梦 as-sd2.0-fast / video-ds-2.0* 走 /videos。自动按模型名路由。",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "视频内容与运动描述。文生视频必填；图生视频可选。" },
        model: { type: "string", description: "可选，默认取 AI_MEDIA_VIDEO_MODEL。" },
        image: { type: "string", description: "可选，图生视频：公网 URL、Data URL、Base64 或本地图片路径。" },
        images: { type: "array", items: { type: "string" }, description: "可选，多张参考图生视频（最多 9 张）：即梦 reference_image_urls / grok image_url 数组。无 image 时生效。" },
        duration: { type: "integer", minimum: 1, description: "可选，grok 视频时长（秒）。" },
        seconds: { type: "string", description: "可选，即梦视频时长，字符串，例如 \"15\"。" },
        aspect_ratio: { type: "string", description: "可选，如 16:9、9:16、1:1。" },
        resolution: { type: "string", description: "可选，如 720p、1k、2k。" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "get_video_status",
    description: "查询视频任务状态（自动兼容即梦 /videos/{id} 与 grok /videos/{id} 两种路由）。",
    inputSchema: {
      type: "object",
      properties: {
        task_id: { type: "string", description: "提交任务后返回的 task_id / request_id。" },
      },
      required: ["task_id"],
      additionalProperties: false,
    },
  },
  {
    name: "generate_video_and_wait",
    description: "提交视频任务、轮询到完成并下载到本地，返回本地文件路径（零 base64）。可能需要数分钟。",
    inputSchema: {
      type: "object",
      properties: {
        prompt: { type: "string", description: "视频内容与运动描述。文生视频必填；图生视频可选。" },
        model: { type: "string", description: "可选，默认取 AI_MEDIA_VIDEO_MODEL。" },
        image: { type: "string", description: "可选，图生视频本地图片路径 / URL / Base64。" },
        images: { type: "array", items: { type: "string" }, description: "可选，多张参考图生视频（最多 9 张）。无 image 时生效。" },
        duration: { type: "integer", minimum: 1, description: "可选，grok 视频时长（秒）。" },
        seconds: { type: "string", description: "可选，即梦视频时长，字符串，例如 \"15\"。" },
        aspect_ratio: { type: "string", description: "可选，如 16:9、9:16、1:1。" },
        resolution: { type: "string", description: "可选，如 720p、1k、2k。" },
        output_dir: { type: "string", description: "可选，视频保存目录（默认 AI_MEDIA_VIDEO_OUTPUT_DIR）。" },
      },
      additionalProperties: false,
    },
  },
];

/* ============ 模型能力清单（基于官方 API 文档，纯本地查询） ============ */
const MODEL_CAPS = [
  {
    family: "GPT Image",
    model: "gpt-image-2",
    kind: "image",
    sizes: ["1024x1024", "1536x1024", "1024x1536", "auto", "任意 WIDTHxHEIGHT"],
    sizeRule: "任意分辨率：宽高均须被 16 整除；比例 1:3 ~ 3:1；单边 ≤ 3840px；像素 ≤ 8,294,400 且 ≥ 655,360。超过 2560x1440 为实验性",
    aspectRatios: ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "2:1", "1:2", "3:1", "1:3"],
    quality: ["low", "medium", "high"],
    notes: "官方：gpt-image-2 支持任意分辨率；编辑/参考图走 /images/edits（本包自动回退）",
  },
  {
    family: "Gemini",
    model: "gemini-3-pro-image",
    kind: "image",
    sizes: ["1k", "2k", "4k (预览)"],
    sizeRule: "分辨率档：1k / 2k / 4k（4k 为预览）",
    aspectRatios: ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9", "9:21", "1:4", "4:1", "1:8", "8:1"],
    quality: ["low", "medium", "high"],
    notes: "原生多模态：最多 14 张参考图；多图生成尊重用户指定模型，GPT / Gemini / Grok 均已通过双参考图网关实测", 
  },
  {
    family: "Grok",
    model: "grok-imagine-image-quality",
    kind: "image",
    sizes: ["1k", "2k"],
    sizeRule: "resolution 参数：1k / 2k",
    aspectRatios: ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3", "2:1", "1:2", "19.5:9", "9:19.5", "20:9", "9:20", "auto"],
    quality: ["low", "medium"],
    notes: "官方 quality 参数仅 grok-imagine-image-2.0 支持；多图参考能力弱于 Gemini（实测）",
  },
  {
    family: "Grok Video",
    model: "grok-imagine-video",
    kind: "video",
    sizes: ["480p", "720p", "1080p"],
    sizeRule: "resolution 参数：480p / 720p / 1080p",
    aspectRatios: ["1:1", "16:9", "9:16", "4:3", "3:4", "3:2", "2:3"],
    duration: "最多 15 秒",
    notes: "支持图生视频（image 参数）；异步任务式（提交→轮询→下载）",
  },
  {
    family: "即梦视频",
    model: "as-sd2.0-fast (Seedance 2.0 fast)",
    kind: "video",
    sizes: ["480p", "720p"],
    sizeRule: "480p / 720p（fast 版不支持 1080p）",
    aspectRatios: ["16:9", "4:3", "1:1", "3:4", "9:16", "21:9", "adaptive"],
    duration: "4 ~ 15 秒",
    notes: "支持帧生视频（首帧/首尾帧）、多模态参考（最多 9 张图）；原生音频 generate_audio",
  },
  {
    family: "即梦视频",
    model: "video-ds-2.0 (Seedance 2.0)",
    kind: "video",
    sizes: ["480p", "720p", "1080p"],
    sizeRule: "480p / 720p / 1080p",
    aspectRatios: ["16:9", "4:3", "1:1", "3:4", "9:16", "21:9", "adaptive"],
    duration: "4 ~ 15 秒",
    notes: "标准版，支持 1080p；生成更慢但画质更高",
  },
];

function listModelCapabilities(args = {}) {
  let models = MODEL_CAPS;
  // 合并实测缓存（probed 优先）
  const probed = loadCapabilitiesCache();
  if (probed && Array.isArray(probed.results) && probed.results.length) {
    const probeMap = {};
    for (const r of probed.results) probeMap[r.model] = r;
    models = models.map((m) => {
      const r = probeMap[m.model];
      if (!r) return m;
      return {
        ...m,
        probedSizes: r.probedSizes || null,
        probedRatios: r.probedRatios || null,
        probedAt: probed.probedAt || null,
      };
    });
  }
  if (args.model) models = models.filter((m) => m.model.toLowerCase().includes(String(args.model).toLowerCase()));
  if (args.kind) models = models.filter((m) => m.kind === args.kind);
  if (args.size) {
    const s = String(args.size).toLowerCase();
    models = models.filter((m) => m.sizes.some((x) => x.toLowerCase() === s) || (m.sizes.some((x) => x.toLowerCase() === s + "p")) || String(m.sizeRule || "").toLowerCase().includes(s) || (m.probedSizes && m.probedSizes.some((x) => x.toLowerCase() === s)));
  }
  if (args.aspect_ratio) {
    const r = String(args.aspect_ratio).toLowerCase();
    models = models.filter((m) => m.aspectRatios.some((x) => x.toLowerCase() === r) || (m.probedRatios && m.probedRatios.some((x) => x.toLowerCase() === r)));
  }
  if (!models.length) return { matched: [], message: "未找到匹配的模型。试试 model / kind / size / aspect_ratio 换个条件。" };
  return { matched: models.length, models: models.map((m) => ({ family: m.family, model: m.model, kind: m.kind, sizes: m.sizes, sizeRule: m.sizeRule, aspectRatios: m.aspectRatios, quality: m.quality || null, duration: m.duration || null, notes: m.notes, probedSizes: m.probedSizes || null, probedRatios: m.probedRatios || null, probedAt: m.probedAt || null })) };
}

/** 读取实测能力缓存（不存在/损坏 → null）。 */
function loadCapabilitiesCache() {
  try {
    const fp = getConfig().capabilitiesCachePath;
    const raw = readFileSync(fp, "utf8");
    if (!raw) return null;
    const obj = JSON.parse(raw);
    return obj && typeof obj === "object" ? obj : null;
  } catch (e) {
    return null;
  }
}

/** 保存实测能力缓存。 */
async function saveCapabilitiesCache(payload) {
  try {
    const fp = getConfig().capabilitiesCachePath;
    await fs.mkdir(path.dirname(fp), { recursive: true });
    await fs.writeFile(fp, JSON.stringify(payload, null, 2), "utf8");
    return { saved: fp, at: new Date().toISOString() };
  } catch (e) {
    return { saved: null, error: e.message };
  }
}

/** 单个模型探测请求：用小成本请求试探参数是否被接受（图片极短 prompt；视频只提交不等待）。 */
async function probeOneRequest(provider, url, payload, timeoutMs = 150000) {
  try {
    await apiJson(provider, "POST", url, payload, timeoutMs);
    return { ok: true, status: 200, body: "accepted" };
  } catch (e) {
    return { ok: false, status: e?.status || 0, body: String(e.message || e).slice(0, 200) };
  }
}

/** 探测指定模型支持哪些尺寸/比例（实测，写缓存）。耗时且可能产生少量生成费用。 */
async function probeCapabilities(config, args = {}) {
  const services = [
    {
      group: "gemini", kind: "image", model: "gemini-3-pro-image",
      url: (c, m) => geminiEndpoint(c.providers.gemini, m),
          build: (size, ratio) => ({ contents: [{ parts: [{ text: "." }] }], generationConfig: { responseModalities: ["TEXT", "IMAGE"], imageConfig: { imageSize: size || undefined, aspectRatio: ratio || undefined } } }),
      sizeValues: ["1k", "2k"], ratioValues: ["1:1", "16:9", "9:16"],
    },
    {
      group: "gpt", kind: "image", model: "gpt-image-2",
      url: (c, m) => `${normalizeBase(c.providers.gpt.base)}/images/generations`,
      build: (size, ratio) => ({ prompt: ".", n: 1, quality: "low", size: size || undefined, aspect_ratio: ratio || undefined }),
      sizeValues: ["1024x1024", "1536x1024"], ratioValues: [],
    },
    {
      group: "grok", kind: "image", model: "grok-imagine-image-quality",
      url: (c, m) => `${normalizeBase(c.providers.grok.base)}/images/generations`,
      build: (size, ratio) => ({ prompt: ".", n: 1, quality: "low", resolution: size || undefined, aspect_ratio: ratio || undefined }),
      sizeValues: ["1k", "2k"], ratioValues: ["1:1", "16:9", "9:16"],
    },
    {
      group: "grok", kind: "video", model: "grok-imagine-video",
      url: (c, m) => `${normalizeBase(c.providers.grok.base)}/videos/generations`,
      build: (size, ratio) => ({ prompt: ".", duration: 3, resolution: size || undefined, aspect_ratio: ratio || undefined }),
      sizeValues: ["720p", "1080p"], ratioValues: ["16:9"],
    },
    {
      group: "jimeng", kind: "video", model: "as-sd2.0-fast",
      url: (c, m) => `${normalizeBase(c.providers.jimeng.base)}/videos`,
      build: (size, ratio) => ({ prompt: ".", seconds: "3", resolution: size || undefined, aspect_ratio: ratio || undefined }),
      sizeValues: ["720p"], ratioValues: ["16:9", "9:16"],
    },
  ];
  const target = String(args.model || "").toLowerCase();
  const results = [];
  for (const svc of services) {
    if (target && !svc.model.toLowerCase().includes(target)) continue;
    const provider = config.providers[svc.group];
    if (!provider || !provider.key) { results.push({ model: svc.model, kind: svc.kind, skipped: "no key" }); continue; }
    const url = svc.url(config, svc.model);
    const tried = [];
    for (const size of svc.sizeValues) {
      const payload = svc.build(size, null);
      payload.model = svc.model;
      payload.size = size;
      const r = await probeOneRequest(provider, url, payload, 30000);
      tried.push({ size, payload, ok: r.ok, status: r.status });
      if (r.ok) break
    }
    for (const ratio of svc.ratioValues) {
      const payload = svc.build(null, ratio);
      payload.model = svc.model;
      payload.aspect_ratio = ratio;
      const r = await probeOneRequest(provider, url, payload, 30000);
      tried.push({ ratio, payload, ok: r.ok, status: r.status });
      if (r.ok) break
    }
    results.push({ model: svc.model, kind: svc.kind, group: svc.group, gateway: provider.base, tried });
  }
  const payload = { probedAt: new Date().toISOString(), results, note: "probed items 为实测接受情况(status 200=接受)；未测项以 MODEL_CAPS 官方清单为准" };
  const saved = await saveCapabilitiesCache(payload);
  return { probed: results.length, probedAt: payload.probedAt, cache: saved, results };
}

/** 启动/定时自动探测（仅 AI_MEDIA_AUTO_PROBE=on 时触发；默认 off 防意外扣费）。 */
async function maybeAutoProbe() {
  try {
    const cfg = getConfig();
    if (!cfg.autoProbe) return null;
    const cache = loadCapabilitiesCache();
    const lastAt = cache && cache.probedAt ? new Date(cache.probedAt).getTime() : 0;
    if (Date.now() - lastAt < 24 * 3600 * 1000) return { skipped: "cache fresh (<24h)" };
    const result = await probeCapabilities(cfg, {});
    return { probed: true, at: new Date().toISOString(), models: result.probed };
  } catch (e) {
    return { error: e.message };
  }
}

/* ------------- 协议处理 --------------------------- */

function resolveReturnMode(args) {
  const value = (args.return_mode || "").trim().toLowerCase();
  return ["path", "inline", "both"].includes(value) ? value : null;
}

function buildTextResult(obj) {
  return { content: [{ type: "text", text: JSON.stringify(obj, null, 2) }] };
}

function buildImageResult(savedPaths, args) {
  const mode = resolveReturnMode(args) || getConfig().returnMode;
  const content = [];
  for (const filePath of savedPaths) {
    content.push({ type: "text", text: `Saved to: ${filePath}` });
  }
  if (mode === "inline" || mode === "both") {
    for (const filePath of savedPaths) {
      try {
        const buffer = readFileSync(filePath);
        const mime = mimeFromBuffer(buffer) || "image/png";
        content.push({ type: "image", data: buffer.toString("base64"), mimeType: mime });
      } catch {
        // 文件不可读时跳过 inline 部分
      }
    }
  }
  return { content };
}

async function callTool(name, args = {}) {
  const config = getConfig();
  switch (name) {
    case "list_model_capabilities":
      return listModelCapabilities(args);
    case "probe_capabilities":
      return await probeCapabilities(config, args);
    case "generate_image": {
      const result = await generateImage(config, args);
      return {
        ...buildImageResult(result.files, args),
        _ai_media_diagnostics: {
          provider: result.provider,
          model: result.model,
          endpoint: result.endpoint || null,
          reference_count: result.reference_count ?? null,
          reference_images: result.reference_images ?? [],
          image_to_image: result.image_to_image ?? false,
          auto_prompted: result.auto_prompted ?? false,
        },
      };
    }
    case "generate_video":
      return buildTextResult(await submitVideo(config, args));
    case "get_video_status":
      return buildTextResult(await getVideoStatus(config, args.task_id));
    case "generate_video_and_wait": {
      const result = await generateVideoAndWait(config, args);
      return result.file
        ? { content: [{ type: "text", text: `Saved to: ${result.file}` }] }
        : buildTextResult(result);
    }
    default:
      throw new Error(`未知工具：${name}`);
  }
}

function textResult(value, isError = false) {
  return {
    content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }],
    ...(isError ? { isError: true } : {}),
  };
}

async function handleMessage(message) {
  if (!message || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    if (message?.id !== undefined) return { jsonrpc: "2.0", id: message.id, error: { code: -32600, message: "Invalid Request" } };
    return null;
  }
  const id = message.id;
  const isNotification = id === undefined || id === null;
  try {
    let result;
    switch (message.method) {
      case "initialize":
        result = {
          protocolVersion: message.params?.protocolVersion || DEFAULT_PROTOCOL_VERSION,
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
          instructions: "generate_image 生成图片（模型名透传，默认返回保存路径）；generate_video 提交视频任务；get_video_status 查询状态；generate_video_and_wait 生成并下载到本地后返回路径。默认零 base64，如需对话内预览请传 return_mode=inline/both。",
        };
        break;
      case "notifications/initialized":
      case "notifications/cancelled":
        return null;
      case "ping":
        result = {};
        break;
      case "tools/list":
        result = { tools: TOOLS };
        break;
      case "tools/call": {
        const name = message.params?.name;
        const args = message.params?.arguments || {};
        try {
          result = textResult(await callTool(name, args));
        } catch (error) {
          result = textResult({ error: error?.message || String(error), status: error?.status || null }, true);
        }
        break;
      }
      default:
        if (isNotification) return null;
        return { jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${message.method}` } };
    }
    if (isNotification) return null;
    return { jsonrpc: "2.0", id, result };
  } catch (error) {
    if (isNotification) return null;
    return { jsonrpc: "2.0", id, error: { code: -32603, message: error?.message || "Internal error" } };
  }
}

let inputBuffer = Buffer.alloc(0);

function writeMessage(message, framing) {
  const json = JSON.stringify(message);
  if (framing === "content-length") {
    const length = Buffer.byteLength(json, "utf8");
    process.stdout.write(`Content-Length: ${length}\r\n\r\n${json}`);
  } else {
    process.stdout.write(`${json}\n`);
  }
}

async function dispatchJson(text, framing) {
  let message;
  try {
    message = JSON.parse(text);
  } catch (error) {
    writeMessage({ jsonrpc: "2.0", id: null, error: { code: -32700, message: `Parse error: ${error.message}` } }, framing);
    return;
  }
  const response = await handleMessage(message);
  if (response) writeMessage(response, framing);
}

async function consumeInput() {
  while (inputBuffer.length) {
    const asciiStart = inputBuffer.subarray(0, Math.min(inputBuffer.length, 32)).toString("ascii");
    if (/^Content-Length\s*:/i.test(asciiStart)) {
      let separator = inputBuffer.indexOf("\r\n\r\n");
      let separatorLength = 4;
      if (separator < 0) {
        separator = inputBuffer.indexOf("\n\n");
        separatorLength = 2;
      }
      if (separator < 0) return;
      const header = inputBuffer.subarray(0, separator).toString("ascii");
      const match = header.match(/Content-Length\s*:\s*(\d+)/i);
      if (!match) {
        inputBuffer = inputBuffer.subarray(separator + separatorLength);
        writeMessage({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "缺少有效 Content-Length" } }, "content-length");
        continue;
      }
      const length = Number(match[1]);
      const bodyStart = separator + separatorLength;
      if (inputBuffer.length < bodyStart + length) return;
      const body = inputBuffer.subarray(bodyStart, bodyStart + length).toString("utf8");
      inputBuffer = inputBuffer.subarray(bodyStart + length);
      await dispatchJson(body, "content-length");
      continue;
    }

    const newline = inputBuffer.indexOf("\n");
    if (newline < 0) return;
    const line = inputBuffer.subarray(0, newline).toString("utf8").trim();
    inputBuffer = inputBuffer.subarray(newline + 1);
    if (line) await dispatchJson(line, "newline");
  }
}

// 启动时自动探测能力（仅 AI_MEDIA_AUTO_PROBE=on 时触发；默认 off 防意外扣费）
maybeAutoProbe().then((r) => {
  if (r) process.stderr.write(`[${SERVER_NAME}] 能力自动探测：${JSON.stringify(r).slice(0, 200)}\n`);
}).catch((e) => {
  process.stderr.write(`[${SERVER_NAME}] 能力自动探测失败：${e?.message || e}\n`);
});

let consumeChain = Promise.resolve();
process.stdin.on("data", (chunk) => {
  inputBuffer = Buffer.concat([inputBuffer, chunk]);
  consumeChain = consumeChain.then(consumeInput).catch((error) => {
    process.stderr.write(`[${SERVER_NAME}] 输入处理错误：${error?.stack || error}\n`);
  });
});
process.stdin.on("error", (error) => process.stderr.write(`[${SERVER_NAME}] stdin 错误：${error.message}\n`));
process.on("uncaughtException", (error) => process.stderr.write(`[${SERVER_NAME}] 未捕获异常：${error?.stack || error}\n`));
process.on("unhandledRejection", (error) => process.stderr.write(`[${SERVER_NAME}] Promise 异常：${error?.stack || error}\n`));

// 直接运行时不向 stdout 输出任何日志，以免破坏 MCP stdio 协议。
const currentFile = fileURLToPath(import.meta.url);
if (process.argv[1] && path.resolve(process.argv[1]) !== path.resolve(currentFile)) {
  process.stderr.write(`[${SERVER_NAME}] 警告：该文件应直接通过 node 运行。\n`);
}
