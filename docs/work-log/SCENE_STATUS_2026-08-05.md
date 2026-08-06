# skinslides テストシーン現状ログ（2026-08-05）

前セッション「sss最終の回収」の後始末と検証を行い、テスト環境を整備した時点の記録。
次の実装セッションはまずこのファイルを読むこと。

## プロジェクトのゴールとロードマップ

skinslides は Web ブラウザで鑑賞するインタラクティブ映像作品。
公開先: https://github.com/richiowaki3/skinslides-web （GitHub Pages）
動画素材: Cloudflare R2 (`pub-b863fe2ba58a4525be0263e22ceb85a5.r2.dev`)

作業順序（決定済み）:

1. ~~テスト環境が動くための掃除~~ ← **本セッションで完了**
2. GitHub 公開に向けた整理（コミット済み。push は未実施）
3. **special のテスト・改善**（シンプルなシーンなので最初に）
4. **test-level2 の微調整** + Play B のオノマトペエンジンでの駆動を検討
5. Play B はコンバートに向けた最低限の調節のみ
6. Play A は無修正で予備として保持（コンバート対象外）
7. 3シーンが動いたら **Combination（コンバート）を再構築**
8. Combination が動いたらメインと入れ替え（旧メインは消去）

## テスト実行場所（明確化）

**ローカルが正。GitHub Pages は公開確認用。**

| 用途 | 場所 |
|---|---|
| ローカルサーバー起動 | `claude_woek/.claude/launch.json` の `skinslides`（python server.py, ポート8000） |
| メイン（Play A / Play B） | http://localhost:8000/index.html |
| テストシーン選択画面 | http://localhost:8000/audio_trigger_demo.html |
| プリロード省略 | `?fast=1` を付ける（**ただし注意点あり、下記参照**） |
| GitHub Pages メイン | https://richiowaki3.github.io/skinslides-web/ |
| GitHub Pages テスト | https://richiowaki3.github.io/skinslides-web/audio_trigger_demo.html |

### 環境の重要な注意点

- **`?fast=1` は Play B / Combination では使えない。** プリロードを飛ばすと
  cut-up エンジンの音声バッファが空になり `[ERROR] No preloaded audio buffers found for cut-up!`
  で即停止する（本セッションで再現確認）。special / test-level2 のみ `?fast=1` 可。
- ローカル `videos/` は **360p の 01〜56 のみ52本**（37/42/43/55 は欠番）。
  special が使う **90番台はローカルに無く、R2 から自動フォールバック**して再生される（動作確認済み）。
- 起動直後の 404 連発（66〜97 の HEAD）は**一度きりの可用性プローブ**であり暴走ではない。
  プローブ後は「52本の既知動画」に自動絞り込みされる。
- ポート8000が塞がっている場合は前セッションのサーバー残骸。
  `Get-NetTCPConnection -LocalPort 8000` で PID を特定して停止する。
  server.py は PORT 環境変数対応済み（既定8000）。

## 各シーンの現状（2026-08-05 実測）

| シーン | 場所 | 状態 |
|---|---|---|
| Play A | index.html | ✅ 動作。**無修正で凍結**（予備） |
| Play B | index.html | ✅ 動作。コンバート向け最低限調節のみ予定 |
| test-level2 | audio_trigger_demo.html | ✅ 動作確認済み。パイプ連結600手検証で違反0。微調整＋オノマトペエンジン駆動の検討が残タスク |
| special | audio_trigger_demo.html | ✅ **動画・音声とも再生確認済み**（今回実測: 90-Sss360p.mp4 を R2 から再生、T525.mp3 同時再生、コンソールエラー0）。前セッションの canplay 待ち修正が効いている |
| Combination | audio_trigger_demo.html | ❌ **失敗を再現・原因特定**（下記） |

### special について

前セッションで2つの問題があり、両方とも解決済みの模様:
1. `src` 設定直後の `play()` によるタイミング不良 → **canplay 待ちに修正済み・効果確認済み**
2. Chrome 省電力による muted 動画の強制停止（バックグラウンドタブ時のみ発生）
   → フォアグラウンドで鑑賞する分には問題にならない。気になるなら
   `visibilitychange` での再開処理を検討。

special は「とてもシンプルなシーン」なので、シーン内容の改善（演出面）が次の実装タスク。

### Combination の失敗内容（本セッションで再現）

Combination は Play B → test-level2 → special を順に繋ぐ構成。開始フェーズは Play B（120秒）。

観測された失敗:
```
[CONTROL] Audio Cut-up Duet started (Twin-Agent Stereo Mode)
[ERROR] No preloaded audio buffers found for cut-up!
[CONTROL] Audio Cut-up Test stopped
Combination: Play B (120秒)   ← ここで映像・音声とも何も動かないまま停止
```
コンソール: `Collage video play failed: AbortError: The play() request was interrupted
because the media was removed from the document.`

要因の整理:
- `?fast=1` でテストしたため音声バッファが未ロード → cut-up が即死。
  **フルプリロードでの再テストが必要**（未実施。これが最初の切り分け作業）。
- 動画要素が play() 中に DOM から除去される競合があり、フェーズ遷移処理に
  ライフサイクル管理の問題がある可能性。
- 再構築の方針: special の改善を終えてから、3シーンが個別に安定した状態で再コンバート。

## Git の状態

- ブランチ: main のみ。origin = github.com/richiowaki3/skinslides-web
- 本セッションで前セッション由来の作業ツリー（server.py スレッド化、360p フォールバック、
  special canplay 修正、lexicon 系新規ファイル等）を一括コミット。**push は未実施**。
- `videos/`（ローカル360pコピー52本）は .gitignore 追加済み。コミット対象外。
- 現メイン（GitHub Pages 上の旧版）は Combination 完成時に全面入れ替え予定のため保護不要。

## 次セッション（実装担当）の最初のタスク

1. `?fast=1` **無し**で Combination を起動し、フルプリロードで Play B フェーズが動くか切り分け
2. special のシーン内容改善（演出調整）
3. test-level2 の微調整、Play B のオノマトペエンジン（lexicon_live.js / 質感ベクトル）での駆動検討
4. 3シーン安定後に Combination 再構築 → メイン入れ替え
