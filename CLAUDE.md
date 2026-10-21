# nwa-lms

法人: BWS
事業: NWA
Slack報告先: #dev-review

## 概要
NWA 受講生向けの学習管理システム（LMS）。STEP1〜8 のコース／レッスン、ミニテスト・修了テスト、課題、質問コメント、通知を提供する。
講師（INSTRUCTOR）は管理画面でコンテンツと受講生を管理する。

## 環境
- 本番URL: https://nwa-lms.vercel.app
- DB: Supabase 上の Postgres を Prisma で利用（プロジェクト名: nwa-lms。Postgres 17）。Supabase Auth / Storage は未使用
- 手元の DB: Supabase CLI のローカル DB（`supabase start`、127.0.0.1:54322。設定は `supabase/config.toml`）。本番とは別（#8）。Preview 用の開発プロジェクトはない。手順は `docs/dev-db-setup.md`
- 認証: NextAuth v5（Credentials + bcrypt、JWT セッション）。ユーザーは Prisma の User テーブルで管理
- セッションの即時失効（#11）: API（`@/lib/auth` の `auth()`）は毎回 jwt コールバックで User を主キーで 1 回読んで照合し、無効化・ロール変更・メール変更・パスワード変更（`User.sessionVersion` とトークンの `sv` の不一致）で即座に失効する（`src/lib/session-guard.ts`。DB エラー時も失効）。パスワード変更・リセットは `sessionVersion` を +1 し、全端末をログアウトさせる。middleware（Edge）は DB を見ない（`auth.config.ts` の jwt）ため古い JWT のまま通り、Cookie を作り直す。そのため middleware は画面だけにかけ、`/api` と `/api/*` は対象外にしている（matcher は `src/middleware.ts` のリテラルと `src/lib/middleware-matcher.ts` の定数をテストで照合。#30）。画面（`src/app/page.tsx`）はまず `/api/auth/session` で失効を確かめ、失効していればサインアウトして `/login` へ移動する。API の 401・`/login` へのリダイレクト、および 403 のうち `/api/auth/session` で失効と分かったものも同様に扱う（`src/lib/client-session.ts`。#30）。`auth.config.ts` に prisma を import しない
- メール: Resend（パスワードリセット）。送信元ドメインは `mail.bws-bennet.com`（例: `Next World Academy <no-reply@mail.bws-bennet.com>`）。環境変数 `RESEND_API_KEY` / `MAIL_FROM` / `APP_BASE_URL` / `MAIL_REPLY_TO`（任意）は Vercel の Production にだけ設定する（メールは本番からだけ送る。手元や Preview から本物の受講生にメールが届かないようにするため）。必須変数が未設定・不正ならメール送信はスキップされ、変数名だけがログに出る（`src/lib/mail-config.ts`）。変数の説明は `.env.example`
- デプロイ: Vercel（main マージで本番反映）

## コマンド
- 開発: `npm run dev`
- 型チェック: `npm run typecheck`（`prisma/seed.ts` は tsconfig の exclude により対象外）
- テスト: `npm test`（node:test + `tsx --test`。seed ガードの単体テストと seed スクリプトをダミー URL で起動する E2E テスト、ローカル DB 用スクリプト（`scripts/lib/db-local.test.ts`。子プロセスの起動を差し替え、リモートのダミー URL だけで E2E）、forgot-password・リセットトークン系（verify-reset-token / reset-password）・受講生管理 API・change-password / reset-password のセッション失効（#11）・progress・コースのロック（#47。`course-lock-routes.p4` / `course-routes.shape`、クイズは `quizzes-route`・通しの流れの `quizzes-route.flow`・止めたときの `quizzes-route.disabled`）のルートテスト（偽 prisma・偽 auth・fetch モックでネットワーク / DB に接続しない。偽 `$transaction` は原子性を再現しない）、`src/lib` の単体テスト（mail-config / safe-error / initial-password / student-status / account-access / student-invite / session-guard / comment-rate-limit / quiz-rate-limit / quiz-shuffle / lesson-access（`lesson-access.schema` は Lesson の列を schema.prisma と照合）/ course-locked など）、画面のテスト（`*.page.test.ts`。course-locked の表示など）。seed の E2E は `npm install` と Prisma Client 生成済みが前提）
- DB の接続先の確認: `npm run db:where`（DATABASE_URL / DIRECT_URL の「ホスト:ポート」とガードの判定だけを表示。接続しない）
- マイグレーションの適用（ローカル DB のみ）: `npm run db:local:deploy`（ガードを通したあとで `prisma migrate deploy`）
- ローカル DB の作り直し（ローカル DB のみ）: `npm run db:local:reset`（ガードを通したあとで `prisma migrate reset --force`。続けて seed も走る）
- Prisma Client 生成: `npm run db:generate`
- seed（ローカル DB のみ）: `npm run db:seed`
- ※ Supabase 型生成（supabase gen types）は使わない。型は Prisma Client から生成される

## このリポジトリ固有のルール
- ユーザー・ロールは Prisma の `User` テーブルに集約する（Supabase Auth は使わない）
- スキーマ変更は `prisma/schema.prisma` を更新し、`prisma/migrations/<timestamp>_<name>/migration.sql` をコミットする。本番適用は Tec の承認後に Tec が行う（下記「本番マイグレーションの適用手順」）
- **手元の DB はローカル DB（127.0.0.1:54322）、本番は別の Supabase プロジェクト**（#8）。`.env` の DATABASE_URL / DIRECT_URL はローカル DB を指す。作業前に `npm run db:where` で接続先を確かめる
  - **`db:where` の結果が `127.0.0.1:54322` 以外、ガードが「拒否」、またはエラーなどで判定できないなら**、DB に接続する prisma コマンド・psql・`db:` で始まる npm スクリプト（`db:where` と、DB に接続しない `db:generate` を除く）を実行せず、Tec に報告する（ホスト名・値は報告に書かず、「ローカル以外」「ガード拒否」「判定できない」と伝える）
  - **許すこと**（いずれもローカル DB のガード `scripts/lib/assert-local-db.ts` 付き）：`npm run db:where`、`npm run db:local:deploy`、`npm run db:local:reset`、`npm run db:seed`
  - **引き続き禁止**：本番の接続情報を読み込んだ状態での prisma / psql の実行（本番マイグレーションの適用は Tec の承認後に Tec が行う）、`supabase link` / `supabase db push` / `--linked` の付くコマンド、ガードのない `prisma migrate dev` / `migrate reset` / `db push`（npx などで直接起動しない）
  - DB の URL は `.env` だけに書く。`.env.local` には書かない（Next.js は `.env.local` を優先し、Prisma の CLI は `.env` を読むため、混在すると接続先が食い違う）
  - `vercel env pull` は使わない（本番などの値が手元の .env 系に書き込まれるため）
  - 本番の接続情報はリポジトリの外のファイル（例 `~/.nwa-lms-secrets/prod-db.env`、権限 600）に置き、リポジトリの .env 系には置かない
- マイグレーション SQL は手で書き、DB を使わずに検証する（例：scratchpad で PGlite を使う）。加えて、ローカル DB に `npm run db:local:deploy` で適用して確認してよい
- 本番マイグレーションの適用手順（Tec が行う。詳細は `docs/dev-db-setup.md`）：毎回まず、本番の接続情報のファイルに `DATABASE_URL=` と `DIRECT_URL=` の行が 1 行ずつあり、どちらも値が `'postgres` で始まることを値を出さずに確かめる（`grep -c '^DATABASE_URL=' <ファイル>` と `grep -c "^DATABASE_URL='postgres" <ファイル>`、`DIRECT_URL` も同様の 4 つがすべて 1。書かれていない変数は `.env` のローカル DB の値のままになる）→ サブシェル `( set -a; . <本番の接続情報のファイル>; set +a; npx prisma migrate status )` で未適用のマイグレーションと、出力の `Datasource` の行（ホスト:ポート）が本番であることを確認 → 承認 → 直前に再度 2 行を確かめ、同じ形で `npx prisma migrate deploy` → もう一度 `migrate status` で未適用が残っていないことを確認。`Datasource` の行は片方の URL（手元の Prisma 6.19 の CLI では `DIRECT_URL` 側）しか示さず、`DATABASE_URL` 側は分からないため、この行だけで適用先を判断しない。サブシェルを抜ければ本番の接続情報は残らない
- テーブルを追加するマイグレーションには、同じファイル内で必ず `ALTER TABLE "<Table>" ENABLE ROW LEVEL SECURITY;` を入れる（FORCE は付けない。ポリシーは作らない）。public スキーマは RLS 有効・anon / authenticated の権限なしが前提（#2）。RLS を DISABLE するマイグレーションは禁止
- public に関数やビューを作らない（anon から `/rpc` で呼べてしまうため。#5）
- `prisma/seed.ts` と `scripts/seed-step1.ts` は既存データを削除する破壊的スクリプト。ローカル DB 以外では起動時に拒否される（`scripts/lib/assert-local-db.ts`）。ガードを外さない
- テスト用アカウントは seed がローカル DB にのみ作成する（ドメインは example.com）。ログイン画面・README・本ファイルに認証情報を書かない
- 本番データを含む SQL / CSV は `supabase/private/`（git 管理外）に置く
- `.env.example` は値を含まない見本ファイルとして、就業規則の「.env 系ファイルの読み取り・コミット禁止」の例外とする（Tec 承認 2026-09-25）。変数名と説明だけを書き、実値・実在のキーは書かない。`.env` / `.env.local` などは従来どおり読み取り・出力・コミット禁止
- `src/lib/supabase.ts` は現在未使用
- Course / Section / Lesson の orderBy は `src/lib/course-order.ts` の定数（[order, id]）を使う（#47）。取りこぼしは `scripts/lib/course-order.static.test.ts` で検出する
- AI チャット（`src/components/Chat*.tsx`、`src/lib/chat-mock.ts`）は見本の回答を返すモックで、リリースでは非表示（#32）。画面から import しない
- 受講生の無効化は論理削除（#7）。`PUT /api/admin/students/[id]/deactivate` は `User.deactivatedAt` を設定し、`sessionVersion` を +1、未使用のパスワードリセットトークンを失効させる（データは削除しない）。`PUT /api/admin/students/[id]/reactivate` は `deactivatedAt` を null に戻す。無効化済みの受講生はログインとパスワードリセットができず、既存のログイン（JWT セッション）も API では即座に失効する（#11）。受講生一覧 API は既定で有効な受講生だけを返す（`?status=deactivated|all` で切り替え）
- 質問の投稿（#46）：`POST /api/comments` は受講生（STUDENT）だけが親の質問を投稿できる。講師は 403 `forbidden_role`（講師の回答は `POST /api/admin/comments/[id]/replies` だけで行う）、受講生の返信は 403 `reply_not_allowed`、ロック中のコースのレッスンへの投稿は 403 `course_locked`。連投は 30 秒間隔・24 時間 20 件で 429（`Retry-After`）、60 秒以内に直前と同じ本文なら 409（`src/lib/comment-rate-limit.ts`）。同時に送られた投稿の競合は許容している。判定の順と 404 は `src/app/api/comments/route.ts` の POST の先頭コメントを参照
- コースのロック（#46・#47 P4・P5）：受講生（講師以外のロール）には、画面の表示だけでなく API でもロックを確かめる（規則は `src/lib/course-lock.ts` の `isCourseLocked`、並びは `src/lib/course-order.ts` の `[order, id]`、判定は `src/lib/lesson-access.ts`）。講師は確認しない。ロックの確認がある API：`POST /api/comments`・`GET /api/comments`（ロック中のコースの質問を返さない。自分の質問は返す）・`GET /api/comments/[lessonId]`（403 `course_locked`）・`POST /api/progress`（403 `course_locked` で書き込まない。完了を書くとロックが外れるため。lessonId は 400 / 404 を返す）・`GET /api/courses/[courseId]`（403 `course_locked`）・`GET /api/courses`（一覧は返し、`locked` を付け、ロック中のコースのレッスンから `videoUrl`・`content`・`pdfUrl` を除く）。`GET /api/quizzes/[quizId]`（403 `course_locked` で問題・受験記録を読まない。コースに属さないクイズは 404）・`POST /api/quizzes/[quizId]/submit`（入力の形を確かめたあと、問題を読む前に確かめ、ロック中は 403 `course_locked` で採点・保存しない。#47 P5。クイズのコースは一覧と同じ規則（`src/lib/student-quizzes.ts` の `quizCourseId`：修了テストは `courseId`、ミニテストはレッスンのコース）、判定は `quizAccessFor`）・`GET /api/quizzes`（一覧は返し、コースに `locked` を付ける）。画面は 403 `course_locked` を通信エラーと区別して表示する（`src/lib/course-locked.ts`）
- 確認テストの受験の制限（#51、Tec 決定 2026-10-15）：`POST /api/quizzes/[quizId]/submit` は直近 24 時間の自分の受験記録で判定する（`src/lib/quiz-rate-limit.ts` の `QUIZ_RATE_LIMITS`。ミニテストは前回から 60 秒・24 時間に 10 回、修了テストは 30 分・3 回）。上限なら 429 `rate_limited`（`retryAfterSeconds` と `Retry-After`）。body の `questionIds` がサーバーの問題の並び（`[order, id]`）と違えば 409 `quiz_changed`。直近 1 件と同じ回答を間隔の内側で送ると、記録せずに 200 `duplicate: true`（応答が届かなかった再送のため。上限より先に判定）。講師は上限を受けず、重複の判定は受ける。429・409 の本文に点数・正誤・正解・問題の id を入れない。`GET /api/quizzes/[quizId]` は受講生に `retryAfterSeconds`（送れるなら null）を返し、画面は受験画面の冒頭で知らせる。点数は正解率の切り捨て（70 点以上なら合格と一致）。既知の制限：記録を読んでから書くまでの間に同時に送られた受験は、すべて判定を通る（DB のロックは使わない。Q4 a。修了テストの合格に重みが付いたら見直す）。同じ id のまま問題文だけ、または正解（correctIndex）だけを書き換えた場合は `quiz_changed` にならず、今の正解で採点する（選択肢の文・並び・数の変更は、下記のトークンの MAC で 409 `quiz_changed` になる）
- 確認テストの選択肢のシャッフル（#51 追加修正、Tec 決定 2026-10-19）：`GET /api/quizzes/[quizId]` は GET のたびに新しい nonce を作り、問題ごとに選択肢を並べ替えて返す（講師も同じ）。応答に `attemptToken`（`v1.<nonce>.<mac>`）を付け、`Cache-Control: no-store`。並べ替えの表・元の位置・内容のダイジェストは返さない。画面は表示位置の `answers` とトークンをそのまま送り、submit がトークンの形（400 `invalid_attempt_token`）と MAC（409 `quiz_changed`）を確かめてから表示位置を元の位置に戻す。重複判定・採点・`QuizAttempt.answers` の保存は元の位置で行う。トークンに有効期限はない。鍵は既存の `AUTH_SECRET` から HKDF で用途別に導出する（`src/lib/quiz-shuffle-key.ts`。新しい環境変数は使わない。未設定・空・空白だけなら 500。`AUTH_SECRET` を入れ替えると受験中のトークンは 409 になる）。`src/lib/quiz-shuffle.ts` / `quiz-shuffle-key.ts` は node:crypto を使うサーバー専用で、`src/app/page.tsx`・`src/lib/student-quizzes.ts` など画面から import しない（`quiz-shuffle.test.ts` で固定）。トークン・nonce・並べ替え・回答はログに出さない
- 確認テストの受験は公開済み（#51）。`src/lib/student-quizzes.ts` の `QUIZ_ATTEMPTS_ENABLED`（いまは true）は緊急時に受験を止めるためのスイッチとして残している。false にすると、画面は受験ボタンを隠して「受験は準備中です」を出し、`POST /api/quizzes/[quizId]/submit` は認証のあと入力も DB も見ずに 503 `attempts_disabled` を返す（一覧と `GET /api/quizzes/[quizId]` は止まらない）。false のときの動きは、本体に `attemptsEnabled: false` を渡すテスト、画面の true / false 両方の描画テスト、`scripts/lib/quizzes-route.disabled.test.ts`（モジュールキャッシュの `student-quizzes` を false に差し替えて route ごと確かめる。`tsx --test` がファイルごとに別プロセスで動くことが前提で、終わったら差し替えを戻す）で確かめている。公開後の本番では、確認のための送信を試さない（Tec 決定 Q7 a）
- 質問・返信の削除は講師専用の `DELETE /api/admin/comments/[id]`（#47。INSTRUCTOR 以外は DB を読む前に 403）。物理削除で、元に戻せない。質問・返信を消すと、その下の子孫の返信（#32 より前に作られうる返信への返信を含む）もすべて同じトランザクションで先に消す（parentId の in で 1 段ずつ集めて `deleteMany({ where: { id: { in } } })`。lessonId では絞らない。深さは 10 段まで、超えたら 500 でロールバック）。`Comment.parent` の FK は ON DELETE SET NULL なので、返信を明示的に消さないと質問として残る。子孫を集めてから削除するまでの間に commit された回答は、質問として残りうる（既知の残存リスク）。返信を消すと削除後のスレッド（返信への返信を消した場合も根の質問のスレッド）を返す。parentId が循環・自己参照している行と、深さ 10 段を超える行はこの API では消せない（500）。確認と削除の間に別の講師が消した場合（P2025）は 404。既に送った回答の通知は残す。ログは固定文（`[admin] question deleted` / `[admin] reply deleted`）だけで、id・本文・名前は出さない。受講生が自分の投稿を消す API はない
- 確認テストの問題の編集履歴 `QuizQuestionRevision`（#81 Q0。監査用）：`questionId`・`quizId` は FK にしない（問題を消しても履歴を残す）。`editorId` は User への FK（onDelete Restrict）。`changedFields` は 1 件以上（承認済みの設計は `TEXT[] NOT NULL`。列は Prisma の生成どおり NULL 可のまま、CHECK 制約 `QuizQuestionRevision_changedFields_check` で NULL と空配列を拒否する。Prisma 6 は CHECK 制約を schema.prisma で表せず、マイグレーションでも管理しない（db pull は警告を出すだけ）ため、schema.prisma には現れない。手で消さない）。本番適用の順：マイグレーション `20261020063634_add_quiz_question_revision`（Q0）を main にマージしたあと、main のチェックアウトから Tec が本番に適用し、そのあとでこのテーブルを使うクイズ管理 API（Q1）をマージする（逆の順だと API が 500 になる）。適用後に `docs/dev-db-setup.md` の手順 8 の SQL で RLS と anon の権限を確かめる。seed（`prisma/seed.ts`）は User より先に履歴を消す（`scripts/lib/seed-cleanup.static.test.ts`）。マイグレーションの静的な照合は `scripts/lib/migrations.static.test.ts`
