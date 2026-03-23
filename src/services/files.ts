import { InputFile } from "grammy";
import type { BotContext } from "../context";
import { MAX_FILE_SIZE } from "@ton-agent-kit/wallet-store";

// ── File handling for action results ──
export async function handleActionResult(
  ctx: BotContext, uid: number, chatId: number, action: string, result: any,
): Promise<{ summary: string; fileId: string | null }> {
  if (result === null || result === undefined) return { summary: "null", fileId: null };
  if (result?.error) return { summary: JSON.stringify(result), fileId: null };

  // Binary response with content-type (e.g. from pay_for_resource)
  if (result?.contentType && result?.data) {
    const ct = result.contentType as string;
    const buf = Buffer.isBuffer(result.data) ? result.data : Buffer.from(result.data);
    if (buf.length > MAX_FILE_SIZE) {
      return { summary: JSON.stringify({ error: `Response too large (${(buf.length / 1024 / 1024).toFixed(1)} MB). Max 10 MB.` }), fileId: null };
    }
    try {
      if (ct.startsWith("image/")) {
        const ext = ct.includes("png") ? "png" : ct.includes("webp") ? "webp" : "jpg";
        const fileId = ctx.fileStore.save(uid, `${action}.${ext}`, ct, buf, action);
        try { await ctx.bot.api.sendPhoto(chatId, new InputFile(buf, `${action}.${ext}`), { caption: `${action} (saved for 48h)` }); } catch {}
        return { summary: JSON.stringify({ type: "image", fileId, size: `${(buf.length / 1024).toFixed(1)} KB`, sent: true }), fileId };
      }
      if (ct.startsWith("audio/")) {
        const ext = ct.includes("ogg") ? "ogg" : ct.includes("wav") ? "wav" : "mp3";
        const fileId = ctx.fileStore.save(uid, `${action}.${ext}`, ct, buf, action);
        try { await ctx.bot.api.sendAudio(chatId, new InputFile(buf, `${action}.${ext}`), { caption: `${action} (saved for 48h)` }); } catch {}
        return { summary: JSON.stringify({ type: "audio", fileId, size: `${(buf.length / 1024).toFixed(1)} KB`, sent: true }), fileId };
      }
      const subtype = ct.split("/")[1] || "bin";
      const fileId = ctx.fileStore.save(uid, `${action}.${subtype}`, ct, buf, action);
      try { await ctx.bot.api.sendDocument(chatId, new InputFile(buf, `${action}.${subtype}`), { caption: `${action} (saved for 48h)` }); } catch {}
      return { summary: JSON.stringify({ type: "document", fileId, size: `${(buf.length / 1024).toFixed(1)} KB`, sent: true }), fileId };
    } catch (err: any) {
      return { summary: JSON.stringify({ error: `File storage failed: ${err.message}` }), fileId: null };
    }
  }

  // JSON response
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
