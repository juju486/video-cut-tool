@echo off
REM 1. 分离音频
node scripts/extract_audio.js

REM 2. 分割视频
node scripts/video_split.js

REM 3. 合成视频
node scripts/video_concat.js

pause 