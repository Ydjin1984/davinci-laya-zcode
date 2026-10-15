// gates.mjs — реализации гейтов, вызываемые из хуков и из тестов.
//
// Все функции принимают зависимости явно (cfg, client, ledgerApi, now), поэтому
// офлайн-тесты подставляют фиктивного клиента Laya и проверяют решения без
// сервера и без GPU. Хуки — тонкие обёртки: прочитать stdin, позвать gate,
// вывести JSON.
//
// Формат вывода повторяет документированную схему ZCode: наружу уходит только
// `hookSpecificOutput` соответствующего события либо ничего. Никаких allow/deny:
// PreToolUse может лишь повысить вопрос (ask), Stop — лишь попросить одну
// дополнительную проверку.

import { loadConfig } from "./config.mjs";
import { prepareForLaya, maskText, textHash } from "./sanitize.mjs";
import {
  scanDeterministic,
  buildRiskState,
  riskQuestions,
  evaluateRisk,
  evaluateDoneGaps,
  doneQuestions,
  routerQuestions,
  interpretRouter,
  shouldAskLaya,
} from "./decision-policy.mjs";
import { readLedger, recordToolUse, updateLedger, bumpCounter, ledgerSummary } from "./evidence-ledger.mjs";
import { recordEvent } from "./telemetry.mjs";

const TOOL_MATCH_CACHE = new Map();
function toolMatches(pattern, toolName) {
  let re = TOOL_MATCH_CACHE.get(pattern);
  if (!re) {
    try {
      re = new RegExp(`^(?:${pattern})$`);
    } catch {
      re = null;
    }
    TOOL_MATCH_CACHE.set(pattern, re);
  }
  return re ? re.test(toolName) : false;
}

function scoresFromDecide(laya) {
  if (!laya || !laya.ok) return null;
  const out = {};
  for (const id of laya.order) {
    const a = laya.answers[id];
    out[id] = {
      type: a.type,
      choice: a.choice ?? null,
      score: a.type === "score" ? a.score : null,
      noul: a.type === "noul" ? a.noul : null,
      answer_confidence: a.answer_confidence,
    };
  }
  return out;
}

// ------------------------------------------------------------ RiskGate

/**
 * Гейт риска на PreToolUse.
 *
 * Возвращает { output, telemetry }: `output` — объект для stdout (null = молчать).
 * В shadow-режиме output всегда null: решение пишется только локально, разрешения
 * не трогаются — ровно как требует §6.1 ТЗ для первого этапа.
 */
export async function preToolGate(input, deps = {}) {
  const cfg = deps.cfg || loadConfig();
  const client = deps.client;
  const now = deps.now || Date.now();
  const toolName = input?.tool_name || "";
  const toolInput = input?.tool_input || {};
  const cwd = input?.cwd || process.cwd();
  const sessionId = input?.session_id || "unknown";

  if (!toolName || !toolMatches(cfg.riskGate.tools, toolName)) {
    return { output: null, telemetry: null };
  }

  const t0 = now;
  const detHits = scanDeterministic({ toolName, toolInput, cwd, extraRules: cfg.riskGate.extraRules });
  const ledger = readLedger(sessionId, cfg);
  const rawState = buildRiskState({
    toolName,
    toolInput,
    cwd,
    detHits,
    gitEvidence: ledger.lastGitStatus || "",
  });
  // Маскируем и усекаем ПОСЛЕ сборки: строка содержит команду, а в ней может быть
  // токен. Усечение — с маркером выпущенных символов (никаких молчаливых потерь).
  const prepared = prepareForLaya(rawState, cfg.riskGate.stateCharBudget, cfg.riskGate.extraSecrets);
  const state = prepared.text;
  const truncated = prepared.truncated;

  let laya = null;
  let inferenceError = null;
  let layaSkipped = null;
  if (client && cfg.riskGate.mode !== "off") {
    if (shouldAskLaya({ toolName, toolInput, detHits, policy: cfg.riskGate.layaPolicy })) {
      laya = await client.decide(state, riskQuestions(), { cfg });
      if (laya && !laya.ok) inferenceError = laya.error?.code || "error";
    } else {
      layaSkipped = "read_only";
    }
  }

  const verdict = evaluateRisk({ detHits, laya, cfg });
  const latencyMs = (deps.now ? deps.now() : Date.now()) - t0;

  updateLedger(
    sessionId,
    (l) => {
      l.cwd = l.cwd || cwd;
      bumpCounter(l, `risk_${verdict.riskClass}`);
      if (verdict.action === "ask") bumpCounter(l, "risk_ask");
      if (inferenceError) bumpCounter(l, "laya_errors");
      if (layaSkipped) bumpCounter(l, "laya_skipped");
      if (truncated) bumpCounter(l, "state_truncated");
    },
    cfg,
  );

  recordEvent(
    {
      kind: "risk_gate",
      sessionId,
      tool: toolName,
      source: "hook:pre-tool",
      mode: verdict.mode,
      action: verdict.action,
      reason: verdict.reason,
      latencyMs,
      elapsedMs: laya?.elapsedMs ?? null,
      checkpoint: laya?.checkpoint || null,
      questionSetVersion: "risk-v1",
      stateHash: await textHash(state),
      stateChars: state.length,
      stateTruncated: truncated || (laya?.budget?.state_truncated ?? false),
      scores: scoresFromDecide(laya),
      inferenceError,
      detHits: detHits.map((h) => `${h.id}:${h.risk}`),
      extra: layaSkipped ? { laya_skipped: layaSkipped } : null,
    },
    cfg,
  );

  let output = null;
  if (verdict.mode === "ask" && verdict.action === "ask") {
    output = {
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "ask",
        permissionDecisionReason:
          `Laya RiskGate: класс «${verdict.riskClass}»${verdict.confidence !== null ? `, p=${verdict.confidence.toFixed(2)}` : ""}. ${verdict.reason}. ` +
          `Проверьте действие перед подтверждением.`,
      },
    };
  }
  return { output, telemetry: { verdict, detHits, truncated, latencyMs, stateHash: null } };
}

// ------------------------------------------------------- PostToolUse

/** Извлекает короткий stdout из tool_response, если он там есть. */
function extractStdout(toolResponse) {
  if (!toolResponse) return "";
  if (typeof toolResponse === "string") return toolResponse.slice(0, 4000);
  for (const key of ["stdout", "output", "content", "text"]) {
    const v = toolResponse[key];
    if (typeof v === "string") return v.slice(0, 4000);
  }
  return "";
}

/** Есть ли в tool_response признак ошибки (когда PostToolUse пришёл на сбой). */
function responseFailed(toolResponse) {
  if (!toolResponse || typeof toolResponse !== "object") return false;
  if (toolResponse.is_error === true || toolResponse.isError === true) return true;
  if (typeof toolResponse.exit_code === "number" && toolResponse.exit_code !== 0) return true;
  if (typeof toolResponse.exitCode === "number" && toolResponse.exitCode !== 0) return true;
  return false;
}

/**
 * Запись доказательств по завершённому вызову инструмента.
 * Stdout хука всегда пуст: PostToolUse не должен ни заменять вывод инструмента,
 * ни добавлять контекст — это стоило бы токенов на каждом вызове.
 */
export async function postToolGate(input, deps = {}) {
  const cfg = deps.cfg || loadConfig();
  const toolName = input?.tool_name || "";
  const toolInput = { ...(input?.tool_input || {}) };
  const sessionId = input?.session_id || "unknown";
  const stdout = extractStdout(input?.tool_response);
  if (stdout) toolInput.__result_stdout = stdout;
  const ok = !responseFailed(input?.tool_response);

  if (["Bash", "Write", "Edit", "MultiEdit", "ApplyPatch"].includes(toolName)) {
    recordToolUse(sessionId, {
      toolName,
      toolInput,
      ok,
      error: input?.error,
      cfg,
    });
  }
  return { output: null, telemetry: { recorded: ok ? "success" : "failure" } };
}

/** Отдельный обработчик PostToolUseFailure: ошибка идёт в unresolvedErrors. */
export async function postToolFailureGate(input, deps = {}) {
  const cfg = deps.cfg || loadConfig();
  const toolName = input?.tool_name || "";
  const sessionId = input?.session_id || "unknown";
  recordToolUse(sessionId, {
    toolName,
    toolInput: input?.tool_input || {},
    ok: false,
    error: { code: input?.error || "tool_failure", message: input?.error || "" },
    cfg,
  });
  return { output: null, telemetry: { recorded: "failure" } };
}

// ----------------------------------------------------------- DoneGate

/**
 * Гейт завершения на Stop.
 *
 * Детерминированные пробелы (код менялся — тесты не запускались) вычисляются из
 * ledger без модели. Laya привлекается только когда данные неполны или
 * противоречивы, и никогда не «отменяет» найденный пробел.
 *
 * Режимы: report — только лог; block — одна блокировка на сессию (не цикл).
 */
export async function stopGate(input, deps = {}) {
  const cfg = deps.cfg || loadConfig();
  const client = deps.client;
  const sessionId = input?.session_id || "unknown";
  const stopHookActive = input?.stop_hook_active === true;
  const ledger = readLedger(sessionId, cfg);
  const gaps = evaluateDoneGaps(ledger, cfg);

  let laya = null;
  let inferenceError = null;
  if (client && gaps.length > 0 && cfg.doneGate.mode !== "off") {
    // Laya оценивает обоснованность допроверки при неполных доказательствах.
    const summary = prepareForLaya(ledgerSummary(ledger), 900, cfg.riskGate.extraSecrets);
    laya = await client.decide(summary.text, doneQuestions(), { cfg });
    if (laya && !laya.ok) inferenceError = laya.error?.code || "error";
  }
  const layaVerdict = laya && laya.ok
    ? {
        needs_verification: laya.answers?.verification_needed?.noul ?? null,
        strength: laya.answers?.evidence_strength?.choice ?? null,
        confidence: laya.answers?.verification_needed?.answer_confidence ?? null,
      }
    : null;

  const highGaps = gaps.filter((g) => g.severity === "high");
  const mode = cfg.doneGate.mode;
  let output = null;
  let action = "log";

  if (mode === "block" && !stopHookActive && highGaps.length > 0 && (ledger.blocks || 0) < cfg.doneGate.maxBlocksPerSession) {
    action = "block";
    output = {
      decision: "block",
      reason:
        `Laya DoneGate: работа заявлена завершённой, но доказательств не хватает — ${highGaps.map((g) => g.detail).join("; ")}. ` +
        `Запустите проверку (тесты/lint/typecheck) и покажите результат, либо явно отметьте, что проверка невозможна (untested).`,
    };
    updateLedger(sessionId, (l) => {
      l.blocks = (l.blocks || 0) + 1;
      bumpCounter(l, "done_block");
    }, cfg);
  } else if (gaps.length > 0) {
    updateLedger(sessionId, (l) => bumpCounter(l, "done_gap_logged"), cfg);
  }

  recordEvent(
    {
      kind: "done_gate",
      sessionId,
      source: "hook:stop",
      mode,
      action,
      reason: gaps.map((g) => g.id).join(",") || "no-gaps",
      latencyMs: null,
      elapsedMs: laya?.elapsedMs ?? null,
      checkpoint: laya?.checkpoint || null,
      questionSetVersion: "done-v1",
      scores: scoresFromDecide(laya),
      inferenceError,
      extra: {
        gaps: gaps.map((g) => `${g.id}:${g.severity}`),
        changed_files: (ledger.changedFiles || []).length,
        checks: (ledger.checks || []).length,
        laya: layaVerdict,
      },
    },
    cfg,
  );

  return { output, telemetry: { gaps, layaVerdict, action } };
}

// -------------------------------------------------------- SessionStart

export async function sessionStartGate(input, deps = {}) {
  const cfg = deps.cfg || loadConfig();
  const client = deps.client;
  const sessionId = input?.session_id || "unknown";
  const cwd = input?.cwd || process.cwd();
  updateLedger(sessionId, (l) => {
    l.cwd = cwd;
    if (!l.createdAt) l.createdAt = Date.now();
  }, cfg);

  let output = null;
  if (cfg.sessionContext && client) {
    const h = await client.health({ cfg });
    const line = h.ok
      ? `Laya: готова (${h.device}, ${h.checkpointId || "чекпоинт неизвестен"}). Гейты: risk=${cfg.riskGate.mode}, done=${cfg.doneGate.mode}.`
      : `Laya: недоступна (${h.error?.code || "error"}) — гейты работают в пассивном режиме, штатные разрешения не изменяются.`;
    output = { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: line } };
  }
  return { output, telemetry: { cwd } };
}

// ------------------------------------------------------ UserPromptSubmit

/**
 * TaskRouter: рекомендация класса задачи. Модель НЕ переключается — штатный
 * UserPromptSubmit этого не умеет, и делать вид, что умеет, запрещено ТЗ.
 * Режимы: log — только метрика; advise — одна короткая строка в контекст.
 */
export async function userPromptGate(input, deps = {}) {
  const cfg = deps.cfg || loadConfig();
  const client = deps.client;
  const sessionId = input?.session_id || "unknown";
  const prompt = String(input?.prompt || "");
  if (!prompt || cfg.router.mode === "off" || !client) {
    return { output: null, telemetry: null };
  }
  const prepared = prepareForLaya(maskText(prompt, cfg.riskGate.extraSecrets), 1200, cfg.riskGate.extraSecrets);
  const laya = await client.decide(prepared.text, routerQuestions(), { cfg });
  const rec = interpretRouter(laya, cfg);
  recordEvent(
    {
      kind: "router",
      sessionId,
      source: "hook:user-prompt-submit",
      mode: cfg.router.mode,
      action: rec.available ? `class:${rec.taskClass}` : "unavailable",
      reason: rec.reason || null,
      elapsedMs: laya?.elapsedMs ?? null,
      checkpoint: laya?.checkpoint || null,
      questionSetVersion: "router-v2",
      stateHash: await textHash(prepared.text),
      scores: scoresFromDecide(laya),
      inferenceError: laya && !laya.ok ? laya.error?.code : null,
      extra: rec.available ? { trivial: rec.trivial, investigation: rec.investigation, basis: rec.basis, confidence: rec.confidence } : null,
    },
    cfg,
  );
  let output = null;
  if (cfg.router.mode === "advise" && rec.available && rec.suggestion) {
    output = {
      hookSpecificOutput: {
        hookEventName: "UserPromptSubmit",
        additionalContext: `Laya (класс задачи: ${rec.taskClass}, p=${rec.confidence?.toFixed?.(2) ?? "?"}): ${rec.suggestion.text}. Это рекомендация, а не переключение модели.`,
      },
    };
  }
  return { output, telemetry: rec };
}
