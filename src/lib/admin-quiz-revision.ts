import { createHash } from "node:crypto";
import { revisionSource, type QuestionContent } from "./admin-quizzes";

/**
 * 問題の revision（#81 Q1 の楽観ロック。D4 a）：内容（問題文・options の JSON・正解）の sha256 の 16 進 64 字。
 * 秘密の鍵は使わない（改ざんの防止ではなく、読んだ時点から変わったかを知るためのもの）。
 * node:crypto を使うサーバー専用のファイル。src/app/page.tsx・admin-quizzes.ts など画面から使うファイルから import しない
 * （admin-quizzes.test.ts で固定）
 */
export function questionRevision(content: QuestionContent): string {
  return createHash("sha256").update(revisionSource(content), "utf8").digest("hex");
}
