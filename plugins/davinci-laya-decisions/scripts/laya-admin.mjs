#!/usr/bin/env node
// laya-admin.mjs — служебная CLI плагина: status / mode / bench / review / doctor.
//
// Запускается командами ZCode (/laya-status, /laya-bench, /laya-review, /laya-mode)
// и вручную из терминала. Не часть протокола: только диагностика и настройка.

import fs from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { loadConfig, paths, ensureDataDir, allDataDirs } from "../src/config.mjs";
import { health, decide, questions, noul, choice, score, QUESTION_SET_VERSION } from "../src/laya-client.mjs";
import { summarizeMetrics } from "../src/telemetry.mjs";
import { readLedger } from "../src/evidence-ledger.mjs";
import { breakerState } from "../src/laya-client.mjs";
import pkg from "../package.json" with { type: "json" };

const READ_VERSION = pkg.version || "0.0.0";

const [, , cmd, ...rest] = process.argv;

function out(s = "") {
  process.stdout.write(s + "\n");
}

async function status() {
  const cfg = loadConfig();
  const dir = ensureDataDir();
  const h = await health({ cfg });
  const br = breakerState(cfg);
  const m = summarizeMetrics();
  out("=== DaVinci × Laya: статус ===");
  out(`Плагин:        v${READ_VERSION}`);
  out(`Каталог данных: ${dir}`);
  out(`Конфигурация:  ${paths().config}`);
  const extraDataDirs = allDataDirs().filter((d) => path.resolve(d) !== path.resolve(dir));
  if (extraDataDirs.length) out(`  другие каталоги данных (не активны): ${extraDataDirs.join(", ")}`);
  out(`Адрес Laya:    ${cfg.layaUrl}`);
  out("");
  if (h.ok) {
    out(`Laya:          ГОТОВА (device=${h.device}, checkpoint=${h.checkpointId})`);
    out(`  max_len=${h.maxLen}, head_max_len=${h.headMaxLen}, latency=${h.latencyMs} мс`);
    out(`  запросов всего: ${h.stats?.requests ?? "?"}, ошибок: ${h.stats?.failures ?? 0}`);
  } else {
    out(`Laya:          НЕДОСТУПНА (${h.error.code}: ${h.error.message})`);
    out(`  Гейты работают пассивно; штатные разрешения ZCode не изменяются.`);
  }
  if (br.open) out(`Circuit breaker: ОТКРЫТ до ${new Date(br.until).toISOString()} (${br.lastError})`);
  out("");
  out("Режимы гейтов:");
  out(`  RiskGate (PreToolUse): ${cfg.riskGate.mode}  (порог ask: p≥${cfg.riskGate.askMinConfidence})`);
  out(`  DoneGate (Stop):       ${cfg.doneGate.mode}  (блокировок на сессию: ${cfg.doneGate.maxBlocksPerSession})`);
  out(`  TaskRouter:            ${cfg.router.mode}`);
  out(`  sessionContext:        ${cfg.sessionContext ? "вкл" : "выкл"}`);
  out("");
  out(`Метрики (файлы: ${paths().metricsDir}):`);
  out(`  событий: ${m.events}, сбоев Laya: ${m.errors}, с обрезкой state: ${m.truncated}`);
  if (m.events) {
    out(`  по видам: ${Object.entries(m.byKind).map(([k, v]) => `${k}=${v}`).join(", ")}`);
    out(`  действия: ${Object.entries(m.byAction).map(([k, v]) => `${k}=${v}`).join(", ")}`);
    if (m.p50 !== null) out(`  latency p50=${m.p50} мс, p95=${m.p95} мс`);
    out(`  чекпоинты: ${Object.entries(m.checkpoints).map(([k, v]) => `${k}(${v})`).join(", ")}`);
  }
  out("");
  out("Версия шаблонов вопросов: " + QUESTION_SET_VERSION);
  return h.ok ? 0 : 1;
}

function mode(args) {
  const [gate, value] = args;
  const allowed = {
    risk: { key: "riskGate", values: ["off", "shadow", "ask"] },
    done: { key: "doneGate", values: ["off", "report", "block"] },
    router: { key: "router", values: ["off", "log", "advise"] },
    sessioncontext: { key: "sessionContext", values: ["on", "off", "true", "false"] },
  };
  if (!gate || !allowed[gate.toLowerCase()]) {
    out("Использование: laya-admin mode <risk|done|router|sessionContext> <значение>");
    out("  risk:  off | shadow | ask");
    out("  done:  off | report | block");
    out("  router: off | log | advise");
    out("  sessionContext: on | off");
    return 2;
  }
  const spec = allowed[gate.toLowerCase()];
  const file = paths().config;
  const cfg = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  if (spec.key === "sessionContext") {
    cfg.sessionContext = ["on", "true"].includes(String(value).toLowerCase());
  } else {
    if (!spec.values.includes(value)) {
      out(`Недопустимое значение «${value}». Разрешено: ${spec.values.join(" | ")}`);
      return 2;
    }
    cfg[spec.key] = { ...(cfg[spec.key] || {}), mode: value };
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n", "utf8");
  out(`Ок: ${spec.key}${spec.key === "sessionContext" ? "" : ".mode"} = ${value}`);
  if (spec.key === "riskGate" && value === "ask") {
    out("ВНИМАНИЕ: режим ask повышает вопросы пользователю для подтверждённо опасных вызовов.");
    out("Включайте его только после просмотра метрик: node scripts/laya-admin.mjs status");
  }
  if (spec.key === "doneGate" && value === "block") {
    out("ВНИМАНИЕ: режим block разрешает ОДНУ блокировку завершения на сессию при нехватке доказательств.");
  }
  return 0;
}

/**
 * Максимальный режим: включить все гейты и контекстные подсказки сразу.
 * on  → risk=ask, done=block, router=advise, sessionContext=on;
 * off → обратно к наблюдению (shadow/report/log/off).
 */
function all(args) {
  const off = ["off", "выкл", "0", "false"].includes(String(args[0] || "on").toLowerCase());
  const file = paths().config;
  const cfg = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, "utf8")) : {};
  if (!off) {
    cfg.riskGate = { ...(cfg.riskGate || {}), mode: "ask" };
    cfg.doneGate = { ...(cfg.doneGate || {}), mode: "block" };
    cfg.router = { ...(cfg.router || {}), mode: "advise" };
    cfg.sessionContext = true;
    out("Максимальный режим Laya ВКЛЮЧЁН: risk=ask, done=block, router=advise, sessionContext=on.");
    out("Что это значит: подтверждённо опасные вызовы спросят разрешение; Stop может один раз");
    out("вернуть задачу на проверку, если код менялся без тестов; класс задачи придёт строкой в контекст.");
    out("Инструменты — по правилу окупаемости: заменять чтение, а не добавлять проверки (см. /laya-all).");
    out("Строгий режим экономии: mode router log (строка advise идёт на каждый промпт, точность ≈58%).");
  } else {
    cfg.riskGate = { ...(cfg.riskGate || {}), mode: "shadow" };
    cfg.doneGate = { ...(cfg.doneGate || {}), mode: "report" };
    cfg.router = { ...(cfg.router || {}), mode: "log" };
    cfg.sessionContext = false;
    out("Возврат к наблюдению: risk=shadow, done=report, router=log, sessionContext=off.");
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n", "utf8");
  out(`Конфигурация: ${file}`);
  return 0;
}

async function bench() {
  const cfg = loadConfig();
  const q = questions([
    noul("data_loss", "Уничтожит ли это действие несохранённые данные?"),
    choice("risk_class", "Категория риска?", { low: "безопасно", medium: "восстановимо", high: "потеря данных" }),
    score("difficulty", "Сложность?", ["просто", "средне", "сложно"]),
  ]);
  const state = "Инструмент: Bash\nКоманда: rm -rf ./build\nПуть: build (внутри проекта)";
  // Прогрев: первый вызов после простоя дороже (кэш CUDA / кэш процесса).
  await decide(state, q, { cfg });
  const iterations = Number(rest[0] || 30);
  const lat = [];
  let elapsedSum = 0;
  let fail = 0;
  for (let i = 0; i < iterations; i++) {
    const t0 = Date.now();
    const res = await decide(state, q, { cfg });
    lat.push(Date.now() - t0);
    if (!res.ok) fail++;
    else elapsedSum += res.elapsedMs || 0;
  }
  lat.sort((a, b) => a - b);
  const p = (x) => lat[Math.min(lat.length - 1, Math.floor(x * (lat.length - 1)))];
  out(`Прогонов: ${iterations}, сбоев: ${fail}`);
  out(`End-to-end: p50=${p(0.5)} мс, p95=${p(0.95)} мс, max=${lat[lat.length - 1]} мс`);
  out(`Инференс по данным сервера: среднее ${(elapsedSum / Math.max(1, iterations - fail)).toFixed(1)} мс`);
  try {
    const res = await fetch(cfg.layaUrl.replace(/\/+$/, "") + "/benchmark", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ state, questions: q, iterations, concurrency: 1 }),
    });
    const b = await res.json();
    if (b && b.p50_ms !== undefined) {
      out(`Сервер /benchmark: p50=${b.p50_ms.toFixed(2)} мс, p95=${b.p95_ms.toFixed(2)} мс, p99=${b.p99_ms.toFixed(2)} мс, ${b.rps.toFixed(1)} rps, ответов/вызов=${b.answers_per_call}`);
    }
  } catch (err) {
    out(`/benchmark: ${err.message}`);
  }
  return fail === 0 ? 0 : 1;
}

async function review() {
  // Ранжирование текущего git diff через тот же код, что и MCP-инструмент.
  const { findTool } = await import("../src/tools.mjs");
  let diff = "";
  try {
    diff = execFileSync("git", ["diff", "--no-color", "HEAD"], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
  } catch {
    try {
      diff = execFileSync("git", ["diff", "--no-color"], { encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
    } catch (err) {
      out(`git diff недоступен: ${err.message}`);
      return 2;
    }
  }
  if (!diff.trim()) {
    out("Нет незакоммиченных изменений (git diff пуст).");
    return 0;
  }
  const tool = findTool("laya_rank_diff");
  const res = await tool.handler({ diff, top_k: 12 });
  out(res.content[0].text);
  return 0;
}

async function doctor() {
  const cfg = loadConfig();
  const checks = [];
  checks.push(["Node.js ≥ 20", Number(process.versions.node.split(".")[0]) >= 20, process.versions.node]);
  const h = await health({ cfg });
  checks.push(["Laya доступна", h.ok, h.ok ? `${h.device}, ${h.checkpointId}` : h.error.message]);
  if (h.ok) {
    checks.push(["Чекпоинт определён", Boolean(h.checkpointId && !h.checkpointId.endsWith("-")), h.checkpointId || "нет"]);
    const probe = await decide("проверка doctor: текст короткий", questions([noul("ok", "Это текст?")]), { cfg });
    checks.push(["Инференс проходит", probe.ok, probe.ok ? `${probe.elapsedMs} мс` : probe.error.message]);
  }
  const dir = ensureDataDir();
  let writable = true;
  try {
    fs.writeFileSync(path.join(dir, ".write-probe"), "1");
    fs.unlinkSync(path.join(dir, ".write-probe"));
  } catch {
    writable = false;
  }
  checks.push(["Каталог данных доступен на запись", writable, dir]);
  const led = readLedger("doctor", cfg);
  checks.push(["Ledger читается", typeof led.toolCalls === "number", "ок"]);
  // Лаунчер хуков: без него read-only команды стоят ~0.2 c лишних на событие.
  const launcherPath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "bin", "laya-hook.exe");
  if (process.platform === "win32") {
    const exists = fs.existsSync(launcherPath);
    checks.push(["Лаунчер хуков собран", exists, exists ? "bin/laya-hook.exe" : "нет — запустите build-launcher.cmd"]);
  } else {
    checks.push(["Лаунчер хуков", true, "только Windows: не требуется"]);
  }
  out("=== Doctor ===");
  for (const [name, ok, detail] of checks) out(`${ok ? "[ok]  " : "[FAIL]"} ${name}: ${detail}`);
  const failed = checks.filter((c) => !c[1]).length;
  out(failed ? `Провалено проверок: ${failed}` : "Все проверки пройдены.");
  return failed ? 1 : 0;
}

const commands = { status, mode, all, bench, review, doctor };
const fn = commands[cmd];
if (!fn) {
  out("Использование: laya-admin.mjs <status|mode|all|bench|review|doctor>");
  process.exit(2);
}
const code = await fn(rest);
process.exit(typeof code === "number" ? code : 0);
