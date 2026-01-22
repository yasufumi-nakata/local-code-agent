# Local Code Agent

ローカルLLM（Ollama等）を使用してローカルファイルシステムを操作・開発できるエージェントシステムのプロトタイプです。CursorやAntigravityのようなAIベースエディタと同様のコンセプトで構築されています。

## 機能

### マルチタスク管理
- 複数のタスクを並行実行可能
- タスクボード形式のUI
- タスクごとのステータス追跡（idle, running, awaiting, done, failed）

### 5つの実行可能ツール
| ツール | 説明 |
|--------|------|
| `read_file` | ファイル内容を読み取り |
| `write_file` | ファイルに内容を書き込み（上書き） |
| `run_command` | シェルコマンドを実行 |
| `list_files` | ディレクトリ内容を一覧表示 |
| `web_search` | DuckDuckGo経由でWeb検索 |

### 権限管理
- ツールごとに実行許可を制御（Ask/Allow/Deny）
- ノールック（自動許可）モード
- 一括承認オプション

### その他の機能
- ツールコンソール: 手動でツールをテスト実行
- ファイルエディタ: ファイルの読み書きをUI上で実行
- システムプロンプトのカスタマイズ
- プロンプトテンプレート機能

## 技術スタック

### フロントエンド
- React 19
- Vite
- Tailwind CSS
- React Markdown（remark-gfm対応）

### バックエンド
- FastAPI
- Uvicorn
- OpenAI SDK（OpenAI互換API用）
- Pydantic

### LLM
- Ollama またはOpenAI互換API（ローカル実行）
- デフォルトモデル: llama3
- デフォルトURL: `http://localhost:11434/v1`

## プロジェクト構成

```
local-code-agent/
├── backend/
│   ├── main.py           # FastAPI バックエンド
│   └── requirements.txt  # Python依存関係
├── frontend/
│   ├── src/
│   │   ├── App.jsx       # メインUIコンポーネント
│   │   ├── main.jsx      # エントリーポイント
│   │   └── index.css     # スタイル
│   ├── package.json      # Node.js依存関係
│   └── vite.config.js    # Vite設定
├── secrets/              # 機密情報（Git管理外）
├── logs/                 # ログファイル
├── run_backend.sh        # バックエンド起動スクリプト
└── README.md
```

## セットアップ

### 前提条件
- Python 3.8以上
- Node.js 18以上
- Ollama（または他のOpenAI互換LLMサーバー）

### 1. 環境設定

`secrets/.env` ファイルを作成し、以下を設定:

```env
LLM_BASE_URL=http://localhost:11434/v1
LLM_MODEL=llama3
```

### 2. バックエンドの起動

```bash
./run_backend.sh
```

または手動で:

```bash
cd backend
python3 -m venv ../venv
source ../venv/bin/activate
pip install -r requirements.txt
python main.py
```

バックエンドは `http://localhost:8000` で起動します。

### 3. フロントエンドの起動

```bash
cd frontend
npm install
npm run dev
```

フロントエンドは `http://localhost:5173` でアクセスできます。

### 本番ビルド

```bash
cd frontend
npm run build  # dist/ にビルド出力
```

## 使い方

1. ブラウザで `http://localhost:5173` にアクセス
2. タスクボードで新しいタスクを作成
3. チャット欄でエージェントに指示を送信
4. ツール実行時に権限パネルで許可/拒否を選択
5. 結果を確認し、必要に応じて続行

### ツールコンソール
手動でツールをテスト実行できます。JSON形式で呼び出し:

```json
{"tool": "list_files", "params": {"path": "."}}
```

### ファイルエディタ
デフォルトでは非表示です。Agent Controls パネルから開閉できます。

## APIエンドポイント

| メソッド | パス | 説明 |
|---------|------|------|
| GET | `/health` | ヘルスチェック |
| POST | `/chat` | チャット/エージェント実行 |
| POST | `/execute_tool` | ツール直接実行 |

## セキュリティについて

- `.env` ファイルと機密情報は `secrets/` フォルダに隔離
- `secrets/` は `.gitignore` でGit管理から除外
- CORS設定は現在すべてのオリジンを許可（本番環境では制限を推奨）
- `run_command` ツールはローカル環境を直接操作するため注意が必要

## ライセンス

MIT License
