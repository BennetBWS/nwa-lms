# nwa-lms

法人: BWS
事業: NWA
Slack報告先: #dev-review

## 概要
NWA 受講生向けの学習管理システム（LMS）。STEP1〜8 のコース／レッスン、ミニテスト・修了テスト、課題、質問コメント、通知を提供する。
講師（INSTRUCTOR）は管理画面でコンテンツと受講生を管理する。

## 環境
- 本番URL: https://nwa-lms.vercel.app
- DB: Supabase 上の Postgres を Prisma で利用（プロジェクト名: nwa-lms）。Supabase Auth / Storage は未使用
- 認証: NextAuth v5（Credentials + bcrypt、JWT セッション）。ユーザーは Prisma の User テーブルで管理
- セッションの即時失効（#11）: API（`@/lib/auth` の `auth()`）は毎回 jwt コールバックで User を主キーで 1 回読んで照合し、無効化・ロール変更・メール変更・パスワード変更（`User.sessionVersion` とトークンの `sv` の不一致）で即座に失効する（`src/lib/session-guard.ts`。DB エラー時も失効）。パスワード変更・リセットは `sessionVersion` を +1 し、全端末をログアウトさせる。middleware（Edge）は DB を見ない（`auth.config.ts` の jwt）ため古い JWT のまま通るが、データは API から取るので実害はない。`auth.config.ts` に prisma を import しない
- メール: Resend（パスワードリセット）。送信元ドメインは `mail.bws-bennet.com`（例: `Next World Academy <no-reply@mail.bws-bennet.com>`）。環境変数 `RESEND_API_KEY` / `MAIL_FROM` / `APP_BASE_URL` / `MAIL_REPLY_TO`（任意）は Vercel の Production にだけ設定する（開発用 DB と本番 DB が同じため。#8）。必須変数が未設定・不正ならメール送信はスキップされ、変数名だけがログに出る（`src/lib/mail-config.ts`）。変数の説明は `.env.example`
- デプロイ: Vercel（main マージで本番反映）

## コマンド
- 開発: `npm run dev`
- 型チェック: `npm run typecheck`（`prisma/seed.ts` は tsconfig の exclude により対象外）
- テスト: `npm test`（node:test + `tsx --test`。seed ガードの単体テストと seed スクリプトをダミー URL で起動する E2E テスト、forgot-password・リセットトークン系（verify-reset-token / reset-password）・受講生管理 API・change-password / reset-password のセッション失効（#11）のルートテスト（偽 prisma・偽 auth・fetch モックでネットワーク / DB に接続しない。偽 `$transaction` は原子性を再現しない）、`src/lib` の単体テスト（mail-config / safe-error / initial-password / student-status / account-access / student-invite / session-guard）。seed の E2E は `npm install` と Prisma Client 生成済みが前提）
- マイグレーション（ローカル）: `npm run db:migrate`
- Prisma Client 生成: `npm run db:generate`
- seed（ローカル DB のみ）: `npm run db:seed`
- ※ Supabase 型生成（supabase gen types）は使わない。型は Prisma Client から生成される

## このリポジトリ固有のルール
- ユーザー・ロールは Prisma の `User` テーブルに集約する（Supabase Auth は使わない）
- スキーマ変更は `prisma/schema.prisma` を更新し、`prisma/migrations/<timestamp>_<name>/migration.sql` をコミットする。本番適用は Tec の承認後に `npx prisma migrate deploy` で行う
- **現在、開発用 DB と本番 DB は同じ Supabase プロジェクト**（分離は #8）。`.env` の接続先は本番なので、`prisma migrate dev` / `migrate reset` / `db push` など DB に接続する prisma コマンドや psql を実行しない。マイグレーション SQL は手で書き、DB を使わずに検証する（例：scratchpad で PGlite を使う）
- テーブルを追加するマイグレーションには、同じファイル内で必ず `ALTER TABLE "<Table>" ENABLE ROW LEVEL SECURITY;` を入れる（FORCE は付けない。ポリシーは作らない）。public スキーマは RLS 有効・anon / authenticated の権限なしが前提（#2）。RLS を DISABLE するマイグレーションは禁止
- public に関数やビューを作らない（anon から `/rpc` で呼べてしまうため。#5）
- `prisma/seed.ts` と `scripts/seed-step1.ts` は既存データを削除する破壊的スクリプト。ローカル DB 以外では起動時に拒否される（`scripts/lib/assert-local-db.ts`）。ガードを外さない
- テスト用アカウントは seed がローカル DB にのみ作成する（ドメインは example.com）。ログイン画面・README・本ファイルに認証情報を書かない
- 本番データを含む SQL / CSV は `supabase/private/`（git 管理外）に置く
- `.env.example` は値を含まない見本ファイルとして、就業規則の「.env 系ファイルの読み取り・コミット禁止」の例外とする（Tec 承認 2026-09-25）。変数名と説明だけを書き、実値・実在のキーは書かない。`.env` / `.env.local` などは従来どおり読み取り・出力・コミット禁止
- `src/lib/supabase.ts` は現在未使用
- 受講生の無効化は論理削除（#7）。`PUT /api/admin/students/[id]/deactivate` は `User.deactivatedAt` を設定し、`sessionVersion` を +1、未使用のパスワードリセットトークンを失効させる（データは削除しない）。`PUT /api/admin/students/[id]/reactivate` は `deactivatedAt` を null に戻す。無効化済みの受講生はログインとパスワードリセットができず、既存のログイン（JWT セッション）も API では即座に失効する（#11）。受講生一覧 API は既定で有効な受講生だけを返す（`?status=deactivated|all` で切り替え）
