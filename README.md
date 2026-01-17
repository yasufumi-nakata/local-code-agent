# Local Code Agent (Gemini-CLI Project)

CursorやAntigravityのように、ローカルLLM（Ollama等）を使用してローカルファイルを操作・開発できるエージェントシステムのプロトタイプです。

## 構成
- **Frontend**: React (Vite) + Tailwind CSS - マルチタスクのエージェントUI、ツール実行コンソール、権限パネル、プロンプト編集
- **Backend**: FastAPI (Python) - ファイル操作、コマンド実行、LLM連携
- **LLM**: Ollama等のOpenAI互換APIを持つローカルサーバーを使用
- **Security**: 機密情報（.envやログ）は `secrets/` フォルダに隔離し、Git管理から除外

## セットアップ
1. **Backend**:
   - `secrets/.env` を作成し、LLMのベースURLとモデル名を指定します。
   - `./run_backend.sh` を実行してAPIを起動します。

2. **Frontend**:
   - `cd frontend` して、`npm install` で依存関係をセットアップしてください。
   - `npm run dev` で Vite 開発サーバーを起動し、デフォルトでは `http://localhost:5173` でアクセスできます。
   - フロントエンドは Tailwind CSS でスタイルされたチャット UI で、`VITE_BACKEND_URL` を使って FastAPI バックエンドのホスト/ポートを変更できます。
   - `npm run build` で静的ファイルをビルドできます（`dist/` が生成されます）。
   - Tool Console から `run_command` 等を実行できます（ローカル環境を操作するので注意）。
   - Permissions で `run_command` / `write_file` の実行可否を調整できます。
   - Permissions にはノールック（自動許可）と一括承認の操作があります。
   - File Editor はデフォルトでオフなので、必要なときに Agent Controls から開いてください。
