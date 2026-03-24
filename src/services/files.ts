import { InputFile } from "grammy";
import type { BotContext } from "../context";
import { MAX_FILE_SIZE } from "@ton-agent-kit/wallet-store";
import { verboseLog } from "../helpers";

// ── Convert any Buffer-like value to a native Buffer ──
function toBuffer(val: any): Buffer | null {
  if (!val) return null;
  if (Buffer.isBuffer(val)) return val;
  if (val instanceof Uint8Array) return Buffer.from(val);
  // JSON-serialized Buffer: { type: "Buffer", data: [72, 101, ...] }
  if (val.type === "Buffer" && Array.isArray(val.data)) return Buffer.from(val.data);
  // Array of bytes
  if (Array.isArray(val)) return Buffer.from(val);
  // Structured object from pay_for_resource: { contentType: "...", data: <Buffer> }
  if (typeof val === "object" && val.data && val.data !== val) return toBuffer(val.data);
  return null;
}

// ── Send binary content to Telegram based on content-type ──
async function sendMedia(
  ctx: BotContext, uid: number, chatId: number, action: string, ct: string, buf: Buffer,
): Promise<{ summary: string; fileId: string | null }> {
  if (buf.length > MAX_FILE_SIZE) {
    return { summary: JSON.stringify({ error: `Response too large (${(buf.length / 1024 / 1024).toFixed(1)} MB). Max 10 MB.` }), fileId: null };
  }
  const sizeStr = `${(buf.length / 1024).toFixed(1)} KB`;
  if (ct === "image/gif") {
    const fileId = ctx.fileStore.save(uid, `${action}.gif`, "image/gif", buf, action);
    verboseLog(`BOT:${uid}`, "DIRECT_REPLY", `sendAnimation: ${action}.gif`);
    try { await ctx.bot.api.sendAnimation(chatId, new InputFile(buf, `${action}.gif`), { caption: `${action} (saved 48h)` }); } catch {}
    return { summary: JSON.stringify({ type: "animation", fileId, size: sizeStr, sent: true }), fileId };
  }
  if (ct.startsWith("image/")) {
    const ext = ct.includes("png") ? "png" : ct.includes("webp") ? "webp" : "jpg";
    const fileId = ctx.fileStore.save(uid, `${action}.${ext}`, ct, buf, action);
    verboseLog(`BOT:${uid}`, "DIRECT_REPLY", `sendPhoto: ${action}.${ext}`);
    try { await ctx.bot.api.sendPhoto(chatId, new InputFile(buf, `${action}.${ext}`), { caption: `${action} (saved 48h)` }); } catch {}
    return { summary: JSON.stringify({ type: "image", fileId, size: sizeStr, sent: true }), fileId };
  }
  if (ct.startsWith("audio/")) {
    const ext = ct.includes("ogg") ? "ogg" : ct.includes("wav") ? "wav" : "mp3";
    const fileId = ctx.fileStore.save(uid, `${action}.${ext}`, ct, buf, action);
    verboseLog(`BOT:${uid}`, "DIRECT_REPLY", `sendAudio: ${action}.${ext}`);
    try { await ctx.bot.api.sendAudio(chatId, new InputFile(buf, `${action}.${ext}`), { caption: `${action} (saved 48h)` }); } catch {}
    return { summary: JSON.stringify({ type: "audio", fileId, size: sizeStr, sent: true }), fileId };
  }
  const subtype = ct.split("/")[1] || "bin";
  const fileId = ctx.fileStore.save(uid, `${action}.${subtype}`, ct, buf, action);
  verboseLog(`BOT:${uid}`, "DIRECT_REPLY", `sendDocument: ${action}.${subtype}`);
  try { await ctx.bot.api.sendDocument(chatId, new InputFile(buf, `${action}.${subtype}`), { caption: `${action} (saved 48h)` }); } catch {}
  return { summary: JSON.stringify({ type: "document", fileId, size: sizeStr, sent: true }), fileId };
}

// ── File handling for action results ──
export async function handleActionResult(
  ctx: BotContext, uid: number, chatId: number, action: string, result: any,
): Promise<{ summary: string; fileId: string | null }> {
  if (result === null || result === undefined) return { summary: "null", fileId: null };
  if (result?.error) return { summary: JSON.stringify(result), fileId: null };

  // ── x402 paid content ──
  // Use the resource data directly from the result object.
  // Do NOT re-fetch: the payment hash is consumed by the anti-replay store
  // after the first successful verification — re-fetching always gets 402.
  if (action === "pay_for_resource" && result?.paid === true) {
    // Priority 1: result.data = { contentType: "image/png", data: <Buffer> }
    // This is set by plugin-payments when verified:true and the response is binary.
    // result.data.contentType is the REAL resource type (not the error response type).
    const dataCt = (result?.data?.contentType as string | undefined)?.split(";")[0]?.trim();
    const dataBuf = dataCt ? toBuffer(result.data) : null;
    if (dataBuf && dataBuf.length > 0 && dataCt && /^(image|audio|video)\//i.test(dataCt)) {
      return await sendMedia(ctx, uid, chatId, action, dataCt, dataBuf);
    }

    // Priority 2: result.content with a media contentType (verified:true, non-binary parsed differently)
    if (result.verified === true) {
      const ct = ((result.contentType as string) || "").split(";")[0].trim();
      const buf = toBuffer(result.content);
      if (buf && buf.length > 0 && (ct.startsWith("image/") || ct.startsWith("audio/") || ct === "application/pdf" || ct === "application/octet-stream")) {
        return await sendMedia(ctx, uid, chatId, action, ct, buf);
      }
    }

    // Priority 3: JSON-wrapped binary from x402 servers that use res.json()
    // The response may be { service: "...", data: { contentType: "image/png", data: {...} } }
    // or spread: { source: "...", contentType: "image/png", data: {...} }
    if (result.verified === true && result.data && typeof result.data === "object") {
      // Check nested: result.data.data may have contentType
      const nested = result.data.data;
      if (nested && typeof nested === "object" && typeof nested.contentType === "string") {
        const nCt = nested.contentType.split(";")[0].trim();
        const nBuf = toBuffer(nested);
        if (nBuf && nBuf.length > 0 && /^(image|audio|video)\//i.test(nCt)) {
          return await sendMedia(ctx, uid, chatId, action, nCt, nBuf);
        }
      }
    }

    // verified:false or no binary content → fall through to JSON handler.
    // The JSON response includes txHash, message, url for manual recovery.
  } else if (result?.contentType && (result?.content || result?.data)) {
  // ── Generic binary response (non-pay_for_resource actions) ──
    const ct = ((result.contentType as string) || "").split(";")[0].trim();
    const buf = toBuffer(result.content) || toBuffer(result.data);
    if (buf && buf.length > 0 && ct) {
      return await sendMedia(ctx, uid, chatId, action, ct, buf);
    }
  }

  // ── JSON / text response ──
  const jsonStr = JSON.stringify(result);
  if (jsonStr.length < 4000) {
    let fileId: string | null = null;
    try { fileId = ctx.fileStore.save(uid, `${action}.json`, "application/json", Buffer.from(JSON.stringify(result, null, 2)), action); } catch {}
    return { summary: jsonStr, fileId };
  }
  // Large JSON — truncate for LLM, save full version
  let fileId: string | null = null;
  try { fileId = ctx.fileStore.save(uid, `${action}.json`, "application/json", Buffer.from(JSON.stringify(result, null, 2)), action); } catch {}
  const truncated = jsonStr.slice(0, 3500) + `\n... (${(jsonStr.length / 1024).toFixed(1)} KB total${fileId ? ", saved as file" : ""})`;
  return { summary: truncated, fileId };
}
