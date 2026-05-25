import { SessionType, type MessageItem } from "@openim/client-sdk";
import { sendFileToTarget, sendImageToTarget, sendTextToTarget, sendVideoToTarget } from "./media";
import type { ChatType, InboundBodyResult, InboundMediaItem, OpenIMClientState, ParsedTarget } from "./types";
import { formatSdkError } from "./utils";

const inboundDedup = new Map<string, number>();
const INBOUND_DEDUP_TTL_MS = 5 * 60 * 1000;
const MAX_IMAGE_BYTES = 20 * 1024 * 1024;
const IMAGE_FETCH_TIMEOUT_MS = 15000;

// ───────── workspace prefetch (xcph fork) ─────────
// inbound 消息处理前,自动下载 fileElem/pictureElem/videoElem 引用的 URL
// 到 ~/.openclaw/workspace/<sendID>/<fileName>。LLM 因此能 read_file 而不是
// web_fetch 内网 URL(它有"内网拒读"偏好)。
import fs from "node:fs";
import path from "node:path";

const PREFETCH_TIMEOUT_MS = 15000;
const PREFETCH_MAX_BYTES = 50 * 1024 * 1024;
const PREFETCH_WORKSPACE = "/home/node/.openclaw/workspace";

async function prefetchOne(url: string | undefined, sendID: string, fileName: string): Promise<boolean> {
  if (!url || !sendID || !fileName) return false;
  const dst = path.join(PREFETCH_WORKSPACE, sendID, fileName);
  try {
    if (fs.existsSync(dst) && fs.statSync(dst).size > 0) return true;
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), PREFETCH_TIMEOUT_MS);
    let response: Response;
    try {
      response = await fetch(url, { signal: controller.signal });
    } finally { clearTimeout(timer); }
    if (!response.ok) return false;
    const contentLength = Number(response.headers.get("content-length") || 0);
    if (contentLength > PREFETCH_MAX_BYTES) return false;
    const arrayBuffer = await response.arrayBuffer();
    const buffer = Buffer.from(arrayBuffer);
    if (buffer.byteLength > PREFETCH_MAX_BYTES) return false;
    fs.writeFileSync(dst, buffer);
    return true;
  } catch (_e) { return false; }
}

// ───────── channel operator hint (xcph fork) ─────────
// Inline a small system-style block ahead of the user text so the LLM picks
// the right openim_send_{file|image|video} tool when delivery is requested.
function buildChannelOperatorHint(args: { senderId: string; isGroup: boolean; groupId: string }): string {
  const { senderId, isGroup, groupId } = args;
  const target = isGroup ? `group:${groupId}` : `user:${senderId}`;
  const wsPath = `/home/node/.openclaw/workspace/${senderId}/`;
  return [
    `[Channel: OpenIM]`,
    `- Sender: ${senderId}; reply target = ${target}`,
    `- Workspace dir (already prefetched any user attachments): ${wsPath}`,
    `- When the user asks you to send / give / forward / 发 / 给我 a file BACK to them:`,
    `  · *.png / *.jpg / *.jpeg / *.gif / *.webp / *.bmp  -> call openim_send_image({target:"${target}", image:"${wsPath}<name>"})`,
    `  · *.mp4 / *.mov / *.mkv / *.webm                   -> call openim_send_video({target:"${target}", video:"${wsPath}<name>"})`,
    `  · everything else                                  -> call openim_send_file({target:"${target}", file:"${wsPath}<name>"})`,
    `- Never paste binary / file content as a text reply when delivery is requested.`,
    `- read_file is only for *answering questions about* the file's content, not for delivery.`,
  ].join("\n");
}
// ──────────────────────────────────────────────────────

export async function prefetchInboundMediaToWorkspace(msg: MessageItem): Promise<void> {
  const sendID = String((msg as any)?.sendID || "");
  if (!sendID) return;
  const tasks: Promise<boolean>[] = [];
  const file = (msg as any).fileElem;
  if (file?.sourceUrl && file?.fileName) {
    tasks.push(prefetchOne(file.sourceUrl, sendID, file.fileName));
  }
  const pic = (msg as any).pictureElem;
  if (pic) {
    const url = pic.sourcePicture?.url || pic.bigPicture?.url || pic.snapshotPicture?.url;
    const name = pic.sourcePath || pic.sourcePicture?.uuid || `${Date.now()}.jpg`;
    if (url) tasks.push(prefetchOne(url, sendID, name));
  }
  const vid = (msg as any).videoElem;
  if (vid?.videoUrl) {
    const name = vid.videoName || vid.fileName || `${Date.now()}.mp4`;
    tasks.push(prefetchOne(vid.videoUrl, sendID, name));
  }
  await Promise.all(tasks);
}

function workspacePathOf(sendID: string, fileName: string | undefined): string | undefined {
  if (!sendID || !fileName) return undefined;
  const candidate = path.join(PREFETCH_WORKSPACE, sendID, fileName);
  try { if (fs.existsSync(candidate)) return candidate; } catch (_e) {}
  return undefined;
}
// ─────────────────────────────────────────────────────

type ImagePart = { type: "image"; data: string; mimeType: string };

function normalizeImageMimeType(value: unknown): string | undefined {
  const mime = String(value ?? "").trim().toLowerCase();
  return mime.startsWith("image/") ? mime : undefined;
}

function normalizeMimeType(value: unknown): string | undefined {
  const mime = String(value ?? "").trim().toLowerCase();
  return mime.includes("/") ? mime : undefined;
}

function normalizeString(value: unknown): string | undefined {
  const text = String(value ?? "").trim();
  return text || undefined;
}

function normalizeSize(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function summarizeMedia(item: InboundMediaItem): string {
  // Plugin already prefetched media to /home/node/.openclaw/workspace/<sendID>/<fileName>.
  // When workspacePath is set, hide the internal sourceUrl entirely so the LLM uses
  // read_file instead of web_fetch (which it refuses on private IPs as SSRF heuristic).
  if (item.workspacePath) {
    if (item.kind === "image") {
      const ps = ["[Image]", `workspacePath=${item.workspacePath}`];
      if (item.fileName) ps.push(`name=${item.fileName}`);
      if (item.mimeType) ps.push(`type=${item.mimeType}`);
      return ps.join(" ");
    }
    if (item.kind === "video") {
      const ps = ["[Video]", `workspacePath=${item.workspacePath}`];
      if (item.fileName) ps.push(`name=${item.fileName}`);
      if (item.size) ps.push(`size=${item.size}`);
      return ps.join(" ");
    }
    const ps = ["[File]", `workspacePath=${item.workspacePath}`];
    if (item.fileName) ps.push(`name=${item.fileName}`);
    if (item.mimeType) ps.push(`type=${item.mimeType}`);
    if (item.size) ps.push(`size=${item.size}`);
    return ps.join(" ");
  }

  if (item.kind === "image") {
    return item.url ? `[Image] ${item.url}` : "[Image message]";
  }

  if (item.kind === "video") {
    const parts = ["[Video]"];
    if (item.fileName) parts.push(`name=${item.fileName}`);
    if (item.url) parts.push(`video=${item.url}`);
    if (item.snapshotUrl) parts.push(`snapshot=${item.snapshotUrl}`);
    if (item.size) parts.push(`size=${item.size}`);
    return parts.join(" ");
  }

  const parts = ["[File]"];
  if (item.fileName) parts.push(`name=${item.fileName}`);
  if (item.mimeType) parts.push(`type=${item.mimeType}`);
  if (item.url) parts.push(`url=${item.url}`);
  if (item.size) parts.push(`size=${item.size}`);
  return parts.join(" ");
}

function mergeInboundResults(parts: Array<InboundBodyResult | null | undefined>): InboundBodyResult {
  const valid = parts.filter(Boolean) as InboundBodyResult[];
  if (valid.length === 0) return { body: "", kind: "unknown" };

  const bodies = valid.map((item) => item.body).filter(Boolean);
  const media = valid.flatMap((item) => item.media ?? []);
  if (valid.length === 1) {
    return {
      body: bodies[0] || "",
      kind: valid[0].kind,
      media: media.length > 0 ? media : undefined,
    };
  }

  return {
    body: bodies.join("\n"),
    kind: "mixed",
    media: media.length > 0 ? media : undefined,
  };
}

async function fetchImageAsContentPart(url: string, hintedMimeType?: string): Promise<ImagePart> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), IMAGE_FETCH_TIMEOUT_MS);
  let response: Response;
  try {
    response = await fetch(url, { signal: controller.signal });
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`image fetch timeout after ${IMAGE_FETCH_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    throw new Error(`image fetch failed: ${response.status} ${response.statusText}`);
  }

  const contentLength = Number(response.headers.get("content-length") || 0);
  if (contentLength > MAX_IMAGE_BYTES) {
    throw new Error(`image too large: ${contentLength} bytes`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  if (buffer.byteLength > MAX_IMAGE_BYTES) {
    throw new Error(`image too large: ${buffer.byteLength} bytes`);
  }

  const mimeType = normalizeImageMimeType(response.headers.get("content-type")) ?? normalizeImageMimeType(hintedMimeType) ?? "image/jpeg";
  return {
    type: "image",
    data: buffer.toString("base64"),
    mimeType,
  };
}

function buildTextEnvelope(
  runtime: any,
  cfg: any,
  fromLabel: string,
  senderId: string,
  timestamp: number,
  bodyText: string,
  chatType: ChatType
): string {
  const envelopeOptions = runtime.channel.reply?.resolveEnvelopeFormatOptions?.(cfg) ?? {};
  const formatted = runtime.channel.reply?.formatInboundEnvelope?.({
    channel: "OpenIM",
    from: fromLabel,
    timestamp,
    body: bodyText,
    chatType,
    sender: { name: fromLabel, id: senderId },
    envelope: envelopeOptions,
  });
  return typeof formatted === "string" ? formatted : bodyText;
}

async function materializeInboundMedia(media: InboundMediaItem[] | undefined): Promise<{ images: ImagePart[]; warnings: string[] }> {
  if (!Array.isArray(media) || media.length === 0) {
    return { images: [], warnings: [] };
  }

  const images: ImagePart[] = [];
  const warnings: string[] = [];

  for (const item of media) {
    try {
      if (item.kind === "image" && item.url) {
        images.push(await fetchImageAsContentPart(item.url, item.mimeType));
        continue;
      }

      if (item.kind === "video" && item.snapshotUrl) {
        images.push(await fetchImageAsContentPart(item.snapshotUrl));
        continue;
      }
    } catch (err) {
      warnings.push(`${summarizeMedia(item)} => ${formatSdkError(err)}`);
    }
  }

  return { images, warnings };
}

function extractPictureMedia(msg: MessageItem): InboundMediaItem[] {
  const pic = msg.pictureElem;
  if (!pic) return [];
  const source = pic.sourcePicture;
  const big = pic.bigPicture;
  const snapshot = pic.snapshotPicture;
  const url = normalizeString(source?.url) || normalizeString(big?.url) || normalizeString(snapshot?.url);
  const mimeType = normalizeImageMimeType(source?.type) || normalizeImageMimeType(big?.type) || normalizeImageMimeType(snapshot?.type);
  const sourcePath = normalizeString((pic as any).sourcePath);
  const sendID = String((msg as any).sendID || "");
  return [{ kind: "image", url, workspacePath: workspacePathOf(sendID, sourcePath), fileName: sourcePath, mimeType }];
}

function extractVideoMedia(msg: MessageItem): InboundMediaItem[] {
  const video = msg.videoElem as any;
  if (!video) return [];
  return [
    {
      kind: "video",
      url: normalizeString(video.videoUrl),
      snapshotUrl: normalizeString(video.snapshotUrl),
      fileName: normalizeString(video.videoName ?? video.fileName ?? video.snapshotName),
      size: normalizeSize(video.videoSize ?? video.duration),
      mimeType: normalizeMimeType(video.videoType ?? video.type),
    },
  ];
}

function extractFileMedia(msg: MessageItem): InboundMediaItem[] {
  const file = msg.fileElem as any;
  if (!file) return [];
  const fileName = normalizeString(file.fileName);
  const sendID = String((msg as any).sendID || "");
  return [
    {
      kind: "file",
      url: normalizeString(file.sourceUrl),
      workspacePath: workspacePathOf(sendID, fileName),
      fileName,
      size: normalizeSize(file.fileSize),
      mimeType: normalizeMimeType(file.fileType ?? file.type),
    },
  ];
}

function extractInboundBody(msg: MessageItem, depth = 0): InboundBodyResult {
  const text = String(msg.textElem?.content ?? msg.atTextElem?.text ?? "").trim();
  const imageMedia = extractPictureMedia(msg);
  const videoMedia = extractVideoMedia(msg);
  const fileMedia = extractFileMedia(msg);

  if (msg.quoteElem?.quoteMessage) {
    const quotedMsg = msg.quoteElem.quoteMessage;
    const quotedSender = String(quotedMsg.senderNickname || quotedMsg.sendID || "unknown");
    const quoted = depth < 2 ? extractInboundBody(quotedMsg, depth + 1) : { body: "[quoted message]", kind: "mixed" as const };
    const currentParts: string[] = [];
    if (text) currentParts.push(`Reply: ${text}`);
    for (const item of [...imageMedia, ...videoMedia, ...fileMedia]) {
      currentParts.push(`Reply attachment: ${summarizeMedia(item)}`);
    }

    const bodyLines = [`[Quote] ${quotedSender}: ${quoted.body || "[empty message]"}`];
    if (currentParts.length > 0) bodyLines.push(currentParts.join("\n"));

    return {
      body: bodyLines.join("\n"),
      kind: currentParts.length > 0 ? "mixed" : quoted.kind,
      media: [...imageMedia, ...videoMedia, ...fileMedia],
    };
  }

  const parts: InboundBodyResult[] = [];
  if (text) parts.push({ body: text, kind: "text" });

  for (const item of imageMedia) {
    parts.push({ body: summarizeMedia(item), kind: "image", media: [item] });
  }
  for (const item of videoMedia) {
    parts.push({ body: summarizeMedia(item), kind: "video", media: [item] });
  }
  for (const item of fileMedia) {
    parts.push({ body: summarizeMedia(item), kind: "file", media: [item] });
  }

  if (msg.customElem?.data || msg.customElem?.description || msg.customElem?.extension) {
    const customText = msg.customElem.description || msg.customElem.data || msg.customElem.extension || "[Custom message]";
    parts.push({ body: `[Custom message] ${customText}`, kind: "mixed" });
  }

  return mergeInboundResults(parts);
}

function shouldProcessInboundMessage(accountId: string, msg: MessageItem): boolean {
  const idPart = String(msg.clientMsgID || msg.serverMsgID || `${msg.sendID}-${msg.seq || msg.createTime || 0}`);
  if (!idPart) return true;

  const key = `${accountId}:${idPart}`;
  const now = Date.now();
  const last = inboundDedup.get(key);
  inboundDedup.set(key, now);

  if (inboundDedup.size > 2000) {
    for (const [k, ts] of inboundDedup.entries()) {
      if (now - ts > INBOUND_DEDUP_TTL_MS) inboundDedup.delete(k);
    }
  }

  return !(last && now - last < INBOUND_DEDUP_TTL_MS);
}

function isGroupMessage(msg: MessageItem): boolean {
  return msg.sessionType === SessionType.Group && !!msg.groupID;
}

function isMentionedInGroup(msg: MessageItem, selfUserID: string): boolean {
  const list = msg.atTextElem?.atUserList;
  if (!Array.isArray(list) || list.length === 0) return false;
  const id = String(selfUserID);
  return list.some((item) => String(item) === id);
}

function isWhitelistedSender(client: OpenIMClientState, msg: MessageItem): boolean {
  const whitelist = client.config.inboundWhitelist;
  if (!Array.isArray(whitelist) || whitelist.length === 0) return true;
  const senderId = String(msg.sendID || "").trim();
  if (!senderId) return false;
  return whitelist.some((id) => id === senderId);
}

async function sendReplyFromInbound(client: OpenIMClientState, msg: MessageItem, text: string): Promise<void> {
  const isGroup = isGroupMessage(msg);
  const target: ParsedTarget = isGroup ? { kind: "group", id: String(msg.groupID) } : { kind: "user", id: String(msg.sendID) };
  await sendTextToTarget(client, target, text);
}

// ───────── inbound safety guards (xcph fork) ─────────
// 1) size cap: pasted source / long text shouldn't be fed into LLM context
// 2) rate limit: >N msgs in 10s from same sender → 30s cooldown
const INBOUND_MAX_BODY_CHARS = 4096;
const RATE_WINDOW_MS = 10 * 1000;
const RATE_MAX_IN_WINDOW = 3;
const RATE_COOLDOWN_MS = 30 * 1000;
const inboundRateBuckets = new Map<string, number[]>();
const inboundCooldownUntil = new Map<string, number>();

type RateGateResult =
  | { allowed: true }
  | { allowed: false; reason: "cooldown" | "burst"; remainingMs: number };

function rateGate(senderId: string): RateGateResult {
  const now = Date.now();
  const until = inboundCooldownUntil.get(senderId) || 0;
  if (until > now) return { allowed: false, reason: "cooldown", remainingMs: until - now };
  const arr = (inboundRateBuckets.get(senderId) || []).filter((t) => now - t < RATE_WINDOW_MS);
  arr.push(now);
  inboundRateBuckets.set(senderId, arr);
  if (arr.length > RATE_MAX_IN_WINDOW) {
    inboundCooldownUntil.set(senderId, now + RATE_COOLDOWN_MS);
    return { allowed: false, reason: "burst", remainingMs: RATE_COOLDOWN_MS };
  }
  return { allowed: true };
}
// ─────────────────────────────────────────────────────

// ───────── deterministic file-delivery shortcut (xcph fork) ─────────
// LLM 即使被强提示也常常把 read_file 内容当文本回贴。这里抢在 dispatch 前
// 做模式匹配,匹配到"发文件回去"意图就直接调 sendFile/Image/VideoToTarget,
// 绕过 LLM。不匹配 → 落到原流程让 LLM 决策。
const FILE_INTENT_PATTERNS: RegExp[] = [
  /把\s*(?<n>[^\s,，。!?]+)\s*(?:发|传|拿|拷)\s*(?:给|过|回)\s*(?:我|来)/u,
  /(?<n>[^\s,，。!?]+)\s*发\s*(?:给|过|回)\s*(?:我|来)/u,
  /(?:发|传)(?:\s*(?:给|过|回))?(?:\s*我)?\s+(?<n>[A-Za-z0-9_\-\.]+\.[A-Za-z0-9]{1,8})/iu,
  /(?:send|forward|give)\s+me\s+(?<n>[A-Za-z0-9_\-\.]+\.[A-Za-z0-9]{1,8})/iu,
];

function detectFileIntent(text: string | undefined): string | null {
  const stripped = (text || "").trim();
  if (!stripped) return null;
  for (const re of FILE_INTENT_PATTERNS) {
    const m = stripped.match(re);
    if (m && m.groups && m.groups.n) {
      const name = m.groups.n.trim().replace(/^["'`]+|["'`]+$/g, "");
      if (name) return name;
    }
  }
  return null;
}

function resolveWorkspaceFile(senderId: string, requested: string): string | null {
  const dir = `/home/node/.openclaw/workspace/${senderId}`;
  try { if (!fs.existsSync(dir)) return null; } catch { return null; }
  const exact = `${dir}/${requested}`;
  try { if (fs.existsSync(exact) && fs.statSync(exact).isFile()) return exact; } catch {}
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    const lower = requested.toLowerCase();
    for (const e of entries) {
      if (e.isFile() && e.name.toLowerCase() === lower) return `${dir}/${e.name}`;
    }
    const prefix = lower.replace(/\.[^.]+$/, "");
    const matches = entries
      .filter((e) => e.isFile() && e.name.toLowerCase().startsWith(prefix))
      .map((e) => {
        const full = `${dir}/${e.name}`;
        let mtime = 0; try { mtime = fs.statSync(full).mtimeMs; } catch {}
        return { name: e.name, full, mtime };
      })
      .sort((a, b) => b.mtime - a.mtime);
    if (matches.length > 0) return matches[0].full;
  } catch {}
  return null;
}

const IMAGE_EXTS = new Set([".png", ".jpg", ".jpeg", ".gif", ".webp", ".bmp"]);
const VIDEO_EXTS = new Set([".mp4", ".mov", ".mkv", ".webm"]);

async function tryDeterministicFileDelivery(
  client: OpenIMClientState,
  msg: MessageItem,
  text: string,
): Promise<boolean> {
  if (!text) return false;
  const isGroup = isGroupMessage(msg);
  const senderId = String((msg as any).sendID || "");
  if (!senderId) return false;
  const wanted = detectFileIntent(text);
  if (!wanted) return false;
  const file = resolveWorkspaceFile(senderId, wanted);
  if (!file) return false;
  const target: ParsedTarget = isGroup
    ? { kind: "group", id: String((msg as any).groupID) }
    : { kind: "user", id: senderId };
  const ext = (file.match(/\.[^.]+$/)?.[0] || "").toLowerCase();
  const fileName = file.split("/").pop() || "file";
  try {
    if (IMAGE_EXTS.has(ext)) {
      await sendImageToTarget(client, target, file);
    } else if (VIDEO_EXTS.has(ext)) {
      await sendVideoToTarget(client, target, file, fileName);
    } else {
      await sendFileToTarget(client, target, file, fileName);
    }
    return true;
  } catch (_e) {
    return false;
  }
}
// ──────────────────────────────────────────────────────────────────

export async function processInboundMessage(api: any, client: OpenIMClientState, msg: MessageItem): Promise<void> {
  const runtime = api.runtime;
  if (!runtime?.channel?.reply?.dispatchReplyWithBufferedBlockDispatcher) {
    api.logger?.warn?.("[openim] runtime.channel.reply not available");
    return;
  }

  if (String(msg.sendID) === String(client.config.userID)) {
    return;
  }
  if (!shouldProcessInboundMessage(client.config.accountId, msg)) {
    return;
  }

  await prefetchInboundMediaToWorkspace(msg);
  const inbound = extractInboundBody(msg);
  const bodyLen = (inbound.body || "").length;
  api.logger?.info?.(`[openim] inbound body (${bodyLen} chars): ${(inbound.body || "").slice(0, 200)}`);

  // 🔒 guard 1: size cap — overlong (pasted source / long text) → reject, no LLM
  if (bodyLen > INBOUND_MAX_BODY_CHARS) {
    api.logger?.warn?.(`[openim] body too long (${bodyLen}), rejecting`);
    try {
      await sendReplyFromInbound(
        client, msg,
        `⚠️ 消息太长 (${bodyLen} 字符,上限 ${INBOUND_MAX_BODY_CHARS})。请用 📎 附件上传文件,而不是把内容粘进聊天。`,
      );
    } catch { /* ignore */ }
    return;
  }

  // 🔒 guard 2: rate limit — >3 msgs in 10s from same sender → 30s cooldown
  const senderRateId = String((msg as any).sendID || "anon");
  const gate = rateGate(senderRateId);
  if (!gate.allowed) {
    api.logger?.warn?.(`[openim] rate-gated sender=${senderRateId} reason=${gate.reason} remainingMs=${gate.remainingMs}`);
    if (gate.reason === "burst") {
      try {
        await sendReplyFromInbound(
          client, msg,
          `⏳ 收到太多消息,休息 ${Math.ceil(gate.remainingMs / 1000)}s 再继续。`,
        );
      } catch { /* ignore */ }
    }
    return;
  }

  // ✂️ deterministic short-circuit: "把 X 发给我" → 直接 send_file/image/video, 不经 LLM
  if (inbound.body && (msg as any).contentType === 101) {
    const delivered = await tryDeterministicFileDelivery(client, msg, inbound.body);
    if (delivered) {
      api.logger?.info?.(`[openim] deterministic file delivery satisfied request, skipped LLM`);
      return;
    }
  }
  if (!inbound.body) {
    api.logger?.info?.(
      `[openim] ignore unsupported message: contentType=${msg.contentType}, clientMsgID=${msg.clientMsgID || "unknown"}`
    );
    return;
  }

  const group = isGroupMessage(msg);
  const mentioned = group && isMentionedInGroup(msg, client.config.userID);
  const hasWhitelist = client.config.inboundWhitelist.length > 0;
  if (hasWhitelist) {
    if (!isWhitelistedSender(client, msg)) return;
    if (group && !mentioned) return;
  } else if (group && client.config.requireMention && !mentioned) {
    return;
  }

  const baseSessionKey = group ? `openim:group:${msg.groupID}`.toLowerCase() : `openim:${msg.sendID}`.toLowerCase();
  const cfg = api.config;

  const route =
    runtime.channel.routing?.resolveAgentRoute?.({
      cfg,
      sessionKey: baseSessionKey,
      channel: "openim",
      accountId: client.config.accountId,
    }) ?? { agentId: "main", sessionKey: baseSessionKey };

  const sessionKey = String(route?.sessionKey ?? baseSessionKey).trim() || baseSessionKey;

  const storePath =
    runtime.channel.session?.resolveStorePath?.(cfg?.session?.store, {
      agentId: route.agentId,
    }) ?? "";

  const chatType: ChatType = group ? "group" : "direct";
  const fromLabel = String(msg.senderNickname || msg.sendID);
  const senderId = String(msg.sendID);
  const timestamp = msg.sendTime || Date.now();
  const mediaResult = await materializeInboundMedia(inbound.media);
  const warningText = mediaResult.warnings.map((warning) => `[Media fetch failed] ${warning}`).join("\n");
  const channelHint = buildChannelOperatorHint({ senderId, isGroup: group, groupId: String(msg.groupID || "") });
  const userText = warningText ? `${inbound.body}\n${warningText}` : inbound.body;
  const rawBody = `${channelHint}\n\n[Message]\n${userText}`;
  const body = buildTextEnvelope(runtime, cfg, fromLabel, senderId, timestamp, rawBody, chatType);

  if (mediaResult.warnings.length > 0) {
    for (const warning of mediaResult.warnings) {
      api.logger?.warn?.(`[openim] inbound media fetch failed: ${warning}`);
    }
  }

  const ctxPayload = {
    Body: body,
    RawBody: rawBody,
    From: group ? `openim:group:${msg.groupID}` : `openim:${msg.sendID}`,
    To: `openim:${client.config.userID}`,
    SessionKey: sessionKey,
    AccountId: client.config.accountId,
    ChatType: chatType,
    ConversationLabel: fromLabel,
    SenderName: fromLabel,
    SenderId: senderId,
    Provider: "openim",
    Surface: "openim",
    MessageSid: msg.clientMsgID || `openim-${Date.now()}`,
    Timestamp: timestamp,
    OriginatingChannel: "openim",
    OriginatingTo: `openim:${client.config.userID}`,
    CommandAuthorized: true,
    _openim: {
      accountId: client.config.accountId,
      isGroup: group,
      senderId,
      groupId: String(msg.groupID || ""),
      messageKind: inbound.kind,
      mediaCount: inbound.media?.length ?? 0,
    },
  };

  if (runtime.channel.session?.recordInboundSession) {
    await runtime.channel.session.recordInboundSession({
      storePath,
      sessionKey,
      ctx: ctxPayload,
      updateLastRoute: !group
        ? {
            sessionKey,
            channel: "openim",
            to: String(msg.sendID),
            accountId: client.config.accountId,
          }
        : undefined,
      onRecordError: (err: unknown) => api.logger?.warn?.(`[openim] recordInboundSession: ${String(err)}`),
    });
  }

  if (runtime.channel.activity?.record) {
    runtime.channel.activity.record({
      channel: "openim",
      accountId: client.config.accountId,
      direction: "inbound",
    });
  }

  try {
    await runtime.channel.reply.dispatchReplyWithBufferedBlockDispatcher({
      ctx: ctxPayload,
      cfg,
      dispatcherOptions: {
        deliver: async (payload: { text?: string }) => {
          if (!payload.text) return;
          try {
            await sendReplyFromInbound(client, msg, payload.text);
          } catch (e: any) {
            api.logger?.error?.(`[openim] deliver failed: ${formatSdkError(e)}`);
          }
        },
        onError: (err: unknown, info: { kind?: string }) => {
          api.logger?.error?.(`[openim] ${info?.kind || "reply"} failed: ${String(err)}`);
        },
      },
      replyOptions: {
        disableBlockStreaming: true,
        images: mediaResult.images,
      },
    });
  } catch (err: any) {
    api.logger?.error?.(`[openim] dispatch failed: ${formatSdkError(err)}`);
    try {
      const errMsg = formatSdkError(err);
      await sendReplyFromInbound(client, msg, `Processing failed: ${errMsg.slice(0, 80)}`);
    } catch {
      // ignore secondary send errors
    }
  }
}
