class VideoPlayer {
    constructor(elementId, isHiddenAudioOnly = false) {
        this.mediaEl = document.getElementById(elementId);
        this.isHiddenAudioOnly = isHiddenAudioOnly;
        
        // 第4プレイヤー（音声専門）以外はミュートにしておく
        this.mediaEl.muted = !isHiddenAudioOnly; 
    }

    playSequence(fileName, waitDelaySec = 0) {
        return new Promise((resolve) => {
            // パスを設定してメディア（動画または音声）をロード
            const basePath = this.isHiddenAudioOnly ? AUDIO_BASE_PATH : VIDEO_BASE_PATH;
            this.mediaEl.src = basePath + fileName;
            this.mediaEl.volume = 1.0; // ボリュームを戻す（フェードアウト後を考慮）
            
            // 再生開始
            this.mediaEl.play().catch(e => {
                console.error(`再生エラー [${fileName}]: ファイルが見つからないか、ブラウザのポリシーでブロックされました。`, e);
                // 失敗した場合はエラーを出して即座に終了扱い（シーケンスを止めないため）
                resolve(); 
            });

            // メディアが最後まで再生しきったタイミング
            this.mediaEl.onended = () => {
                if (!this.isHiddenAudioOnly) {
                    this.mediaEl.src = ""; // 物理的に黒画面にして沈黙を生む
                }
                
                // --- フィボナッチ待機（余韻フェーズ） ---
                if (waitDelaySec > 0) {
                    setTimeout(() => resolve(), waitDelaySec * 1000);
                } else {
                    resolve();
                }
            };
        });
    }

    // フェードアウト処理
    fadeOut(durationMs = 1000) {
        return new Promise((resolve) => {
            if (this.mediaEl.paused) {
                resolve();
                return;
            }
            const startVolume = this.mediaEl.volume;
            const intervalTime = 50;
            const steps = durationMs / intervalTime;
            const stepVolume = startVolume / steps;
            
            const fadeInterval = setInterval(() => {
                if (this.mediaEl.volume > stepVolume) {
                    this.mediaEl.volume -= stepVolume;
                } else {
                    this.mediaEl.volume = 0;
                    this.mediaEl.pause();
                    this.mediaEl.volume = startVolume; // 次の再生のためにボリュームを元に戻す
                    clearInterval(fadeInterval);
                    resolve();
                }
            }, intervalTime);
        });
    }

    // 即時停止
    stop() {
        this.mediaEl.pause();
        this.mediaEl.currentTime = 0;
        if (!this.isHiddenAudioOnly) {
            this.mediaEl.src = "";
        }
    }
}
