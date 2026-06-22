class VideoPlayer {
    constructor(elementId, isHiddenAudioOnly = false) {
        this.mediaEl = document.getElementById(elementId);
        this.isHiddenAudioOnly = isHiddenAudioOnly;
        
        // 第4プレイヤー（音声専門）以外はミュートにしておく
        this.mediaEl.muted = !isHiddenAudioOnly; 
        
        // 状態管理用
        this.isLocked = false;
        this.activeResolve = null;
        this.timeUpdateHandler = null;
        this.fadeInterval = null;
        this.fadeTimeout = null;
    }

    // 従来のオーディオ再生用メソッドを維持
    playSequence(fileName, waitDelaySec = 0) {
        this.stop();
        return new Promise((resolve) => {
            this.activeResolve = resolve;
            const basePath = this.isHiddenAudioOnly ? AUDIO_BASE_PATH : VIDEO_BASE_PATH;
            
            let finalFileName = fileName;
            if (!this.isHiddenAudioOnly) {
                const match = fileName.match(/(\d+)\.(mov|mp4)/i);
                if (match) {
                    finalFileName = `${match[1]}-Sss720p.mp4`;
                }
            }
            
            this.mediaEl.src = basePath + finalFileName;
            this.mediaEl.volume = 1.0;
            
            this.mediaEl.play().then(() => {
                if (!this.isHiddenAudioOnly) {
                    this.mediaEl.classList.add("playing");
                    this.mediaEl.style.opacity = 1;
                }
            }).catch(e => {
                console.error(`再生エラー [${fileName}]:`, e);
                resolve(); 
            });

            this.mediaEl.onended = () => {
                if (!this.isHiddenAudioOnly) {
                    this.mediaEl.classList.remove("playing");
                    this.mediaEl.src = "";
                }
                
                if (waitDelaySec > 0) {
                    this.fadeTimeout = setTimeout(() => resolve(), waitDelaySec * 1000);
                } else {
                    resolve();
                }
            };
        });
    }

    // レベル 1: 静かで変化が少ない（最後のフレームでフリーズして待機）
    playLevel1(fileName) {
        this.stop();
        return new Promise((resolve) => {
            this.activeResolve = resolve;
            const basePath = VIDEO_BASE_PATH;
            let finalFileName = fileName;
            const match = fileName.match(/(\d+)\.(mov|mp4)/i);
            if (match) {
                finalFileName = `${match[1]}-Sss720p.mp4`;
            }
            
            this.mediaEl.src = basePath + finalFileName;
            this.mediaEl.style.opacity = 1;
            this.mediaEl.classList.add("playing");
            
            this.mediaEl.play().catch(e => {
                console.error(`L1再生エラー [${fileName}]:`, e);
                resolve();
            });

            this.timeUpdateHandler = () => {
                if (this.mediaEl.duration && this.mediaEl.currentTime >= this.mediaEl.duration - 0.1) {
                    this.mediaEl.pause();
                    this.mediaEl.removeEventListener('timeupdate', this.timeUpdateHandler);
                    this.timeUpdateHandler = null;
                    resolve();
                }
            };
            this.mediaEl.addEventListener('timeupdate', this.timeUpdateHandler);
        });
    }

    // レベル 2: やや動きがある（最初のフレームでフリーズ＆フェードイン、再生、最後のフレームでフリーズ＆フェードアウト）
    playLevel2(fileName, fadeTimeSec) {
        this.stop();
        return new Promise((resolve) => {
            this.activeResolve = resolve;
            const basePath = VIDEO_BASE_PATH;
            let finalFileName = fileName;
            const match = fileName.match(/(\d+)\.(mov|mp4)/i);
            if (match) {
                finalFileName = `${match[1]}-Sss720p.mp4`;
            }
            
            this.mediaEl.src = basePath + finalFileName;
            this.mediaEl.style.opacity = 0;
            this.mediaEl.classList.add("playing");
            
            // 最初のフレームをロードして一時停止
            this.mediaEl.currentTime = 0;
            this.mediaEl.pause();
            
            const onCanPlay = () => {
                this.mediaEl.removeEventListener('canplay', onCanPlay);
                this.mediaEl.removeEventListener('error', onError);
                
                // フェードイン処理開始
                let opacity = 0;
                const intervalMs = 30;
                const step = 1 / (fadeTimeSec * 1000 / intervalMs);
                
                this.fadeInterval = setInterval(() => {
                    opacity += step;
                    if (opacity >= 1) {
                        opacity = 1;
                        clearInterval(this.fadeInterval);
                        this.fadeInterval = null;
                        
                        // フェードイン完了後に再生開始
                        this.mediaEl.play().catch(e => {
                            console.error(`L2再生エラー [${fileName}]:`, e);
                            resolve();
                        });
                        
                        // 終了検知フェードアウト監視
                        this.timeUpdateHandler = () => {
                            if (this.mediaEl.duration && this.mediaEl.currentTime >= this.mediaEl.duration - 0.1) {
                                this.mediaEl.pause(); // 最後のフレームでフリーズ
                                this.mediaEl.removeEventListener('timeupdate', this.timeUpdateHandler);
                                this.timeUpdateHandler = null;
                                
                                // フェードアウト処理開始
                                let outOpacity = 1;
                                this.fadeInterval = setInterval(() => {
                                    outOpacity -= step;
                                    if (outOpacity <= 0) {
                                        outOpacity = 0;
                                        clearInterval(this.fadeInterval);
                                        this.fadeInterval = null;
                                        
                                        // 完全に終了
                                        this.stop();
                                    } else {
                                        this.mediaEl.style.opacity = outOpacity;
                                    }
                                }, intervalMs);
                            }
                        };
                        this.mediaEl.addEventListener('timeupdate', this.timeUpdateHandler);
                    } else {
                        this.mediaEl.style.opacity = opacity;
                    }
                }, intervalMs);
            };
            
            const onError = (e) => {
                console.error(`L2ロードエラー: ${finalFileName}`, e);
                this.mediaEl.removeEventListener('canplay', onCanPlay);
                this.mediaEl.removeEventListener('error', onError);
                resolve();
            };
            
            this.mediaEl.addEventListener('canplay', onCanPlay);
            this.mediaEl.addEventListener('error', onError);
            this.mediaEl.load();
        });
    }

    // レベル 3: 変化が一貫してある（即カットイン、上書きロック、最後まで再生）
    playLevel3(fileName) {
        this.stop();
        this.isLocked = true;
        return new Promise((resolve) => {
            this.activeResolve = resolve;
            const basePath = VIDEO_BASE_PATH;
            let finalFileName = fileName;
            const match = fileName.match(/(\d+)\.(mov|mp4)/i);
            if (match) {
                finalFileName = `${match[1]}-Sss720p.mp4`;
            }
            
            this.mediaEl.src = basePath + finalFileName;
            this.mediaEl.style.opacity = 1;
            this.mediaEl.classList.add("playing");
            
            this.mediaEl.play().catch(e => {
                console.error(`L3再生エラー [${fileName}]:`, e);
                this.isLocked = false;
                resolve();
            });

            this.mediaEl.onended = () => {
                this.isLocked = false;
                this.stop();
            };
        });
    }

    // レベル 4: 激しい（即カットイン、上書き可能、最後まで再生）
    playLevel4(fileName) {
        this.stop();
        return new Promise((resolve) => {
            this.activeResolve = resolve;
            const basePath = VIDEO_BASE_PATH;
            let finalFileName = fileName;
            const match = fileName.match(/(\d+)\.(mov|mp4)/i);
            if (match) {
                finalFileName = `${match[1]}-Sss720p.mp4`;
            }
            
            this.mediaEl.src = basePath + finalFileName;
            this.mediaEl.style.opacity = 1;
            this.mediaEl.classList.add("playing");
            
            this.mediaEl.play().catch(e => {
                console.error(`L4再生エラー [${fileName}]:`, e);
                resolve();
            });

            this.mediaEl.onended = () => {
                this.stop();
            };
        });
    }

    // プレイヤー状態の完全クリーンアップ
    stop() {
        if (this.activeResolve) {
            this.activeResolve();
            this.activeResolve = null;
        }
        if (this.fadeInterval) {
            clearInterval(this.fadeInterval);
            this.fadeInterval = null;
        }
        if (this.fadeTimeout) {
            clearTimeout(this.fadeTimeout);
            this.fadeTimeout = null;
        }
        if (this.timeUpdateHandler) {
            this.mediaEl.removeEventListener('timeupdate', this.timeUpdateHandler);
            this.timeUpdateHandler = null;
        }
        
        this.mediaEl.pause();
        this.isLocked = false;
        
        if (!this.isHiddenAudioOnly) {
            this.mediaEl.src = "";
            this.mediaEl.classList.remove("playing");
            this.mediaEl.style.opacity = 0;
        }
    }
}
