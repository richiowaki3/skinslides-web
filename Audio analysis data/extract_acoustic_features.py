#!/usr/bin/env python3
"""
Skinslides Acoustic Physics Feature Extractor (Time-Series, Percentiles, & F0 Tracker)
Processes Yoshihide Otomo's abstract soundscapes to extract physical texture indicators
using pure NumPy and soundfile (no librosa installation/compilation required).
"""

import os
import sys
import json
import argparse
import numpy as np
import soundfile as sf

def estimate_f0(frame, sr):
    """
    Estimates the fundamental frequency (F0) of a frame using Autocorrelation Method (ACM).
    Restricted to standard human pitch range (50Hz to 1000Hz).
    """
    n = len(frame)
    # Zero-center the frame
    x = frame - np.mean(frame)
    if np.max(np.abs(x)) < 1e-4:
        return 0.0
        
    # Compute Autocorrelation
    r = np.correlate(x, x, mode='full')[n-1:]
    
    # Define lag search range
    min_lag = int(sr / 1000.0)
    max_lag = int(sr / 50.0)
    max_lag = min(max_lag, n - 1)
    
    if min_lag >= max_lag:
        return 0.0
        
    # Search for peak in autocorrelation
    r_search = r[min_lag:max_lag]
    if len(r_search) == 0:
        return 0.0
        
    peak_idx = np.argmax(r_search) + min_lag
    
    # Check peak prominence (voicing threshold)
    if r[peak_idx] > 0.25 * r[0]:
        return float(sr / peak_idx)
    return 0.0

def analyze_frames(frames, sr):
    """
    Computes acoustic features for a 2D array of audio frames (num_frames, window_size).
    """
    num_frames, window_size = frames.shape
    hop_size = 512
    
    # 1. RMS (Intensity / Volume Pressure)
    rms = np.sqrt(np.mean(frames**2, axis=1))
    
    # 2. ZCR (Zero Crossing Rate / Friction)
    signs = np.sign(frames)
    sign_changes = np.diff(signs, axis=1) != 0
    zcr = np.mean(sign_changes, axis=1) / 2.0
    
    # 3. Spectral Analysis via FFT (Hann window applied)
    window = np.hanning(window_size)
    windowed_frames = frames * window
    stft = np.fft.rfft(windowed_frames, axis=1)
    magnitude = np.abs(stft)
    freqs = np.fft.rfftfreq(window_size, d=1.0/sr)
    
    mag_sum = np.sum(magnitude, axis=1)
    mag_sum_safe = np.where(mag_sum == 0, 1e-20, mag_sum)
    
    # Spectral Centroid (Gravity / Muffled vs Sharp)
    centroid = np.sum(freqs[None, :] * magnitude, axis=1) / mag_sum_safe
    
    # Spectral Bandwidth (Spread / Thickness)
    diff_sq = (freqs[None, :] - centroid[:, None])**2
    bandwidth = np.sqrt(np.sum(diff_sq * magnitude, axis=1) / mag_sum_safe)
    
    # Spectral Rolloff (High frequency boundary)
    cum_sum = np.cumsum(magnitude, axis=1)
    total_energy = cum_sum[:, -1]
    threshold = 0.85 * total_energy
    
    rolloff = []
    for i in range(num_frames):
        idx = np.searchsorted(cum_sum[i], threshold[i])
        rolloff.append(freqs[idx])
    rolloff = np.array(rolloff)
    
    # Spectral Flatness (Noise-like vs Tonal)
    power = magnitude ** 2
    power_safe = np.where(power == 0, 1e-20, power)
    geometric_mean = np.exp(np.mean(np.log(power_safe), axis=1))
    arithmetic_mean = np.mean(power, axis=1)
    arithmetic_mean_safe = np.where(arithmetic_mean == 0, 1e-20, arithmetic_mean)
    flatness = geometric_mean / arithmetic_mean_safe
    
    # 4. Onsets (Spectral Flux for attack count)
    log_mag = np.log1p(1000.0 * magnitude)
    diff = np.diff(log_mag, axis=0)
    onset_env = np.maximum(0, diff)
    onset_envelope = np.mean(onset_env, axis=1)
    onset_envelope = np.pad(onset_envelope, (1, 0), mode='edge')
    
    # 5. F0 (Pitch) Tracking
    # Optimize: only track pitch on voiced frames (rms > noise floor)
    f0 = []
    for idx in range(num_frames):
        if rms[idx] > 0.005:  # Absolute noise floor threshold
            f0.append(estimate_f0(frames[idx], sr))
        else:
            f0.append(0.0)
    f0 = np.array(f0)
    
    return {
        "rms": rms,
        "zcr": zcr,
        "centroid": centroid,
        "bandwidth": bandwidth,
        "rolloff": rolloff,
        "flatness": flatness,
        "onset_envelope": onset_envelope,
        "f0": f0
    }

def process_audio_file(file_path, chunk_duration_sec=60, resolution_sec=1.0):
    """
    Processes a single audio file in a memory-safe chunked manner, returning both
    aggregated statistical indicators (including percentiles) and a detailed time-series.
    """
    try:
        info = sf.info(file_path)
        sr = info.samplerate
        total_duration = info.duration
        channels = info.channels
        
        if total_duration <= 0:
            return None, "File duration is zero or invalid"
            
        chunk_samples = int(sr * chunk_duration_sec)
        window_size = 2048
        hop_size = 512
        
        # Frame rate of the STFT
        frames_per_sec = sr / float(hop_size)
        frames_per_bin = int(frames_per_sec * resolution_sec)
        if frames_per_bin < 1:
            frames_per_bin = 1
            
        # Collect raw frame-level parameters
        all_rms = []
        all_zcr = []
        all_centroid = []
        all_bandwidth = []
        all_rolloff = []
        all_flatness = []
        all_onset_env = []
        all_f0 = []
        
        for block in sf.blocks(file_path, blocksize=chunk_samples, dtype='float32'):
            # Convert to mono if multichannel
            if len(block.shape) > 1:
                y = np.mean(block, axis=1)
            else:
                y = block
                
            n_samples = len(y)
            if n_samples < window_size:
                continue
                
            # Create frames
            frames = np.lib.stride_tricks.sliding_window_view(y, window_shape=window_size)[::hop_size]
            
            res = analyze_frames(frames, sr)
            all_rms.extend(res["rms"])
            all_zcr.extend(res["zcr"])
            all_centroid.extend(res["centroid"])
            all_bandwidth.extend(res["bandwidth"])
            all_rolloff.extend(res["rolloff"])
            all_flatness.extend(res["flatness"])
            all_onset_env.extend(res["onset_envelope"])
            all_f0.extend(res["f0"])
            
        if not all_rms:
            return None, "No audio frames could be processed"
            
        # Convert to numpy arrays
        all_rms = np.array(all_rms)
        all_zcr = np.array(all_zcr)
        all_centroid = np.array(all_centroid)
        all_bandwidth = np.array(all_bandwidth)
        all_rolloff = np.array(all_rolloff)
        all_flatness = np.array(all_flatness)
        all_onset_env = np.array(all_onset_env)
        all_f0 = np.array(all_f0)
        
        total_frames = len(all_rms)
        
        # 1. Onset Peak Detection (Dynamic thresholding)
        onset_peaks = []
        if total_frames > 2:
            threshold_val = np.mean(all_onset_env) + 1.0 * np.std(all_onset_env)
            for t in range(1, total_frames - 1):
                if (all_onset_env[t] > all_onset_env[t-1] and 
                    all_onset_env[t] > all_onset_env[t+1] and 
                    all_onset_env[t] > threshold_val):
                    onset_peaks.append(t)
                    
        peak_set = set(onset_peaks)
        
        # 2. Group frames into time-series intervals (e.g. 1-second bins)
        time_series = []
        num_bins = int(np.ceil(total_frames / frames_per_bin))
        
        for b in range(num_bins):
            start_f = b * frames_per_bin
            end_f = min(start_f + frames_per_bin, total_frames)
            if start_f >= end_f:
                break
                
            bin_rms = all_rms[start_f:end_f]
            bin_zcr = all_zcr[start_f:end_f]
            bin_centroid = all_centroid[start_f:end_f]
            bin_bandwidth = all_bandwidth[start_f:end_f]
            bin_rolloff = all_rolloff[start_f:end_f]
            bin_flatness = all_flatness[start_f:end_f]
            bin_f0 = all_f0[start_f:end_f]
            
            # Count onset peaks in this bin
            bin_onsets = sum(1 for f in range(start_f, end_f) if f in peak_set)
            
            # Voiced F0 average for the bin (exclude 0.0)
            voiced_bin_f0 = bin_f0[bin_f0 > 0.0]
            avg_bin_f0 = float(np.mean(voiced_bin_f0)) if len(voiced_bin_f0) > 0 else 0.0
            
            time_series.append({
                "time_sec": round(b * resolution_sec, 2),
                "rms_intensity": round(float(np.mean(bin_rms)), 4),
                "spectral_centroid": round(float(np.mean(bin_centroid)), 2),
                "spectral_rolloff": round(float(np.mean(bin_rolloff)), 2),
                "spectral_bandwidth": round(float(np.mean(bin_bandwidth)), 2),
                "spectral_flatness": round(float(np.mean(bin_flatness)), 4),
                "zero_crossing_rate": round(float(np.mean(bin_zcr)), 4),
                "f0": round(avg_bin_f0, 1),
                "onset_count": bin_onsets
            })
            
        # 3. Overall statistics with percentiles
        onset_rate = len(onset_peaks) / total_duration
        avg_onset_strength = float(np.mean(all_onset_env))
        
        # Voiced F0 mean (excluding 0.0)
        voiced_f0s = all_f0[all_f0 > 0.0]
        avg_f0 = float(np.mean(voiced_f0s)) if len(voiced_f0s) > 0 else 0.0
        
        def get_stats(arr):
            if len(arr) == 0:
                return {"mean": 0.0, "max": 0.0, "min": 0.0, "std": 0.0, "p10": 0.0, "p50": 0.0, "p90": 0.0, "p95": 0.0}
            p10, p50, p90, p95 = np.percentile(arr, [10, 50, 90, 95])
            return {
                "mean": round(float(np.mean(arr)), 4),
                "max": round(float(np.max(arr)), 4),
                "min": round(float(np.min(arr)), 4),
                "std": round(float(np.std(arr)), 4),
                "p10": round(float(p10), 4),
                "p50": round(float(p50), 4),
                "p90": round(float(p90), 4),
                "p95": round(float(p95), 4)
            }
            
        # Compiling final dict
        result = {
            "file_id": os.path.basename(file_path),
            "metadata": {
                "duration_sec": round(total_duration, 2),
                "sample_rate": sr,
                "channels": channels
            },
            # Backward-compatible and updated acoustic_physics
            "acoustic_physics": {
                "rms_intensity": round(float(np.mean(all_rms)), 4),
                "spectral_centroid": round(float(np.mean(all_centroid)), 2),
                "spectral_rolloff": round(float(np.mean(all_rolloff)), 2),
                "spectral_bandwidth": round(float(np.mean(all_bandwidth)), 2),
                "spectral_flatness": round(float(np.mean(all_flatness)), 4),
                "zero_crossing_rate": round(float(np.mean(all_zcr)), 4),
                "onset_rate_per_sec": round(onset_rate, 4),
                "onset_count": len(onset_peaks),
                "onset_strength": round(avg_onset_strength, 4),
                "f0": round(avg_f0, 1)
            },
            # Statistics block with percentiles
            "statistics": {
                "rms_intensity": get_stats(all_rms),
                "spectral_centroid": get_stats(all_centroid),
                "spectral_rolloff": get_stats(all_rolloff),
                "spectral_bandwidth": get_stats(all_bandwidth),
                "spectral_flatness": get_stats(all_flatness),
                "zero_crossing_rate": get_stats(all_zcr),
                # Dynamic distribution of onset envelopes to pick out transients
                "onset_envelope": get_stats(all_onset_env),
                # Fundamental frequency distribution (voiced frames only)
                "f0": get_stats(voiced_f0s)
            },
            "time_series_1s": time_series
        }
        return result, None
        
    except Exception as e:
        return None, str(e)

def main():
    if sys.platform.startswith('win'):
        default_input_dir = r"Z:\skinslides_soul\10.0.0.1\skinslides_src\sound\otomo"
    else:
        default_input_dir = "/mnt/z/skinslides_soul/10.0.0.1/skinslides_src/sound/otomo"
        
    parser = argparse.ArgumentParser(description="Extract physical texture features & time-series from skinslides audio.")
    parser.add_argument('--input_dir', type=str, default=default_input_dir,
                        help=f"Directory containing audio files (default: {default_input_dir})")
    parser.add_argument('--output', type=str, default="acoustic_features.json",
                        help="Path to output JSON file (default: acoustic_features.json)")
    parser.add_argument('--chunk_size', type=int, default=60,
                        help="Chunk size in seconds for processing (default: 60)")
    parser.add_argument('--resolution', type=float, default=1.0,
                        help="Time-series bin resolution in seconds (default: 1.0)")
    args = parser.parse_args()
    
    input_dir = args.input_dir
    output_file = args.output
    chunk_size = args.chunk_size
    resolution = args.resolution
    
    # Resolve relative dot path
    if input_dir == ".":
        input_dir = os.getcwd()
        
    print(f"Checking input directory: {input_dir}")
    if not os.path.exists(input_dir):
        print(f"Error: Input directory does not exist: {input_dir}")
        sys.exit(1)
        
    valid_extensions = ('.aif', '.aiff', '.siff', '.wav', '.mp3')
    all_files = os.listdir(input_dir)
    audio_files = [f for f in all_files if f.lower().endswith(valid_extensions) and not f.startswith('._')]
    
    if not audio_files:
        print(f"No audio files found with extensions {valid_extensions} in {input_dir}")
        sys.exit(1)
        
    print(f"Found {len(audio_files)} audio files to process.")
    
    results = []
    for idx, filename in enumerate(audio_files, 1):
        file_path = os.path.join(input_dir, filename)
        print(f"[{idx}/{len(audio_files)}] Processing {filename} ({resolution}s time-series)...")
        
        features, error = process_audio_file(file_path, chunk_duration_sec=chunk_size, resolution_sec=resolution)
        if error:
            print(f"  Warning: Failed to process {filename}: {error}")
            continue
            
        results.append(features)
        print(f"  Success: duration={features['metadata']['duration_sec']}s, bins={len(features['time_series_1s'])}")
        
    try:
        with open(output_file, 'w', encoding='utf-8') as f:
            json.dump(results, f, indent=4, ensure_ascii=False)
        print(f"\nAnalysis completed successfully. Output saved to: {output_file}")
    except Exception as e:
        print(f"Error writing output JSON file: {e}")
        sys.exit(1)

if __name__ == '__main__':
    main()
