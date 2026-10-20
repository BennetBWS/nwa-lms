import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// prisma/seed.ts の「既存データの削除」の順の静的な照合（DB なし。ファイルを読むだけ）。#81 Q0
// User を参照するモデル（FK の既定と onDelete: Restrict は、参照されている User を消せない）は、
// user.deleteMany() より先に deleteMany() しないと、ローカル DB に行があるときに seed が FK 違反で止まる。
// QuizQuestionRevision（editorId → User、RESTRICT）は、消し忘れると履歴が 1 行でもあるときに
// npm run db:seed が失敗する（PGlite で 23001 を確認済み）ため、名前を挙げて別にも確かめる。

const ROOT = join(__dirname, "..", "..");
const REVISION = "QuizQuestionRevision";

function modelsReferencingUser(): string[] {
  const schema = readFileSync(join(ROOT, "prisma", "schema.prisma"), "utf8");
  return Array.from(schema.matchAll(/^model (\w+) \{([\s\S]*?)^\}/gm))
    .filter(([, name, body]) => name !== "User" && /^\s+\w+\s+User\??\s+@relation\(/m.test(body))
    .map(([, name]) => name);
}

function seedDeleteOrder(): string[] {
  const seed = readFileSync(join(ROOT, "prisma", "seed.ts"), "utf8");
  return Array.from(seed.matchAll(/\bprisma\.(\w+)\.deleteMany\(/g)).map((m) => m[1]);
}

const delegate = (model: string) => model[0].toLowerCase() + model.slice(1);

describe("seed の削除の順（User を参照するモデルを User より先に消す）", () => {
  it("schema.prisma から User を参照するモデルを読める（照合の前提）", () => {
    const models = modelsReferencingUser();
    for (const m of ["PasswordReset", "Progress", "QuizAttempt", "Comment", "Assignment", "Notification", REVISION]) {
      assert.ok(models.includes(m), `${m} が User を参照するモデルとして読めない: ${models.join(", ")}`);
    }
  });

  it("seed.ts は user.deleteMany() を呼ぶ（照合の前提）", () => {
    assert.ok(seedDeleteOrder().includes("user"), "seed.ts に prisma.user.deleteMany() がない");
  });

  it("User を参照するモデルはすべて、user.deleteMany() より先に deleteMany() している", () => {
    const order = seedDeleteOrder();
    const userAt = order.indexOf("user");
    for (const m of modelsReferencingUser()) {
      const at = order.indexOf(delegate(m));
      assert.ok(at >= 0 && at < userAt, `${delegate(m)}.deleteMany() が user.deleteMany() より先にない`);
    }
  });

  it("QuizQuestionRevision も user.deleteMany() より先に deleteMany() している（#81 Q0）", () => {
    const order = seedDeleteOrder();
    const at = order.indexOf(delegate(REVISION));
    assert.ok(at >= 0 && at < order.indexOf("user"), `${delegate(REVISION)}.deleteMany() が user.deleteMany() より先にない`);
  });
});
