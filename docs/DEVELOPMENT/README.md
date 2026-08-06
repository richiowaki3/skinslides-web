# 開発者向けドキュメント

このディレクトリは実装・改造を行う人向けです。仕組みの概要を知りたいだけの場合は
[`../SYSTEM_ARCHITECTURE.md`](../SYSTEM_ARCHITECTURE.md) を参照してください。

## 最新の状況

- **[SCENE_STATUS_2026-08-06.md](SCENE_STATUS_2026-08-06.md)** — 直近の変更内容とハンドオフ事項。
  次にこのプロジェクトを触るならまずこれを読む
- [SCENE_STATUS_2026-08-05.md](SCENE_STATUS_2026-08-05.md) — 一つ前のログ

## 設計の経緯

- [REDESIGN_DIRECTION.md](REDESIGN_DIRECTION.md) — Plan A / Plan B ロジックの検証結果と
  再設計方針（2026-07-05時点）
- [WORK_ORDER.md](WORK_ORDER.md) — 上記に基づく実装指示書（Phase 0〜4）

## アーカイブ（旧版・参考資料）

- [ARCHIVE_logic_v1.0.md](ARCHIVE_logic_v1.0.md) — 初期実装（3画面固定モデル）の設計コード
- [ARCHIVE_charts_v1.10.5.md](ARCHIVE_charts_v1.10.5.md) — v1.10.5時点のシステム図・ロジック図

これらは現行の Combination アーキテクチャ（`index.html` 単一ボタン構成）以前のもので、
実装として参照する場合は古い記述である点に注意してください。
