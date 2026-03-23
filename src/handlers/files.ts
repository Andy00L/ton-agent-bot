import { InlineKeyboard, InputFile } from "grammy";
import { MAX_USER_STORAGE } from "@ton-agent-kit/wallet-store";
import type { BotContext } from "../context";
import { escapeHtml, safeReply, verboseLog } from "../helpers";
import { mainMenuKb } from "../keyboards";

// ── renderFilesList helper ──
async function renderFilesList(botCtx: BotContext, ctx: any, uid: number, page: number) {
  botCtx.fileStore.cleanupExpired();
  const limit = 5;
  const files = botCtx.fileStore.listFiles(uid, page * limit, limit);
  const total = botCtx.fileStore.countFiles(uid);
  const storage = botCtx.fileStore.getUserStorage(uid);
  const now = Math.floor(Date.now() / 1000);

  let msg = `<b>📁 My Files</b> (${total} files, ${(storage / 1024 / 1024).toFixed(1)} / ${MAX_USER_STORAGE / 1024 / 1024} MB)\n\n`;
  if (files.length === 0) {
    msg += `<i>No files stored.</i>\nFiles are saved automatically from action results.`;
  } else {
    for (const f of files) {
      const hoursLeft = Math.max(0, Math.floor((f.expiresAt - now) / 3600));
      const icon = f.contentType.startsWith("image/") ? "🖼️" : f.contentType.startsWith("audio/") ? "🎵" : f.contentType === "application/pdf" ? "📕" : "📄";
      const sizeStr = f.size < 1024 ? `${f.size} B` : f.size < 1024 * 1024 ? `${(f.size / 1024).toFixed(1)} KB` : `${(f.size / 1024 / 1024).toFixed(1)} MB`;
      msg += `${icon} <b>${escapeHtml(f.filename)}</b> (${sizeStr})\n   ${escapeHtml(f.source || "unknown")} | ${hoursLeft}h left\n\n`;
    }
  }

  const kb = new InlineKeyboard();
  for (const f of files) {
    const isImage = f.contentType.startsWith("image/");
    const isAudio = f.contentType.startsWith("audio/");
    if (isImage) {
      kb.text(`View ${f.filename.slice(0, 12)}`, `file_view_${f.id}`).text("Del", `file_del_${f.id}`).row();
    } else if (isAudio) {
      kb.text(`Play ${f.filename.slice(0, 12)}`, `file_play_${f.id}`).text("Del", `file_del_${f.id}`).row();
    } else {
      kb.text(`View ${f.filename.slice(0, 12)}`, `file_view_${f.id}`).text("DL", `file_dl_${f.id}`).text("Del", `file_del_${f.id}`).row();
    }
  }
  if (page > 0 || files.length === limit) {
    if (page > 0) kb.text("« Prev", `btn_files_${page - 1}`);
    if (files.length === limit) kb.text("Next »", `btn_files_${page + 1}`);
    kb.row();
  }
  if (total > 0) kb.text("Delete All", "files_delete_all").row();
  kb.text("« Back", "btn_main");
  await ctx.editMessageText(msg, { parse_mode: "HTML", reply_markup: kb });
}

// ══════════════════════════════════════
// ══ FILES CALLBACKS ══════════════════
// ══════════════════════════════════════
export function registerFilesHandlers(botCtx: BotContext) {

  botCtx.bot.callbackQuery(/^btn_files(?:_(\d+))?$/, async (ctx) => {
    verboseLog(`USER:${ctx.from?.id}`, `BUTTON:${ctx.callbackQuery.data}`, "");
    verboseLog(`BOT:${ctx.from?.id ?? "?"}`, "DIRECT_REPLY", "answerCallbackQuery");
    await ctx.answerCallbackQuery();
    await renderFilesList(botCtx, ctx, ctx.from!.id, parseInt(ctx.match?.[1] || "0"));
  });

  botCtx.bot.callbackQuery(/^file_view_([a-f0-9]+)$/, async (ctx) => {
    verboseLog(`USER:${ctx.from?.id}`, `BUTTON:${ctx.callbackQuery.data}`, "");
    verboseLog(`BOT:${ctx.from?.id ?? "?"}`, "DIRECT_REPLY", "answerCallbackQuery");
    await ctx.answerCallbackQuery();
    const fileId = ctx.match![1];
    const uid = ctx.from!.id;
    const file = botCtx.fileStore.getFile(fileId);
    if (!file || file.uid !== uid) {
      await ctx.editMessageText("File not found or expired.", { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("« Back", "btn_files") });
      return;
    }
    const buffer = botCtx.fileStore.getFileBuffer(fileId);
    if (!buffer) {
      await ctx.editMessageText("File data not found.", { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("« Back", "btn_files") });
      return;
    }
    const chatId = ctx.chat!.id;
    try {
      if (file.contentType.startsWith("image/")) {
        verboseLog(`BOT:${ctx.from?.id ?? "?"}`, "DIRECT_REPLY", `sendPhoto: ${file.filename}`);
        await botCtx.bot.api.sendPhoto(chatId, new InputFile(buffer, file.filename));
      } else if (file.contentType.startsWith("audio/")) {
        verboseLog(`BOT:${ctx.from?.id ?? "?"}`, "DIRECT_REPLY", `sendAudio: ${file.filename}`);
        await botCtx.bot.api.sendAudio(chatId, new InputFile(buffer, file.filename));
      } else {
        const text = buffer.toString("utf8");
        if (text.length <= 4000) {
          verboseLog(`BOT:${ctx.from?.id ?? "?"}`, "DIRECT_REPLY", `file text preview: ${file.filename}`);
          await ctx.reply(`<b>${escapeHtml(file.filename)}</b>\n\n<pre>${escapeHtml(text)}</pre>`, { parse_mode: "HTML" });
        } else {
          verboseLog(`BOT:${ctx.from?.id ?? "?"}`, "DIRECT_REPLY", `sendDocument: ${file.filename}`);
          await botCtx.bot.api.sendDocument(chatId, new InputFile(buffer, file.filename));
        }
      }
    } catch (err: any) {
      await safeReply(ctx, `Failed to send file: ${escapeHtml(err.message?.slice(0, 100) || "unknown")}`);
    }
  });

  botCtx.bot.callbackQuery(/^file_play_([a-f0-9]+)$/, async (ctx) => {
    verboseLog(`USER:${ctx.from?.id}`, `BUTTON:${ctx.callbackQuery.data}`, "");
    verboseLog(`BOT:${ctx.from?.id ?? "?"}`, "DIRECT_REPLY", "answerCallbackQuery");
    await ctx.answerCallbackQuery();
    const uid = ctx.from!.id;
    const file = botCtx.fileStore.getFile(ctx.match![1]);
    if (!file || file.uid !== uid) return;
    const buffer = botCtx.fileStore.getFileBuffer(ctx.match![1]);
    if (!buffer) return;
    verboseLog(`BOT:${ctx.from?.id ?? "?"}`, "DIRECT_REPLY", `sendAudio: ${file.filename}`);
    try { await botCtx.bot.api.sendAudio(ctx.chat!.id, new InputFile(buffer, file.filename)); } catch {}
  });

  botCtx.bot.callbackQuery(/^file_dl_([a-f0-9]+)$/, async (ctx) => {
    verboseLog(`USER:${ctx.from?.id}`, `BUTTON:${ctx.callbackQuery.data}`, "");
    verboseLog(`BOT:${ctx.from?.id ?? "?"}`, "DIRECT_REPLY", "answerCallbackQuery");
    await ctx.answerCallbackQuery();
    const uid = ctx.from!.id;
    const file = botCtx.fileStore.getFile(ctx.match![1]);
    if (!file || file.uid !== uid) return;
    const buffer = botCtx.fileStore.getFileBuffer(ctx.match![1]);
    if (!buffer) return;
    verboseLog(`BOT:${ctx.from?.id ?? "?"}`, "DIRECT_REPLY", `sendDocument: ${file.filename}`);
    try { await botCtx.bot.api.sendDocument(ctx.chat!.id, new InputFile(buffer, file.filename)); } catch {}
  });

  botCtx.bot.callbackQuery(/^file_del_([a-f0-9]+)$/, async (ctx) => {
    verboseLog(`USER:${ctx.from?.id}`, `BUTTON:${ctx.callbackQuery.data}`, "");
    verboseLog(`BOT:${ctx.from?.id ?? "?"}`, "DIRECT_REPLY", "answerCallbackQuery: Deleted");
    await ctx.answerCallbackQuery("Deleted");
    const uid = ctx.from!.id;
    const file = botCtx.fileStore.getFile(ctx.match![1]);
    if (file && file.uid === uid) botCtx.fileStore.deleteFile(ctx.match![1]);
    await renderFilesList(botCtx, ctx, uid, 0);
  });

  botCtx.bot.callbackQuery("files_delete_all", async (ctx) => {
    verboseLog(`USER:${ctx.from?.id}`, `BUTTON:${ctx.callbackQuery.data}`, "");
    verboseLog(`BOT:${ctx.from?.id ?? "?"}`, "DIRECT_REPLY", "answerCallbackQuery");
    await ctx.answerCallbackQuery();
    await ctx.editMessageText(
      `<b>⚠️ Delete ALL your stored files?</b>`,
      { parse_mode: "HTML", reply_markup: new InlineKeyboard().text("Yes, delete all", "files_delete_all_confirm").text("Cancel", "btn_files") },
    );
  });

  botCtx.bot.callbackQuery("files_delete_all_confirm", async (ctx) => {
    verboseLog(`USER:${ctx.from?.id}`, `BUTTON:${ctx.callbackQuery.data}`, "");
    verboseLog(`BOT:${ctx.from?.id ?? "?"}`, "DIRECT_REPLY", "answerCallbackQuery: All files deleted");
    await ctx.answerCallbackQuery("All files deleted");
    const uid = ctx.from!.id;
    const count = botCtx.fileStore.deleteAllFiles(uid);
    await ctx.editMessageText(
      `<b>Deleted ${count} files.</b>`,
      { parse_mode: "HTML", reply_markup: mainMenuKb() },
    );
  });
}
