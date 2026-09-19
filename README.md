# Desked

自宅の Windows PC を外出先のスマホ / PC から Web ブラウザで操作できる、セルフホスト型リモートデスクトップアプリケーション。

## 主な機能

- 低遅延 H.264 ストリーミング（FFmpeg / NVENC・QSV・AMF・libx264 自動選択、失敗時は JPEG にフォールバック）
- マウス・キーボード・マルチタッチ操作、仮想キーボード、Ctrl/Alt/Ctrl+Alt+Del 送信
- パスワード認証、セッショントークン、ブルートフォース対策（試行回数制限・ロックアウト）
- Cloudflare Tunnel による外部公開（デフォルトはアカウント不要の **Quick Tunnel**）
- CLI によるセットアップ（初回パスワード設定・Quick Tunnel）
- Material 3（ライトテーマ）に準拠したUI

## セットアップ（CLI）

```bash
npm install
npm run setup
```

`npm run setup` が対話形式で以下を設定し、`.env` に保存します。

1. **初回パスワード**（8文字以上・確認入力あり。入力は非表示）
2. **トンネル方式** — デフォルトは **Quick Tunnel**（Enter で決定）。安定 URL が必要な場合のみ名前付きトークンを入力
3. **ポート**（デフォルト 3389）

非対話で実行する場合（`--password` はシェル履歴に残る点に注意）:

```bash
node cli.js setup --yes --password <password> --quick --port 3389

# 履歴に残したくない場合は stdin から渡す
echo <password> | node cli.js setup --yes --password-stdin --quick --port 3389
```

### 起動

```bash
npm start
```

サーバーと Cloudflare Tunnel をまとめて起動し、Quick Tunnel の公開 URL とスマホで読み取れる **QR コード** を表示します。サーバーのみ起動する場合は `npm run start:server`。

起動時に GitHub の最新バージョンを確認し、更新があれば `Update now? [y/N]` と確認します（yes で `git pull` / アーカイブ取得 → `npm install` を実行）。確認を止めるには `--no-update-check`、または環境変数 `DESKED_NO_UPDATE_CHECK=1` を設定します。

### CLI コマンド

| コマンド | 説明 |
|----------|------|
| `npm run setup` | 対話形式のセットアップ（パスワード・トンネル・ポート） |
| `npm start` | サーバー + トンネルを起動し公開 URL と QR コードを表示 |
| `npm run password` | `.env` のパスワードを変更（`--password-stdin` 対応） |
| `npm run update` | 最新バージョンに更新（`--yes` で確認省略、`--no-update-check` で起動時チェック無効） |
| `npm run check` | 更新の有無だけを確認 |
| `npm run install-service` | 管理者権限で自動起動タスクを登録 |
| `npm run uninstall-service` | 自動起動タスクを削除 |

## 設定項目 (.env)

| 項目 | デフォルト | 説明 |
|------|-----------|------|
| `HOST` | 0.0.0.0 | バインドするアドレス |
| `PORT` | 3389 | サーバーポート（Windows RDP と衝突する場合は変更） |
| `PASSWORD_HASH` | (必須) | scrypt ハッシュ。`npm run setup` / `npm run password` で設定（平文は保存されません） |
| `TUNNEL_TOKEN` | (空) | 空なら Quick Tunnel（デフォルト）。設定すると名前付きトンネル |
| `CAPTURE_QUALITY` | 60 | 画質 (1-100) |
| `CAPTURE_SCALE` | 0.6667 | キャプチャ解像度スケール (0.1-1.0) |
| `TARGET_FPS` | 10 | JPEG モードの目標フレームレート |
| `STREAM_MODE` | h264 | `h264` または `jpeg` |
| `H264_ENCODER` | (空 = 自動) | 空で NVENC > QSV > AMF > libx264 を自動選択。明示する場合は `h264_nvenc` などを指定 |
| `H264_TARGET_FPS` / `H264_CAPTURE_FPS` | 24 | 出力 / キャプチャ FPS |
| `H264_GOP` | 24 | キーフレーム間隔 |
| `H264_CQ` | 28 | 画質（小さいほど高品質） |
| `SESSION_TIMEOUT_HOURS` | 24 | セッション有効期限 (時間) |
| `MAX_LOGIN_ATTEMPTS` | 5 | ログイン試行上限 |
| `LOCKOUT_MINUTES` | 15 | ロックアウト時間 (分) |

## 外部アクセス

### Quick Tunnel（デフォルト）

`cloudflared.exe` はリポジトリに含まれません（サイズのため）。`npm run setup` または `npm start` は未配置を検出すると自動ダウンロードを提案します（`--no-download` で無効化）。手動の場合は[こちら](https://github.com/cloudflare/cloudflared/releases)からプロジェクト直下に配置してください。

起動すると以下を実行し、`https://<ランダム>.trycloudflare.com` を発行します。Cloudflare アカウントやトークンは不要ですが、URL は起動ごとに変わります。`npm start` は発行された URL と、スマホで読み取れる **QR コード** をターミナルに表示します。

```bash
cloudflared tunnel --url http://localhost:3389
```

### 名前付きトンネル（安定 URL）

`npm run setup` でトークンを入力する（または `.env` の `TUNNEL_TOKEN` を設定する）と、名前付きトンネルで起動します。常時起動するには管理者権限で:

```bash
npm run install-service
```

`DeskedServer`（高整合性レベル）と `DeskedTunnel` の 2 つのスケジュールタスクが登録され、トンネルの URL/ログは `cloudflare.log` に出力されます。

### ポートフォワーディング

ルーターで外部ポート → 内部 IP:3389 を転送します。HTTPS 終端は別途用意してください。

## セキュリティ

- **HTTPS を必須とする**: Cloudflare Tunnel または nginx + Let's Encrypt などのリバースプロキシを経由させてください。パスワードと映像は平文の HTTP では保護されません。
- パスワードは **scrypt ハッシュ**（`PASSWORD_HASH`）で保存され、平文はディスクに残りません。
- **強力なパスワード**を設定し、`.env` は絶対にコミットしないでください（`.gitignore` 済み）。
- WebSocket は同一オリジンのみ受け付けます（クロスサイト WebSocket ハイジャック対策）。受信ペイロードは 64KB に制限しています。
- `ws` は脆弱性修正済みの `>= 8.21.3` を使用します（極小 fragment によるメモリ枯渇 DoS 対策）。
- ログイン試行回数の制限とロックアウト、セッション期限、サーバー側のログアウト（トークン失効）を実装しています。ロックアウトのキーはループバック経由の場合のみ `CF-Connecting-IP` を信頼します。
- 厳格な **Content-Security-Policy** と関連ヘッダー（`nosniff` / `frame-ancestors 'none'` 等）を付与します。
- `cloudflared.exe` は**固定バージョン**をダウンロードし、SHA-256 を検証します。
- `cloudflared.exe`・ログ・スクリーンショットなどの実行時生成物はコミット対象外です。

詳細な脅威モデルと既知の制約（管理者権限プロセスの分離案など）は [SECURITY.md](SECURITY.md) を参照してください。

## 開発

```bash
npm ci          # lockfile どおりに依存をインストール
npm test        # ユニットテスト (node:test)
```

`test/` にパスワードハッシュと `.env` ライタのテストがあります。GitHub Actions（Windows）で `npm ci` → 構文チェック → テストを実行し、Dependabot が依存更新を監視します。変更履歴は [CHANGELOG.md](CHANGELOG.md) を参照してください。

## トラブルシューティング

- **`EADDRINUSE: address already in use :::3389`**: 既に別の Desked（常駐タスクなど）が 3389 番を使用しています。`Stop-ScheduledTask -TaskName 'DeskedServer'` で停止するか、`.env` の `PORT` を変更してください。
- **`cloudflared.exe not found`**: `npm run setup` を実行して自動ダウンロードするか、手動でプロジェクト直下に配置してください。
- **`InputHandler: Server is not elevated`**: 管理者アプリへ入力できません。`npm run install-service` で高整合性タスクとして起動してください。

## 操作方法

### PC (マウス & キーボード)
- マウス・キーボードはそのまま使用可能
- 右クリック・ホイールスクロール対応

### スマートフォン (タッチ)
- **タップ**: 左クリック / **ダブルタップ**: ダブルクリック / **長押し**: 右クリック
- **ドラッグ**: 指をスライド / **2本指スクロール**: ホイール / **ピンチ**: ズーム
- **キーボードボタン**: モバイルキーボード表示

### ツールバー
- **Fullscreen** / **Keyboard** / **Ctrl** / **Alt** / **C+A+D** / **Quality** / **Scale** / **Disconnect**
- パスワードの変更はサーバー側の CLI（`npm run password`）で行います

## 技術スタック

- **Screen Capture**: FFmpeg Desktop Duplication / GDI + sharp
- **Input Simulation**: koffi + Windows API (user32.dll)
- **WebSocket**: ws
- **HTTP**: Express
- **Client**: HTML5 Canvas + WebCodecs + Vanilla JS
