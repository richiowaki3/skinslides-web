window.freezeFramesPool = {};
window.videoPausePer = 100; // デフォルトで100%発生
window.videosMuted = false;  // 動画の音声をデフォルトでON（ミュート解除）

// pauseTime.xml からフリーズフレーム情報をロードして秒数に変換
window.loadFreezeFrames = async function() {
    try {
        const res = await fetch("pauseTime.xml");
        const text = await res.text();
        const parser = new DOMParser();
        const xmlDoc = parser.parseFromString(text, "text/xml");
        const movieNode = xmlDoc.getElementsByTagName("MOVIE")[0];
        if (!movieNode) {
            console.warn("[player] MOVIE tag not found in pauseTime.xml");
            return;
        }
        
        const children = movieNode.children;
        for (let i = 0; i < children.length; i++) {
            const child = children[i];
            const tagName = child.tagName.toLowerCase(); // 例: "s05.mov"
            const match = tagName.match(/s(\d+)\.mov/);
            if (match) {
                const videoNumStr = match[1];
                const videoKey = `${videoNumStr}.mov`;
                
                const pauseNodes = child.getElementsByTagName("PAUSE");
                const pauseTimes = [];
                for (let j = 0; j < pauseNodes.length; j++) {
                    const frameNum = parseInt(pauseNodes[j].textContent, 10);
                    if (frameNum > 0) {
                        pauseTimes.push(frameNum / 30.0); // 30fpsとしてフレーム番号を秒数に変換
                    }
                }
                if (pauseTimes.length > 0) {
                    window.freezeFramesPool[videoKey] = pauseTimes;
                }
            }
        }
        console.log(`[player] Loaded freeze frames for ${Object.keys(window.freezeFramesPool).length} videos.`);
    } catch (e) {
        console.warn("[player] Failed to load pauseTime.xml. Freeze frames will be disabled.", e);
    }
};

class VideoPlayer {
    constructor(elementId, isHiddenAudioOnly = false) {
        this.mediaEl = document.getElementById(elementId);
        this.isHiddenAudioOnly = isHiddenAudioOnly;
        
        // 音声専用プレイヤーは常にミュート解除、動画プレイヤーは window.videosMuted に従う
        this.mediaEl.muted = isHiddenAudioOnly ? false : window.videosMuted; 
        
        // 状態管理用
        this.isLocked = false;
        this.activeResolve = null;
        this.timeUpdateHandler = null;
        this.fadeInterval = null;
        this.fadeTimeout = null;
        
        // フリーズフレーム用
        this.freezeAnimationId = null;
        this.freezeTimeout = null;
        this.freezeTimes = null;
        this.triggeredFreezes = null;

        // 分析モニター用の状態変数
        this.currentVideoData = null;
        this.currentRotationAngle = 90;
        this.currentFlowDir = 1;
    }

    // ミュート状態を動的に変更
    setMute(isMuted) {
        if (!this.isHiddenAudioOnly) {
            this.mediaEl.muted = isMuted;
        }
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
                    this.startFreezeMonitor(fileName);
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
            
            this.mediaEl.play().then(() => {
                this.startFreezeMonitor(fileName);
            }).catch(e => {
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
                        this.mediaEl.play().then(() => {
                            this.startFreezeMonitor(fileName);
                        }).catch(e => {
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
            
            this.mediaEl.play().then(() => {
                this.startFreezeMonitor(fileName);
            }).catch(e => {
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
            
            this.mediaEl.play().then(() => {
                this.startFreezeMonitor(fileName);
            }).catch(e => {
                console.error(`L4再生エラー [${fileName}]:`, e);
                resolve();
            });

            this.mediaEl.onended = () => {
                this.stop();
            };
        });
    }

    // 高精度フリーズフレーム監視ループ
    startFreezeMonitor(fileName) {
        this.stopFreezeMonitor();
        if (this.isHiddenAudioOnly) return;

        const freezeTimes = window.freezeFramesPool ? (window.freezeFramesPool[fileName] || []) : [];
        if (freezeTimes.length === 0) return;

        this.freezeTimes = freezeTimes;
        this.triggeredFreezes = new Array(freezeTimes.length).fill(false);

        const checkFreeze = () => {
            if (this.mediaEl.paused || this.mediaEl.ended) {
                // フリーズによる一時停止中でない場合は、再生再開を待つためにループのみ継続
                if (!this.freezeTimeout) {
                    this.freezeAnimationId = requestAnimationFrame(checkFreeze);
                    return;
                }
            }

            const cf = this.mediaEl.currentTime;
            for (let i = 0; i < this.freezeTimes.length; i++) {
                if (!this.triggeredFreezes[i]) {
                    const pt = this.freezeTimes[i];
                    
                    // 指定フレームの前後0.05秒〜0.1秒の範囲で検知
                    if (cf >= pt - 0.03 && cf <= pt + 0.1) {
                        this.triggeredFreezes[i] = true;

                        const prob = window.videoPausePer !== undefined ? window.videoPausePer : 100;
                        if (Math.random() * 100 < prob) {
                            this.mediaEl.pause();

                            // 一時停止するフレーム数: rand() % 136 + 15
                            const pauseFrames = Math.floor(Math.random() * 136) + 15;
                            const pauseSec = pauseFrames / 30.0; // 30fps換算

                            console.log(`[player] Freeze triggered at ${cf.toFixed(2)}s (target ${pt.toFixed(2)}s). Pausing for ${pauseSec.toFixed(2)}s (${pauseFrames} frames).`);

                            if (window.addDecisionLog) {
                                const screenNum = this.mediaEl.id.split('-').pop();
                                window.addDecisionLog(`Screen ${screenNum}: Freeze frame triggered at ${cf.toFixed(2)}s (target ${pt.toFixed(2)}s). Pausing for ${pauseSec.toFixed(2)}s (${pauseFrames} frames).`, 'warning');
                            }

                            this.freezeTimeout = setTimeout(() => {
                                this.freezeTimeout = null;
                                if (this.mediaEl && !this.isHiddenAudioOnly && !this.mediaEl.ended) {
                                    this.mediaEl.play().catch(e => {});
                                }
                            }, pauseSec * 1000);
                        }
                    }
                }
            }

            this.freezeAnimationId = requestAnimationFrame(checkFreeze);
        };

        this.freezeAnimationId = requestAnimationFrame(checkFreeze);
    }

    stopFreezeMonitor() {
        if (this.freezeAnimationId) {
            cancelAnimationFrame(this.freezeAnimationId);
            this.freezeAnimationId = null;
        }
        if (this.freezeTimeout) {
            clearTimeout(this.freezeTimeout);
            this.freezeTimeout = null;
        }
        this.freezeTimes = null;
        this.triggeredFreezes = null;
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
        
        this.stopFreezeMonitor();
        
        this.mediaEl.pause();
        this.isLocked = false;
        
        if (!this.isHiddenAudioOnly) {
            this.mediaEl.src = "";
            this.mediaEl.classList.remove("playing");
            this.mediaEl.style.opacity = 0;
        }
    }
}
