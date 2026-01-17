# Development Log

## 2026-01-16: プロジェクト初期化
- ディレクトリ構造の作成 (`frontend/`, `backend/`, `secrets/`)。
- セキュリティ対策として `.gitignore` を設定し、`secrets/` 内の機密情報を保護。
- Backend (FastAPI) の基盤実装。
    - `read_file`, `write_file`, `run_command`, `list_files` のツール実行機能を実装。
- ローカルLLM (Ollama等) との通信機能を実装。
- ドキュメント (`README.md`, `DEVELOPMENT_LOG.md`) の作成。
- Frontend (React + Tailwind) の構築を開始。
- `frontend` に Vite + Tailwind + 会話 UI を追加し、FastAPI バックエンドへの問い合わせができるようになった。
- リクエスト/コンテキスト入力、エラーメッセージ、会話ログ、バックエンド URL 切り替えオプションを UI で提供。
- README にフロントエンドのセットアップ手順を追加。

## 2026-01-16: エージェンティックUIの拡張
- マルチタスクのタスクボード UI を追加。
- ツール提案の検出・実行・ログ表示を追加。
- 手動でツールを実行する Tool Console を追加。
- プロンプト調整パネルと自動続行オプションを追加。
- Cursorライクな権限パネルを追加し、ツールごとの許可/拒否/確認を管理。
- File Editor を追加し、デフォルトは非表示に設定。
- 権限パネルにノールックと一括承認の操作を追加。

## 次のステップ
- [x] Frontend (React) の構築
- [ ] エージェントの自律的な思考（Loop）機能の強化
- [ ] UIでのファイル差分表示機能
