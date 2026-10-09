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
- テスト: `npm test`（node:test + `tsx --test`。seed ガードの単体テストと seed スクリプトをダミー URL で起動する E2E テスト、ローカル DB 用スクリプト（`scripts/lib/db-local.test.ts`。子プロセスの起動を差し替え、リモートのダミー URL だけで E2E）、forgot-password・リセットトークン系（verify-reset-token / reset-password）・受講生管理 API・change-password / reset-password のセッション失効（#11）のルートテスト（偽 prisma・偽 auth・fetch モックでネットワーク / DB に接続しない。偽 `$transaction` は原子性を再現しない）、`src/lib` の単体テスト（mail-config / safe-error / initial-password / student-status / account-access / student-invite / session-guard）。seed の E2E は `npm install` と Prisma Client 生成済みが前提）
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
- AI チャット（`src/components/Chat*.tsx`、`src/lib/chat-mock.ts`）は見本の回答を返すモックで、リリースでは非表示（#32）。画面から import しない
- 受講生の無効化は論理削除（#7）。`PUT /api/admin/students/[id]/deactivate` は `User.deactivatedAt` を設定し、`sessionVersion` を +1、未使用のパスワードリセットトークンを失効させる（データは削除しない）。`PUT /api/admin/students/[id]/reactivate` は `deactivatedAt` を null に戻す。無効化済みの受講生はログインとパスワードリセットができず、既存のログイン（JWT セッション）も API では即座に失効する（#11）。受講生一覧 API は既定で有効な受講生だけを返す（`?status=deactivated|all` で切り替え）
