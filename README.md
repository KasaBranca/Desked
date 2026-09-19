# Desked

自宅の Windows PC を外出先のスマホ / PC から Web ブラウザで操作できる、セルフホスト型リモートデスクトップアプリケーション。

## 主な機能

- 低遅延 H.264 ストリーミング（FFmpeg / NVENC・QSV・AMF・libx264 自動選択、失敗時は JPEG にフォールバック）
- マウス・キーボード・マルチタッチ操作、仮想キーボード、Ctrl/Alt/Ctrl+Alt+Del 送信
- パスワード認証、セッショントークン、ブルートフォース対策（試行回数制限・ロックアウト）
- Cloudflare Tunnel による外部公開

## セットアップ

### 1. 依存パッケージのインストール

```bash
npm install
```

### 2. 設定ファイルの作成

`.env.example` をコピーして `.env` を作成し、パスワードを設定します。

```bash
copy .env.example .env
```

`.env` を開き、必ず推測されにくい長いパスワードに変更してください。

```
PASSWORD=your_secure_password_here
```

### 3. サーバー起動

```bash
npm start
```

起動後、`http://localhost:3389` でアクセスできます。

## 設定項目 (.env)

| 項目 | デフォルト | 説明 |
|------|-----------|------|
| `HOST` | 0.0.0.0 | バインドするアドレス |
| `PORT` | 3389 | サーバーポート |
| `PASSWORD` | (必須) | 認証パスワード |
| `TUNNEL_TOKEN` | (任意) | Cloudflare Tunnel トークン。未設定時は一時的な quick tunnel を使用 |
| `CAPTURE_QUALITY` | 60 | 画質 (1-100) |
| `CAPTURE_SCALE` | 0.6667 | キャプチャ解像度スケール (0.1-1.0) |
| `TARGET_FPS` | 60 | JPEG モードの目標フレームレート |
| `STREAM_MODE` | h264 | `h264` または `jpeg` |
| `H264_ENCODER` | libx264 | `h264_nvenc` / `h264_qsv` / `h264_amf` / `libx264` |
| `H264_TARGET_FPS` / `H264_CAPTURE_FPS` | 24 | 出力 / キャプチャ FPS |
| `SESSION_TIMEOUT_HOURS` | 24 | セッション有効期限 (時間) |
| `MAX_LOGIN_ATTEMPTS` | 5 | ログイン試行上限 |
| `LOCKOUT_MINUTES` | 15 | ロックアウト時間 (分) |

## 外部アクセス

### 方法1: Cloudflare Tunnel（推奨）

`cloudflared.exe` をプロジェクト直下に配置し、`.env` に `TUNNEL_TOKEN` を設定します。

```bash
cloudflared tunnel --url http://localhost:3389
```

トークン付きの名前付きトンネルを常時起動する場合は、管理者権限で次を実行します。

```bash
npm run install-service
```

`DeskedServer`（高整合性レベル）と `DeskedTunnel` の 2 つのスケジュールタスクが登録されます。

### 方法2: ポートフォワーディング

ルーターで外部ポート → 内部 IP:3389 を転送します。HTTPS 終端は別途用意してください。

## セキュリティ

- **HTTPS を必須とする**: Cloudflare Tunnel または nginx + Let's Encrypt などのリバースプロキシを経由させてください。パスワードと映像は平文の HTTP では保護されません。
- **強力なパスワード**を設定し、`.env` は絶対にコミットしないでください（`.gitignore` 済み）。
- WebSocket は同一オリジンのみ受け付けます（クロスサイト WebSocket ハイジャック対策）。
- ログイン試行回数の制限とロックアウトを内蔵しています。
- `cloudflared.exe`・ログ・スクリーンショットなどの実行時生成物はコミット対象外です。

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

## 技術スタック

- **Screen Capture**: FFmpeg Desktop Duplication / GDI + sharp
- **Input Simulation**: koffi + Windows API (user32.dll)
- **WebSocket**: ws
- **HTTP**: Express
- **Client**: HTML5 Canvas + WebCodecs + Vanilla JS
