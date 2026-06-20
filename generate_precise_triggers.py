# generate_precise_triggers.py
import os
import json
import numpy as np
import soundfile as sf

METADATA_PATH = "Audio analysis data/sound_metadata.json"

def main():
    if not os.path.exists(METADATA_PATH):
        print(f"[error] Metadata file not found: {METADATA_PATH}")
        return

    with open(METADATA_PATH, "r", encoding="utf-8") as f:
        metadata = json.load(f)

    print(f"Loaded metadata for {len(metadata)} tracks.")
    updated_count = 0

    for track in metadata:
        file_id = track["file_id"]
        # Resolve local MP3 path
        mp3_name = file_id.replace(".aif", ".mp3").replace(".aiff", ".mp3")
        mp3_path = os.path.join("audios", mp3_name)

        if not os.path.exists(mp3_path):
            print(f"[warning] MP3 file not found: {mp3_path}. Skipping.")
            continue

        try:
            # Load audio using soundfile (automatic format support)
            data, sr = sf.read(mp3_path)
            
            # Downmix to mono if stereo
            if len(data.shape) > 1:
                y = np.mean(data, axis=1)
            else:
                y = data

            # Calculate RMS in 100ms bins
            bin_duration = 0.1  # 100ms
            bin_size = int(sr * bin_duration)
            num_bins = int(len(y) / bin_size)

            if num_bins < 3:
                print(f"[warning] File too short: {mp3_path}")
                continue

            rms = np.array([np.sqrt(np.mean(y[i*bin_size : (i+1)*bin_size]**2)) for i in range(num_bins)])
            max_rms = np.max(rms) if len(rms) > 0 else 0.0
            if max_rms <= 0:
                print(f"[warning] Silent file: {mp3_path}")
                continue

            # Read sound tendency parameters from metadata
            onset_rate = track["notes"]["onset_rate_per_sec"]
            dominant_motion = track["profile"]["change_quality"]["dominant_motion"]
            
            # Build vocabulary pool for this track
            onomatopoeia_pool = track["profile"]["timbre"]["onomatopoeia"]
            existing_onomas = [e["onomatopoeia"] for e in track["triggers"]["events"] if e.get("onomatopoeia")]
            vocab = list(set(onomatopoeia_pool + existing_onomas))
            if not vocab:
                vocab = ["しーん"] # fallback

            # Dynamically determine min_gap based on onset rate (sound tendency)
            if onset_rate > 3.0:
                min_gap = 0.25  # Fast / rhythmic (e.g. T522)
            elif onset_rate > 1.5:
                min_gap = 0.50  # Moderate changes
            elif onset_rate > 0.8:
                min_gap = 1.0   # Slow-medium
            else:
                min_gap = 2.0   # Drones / ambient / slow swells

            # Set threshold based on RMS distribution
            mean_rms = np.mean(rms)
            std_rms = np.std(rms)
            threshold = mean_rms + 0.8 * std_rms
            # Clamp threshold to reasonable range
            threshold = max(0.12 * max_rms, min(threshold, 0.60 * max_rms))

            # Detect peaks
            events = []
            last_trigger_bin = -9999
            min_gap_bins = int(min_gap / bin_duration)

            for i in range(1, num_bins - 1):
                val = rms[i]
                if val >= threshold and val >= rms[i-1] and val >= rms[i+1]:
                    if i - last_trigger_bin >= min_gap_bins:
                        # Peak detected!
                        time_sec = round(i * bin_duration, 2)
                        
                        # Determine trigger type
                        rise = val - rms[i-1]
                        if rise >= 0.35 * max_rms:
                            ttype = "アタック"
                        elif dominant_motion == "うねり":
                            ttype = "うねり"
                        elif dominant_motion == "刻み":
                            ttype = "刻み"
                        else:
                            ttype = "刻み" if val >= mean_rms + 1.2 * std_rms else "うねり"

                        # Pick onomatopoeia matching trigger type if possible, or random from vocab
                        # For simple and clean implementation, select randomly from vocab
                        selected_onoma = vocab[len(events) % len(vocab)]

                        events.append({
                            "time_sec": time_sec,
                            "type": ttype,
                            "strength": round(float(val / max_rms), 2),
                            "onomatopoeia": selected_onoma
                        })
                        last_trigger_bin = i

            # Cap the number of triggers to avoid overwhelming the visualization
            # (e.g., max 60 triggers for fast tracks, 30 for slow tracks)
            max_triggers = 60 if onset_rate > 2.0 else 30
            if len(events) > max_triggers:
                # Keep the strongest events, but sort them by time
                events = sorted(events, key=lambda e: e["strength"], reverse=True)[:max_triggers]
                events = sorted(events, key=lambda e: e["time_sec"])

            # Recalculate statistics for triggers
            tcount = {"アタック": 0, "うねり": 0, "刻み": 0}
            for e in events:
                tcount[e["type"]] += 1

            # Update track data
            track["triggers"]["count_total"] = len(events)
            track["triggers"]["count_shown"] = len(events)
            track["triggers"]["by_type"] = tcount
            track["triggers"]["events"] = events

            print(f"  Processed {file_id}: onset_rate={onset_rate:.2f} -> set min_gap={min_gap}s, generated {len(events)} triggers.")
            updated_count += 1

        except Exception as e:
            print(f"[error] Failed to process {file_id}: {e}")

    # Write updated metadata back to disk
    with open(METADATA_PATH, "w", encoding="utf-8") as f:
        json.dump(metadata, f, ensure_ascii=False, indent=2)

    print(f"\n[success] Successfully updated {updated_count}/{len(metadata)} tracks in {METADATA_PATH}.")

if __name__ == "__main__":
    main()
