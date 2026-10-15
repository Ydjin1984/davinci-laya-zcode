// chunk-store.mjs — хранилище вытесненных фрагментов (ContextSelector).
//
// Принцип §6.3/§9.6 ТЗ: любой блок, который «не поместился» в контекст главной
// модели, не исчезает — он сохраняется с идентификатором, хэшем и возможностью
// достать оригинал (`laya_get_chunk`). Вероятностное удаление без возможности
// восстановления запрещено: цена ошибки — потерянное требование пользователя.

import fs from "node:fs";
import path from "node:path";
import { paths, safeId } from "./config.mjs";

function indexFile() {
  return path.join(paths().chunksDir, "index.jsonl");
}

/** Сохраняет фрагменты и возвращает их идентификаторы. Best-effort. */
export function storeChunks(chunks) {
  const ids = [];
  const dir = paths().chunksDir;
  try {
    fs.mkdirSync(dir, { recursive: true });
    const rows = [];
    for (const c of chunks) {
      const id = c.id ? safeId(c.id) : `chunk-${Date.now().toString(36)}-${ids.length}`;
      const file = path.join(dir, `${id}.txt`);
      const text = String(c.text ?? "");
      fs.writeFileSync(file, text, "utf8");
      rows.push({
        id,
        kind: c.kind || "text",
        bytes: Buffer.byteLength(text, "utf8"),
        chars: text.length,
        preview: text.slice(0, 160),
        ts: new Date().toISOString(),
      });
      ids.push(id);
    }
    if (rows.length) fs.appendFileSync(indexFile(), rows.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf8");
  } catch (err) {
    process.stderr.write(`[davinci-laya] chunk store: ${err.message}\n`);
  }
  return ids;
}

/** Достаёт полный текст фрагмента по идентификатору. */
export function getChunk(id) {
  const safe = safeId(id);
  const file = path.join(paths().chunksDir, `${safe}.txt`);
  try {
    if (!fs.existsSync(file)) return { ok: false, error: `фрагмент ${safe} не найден` };
    const text = fs.readFileSync(file, "utf8");
    const st = fs.statSync(file);
    return { ok: true, id: safe, bytes: st.size, chars: text.length, text };
  } catch (err) {
    return { ok: false, error: err.message };
  }
}

/** Удаляет самые старые фрагменты сверх лимита (по mtime файлов). */
export function pruneChunks(cfg) {
  const dir = paths().chunksDir;
  const max = cfg?.chunks?.maxFiles ?? 500;
  try {
    const files = fs
      .readdirSync(dir)
      .filter((n) => n.endsWith(".txt"))
      .map((n) => ({ n, m: fs.statSync(path.join(dir, n)).mtimeMs }))
      .sort((a, b) => a.m - b.m);
    const excess = files.length - max;
    for (let i = 0; i < excess; i++) fs.unlinkSync(path.join(dir, files[i].n));
  } catch {
    /* каталога нет */
  }
}
