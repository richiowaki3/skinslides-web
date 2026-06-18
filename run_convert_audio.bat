@echo off
:: run_convert_audio.bat
:: Runs the audio conversion shell script in a Docker container.
:: MUST BE 100% ASCII ENGLISH TO PREVENT WINDOWS MOJIBAKE.

echo ====================================================
echo  Skinslides Audio Conversion Launcher
echo ====================================================
echo Starting docker container python:3.10-bullseye...
echo Mounting D:\Antigravity_Work to /mnt/d/Antigravity_Work

docker run --rm ^
  -v D:\Antigravity_Work:/mnt/d/Antigravity_Work ^
  -w /mnt/d/Antigravity_Work ^
  python:3.10-bullseye /bin/bash /mnt/d/Antigravity_Work/convert_audio.sh

echo ====================================================
echo  Process Finished. Please check D:\Antigravity_Work\converted_mp3s
echo ====================================================
pause
