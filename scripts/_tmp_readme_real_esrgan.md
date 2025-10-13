This file is a small helper created by the assistant during editing. It documents the fallback flow implemented in `video_enhance.js`.

Fallback flow summary:

1. Try direct Real-ESRGAN video processing:
   realesrgan -i absolute_input.mp4 -o output_name.mp4 -n model -s scale -f mp4
2. If stderr contains "invalid outputpath" (or code non-zero), fallback to frame-level processing:
   a) Extract audio: ffmpeg -i input.mp4 -vn -acodec copy audio.aac
   b) Extract frames: ffmpeg -i input.mp4 tmp/frames/frame_%06d.png
   c) For each frame: realesrgan -i frame.png -o enhanced.png -n model -s scale -f png
   d) Reassemble frames: ffmpeg -r <fps> -i enhanced/frame_%06d.png -c:v libx264 -pix_fmt yuv420p -preset veryfast -crf 18 video_noaudio.mp4
   e) Merge audio: ffmpeg -i video_noaudio.mp4 -i audio.aac -c:v copy -c:a aac -b:a 192k -shortest final_output.mp4

Notes:
- Requires ffmpeg & ffprobe in PATH
- Requires realesrgan-ncnn-vulkan.exe in the path specified in config or project 'real' folder
- This fallback is slower but avoids Windows path parsing bugs in Real-ESRGAN video mode.
