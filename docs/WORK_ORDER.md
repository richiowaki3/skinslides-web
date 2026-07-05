# skinslides-web 修正指示書（作業順序つき）

作成日: 2026-07-05 / 作成: Claude (Fable 5)
検証根拠: [REDESIGN_DIRECTION.md](REDESIGN_DIRECTION.md)（数値・シミュレーション結果はそちらを参照）

この指示書は次の実装エージェント向け。**Phase順に着手すること。**
Phase 0〜2 は挙動検証が容易な独立作業、Phase 3〜4 は演出に関わる再設計。
各Phaseの最後に必ず「受け入れ基準」を満たしてからコミットする。

---

## 進捗（2026-07-05 Opus 4.8 実行分）

- **Phase 0: 完了・push済み**（下記の実測検証あり）
  - 0-1/0-2 スコア表示バグ修正・Space除外解消（logic.js は前コミット、audio_trigger_logic.js を本コミットで同期）
  - 0-3 タイムライン凡例をレベル表記へ（両HTML）
  - 0-4 コラージュ音量クランプ、0-5 死にコード削除（duetState / MAX_COLLAGE_VIDEOS / screenIndex / FIB_CROPS / triggerEvent二重計算 / logic.js到達不能リスナー）
  - バージョン v1.10.5 → v1.10.6（両HTML同時）
  - 実機検証: ブラウザで分類ログ `L1=8 L2=18 L3=16 L4=39` を確認、ロードエラー無し。
    `node tools/simulate.js planB new` → top10Share 42%→14.2%。
- **黒フレーム除去（起動時HEAD可用性フィルタ）: 完了・push済み**（52本のみプールに残す）。
- **Phase 3（質感マッチング選択）: Plan A実装・push済み（v1.11.0）**
  - オノマトペ辞書共通空間方式を logic.js に移植（USE_VECTOR_SELECT フラグ / TEXTURE_TEMP=2.5）。
    起動時に辞書CSV＋metadata_cv2.json＋metadata.jsonを読み、各動画に texVec を付与。
    音イベントのオノマトペ語→辞書ベクトルへ距離確率選択 P∝exp(-d/T)。Frequency軸は
    映像距離で無視(texDistVid)。語が無い/未準備なら selectVideoByLevel へ自動フォールバック。
  - 射影式(videoToVec v3)は tools/vector_map_prototype.js と一致。
  - Node実測(移植コードを実データで再現): texVec 52/52構築、辞書フォールバック0/2534、
    top10Share 31.1%、未使用0/52。※ブラウザ実機はプレビューharness不安定でtextureログ未確認
    だが、fetchは実績あるsound_metadataと同一%20パターン＋失敗時フォールバックで安全。
- **Plan B は未対応**（audio_trigger_logic.js は従来のレベルプール選択のまま。Phase1でcore
  一本化後に同じ texture選択を適用するのが理想）。
- Phase 1（core抽出）は未着手。

## R2 の動画本数について（作者確認済み・問題なし）

`logic_weights.json` は **81本**を参照するが、Cloudflare R2 には **52本**（`01`〜`56`
帯が中心、`57`以降はほぼ欠番）。

**作者判断（2026-07-05）**: これは仕様であり問題ではない。R2 上の52本が現行の実素材。
メタデータに残る欠番は、以前マシンパワーの都合でエフェクトを掛けられなかった時代に
使っていた「52本の別ディテール版」の名残で、現在は使わなくても動くため、
参照されないファイルがあっても構わない。**アップロード(旧case B)は不要。**

- ~~残る技術的副作用: 欠番が選ばれたトリガーで画面が一瞬黒くなる~~
  → **対応済み（作者判断で黒フレーム除去を採用）**。起動時に全動画の HEAD 可用性を
  確認し、404 を `metadataPool`/`videoMetadataPool` から除外する `filterAvailableVideos()`
  を logic.js と audio_trigger_logic.js に追加（分類前に実行）。全滅時はプローブ失敗と
  みなしフィルタ無効化するガード付き。simulate.js にも AVAILABLE_NUMS スナップショット
  フィルタを追加。実機で「Availability filter: 52 playable, 29 missing removed」→分類
  L1=4 L2=16 L3=9 L4=23 を確認、再生中の 404 エラーが消滅。
  ※R2 のアップロード状況が変わったら simulate.js の AVAILABLE_NUMS を更新すること。

---

## 作業ルール（全Phase共通）

1. **変更禁止（意図された仕様）**
   - ロック動画の曲またぎ居座り（トラック終了時にプレイヤーを止めない）
   - L4 の1.2秒チャタリング防止ロック
   - フリーズフレーム機構（`pauseTime.xml` 由来、2009年オリジナルの再現）
   - 方向(L2R/R2L)×フロー方向による 90°/270° 回転決定
   - L1/L2/L3 の「途中で止めない」ロック挙動そのもの
2. **バージョン更新ルール**: `?v=` クエリとダッシュボードの表示バージョンは
   `index.html` と `audio_trigger_demo.html` の**両方を同時に**更新する。
   片方だけ更新するとキャッシュずれが再発する（v1.10.0期に実際に発生した事故）。
   Phase 1 でバージョン文字列を一元化するので、それ以降は1箇所の更新で済む。
3. **検証**: 分類・しきい値・選択ロジックに触れたら必ず
   `node tools/simulate.js planA new` / `planB new` を実行し、
   top10Share / skipRate / unused を変更前後で比較してコミットメッセージに記載する。
4. 行番号は v1.10.5 時点のもの。他エージェントの作業でずれている可能性が
   あるため、**必ずシンボル名で検索**して位置を特定すること。

---

## Phase 0: 表示バグの即時修正（挙動への影響なし・最初にやる）

### 0-1. Activity 3.00 誤表示の修正（バグ）
- ファイル: `audio_trigger_logic.js` の `updateMonitorUI()` コラージュ分岐（≈1560行）
- 現状: `parseFloat(slot.dataset.w) || 3.0` — LMA値 0 が 3.0 に化ける
  （例: `05.mov` W0/T0/S0/H0 が Activity 3.00 と表示される）
- 修正: falsy 判定をやめる
  ```js
  const num = x => { const n = parseFloat(x); return Number.isFinite(n) ? n : 0; };
  const actScore = (num(slot.dataset.w) + num(slot.dataset.t) + num(slot.dataset.s) + num(slot.dataset.h)) / 4;
  ```
  ※ 4値平均にするのは 0-3 と同時適用（下記）

### 0-2. Activity スコアの Space 除外解消（表示と計算の整合）
- `logic.js` は修正済み（4値平均 + 再較正しきい値）。**これを正とする。**
- ファイル: `audio_trigger_logic.js`
  - `classifyVideos()`（≈1099行）: logic.js の修正済み実装をそのままコピーして同期
    （Phase 1 で一本化するまでの暫定。コメントに `// TODO: Phase1でcoreへ` と記す）
  - `updateMonitorUI()` の Plan A 分岐（≈1625行）:
    `vData.activity || (w+t+h)/3` → `vData.activity !== undefined ? vData.activity : (w+t+s+h)/4`

### 0-3. タイムライン凡例の修正（種別とレベルの混同）
- ファイル: `index.html`（≈361行）と `audio_trigger_demo.html`（凡例部を検索）
- 現状: 「Attack (L4) / Swell (L3) / Roll (L2) / Quiet (L1)」— 実際の色分けは
  strength しきい値ベースなので、strength 0.8 の「刻み」がオレンジ(Attack)で描かれ矛盾する
- 修正: レベル基準の表記に変更
  「L4 強 (≥0.75 or アタック) / L3 (≥0.5) / L2 (≥0.25) / L1 静 (<0.25)」

### 0-4. 音量クランプ（潜在バグ）
- ファイル: `audio_trigger_logic.js` の `triggerCollageVideo()`（≈1802行）
- 修正: `videoEl.volume = Math.min(1.0, volume * window.videoGainVolume);`

### 0-5. 死にコードの削除
- `audio_trigger_logic.js`:
  - `duetState`（≈581行、ターン交代制の残骸。参照ゼロ）
  - `MAX_COLLAGE_VIDEOS`（≈588行、未使用。コメントの「最大6枚」も値4と矛盾）
  - `screenIndex`（≈8行と loadTrack 内のリセットのみ。参照ゼロ）
  - `triggerEvent()` 内のレベル二重計算（≈1225行の tempLvl と ≈1237行の audioLevel は
    同一コード。1回にまとめる）
- `logic.js`: `toggle-video-audio` / `video-gain-slider` のリスナー設定（≈29-57行）。
  対応するDOM要素は index.html から削除済みで到達不能。

### Phase 0 受け入れ基準
- [ ] ローカルサーバー（`python server.py`）で両HTML を開きコンソールエラーなし
- [ ] Plan B で LMA 0 の動画表示時に Activity が 0.00 と表示される
- [ ] `node tools/simulate.js planA new` の結果が Phase 0 前と同一
  （表示修正のみで挙動が変わっていないことの確認。0-2 の分類同期だけは
  Plan B の結果が `planB new` の値に変わる — それが正）

---

## Phase 1: 共通コアの抽出（純リファクタ・挙動変更ゼロ）

### 1-1. `skinslides_core.js` を新設し、以下を移動・一本化

| 関数 | 正とするソース | 備考 |
|---|---|---|
| `getAudioLevel(event)` | **新規作成** | strengthしきい値+アタック判定。現在8箇所に複製されている判定を全てこの1関数の呼び出しに置換する |
| `classifyVideos` / `selectVideoByLevel` | `logic.js`（修正済み版） | |
| `filterAvailableVideos(basePath)` | どちらも同一 | 起動時のHEAD可用性除外。coreに一本化 |
| `getScreensToPlay` / `getFibonacciFadeTime` | どちらでも（同一） | |
| `drawTimeline(canvasId, ...)` | `audio_trigger_logic.js` 版 | canvasId引数を取る汎用版。logic.js側の呼び出しを `drawTimeline("timeline-canvas", ...)` に変更 |
| `reactScreenWithVideo` | 共通部を core へ | Plan B 固有処理（wrapper highlight, オノマトペポップアップ）はコールバック引数 `onReact(screenNum, event)` として注入 |
| `updateMonitorUI` | 共通部を core へ | Plan B のコラージュ分岐は分けたまま呼び出し側に残してよい |
| `addDecisionLog` / アイドルタイマー / 冒頭静寂イベント | どちらでも（同一） | |
| `SKINSLIDES_VERSION` 定数 | **新規作成** | ダッシュボード表示はこの定数から描画。`?v=` クエリの手動更新は残るが、表示との二重管理を解消 |

### 1-2. スクリプト読み込みの変更
- 両HTMLの `<script>` を `player.js` → `skinslides_core.js` → (`logic.js` | `audio_trigger_logic.js`) の順に
- `?v=` クエリは3ファイルとも同一値にそろえる

### Phase 1 受け入れ基準
- [ ] 両HTMLでコンソールの分類ログが同一（`Classified videos: L1=8, L2=18, L3=16, L4=39`）
- [ ] Plan A 再生・Plan B 両モード（Play A / Play B）が Phase 0 時点と同一挙動
- [ ] レベル判定しきい値のコード内出現が **grep で1箇所のみ** になっている
  （`grep -n "0.75" *.js` で確認）

---

## Phase 2: 分類再較正の確定（挙動変更・シミュレーション必須）

Phase 0-2 の暫定同期と Phase 1 の一本化が済んでいれば、ここは検証のみ。

### Phase 2 受け入れ基準
※ simulate.js は可用性フィルタ導入後、実在する **52本ベース**で計測する（旧値は81本時代）。
- [x] `node tools/simulate.js planA new` → top10Share 34.5%（旧分類 84.5%）
- [x] `node tools/simulate.js planB new` → top10Share 24.5%（旧分類 60.9%）
- [x] unused = 0/52（全ての実在動画が使われる）
- [ ] 実機で30分再生し、同一動画の目立った反復がないことを目視確認（作者確認事項）

---

## Phase 3: 多次元マップ移動方式（本命の再設計）

4段階プールを**置き換える**新しい選択エンジン。Phase 1 の core に実装し、
フラグで新旧を切り替えられるようにする（`USE_VECTOR_SELECT = true/false`）。

### 3-1. 特徴空間
- 動画側: `[W, T, S, H] / 9` の4次元正規化ベクトル（`logic_weights.json` 既存値）
- カテゴリ（姿勢 st/sp、方向 L2R/R2L/S）は距離に含めず、従来どおり回転決定に使う
- 音響側ターゲット: トラックの `profile.timbre.full_vector_0_9` から
  `[Weight, Time, Space, Hardness] / 9` を取り、イベントで変調する:
  ```
  target = trackVec * (0.5 + 0.5 * event.strength)
  event.type === "アタック" のとき target.Hardness = max(target.Hardness, 0.8)
  event.type === "うねり"   のとき target.Space    = max(target.Space, 0.7)
  ```
  （変調式は初期案。シミュレーションで調整してよい）

### 3-2. 選択スコア（小さいほど良い・最小値の動画を選ぶ）
```
score(v) = dist(v, target)                       // ユークリッド距離
         + α · exp(-(now - lastPlayed[v]) / τ)   // 直近再生ペナルティ
         + β · playCount[v] / maxPlayCount       // 露出均等化
         + γ · dist(v, lastOnScreen[screen])     // 振付連続性
初期値: α = 2.0, τ = 180秒, β = 1.0, γ = -0.3（負=滑らかに繋ぐ。+にすると跳ぶ）
```
- `lastPlayed` / `playCount` はセッション内メモリでよい（永続化不要）
- 同点・近接時は上位3件からランダムに1件（完全決定論による硬直を防ぐ）

### 3-3. 実装上の注意
- 再生レベル（L1〜L4の**再生様式**: フリーズ/フェード/カットイン）は残す。
  廃止するのは「レベル→プール」の対応だけで、`getAudioLevel()` の結果は
  引き続き再生様式と numScreens の決定に使う
- ダッシュボードの Activity 表示は「target との距離」に置き換え、
  ラベルを `Match Dist:` に変更（スコア表示の妥当性を保つ）

### Phase 3 受け入れ基準
- [ ] `tools/simulate.js` にベクトル選択モードを追加し（`planA vector`）、
  top10Share ≤ 20%、unused = 0、かつ「同一動画が10分以内に再登場する率」を
  新指標として出力して旧方式より減っていること
- [ ] フラグを false に戻すと Phase 2 の挙動に完全に戻ること

---

## Phase 4: トリガー間引きとコラージュ滞在時間

### 4-1. Plan A: イベントのダウンサンプリング
- トラックロード時にイベント列を前処理: **3秒窓で strength 局所最大の1件のみ採用**
  （窓幅は core の定数 `TRIGGER_WINDOW_SEC = 3.0` にして調整可能に）
- 期待効果: skipRate 83%→大幅減。採用イベントが確実に振付ステートマシンを通り、
  1→2→3往復のフローが復活する
- 検証: simulate.js に窓処理を入れ skipRate と top10Share を確認

### 4-2. Plan B: コラージュ滞在時間の制御
- 現状: 毎秒1.32本生成 × 4スロット = 滞在約3秒（平均70秒の動画の冒頭しか見えない）
- **まず作者に意図を確認すること**（高速コラージュが意図なら 4-2 はスキップし、
  到達不能な FREEZING 表示ロジックを削除するだけでよい）
- 滞在時間を延ばす場合: スライス内イベントにも 4-1 と同じ局所最大間引きを適用し、
  目標滞在時間 `COLLAGE_DWELL_TARGET_SEC = 10` から生成レート上限を逆算して
  スキップする

### Phase 4 受け入れ基準
- [ ] Plan A: skipRate が 40% 以下（simulate.js 計測）
- [ ] Plan A: 実機で L3 イベント時に隣接画面への遷移（フロー）が目視できる
- [ ] Plan B: 滞在時間が意図値に一致（ログの生成間隔から算出）

---

## 着手順まとめ

| 順 | Phase | 内容 | 規模感 | 挙動変更 |
|---|---|---|---|---|
| 1 | Phase 0 | 表示バグ修正・死にコード削除・Plan B分類同期 | 小 | 表示のみ（0-2除く） |
| 2 | Phase 1 | skinslides_core.js 抽出・しきい値一本化 | 中 | なし（純リファクタ） |
| 3 | Phase 2 | 再較正の確定・シミュレーション検証 | 小 | あり（偏り解消） |
| 4 | Phase 3 | 多次元マップ選択エンジン | 大 | あり（フラグ切替可） |
| 5 | Phase 4 | トリガー間引き・滞在時間制御 | 中 | あり（要作者確認1件） |

未確認事項（作者への質問）:
1. Plan B のコラージュ滞在3秒は意図か（→ 4-2 の要否が決まる）
2. Phase 3 の γ（振付連続性）は「滑らかに繋ぐ」でよいか、「意図的に跳ぶ」演出にするか
