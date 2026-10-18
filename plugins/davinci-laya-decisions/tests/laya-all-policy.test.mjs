// laya-all-policy.test.mjs — проверки Laya-first политики (/laya-all).
//
// Политика должна попадать в SessionStart и в совет router только при
// layaAll=true; иначе обычный режим не должен получать лишних указаний.

import { group, test, assert, summary, makeTempDataDir, cleanupTempDataDir, fakeClient } from "./helpers.mjs";
import { DEFAULTS } from "../src/config.mjs";
import { sessionStartGate, userPromptGate } from "../src/gates.mjs";

const dir = makeTempDataDir("policy");
const client = fakeClient({ answers: { trivial: 0.1, investigation: 0.8 } });
const baseCfg = {
  ...DEFAULTS,
  sessionContext: true,
  router: { ...DEFAULTS.router, mode: "advise" },
  layaAll: false,
};

function contextOf(result) {
  return result?.output?.hookSpecificOutput?.additionalContext || "";
}

group("Laya-first: SessionStart");
await test("layaAll=true добавляет политику в контекст сессии", async () => {
  const r = await sessionStartGate(
    { session_id: "test-policy", cwd: process.cwd() },
    { cfg: { ...baseCfg, layaAll: true }, client },
  );
  const text = contextOf(r);
  assert(/Laya-first/.test(text), `нет Laya-first: ${text}`);
  assert(/laya_log_triage/.test(text), `нет triage: ${text}`);
  assert(/laya_batch/.test(text), `нет batch: ${text}`);
});

await test("layaAll=true добавляет политику даже при sessionContext=false", async () => {
  const r = await sessionStartGate(
    { session_id: "test-policy-2", cwd: process.cwd() },
    { cfg: { ...baseCfg, sessionContext: false, layaAll: true }, client },
  );
  assert(/Laya-first/.test(contextOf(r)), "политика должна остаться");
});

await test("layaAll=false не добавляет политику", async () => {
  const r = await sessionStartGate(
    { session_id: "test-policy-3", cwd: process.cwd() },
    { cfg: baseCfg, client },
  );
  assert(!/Laya-first/.test(contextOf(r)), "политики быть не должно");
});

group("Laya-first: UserPromptSubmit");
await test("layaAll=true добавляет политику к совету router", async () => {
  const r = await userPromptGate(
    { session_id: "test-policy-4", prompt: "проанализируй большой лог" },
    { cfg: { ...baseCfg, layaAll: true }, client },
  );
  const text = contextOf(r);
  assert(/Laya-first/.test(text), `нет Laya-first: ${text}`);
  assert(/laya_\*/.test(text), `нет laya_*: ${text}`);
});

await test("layaAll=false не добавляет политику к совету router", async () => {
  const r = await userPromptGate(
    { session_id: "test-policy-5", prompt: "проанализируй большой лог" },
    { cfg: baseCfg, client },
  );
  assert(!/Laya-first/.test(contextOf(r)), "политики быть не должно");
});

cleanupTempDataDir(dir);
process.exit(summary("laya-all-policy.test"));
