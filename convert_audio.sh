#!/bin/bash
# skinslides audio conversion script
# Converts AIFF files in skinslides_soul to web-friendly MP3 (192kbps) inside Docker.
# Output is saved to /mnt/d/Antigravity_Work/converted_mp3s

echo "=== skinslides Audio Conversion (AIFF -> MP3) ==="
apt-get update -qq && apt-get install -y -qq ffmpeg > /dev/null 2>&1
if [ $? -ne 0 ]; then
  echo "[ERROR] Failed to install ffmpeg inside Docker container."
  exit 1
fi
echo "[INFO] ffmpeg installed successfully."

SRC_DIR="/mnt/d/Antigravity_Work/skinslides_soul/10.0.0.1/skinslides_src/sound/otomo"
OUT_DIR="/mnt/d/Antigravity_Work/converted_mp3s"

if [ ! -d "$SRC_DIR" ]; then
  echo "[ERROR] Source directory does not exist: $SRC_DIR"
  exit 1
fi

mkdir -p "$OUT_DIR"
echo "[INFO] Output directory created: $OUT_DIR"

cd "$SRC_DIR"
echo "[INFO] Processing AIFF files..."
for f in *.aif *.aiff; do
  [ -e "$f" ] || continue
  
  fname=$(basename "$f")
  outname="${fname%.*}.mp3"
  
  echo "Converting: $fname -> $outname"
  ffmpeg -y -i "$f" -ab 192k -ar 44100 "$OUT_DIR/$outname" -loglevel error
done

echo "=== Conversion Completed ==="
