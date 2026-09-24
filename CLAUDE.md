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
- メール: Resend（パスワードリセット）
- デプロイ: Vercel（main マージで本番反映）

## コマンド
- 開発: `npm run dev`
- 型チェック: `npm run typecheck`（`prisma/seed.ts` は tsconfig の exclude により対象外）
- テスト: `npm test`（現状は seed ガードの単体テストと、seed スクリプトをダミー URL で起動する E2E テストのみ。後者は `npm install` と Prisma Client 生成済みが前提。テスト基盤は未整備）
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
- `src/lib/supabase.ts` は現在未使用
- `/api/admin/students/[id]/deactivate` は論理削除ではなく物理削除である点に注意
