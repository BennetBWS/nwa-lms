# 手元の DB を本番から分ける手順（#8）

Tec が手元の Mac で 1 回だけ行う作業の手順書。終わると、手元の `npm run dev` / seed / マイグレーションは
Supabase CLI のローカル DB（127.0.0.1:54322）だけを使い、本番の Supabase には接続しなくなる。

## 守ること

- 値や秘密（パスワード・接続文字列・キー）をコマンドに直接書かない。値の入力はエディタで行う
  （確認画面で許可したコマンドは `.claude/settings.local.json` に平文で残るため）
- `.env` 系ファイルの中身を `cat` などで画面に出さない。確認は変数名や件数だけにする
- `supabase login` / `supabase link` はしない。`supabase db push` や `--linked` の付くコマンドも使わない
  （このリポジトリの Supabase CLI はローカル DB 専用）
- `vercel env pull` は使わない（本番などの値が手元の .env 系に書き込まれるため）
- DB の URL は `.env` だけに書く。`.env.local` には書かない（Next.js は `.env.local` を優先し、
  Prisma の CLI は `.env` を読むため、混在すると接続先が食い違う）

## 0. 事前確認

```sh
docker info >/dev/null && echo "Docker OK"
supabase --version   # 2.120 以上
```

Docker Desktop が起動していなければ起動する。

## 1. 本番の接続情報をリポジトリの外へ移す

1. 置き場所を作る

   ```sh
   mkdir -p ~/.nwa-lms-secrets
   chmod 700 ~/.nwa-lms-secrets
   touch ~/.nwa-lms-secrets/prod-db.env
   chmod 600 ~/.nwa-lms-secrets/prod-db.env
   ```

2. エディタで今の `.env` を開き、`DATABASE_URL` と `DIRECT_URL` の 2 行を `~/.nwa-lms-secrets/prod-db.env` に
   移す（コピーしてから `.env` 側は次の手順 3 で書き換える）。値は**シングルクォートで囲む**
   （`$` やバッククォートなどがシェルに解釈されないように）。パスワードに記号があれば URL エンコード済みであること

   ```
   DATABASE_URL='（本番の値）'
   DIRECT_URL='（本番の値）'
   ```

3. 権限を確かめる（中身は表示しない）

   ```sh
   ls -l ~/.nwa-lms-secrets/prod-db.env          # -rw------- であること
   grep -c '^DATABASE_URL=' ~/.nwa-lms-secrets/prod-db.env   # 1 であること
   grep -c '^DIRECT_URL=' ~/.nwa-lms-secrets/prod-db.env     # 1 であること
   ```

## 2. ローカル DB を起動する

リポジトリ直下で実行する（`supabase/config.toml` を使う。Postgres 17。Studio と、Studio が使う API（`[api]`）以外の機能は無効）。

```sh
supabase start
supabase status
```

- 初回は Docker イメージのダウンロードがあるので時間がかかる
- `supabase status` に出る DB の URL（127.0.0.1:54322 のもの）を次の手順で使う。出力にはローカル専用の
  キーも出るが、チャットや Slack に貼らない

## 3. `.env` をローカル DB に切り替える

エディタで `.env` を開き、`DATABASE_URL` と `DIRECT_URL` の**両方**を `supabase status` の DB の URL にする。

- `pgbouncer=true` などのクエリは付けない
- ほかの変数は `.env.example` の説明に合わせる。`RESEND_API_KEY` / `MAIL_FROM` / `APP_BASE_URL` /
  `MAIL_REPLY_TO` は手元に置かない（メールは本番からだけ送る）
- `AUTH_SECRET` は本番と同じ値にしない（手元用に別の値を作り、エディタで貼る）

## 4. `.env.local` などから DB の URL を消す

`.env.local`（と、もしあれば `.env.development` / `.env.development.local`）に `DATABASE_URL` /
`DIRECT_URL` が残っていると、`npm run dev` だけが本番に接続し続ける。件数だけ確かめる。

```sh
grep -c '^DATABASE_URL=\|^DIRECT_URL=' .env.local .env.development .env.development.local 2>/dev/null
```

1 以上のファイルがあれば、エディタでその行を削除する（本番の値は手順 1 で外へ移してある）。もう一度実行して、
すべて 0（またはファイルなし）になることを確かめる。

## 5. 接続先を確かめる

```sh
npm run db:where
```

次のように出れば OK（接続はしない。ホスト:ポートとガードの判定だけを表示する）。

```
DATABASE_URL: 127.0.0.1:54322
DIRECT_URL: 127.0.0.1:54322
ローカル DB のガード: 通る（...）
```

`pooler.supabase.com` などが出たら、手順 3・4 を見直す。

`db:where` が見るのは `.env`（とシェルの環境変数）だけで、`npm run dev`（Next.js）が `.env` より優先する
`.env.local` / `.env.development` / `.env.development.local` は見ない。`db:where` が 127.0.0.1:54322 を
示していても、`npm run dev` だけが本番に接続している可能性は残るため、`## 4.` の確認（キー名だけを grep し、
すべて 0 またはファイルなし）も合わせて行う。

## 6. マイグレーションを適用する

```sh
npm run db:local:deploy
```

ガード（`scripts/lib/assert-local-db.ts`）を通ったあとでだけ `prisma migrate deploy` が走る。
出力の `Datasource` の行が `127.0.0.1:54322` であることも確かめる。

## 7. seed を入れる

```sh
npm run db:seed
```

テスト用アカウント（example.com）と STEP のデータが入る。ローカル DB 以外では起動時に拒否される。
作り直したいときは `npm run db:local:reset`（全データを消してマイグレーションを当て直し、seed も走る）。

## 8. Studio で RLS と anon の権限を確かめる

ブラウザで http://127.0.0.1:54323 を開き、SQL Editor で実行する。

RLS（すべての行で `rls_enabled` が true、`rls_forced` が false）：

```sql
select c.relname as table_name,
       c.relrowsecurity as rls_enabled,
       c.relforcerowsecurity as rls_forced
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r'
order by 1;
```

anon / authenticated の権限（0 行であること）：

```sql
select grantee, table_name, privilege_type
from information_schema.role_table_grants
where table_schema = 'public' and grantee in ('anon', 'authenticated')
order by 1, 2, 3;
```

public に関数やビューがないこと（0 行であること。#5）：

```sql
select 'function' as kind, p.proname as name
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
union all
select 'view', c.relname
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind in ('v', 'm');
```

## 9. アプリで確かめる

```sh
npm run dev
```

http://localhost:3000 で seed のテスト用アカウント（`prisma/seed.ts` を参照）でログインし、
コース・レッスン・管理画面が表示されることを確かめる。

## 10. 本番に接続していないことを確かめる

- Wi-Fi を切っても、`npm run dev` の画面でログインとページの表示ができる（ローカル DB だけで動いている）
- 本番（https://nwa-lms.vercel.app）の管理画面の受講生一覧に、seed のアカウント（example.com）が増えていない

## 本番マイグレーションの適用手順（Tec が行う。承認後）

本番の接続情報は、サブシェルの中でだけ読み込む。サブシェルを抜ければ残らない。
シェルの環境変数は `.env` より優先される（Prisma は `.env` で上書きしない）。
裏を返すと、`prod-db.env` に**書かれていない変数は `.env`（ローカル DB）の値のまま**になる。

0. 毎回、`prod-db.env` に `DATABASE_URL=` と `DIRECT_URL=` の行が 1 行ずつあることを確かめる（中身は表示しない）

   ```sh
   grep -c '^DATABASE_URL=' ~/.nwa-lms-secrets/prod-db.env   # 1 であること
   grep -c '^DIRECT_URL=' ~/.nwa-lms-secrets/prod-db.env     # 1 であること
   ```

   どちらかが 1 でなければ、ここで止める（以降の手順に進まない）。

1. 未適用のマイグレーションと接続先を確かめる

   ```sh
   ( set -a; . ~/.nwa-lms-secrets/prod-db.env; set +a; npx prisma migrate status )
   ```

   出力の `Datasource "db": ... at "<ホスト>:<ポート>"` の行が**本番のホスト**になっていることを確かめる
   （`127.0.0.1:54322` なら読み込みに失敗している。deploy しない）。

   注意：この `Datasource` の行は**片方の URL しか示さない**。手元の Prisma（6.19）の CLI のソースでは、
   `directUrl` があればその値（`DIRECT_URL`）からホストを表示しており、`DATABASE_URL` 側は表示されない。
   `migrate deploy` は `directUrl`（`DIRECT_URL`）で接続するとされているが、実際の接続は Prisma の
   エンジン側で決まり、手元のソースだけでは確かめきれていない。Prisma のバージョンによって表示する側が
   変わる可能性もある。そのため、**`Datasource` の行だけで適用先を判断しない**。手順 0 で 2 行がそろっていることと、
   この行が本番のホストであることの両方を確かめてから進む。

2. 承認（#hq-approval）

3. 適用する

   ```sh
   ( set -a; . ~/.nwa-lms-secrets/prod-db.env; set +a; npx prisma migrate deploy )
   ```

   実行の直前に手順 0 を、もう一度行う。

4. 手順 1 のコマンドをもう一度実行し、未適用が残っていないことを確かめる

`npm run db:local:deploy` / `db:local:reset` / `db:seed` は、本番の接続情報を読み込んだ状態ではガードで拒否される。
本番に対して `prisma migrate dev` / `migrate reset` / `db push` は使わない。

## 元に戻す方法

ローカル DB で問題が起きて、一時的に以前の状態（`.env` が本番を指す）に戻す場合：

1. `supabase stop`（データは残る。消す場合は `supabase stop --no-backup`）
2. エディタで `~/.nwa-lms-secrets/prod-db.env` の 2 行を `.env` の `DATABASE_URL` / `DIRECT_URL` に戻す
3. `npm run db:where` で本番のホストが表示されることを確かめる

この状態では `db:where` の結果が `127.0.0.1:54322` 以外になるので、CLAUDE.md の
「`db:where` の結果が `127.0.0.1:54322` 以外、またはガードが拒否なら、DB に接続する prisma コマンド・psql・
`npm run db:*`（`db:where` を除く）を実行せず Tec に報告する」に従う（`db:local:*` と `db:seed` はガードでも拒否される）。
戻したことは Claude にも伝える。ローカル DB に戻すときは `## 3.` から行う。

## 注意：git worktree で作業する場合

Prisma Client は、生成先（`node_modules/.prisma/client`）から見た `.env` を読む。`node_modules` を本体の
リポジトリへのシンボリックリンクにした worktree では、`npm run db:where` / `db:local:*` / `db:seed` が
**本体の `.env`** を読む。worktree で実行するときは `npm run db:where` で接続先を確かめてから行う。
