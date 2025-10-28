const yaml = require('js-yaml');
const fs = require('fs-extra');
const path = require('path');
const ProgressBar = require('./electron_progress'); // 使用我们自定义的Electron兼容进度条
const crypto = require('crypto');
const {
  concatClips,
  shuffle,
  getClipDuration
} = require('./video_utils');

// 读取配置
const config = yaml.load(fs.readFileSync(path.join(__dirname, '../config.yaml'), 'utf8'));
const clipsDir = path.join(__dirname, '../', config.clipsDir || 'clips');
const openDir = path.join(__dirname, '../', config.openDir || 'open');
const outputDir = path.join(__dirname, '../', config.outputDir || 'output');
const musicDir = path.join(__dirname, '../', config.musicDir || 'music');
const numNewVideos = config.numNewVideos || 3;

const minVideoRate = config.minVideoRate || 0.95;
const maxVideoRate = config.maxVideoRate || 1.05;
const minClipDuration = config.minClipDuration || 1.5;
const maxClipDuration = config.maxClipDuration || 30;
const maxAVDiff = config.maxAVDiff || 0.2;
const ffmpegTimeout = (config.ffmpegTimeout || 120) * 1000; // ms
const videoShorterAudioMaxDiff = config.videoShorterAudioMaxDiff || 2;
const videoLongerAudioMaxDiff = config.videoLongerAudioMaxDiff || 2;
const videoNamePrefix = config.videoNamePrefix || 'myvideo';
// 新增：openClipsCount配置项，用于指定从openDir中选择的开头片段数量
const openClipsCount = config.openClipsCount !== undefined ? config.openClipsCount : 1;
// 音频长度控制参数
const minAudioDuration = config.minAudioDuration || 30;  // 最小音频时长(秒)
const maxAudioDuration = config.maxAudioDuration || 180; // 最大音频时长(秒)
const enableAudioFilter = config.enableAudioFilter !== undefined ? config.enableAudioFilter : true;

// 新增：FFmpeg 编码与加速配置（支持 AMD/NVIDIA/CPU）
const ffmpegVideoCodec = config.ffmpegVideoCodec || 'libx264'; // 可选：libx264 | h264_nvenc | h264_amf
const ffmpegPreset = config.ffmpegPreset || 'veryfast';        // libx264 预设
const ffmpegThreads = Number.isFinite(config.ffmpegThreads) ? config.ffmpegThreads : 0; // 0 表示不显式设置
const ffmpegNvencPreset = config.ffmpegNvencPreset || 'p5';    // nvenc 预设（p1~p7）
const ffmpegAmfQuality = config.ffmpegAmfQuality || 'balanced';// amf 质量：speed|balanced|quality
const ffmpegCopyOnMux = config.ffmpegCopyOnMux !== undefined ? !!config.ffmpegCopyOnMux : true; // 合成时尽量复制视频流
const ffmpegRemuxCopy = config.ffmpegRemuxCopy !== undefined ? !!config.ffmpegRemuxCopy : true; // 封装/修正时复制

// 新增：最小分辨率自动放大配置读取（优先级：resizeMinWidth/resizeMinHeight > resize.minWidth/resize.minHeight > minWidth/minHeight）
const resizeMinWidth = config.resizeMinWidth || (config.resize && config.resize.minWidth) || config.minWidth || 0;
const resizeMinHeight = config.resizeMinHeight || (config.resize && config.resize.minHeight) || config.minHeight || 0;

// 编码器自动探测与回退（兼容旧版 ffmpeg）
let __resolvedCodec = null; // 'h264_amf' | 'h264_nvenc' | 'libx264'
async function detectAvailableCodec(preferred) {
  if (__resolvedCodec) return __resolvedCodec;
  const { spawn } = require('child_process');
  let out = '';
  try {
    const p = spawn('ffmpeg', ['-hide_banner', '-encoders'], { stdio: ['ignore', 'pipe', 'pipe'] });
    p.stdout.on('data', d => out += d.toString());
    p.stderr.on('data', d => out += d.toString());
    await new Promise(r => p.on('close', () => r()));
  } catch (_) {
    // 旧版可能不支持 -hide_banner，再试一次
    try {
      const p2 = require('child_process').spawn('ffmpeg', ['-encoders'], { stdio: ['ignore', 'pipe', 'pipe'] });
      p2.stdout.on('data', d => out += d.toString());
      p2.stderr.on('data', d => out += d.toString());
      await new Promise(r => p2.on('close', () => r()));
    } catch (e) {
      console.warn('无法列出 ffmpeg 编码器，将回退到 libx264');
      __resolvedCodec = 'libx264';
      return __resolvedCodec;
    }
  }
  const has = (name) => new RegExp(`\\b${name}\\b`, 'i').test(out);
  const pref = String(preferred || '').toLowerCase();
  const candidates = [];
  if (pref === 'h264_amf') {
    if (has('h264_amf')) __resolvedCodec = 'h264_amf';
    else if (has('h264_nvenc')) __resolvedCodec = 'h264_nvenc';
    else __resolvedCodec = 'libx264';
  } else if (pref === 'h264_nvenc') {
    if (has('h264_nvenc')) __resolvedCodec = 'h264_nvenc';
    else if (has('h264_amf')) __resolvedCodec = 'h264_amf';
    else __resolvedCodec = 'libx264';
  } else {
    if (has('libx264')) __resolvedCodec = 'libx264';
    else if (has('h264_amf')) __resolvedCodec = 'h264_amf';
    else if (has('h264_nvenc')) __resolvedCodec = 'h264_nvenc';
    else __resolvedCodec = 'libx264';
  }
  if (__resolvedCodec !== pref) {
    console.log(`编码器已回退：${pref} -> ${__resolvedCodec}`);
  } else {
    console.log(`使用编码器：${__resolvedCodec}`);
  }
  return __resolvedCodec;
}

async function buildVideoCodecArgs() {
  const codec = await detectAvailableCodec(ffmpegVideoCodec);
  const args = [];
  if (codec === 'h264_nvenc') {
    args.push('-c:v', 'h264_nvenc', '-preset', ffmpegNvencPreset);
  } else if (codec === 'h264_amf') {
    args.push('-c:v', 'h264_amf');
  } else {
    args.push('-c:v', 'libx264', '-preset', ffmpegPreset);
    if (ffmpegThreads && ffmpegThreads > 0) args.push('-threads', String(ffmpegThreads));
  }
  return args;
}

// 新增：获取视频宽高
async function getVideoDimensions(p) {
  return new Promise((resolve, reject) => {
    const { spawn } = require('child_process');
    const proc = spawn('ffprobe', [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=width,height',
      '-of', 'csv=p=0:s=x',
      p
    ]);
    let data = '';
    proc.stdout.on('data', d => data += d.toString());
    proc.on('close', () => {
      const m = data.trim().match(/(\d+)x(\d+)/);
      if (m) return resolve({ width: +m[1], height: +m[2] });
      resolve({ width: 0, height: 0 });
    });
    proc.on('error', reject);
  });
}

// 新增：向上取偶
function nextEven(n) { const x = Math.ceil(n); return x % 2 === 0 ? x : x + 1; }

// 新增：确保片段满足最小分辨率（仅放大，不缩小），返回可能的新路径；带缓存避免重复处理
const __resizeCache = new Map();
async function ensureMinResolution(clipPath, cacheRoot, minW, minH) {
   if (!minW || !minH) return clipPath;
   if (__resizeCache.has(clipPath)) return __resizeCache.get(clipPath);
   try {
     const { width, height } = await getVideoDimensions(clipPath);
     if (width >= minW && height >= minH) {
       __resizeCache.set(clipPath, clipPath);
       return clipPath; // 已满足
     }
     if (!width || !height) {
       __resizeCache.set(clipPath, clipPath);
       return clipPath;
     }
     const scale = Math.max(minW / width, minH / height);
     const outW = nextEven(width * scale);
     const outH = nextEven(height * scale);
    await fs.ensureDir(cacheRoot);
    const base = path.parse(clipPath).name; // 不改变 idList 使用
    const hash = crypto.createHash('sha1').update(path.resolve(clipPath)).digest('hex').slice(0, 8);
    const outPath = path.join(cacheRoot, `${base}_${hash}_${outW}x${outH}.mp4`);
     if (fs.existsSync(outPath)) { // 已有缓存
       __resizeCache.set(clipPath, outPath);
       return outPath;
     }
     await new Promise(async (resolve, reject) => {
       const args = [
         '-i', clipPath,
         '-vf', `scale=${outW}:${outH}:flags=lanczos`,
         '-an',
         ...(await buildVideoCodecArgs()),
         '-y', outPath
       ];
       const { spawn } = require('child_process');
       const ff = spawn('ffmpeg', args, { stdio: 'pipe' });
       let err = '';
       ff.stderr.on('data', d => { err += d.toString(); });
       ff.on('close', c => {
         if (c === 0) resolve(); else reject(new Error(err || 'ffmpeg resize error'));
       });
       ff.on('error', reject);
     });
     __resizeCache.set(clipPath, outPath);
     return outPath;
   } catch (e) {
     console.warn('自动放大失败，使用原片段:', path.basename(clipPath), e.message || e);
     __resizeCache.set(clipPath, clipPath);
     return clipPath;
   }
}

// 确定实际使用的音频目录
let actualMusicDir = musicDir;
if (enableAudioFilter) {
  actualMusicDir = path.join(musicDir, `${minAudioDuration}-${maxAudioDuration}`);
  console.log(`启用音频预筛选，使用音频目录: ${actualMusicDir}`);
} else {
  console.log(`未启用音频预筛选，使用原始音频目录: ${musicDir}`);
}

// 获取音频文件列表
function getMusicFiles() {
  // 检查实际音频目录是否存在
  if (!fs.existsSync(actualMusicDir)) {
    console.error(`音频目录不存在: ${actualMusicDir}`);
    if (enableAudioFilter) {
      console.error('请先运行 filter_audio.js 脚本筛选音频文件');
    }
    process.exit(1);
  }

  const files = fs.readdirSync(actualMusicDir).filter(f => /\.(aac|mp3|wav|m4a)$/i.test(f)).sort();
  if (files.length === 0) {
    console.error(`音频目录中没有找到音频文件: ${actualMusicDir}`);
    if (enableAudioFilter) {
      console.error('可能是筛选条件过于严格，没有符合条件的音频文件');
    }
    process.exit(1);
  }
  return files;
}

// 获取音频时长
async function getAudioDuration(filePath) {
  return new Promise((resolve, reject) => {
    const { spawn } = require('child_process');
    const ffprobe = spawn('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      filePath
    ]);
    let data = '';
    ffprobe.stdout.on('data', chunk => data += chunk);
    ffprobe.on('close', () => {
      resolve(parseFloat(data));
    });
    ffprobe.on('error', err => reject(err));
  });
}

// 合成视频并对齐音频
async function concatClipsWithAudio(clips, audioPath, outPath, outputDir, audioRate, videoRates, progressCb) {
  // 先拼接视频片段为一个临时视频
  progressCb && progressCb('[1/4] 正在拼接片段...');
  const tempVideo = path.join(outputDir, `temp_${Date.now()}.mp4`);
  await concatClips(clips, tempVideo, outputDir);
  // 如果需要裁剪最后一个片段
  let finalVideo = tempVideo;
  // 新增：调整视频速率
  if (videoRates && videoRates[0] !== 1.0) {
    const speededVideo = path.join(outputDir, `speeded_${Date.now()}.mp4`);
    const vRate = videoRates[0];
    await new Promise(async (resolve, reject) => {
      const codecArgs = await buildVideoCodecArgs();
      const args = [
        '-i', finalVideo,
        '-filter:v', `setpts=${(1/vRate).toFixed(6)}*PTS`,
        '-an',
        ...codecArgs,
        '-y',
        speededVideo
      ];
      const { spawn } = require('child_process');
      const ffmpeg = spawn('ffmpeg', args, { stdio: 'pipe' });
      let stderrData = '';
      ffmpeg.stderr.on('data', chunk => { stderrData += chunk.toString(); });
      ffmpeg.on('close', code => {
        if (code === 0) {
          resolve();
        } else {
          console.error('FFmpeg 变速错误输出:', stderrData);
          reject(new Error('ffmpeg speed error'));
        }
      });
      ffmpeg.on('error', err => reject(err));
    });
    fs.unlinkSync(finalVideo);
    finalVideo = speededVideo;
  }
  if (clips.cutLastTo) {
    // 裁剪最后一个片段
    progressCb && progressCb('[2/4] 正在裁剪最后片段...');
    const cutVideo = path.join(outputDir, `cut_${Date.now()}.mp4`);
    // 先获取所有片段时长
    let total = 0;
    for (let i = 0; i < clips.length - 1; i++) {
      total += await getClipDuration(clips[i]);
    }
    const lastStart = total;
    const lastLen = clips.cutLastTo;
    // 用ffmpeg裁剪最后一段
    await new Promise((resolve, reject) => {
      // 检查输入文件是否存在
      if (!fs.existsSync(finalVideo)) {
        reject(new Error(`临时视频文件不存在: ${finalVideo}`));
        return;
      }

      const args = [
        '-i', finalVideo,
        '-ss', lastStart.toString(),
        '-t', lastLen.toString(),
        '-c', 'copy',
        '-y', cutVideo
      ];
      const { spawn } = require('child_process');
      const ffmpeg = spawn('ffmpeg', args, { stdio: 'pipe' });

      let stderrData = '';
      ffmpeg.stderr.on('data', chunk => {
        stderrData += chunk.toString();
      });

      ffmpeg.on('close', code => {
        if (code === 0) {
          resolve();
        } else {
          console.error('FFmpeg 裁剪最后片段错误输出:', stderrData);
          reject(new Error(`ffmpeg error (code: ${code}): ${stderrData}`));
        }
      });

      ffmpeg.on('error', err => {
        console.error('FFmpeg 裁剪最后片段进程错误:', err);
        reject(err);
      });
    });
    finalVideo = cutVideo;
    fs.unlinkSync(tempVideo);
  }
  // 构造ffmpeg命令：调整音频速率、视频速率，合成输出
  progressCb && progressCb('[3/4] 正在合成音视频...');
  const tempOut = path.join(outputDir, `out_${Date.now()}.mp4`);
  await new Promise(async (resolve, reject) => {
    // 检查输入文件是否存在
    if (!fs.existsSync(finalVideo)) {
      reject(new Error(`视频文件不存在: ${finalVideo}`));
      return;
    }
    if (!fs.existsSync(audioPath)) {
      reject(new Error(`音频文件不存在: ${audioPath}`));
      return;
    }

    console.log(`合成音视频 - 输入视频: ${path.basename(finalVideo)}`);
    console.log(`合成音视频 - 输入音频: ${path.basename(audioPath)}`);
    console.log(`合成音视频 - 输出文件: ${path.basename(tempOut)}`);
    console.log(`合成音视频 - 音频速率: ${audioRate}, 视频速率: ${videoRates[0]}`);

    // 确保路径使用正斜杠
    const normalizedVideoPath = finalVideo.replace(/\\/g, '/');
    const normalizedAudioPath = audioPath.replace(/\\/g, '/');
    const normalizedOutPath = tempOut.replace(/\\/g, '/');

    // 合成音视频参数：尽量复制视频流，降低 CPU
    const videoCodecArgs = ffmpegCopyOnMux ? ['-c:v', 'copy'] : (await buildVideoCodecArgs());
    let args;
    args = [
      '-i', normalizedVideoPath,
      '-i', normalizedAudioPath,
      ...videoCodecArgs,
      '-c:a', 'aac',
      '-strict', '-2',
      '-shortest',
      '-y',
      normalizedOutPath
    ];

    const { spawn } = require('child_process');
    const ffmpeg = spawn('ffmpeg', args, { stdio: 'pipe' });
    console.log('ffmpeg 开始');

    // 添加超时机制
    const timeout = setTimeout(() => {
      console.error('FFmpeg 合成超时，强制终止进程');
      ffmpeg.kill('SIGKILL');
      // 清理本轮所有相关临时文件
      if (fs.existsSync(finalVideo)) {
        try { fs.unlinkSync(finalVideo); } catch (e) {}
      }
      if (fs.existsSync(tempVideo)) {
        try { fs.unlinkSync(tempVideo); } catch (e) {}
      }
      if (fs.existsSync(tempOut)) {
        try { fs.unlinkSync(tempOut); } catch (e) {}
      }
      reject(new Error('FFmpeg 合成超时'));
    }, ffmpegTimeout);

    let stderrData = '';
    let stdoutData = '';

    ffmpeg.stdout.on('data', chunk => {
      stdoutData += chunk.toString();
    });

    ffmpeg.stderr.on('data', chunk => {
      stderrData += chunk.toString();
      // 实时输出进度信息
      const lines = chunk.toString().split('\n');
      for (const line of lines) {
        if (line.includes('time=') && line.includes('bitrate=')) {
          process.stdout.write(`\r${line}`);
        }
      }
    });

    ffmpeg.on('close', code => {
      clearTimeout(timeout); // 清理超时定时器
      process.stdout.write('\n'); // 换行
      if (finalVideo !== tempVideo && fs.existsSync(finalVideo)) {
        try {
          fs.unlinkSync(finalVideo);
        } catch (e) {
          console.error('清理临时视频文件失败:', e.message);
        }
      }
      if (code === 0) {
        console.log('音视频合成成功');
        resolve();
      } else {
        console.error('FFmpeg 合成错误输出:', stderrData);
        console.error('FFmpeg 标准输出:', stdoutData);
        reject(new Error(`ffmpeg error (code: ${code}): ${stderrData}`));
      }
    });

    ffmpeg.on('error', err => {
      clearTimeout(timeout); // 清理超时定时器
      process.stdout.write('\n'); // 换行
      if (finalVideo !== tempVideo && fs.existsSync(finalVideo)) {
        try {
          fs.unlinkSync(finalVideo);
        } catch (e) {
          console.error('清理临时视频文件失败:', e.message);
        }
      }
      console.error('FFmpeg 合成进程错误:', err);
      reject(err);
    });
  });
  // 最后一步：用音频时长精确裁剪，防止卡帧
  progressCb && progressCb('[4/4] 正在裁剪并封装修正索引...');
  const audioDuration = await getAudioDuration(audioPath);
  const tempCutted = path.join(outputDir, `cutted_${Date.now()}.mp4`);

  console.log(`裁剪视频 - 音频时长: ${audioDuration.toFixed(2)}s`);
  console.log(`裁剪视频 - 输入文件: ${path.basename(tempOut)}`);
  console.log(`裁剪视频 - 输出文件: ${path.basename(tempCutted)}`);

  await new Promise(async (resolve, reject) => {
    // 检查输入文件是否存在
    if (!fs.existsSync(tempOut)) {
      reject(new Error(`输入文件不存在: ${tempOut}`));
      return;
    }

    // 确保路径使用正斜杠
    const normalizedTempOut = tempOut.replace(/\\/g, '/');
    const normalizedTempCutted = tempCutted.replace(/\\/g, '/');

    // 裁剪步骤：可选择复制或重编码（复制可能只到关键帧，更省 CPU）
    const cutCodecArgs = ffmpegRemuxCopy ? ['-c', 'copy'] : [ ...(await buildVideoCodecArgs()), '-c:a', 'aac' ];
    const args = [
      '-i', normalizedTempOut,
      '-t', audioDuration.toString(),
      ...cutCodecArgs,
      '-y', normalizedTempCutted
    ];

    const { spawn } = require('child_process');
    const ffmpeg = spawn('ffmpeg', args, { stdio: 'pipe' });

    console.log('裁剪开始');

    // 添加超时机制
    const timeout = setTimeout(() => {
      console.error('FFmpeg 裁剪超时，强制终止进程');
      ffmpeg.kill('SIGKILL');
      if (fs.existsSync(tempOut)) {
        try { fs.unlinkSync(tempOut); } catch (e) {}
      }
      if (fs.existsSync(tempCutted)) {
        try { fs.unlinkSync(tempCutted); } catch (e) {}
      }
      reject(new Error('FFmpeg 裁剪超时'));
    }, ffmpegTimeout);

    let stderrData = '';
    let stdoutData = '';

    ffmpeg.stdout.on('data', chunk => {
      stdoutData += chunk.toString();
    });

    ffmpeg.stderr.on('data', chunk => {
      stderrData += chunk.toString();
      // 实时输出进度信息
      const lines = chunk.toString().split('\n');
      for (const line of lines) {
        if (line.includes('time=') && line.includes('bitrate=')) {
          process.stdout.write(`\r${line}`);
        }
      }
    });

    ffmpeg.on('close', code => {
      clearTimeout(timeout); // 清理超时定时器
      process.stdout.write('\n'); // 换行
      if (fs.existsSync(tempOut)) {
        try {
          fs.unlinkSync(tempOut);
        } catch (e) {
          console.error('清理临时输出文件失败:', e.message);
        }
      }
      if (code === 0) {
        console.log('视频裁剪成功');
        resolve();
      } else {
        console.error('FFmpeg 裁剪错误输出:', stderrData);
        console.error('FFmpeg 标准输出:', stdoutData);
        reject(new Error(`ffmpeg error (code: ${code}): ${stderrData}`));
      }
    });

    ffmpeg.on('error', err => {
      clearTimeout(timeout); // 清理超时定时器
      process.stdout.write('\n'); // 换行
      if (fs.existsSync(tempOut)) {
        try {
          fs.unlinkSync(tempOut);
        } catch (e) {
          console.error('清理临时输出文件失败:', e.message);
        }
      }
      console.error('FFmpeg 裁剪进程错误:', err);
      reject(err);
    });
  });
  // 再次封装修正索引，彻底消除卡帧
  console.log(`封装修正 - 输入文件: ${path.basename(tempCutted)}`);
  console.log(`封装修正 - 输出文件: ${path.basename(outPath)}`);

  await new Promise(async (resolve, reject) => {
    // 检查临时文件是否存在
    if (!fs.existsSync(tempCutted)) {
      reject(new Error(`临时文件不存在: ${tempCutted}`));
      return;
    }

    // 确保路径使用正斜杠
    const normalizedTempCutted = tempCutted.replace(/\\/g, '/');
    const normalizedOutPath = outPath.replace(/\\/g, '/');

    // 封装修正：尽量复制以减少 CPU；如需要重编码可关闭开关
    const muxCodecArgs = ffmpegRemuxCopy ? ['-c', 'copy'] : [ ...(await buildVideoCodecArgs()), '-c:a', 'aac' ];
    const args = [
      '-i', normalizedTempCutted,
      ...muxCodecArgs,
      '-y', normalizedOutPath
    ];

    console.log('封装修正FFmpeg命令:', args.join(' '));

    const { spawn } = require('child_process');
    const ffmpeg = spawn('ffmpeg', args, { stdio: 'pipe' });

    // 添加超时机制
    const timeout = setTimeout(() => {
      console.error('FFmpeg 封装修正超时，强制终止进程');
      ffmpeg.kill('SIGKILL');
      if (fs.existsSync(tempCutted)) {
        try { fs.unlinkSync(tempCutted); } catch (e) {}
      }
      if (fs.existsSync(outPath)) {
        try { fs.unlinkSync(outPath); } catch (e) {}
      }
      reject(new Error('FFmpeg 封装修正超时'));
    }, ffmpegTimeout);

    let stderrData = '';
    let stdoutData = '';

    ffmpeg.stdout.on('data', chunk => {
      stdoutData += chunk.toString();
    });

    ffmpeg.stderr.on('data', chunk => {
      stderrData += chunk.toString();
      // 实时输出进度信息
      const lines = chunk.toString().split('\n');
      for (const line of lines) {
        if (line.includes('time=') && line.includes('bitrate=')) {
          process.stdout.write(`\r${line}`);
        }
      }
    });

    ffmpeg.on('close', code => {
      clearTimeout(timeout); // 清理超时定时器
      process.stdout.write('\n'); // 换行
      if (fs.existsSync(tempCutted)) {
        try {
          fs.unlinkSync(tempCutted);
        } catch (e) {
          console.error('清理临时裁剪文件失败:', e.message);
        }
      }
      if (code === 0) {
        console.log('视频封装修正成功');
        resolve();
      } else {
        console.error('FFmpeg 封装修正错误输出:', stderrData);
        console.error('FFmpeg 标准输出:', stdoutData);
        reject(new Error(`ffmpeg error (code: ${code}): ${stderrData}`));
      }
    });

    ffmpeg.on('error', err => {
      clearTimeout(timeout); // 清理超时定时器
      process.stdout.write('\n'); // 换行
      if (fs.existsSync(tempCutted)) {
        try {
          fs.unlinkSync(tempCutted);
        } catch (e) {
          console.error('清理临时裁剪文件失败:', e.message);
        }
      }
      console.error('FFmpeg 封装修正进程错误:', err);
      reject(err);
    });
  });
}

async function composeVideosWithOpen() {
  await fs.ensureDir(outputDir);
  // 生成本次批量的子文件夹名
  const now = new Date();
  const pad = n => n.toString().padStart(2, '0');
  const folderName = `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}`;
  const batchDir = path.join(outputDir, folderName);
  await fs.ensureDir(batchDir);
  const tempClipsDir = path.join(batchDir, 'temp_clips');
  await fs.ensureDir(tempClipsDir);
  // 日志文件路径和写入函数
  const logPath = path.join(batchDir, 'log.log');
  function logToFile(...args) {
    const msg = args.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
    fs.appendFileSync(logPath, `[${new Date().toLocaleString()}] ${msg}
`);
  }
  // 定义合成记录文件路径
  const synthesisLogPath = path.join(batchDir, 'synthesis_log.json');

  // 初始化记录文件（如果不存在）
  if (!fs.existsSync(synthesisLogPath)) {
    fs.writeFileSync(synthesisLogPath, JSON.stringify({}, null, 2));
  }

  // 每次合成成功后更新记录文件
  function updateSynthesisLog(videoName, clips, audio) {
    // 读取现有记录
    let logData = {};
    if (fs.existsSync(synthesisLogPath)) {
      try {
        logData = JSON.parse(fs.readFileSync(synthesisLogPath, 'utf8'));
      } catch (e) {
        console.error('读取合成记录文件失败:', e.message);
        logData = {};
      }
    }

    // 添加新记录
    logData[videoName] = {
      clips: clips,
      audio: audio,
      openDir: openDir,        // 添加开头片段文件夹路径
      clipsDir: clipsDir,      // 添加片段文件夹路径
      musicDir: musicDir,      // 添加音频文件夹路径
      timestamp: new Date().toISOString()
    };

    // 写入更新后的记录
    fs.writeFileSync(synthesisLogPath, JSON.stringify(logData, null, 2));
    console.log(`已更新合成记录: ${synthesisLogPath}`);
    logToFile(`已更新合成记录: ${synthesisLogPath}`);
  }

  // 记录所有视频的片段标识
  const allVideoIdsObj = {};
  let successCount = 0;
  let tryIndex = 0;
  let totalRetry = 0;
  // 记录每个视频合成耗时
  const videoTimes = [];
  // 进度条定义
  const concatBar = new ProgressBar('合成新视频进度 [:bar] :current/:total', { total: numNewVideos, width: 30 });
  const allClips = fs.readdirSync(clipsDir).filter(f => /\.mp4$/i.test(f)).map(f => path.join(clipsDir, f));
  const musicFiles = getMusicFiles();
  const openFiles = fs.existsSync(openDir)
    ? fs.readdirSync(openDir).filter(f => /\.mp4$/i.test(f)).map(f => path.join(openDir, f))
    : [];
  let openAssign = [];
  if (openFiles.length > 0 && openClipsCount > 0) {
    // 如果配置了openClipsCount且openDir中有文件，则为每个视频选择指定数量的开头片段
    for (let i = 0; i < numNewVideos; i++) {
      // 随机选择openClipsCount个开头片段
      const selectedOpenClips = [];
      for (let j = 0; j < openClipsCount; j++) {
        const randomIndex = Math.floor(Math.random() * openFiles.length);
        selectedOpenClips.push(openFiles[randomIndex]);
      }
      openAssign.push(selectedOpenClips);
    }
  }
  const usedOrders = new Set();
  // 音频轮换记忆文件
  const lastMusicIdxPath = path.join(outputDir, 'last_music_idx.json');
  let lastMusicIdx = 0;
  let lastInputDir = '';
  let lastMusicDir = '';
  if (fs.existsSync(lastMusicIdxPath)) {
    try {
      const lastData = JSON.parse(fs.readFileSync(lastMusicIdxPath, 'utf8'));
      lastInputDir = lastData.inputDir;
      lastMusicDir = lastData.musicDir;
      if (lastInputDir === config.inputDir && lastMusicDir === config.musicDir) {
        lastMusicIdx = (lastData.lastMusicIdx || 0) + 1;
      } else {
        lastMusicIdx = 0;
      }
    } catch (e) {
      lastMusicIdx = 0;
    }
  }
  let musicStartIdx = lastMusicIdx % musicFiles.length;
  while (successCount < numNewVideos) {
    const startTime = Date.now();
    concatBar.tick(); // 每次开始处理一个新视频就刷新进度条
    // 1. 选音频：从预筛选的音频目录中选择
    let audioPath = null;
    let audioDuration = 0;
    let audioIdx = 0;

    // 计算音频索引
    audioIdx = (musicStartIdx + successCount) % musicFiles.length;
    audioPath = path.join(actualMusicDir, musicFiles[audioIdx]);

    // 检查音频文件是否存在
    if (!fs.existsSync(audioPath)) {
      console.error(`音频文件不存在: ${audioPath}`);
      logToFile(`音频文件不存在: ${audioPath}`);
      successCount++;
      continue;
    }

    // 获取音频时长
    audioDuration = await getAudioDuration(audioPath);
    console.log(`正在生成第${successCount + 1}个视频，使用音频: ${musicFiles[audioIdx]}，时长: ${audioDuration.toFixed(2)}s`);
    logToFile(`正在生成第${successCount + 1}个视频，使用音频: ${musicFiles[audioIdx]}，时长: ${audioDuration.toFixed(2)}s`);
    // 2. 精确选片段
    let selectedClips = [], selectedDur = 0, order, videoRates;
    let tryCount = 0;
    let found = false;
    do {
      tryCount++;
      if (tryCount > 1) {
        console.log(`第${successCount + 1}个视频第${tryCount}次重试...`);
        logToFile(`第${successCount + 1}个视频第${tryCount}次重试...`);
        totalRetry++;
      }
      const idxs = shuffle([...Array(allClips.length).keys()]);
      let tmpClips = [];
      let tmpDur = 0;
      for (let idx of idxs) {
        const f = allClips[idx];
        const dur = await getClipDuration(f);
        if (dur < minClipDuration || dur > maxClipDuration) continue;
        if (tmpDur + dur > audioDuration + maxAVDiff) break;
        tmpClips.push(f);
        tmpDur += dur;
        if (tmpDur >= audioDuration) break;
      }
      // 判断片段总时长与音频时长关系
      let diff = tmpDur - audioDuration;
      console.log(`音频时长: ${audioDuration.toFixed(2)}s, 片段总时长: ${tmpDur.toFixed(2)}s, 差值: ${diff.toFixed(2)}s`);
      logToFile(`音频时长: ${audioDuration.toFixed(2)}s, 片段总时长: ${tmpDur.toFixed(2)}s, 差值: ${diff.toFixed(2)}s`);
      if (diff < -maxAVDiff) {
        if (Math.abs(diff) > videoShorterAudioMaxDiff) {
          console.log(`片段总时长小于音频，差值大于${videoShorterAudioMaxDiff}s，继续选片段...`);
          logToFile(`片段总时长小于音频，差值大于${videoShorterAudioMaxDiff}s，继续选片段...`);
          continue;
        } else {
          // 只允许调整视频速率
          let vRate = tmpDur / audioDuration;
          if (vRate >= minVideoRate && vRate <= maxVideoRate) {
            console.log(`片段总时长小于音频，差值小于${videoShorterAudioMaxDiff}s，调整视频速率为: ${vRate.toFixed(4)}`);
            logToFile(`片段总时长小于音频，差值小于${videoShorterAudioMaxDiff}s，调整视频速率为: ${vRate.toFixed(4)}`);
            videoRates = [vRate];
            found = true;
          }
        }
      } else if (diff > maxAVDiff) {
        if (diff > videoLongerAudioMaxDiff) {
          console.log(`片段总时长大于音频，差值大于${videoLongerAudioMaxDiff}s，重新选片段...`);
          logToFile(`片段总时长大于音频，差值大于${videoLongerAudioMaxDiff}s，重新选片段...`);
          continue;
        } else {
          // 差值小于videoLongerAudioMaxDiff，调整视频速率
          let vRate = audioDuration / tmpDur;
          if (vRate >= minVideoRate && vRate <= maxVideoRate) {
            console.log(`片段总时长大于音频，差值小于${videoLongerAudioMaxDiff}s，调整视频速率为: ${vRate.toFixed(4)}`);
            logToFile(`片段总时长大于音频，差值小于${videoLongerAudioMaxDiff}s，调整视频速率为: ${vRate.toFixed(4)}`);
            videoRates = [vRate];
            found = true;
          } else {
            // 只允许裁剪视频
            let lastClipDur = await getClipDuration(tmpClips[tmpClips.length - 1]);
            if (lastClipDur - diff >= minClipDuration) {
              console.log(`片段总时长大于音频，速率不在区间，裁剪最后片段，裁剪后时长: ${(lastClipDur - diff).toFixed(2)}s`);
              logToFile(`片段总时长大于音频，速率不在区间，裁剪最后片段，裁剪后时长: ${(lastClipDur - diff).toFixed(2)}s`);
              tmpClips.cutLastTo = lastClipDur - diff;
              videoRates = [1.0];
              found = true;
            }
          }
        }
      } else {
        console.log('片段总时长与音频时长差值在允许范围内，直接裁剪多余部分');
        logToFile('片段总时长与音频时长差值在允许范围内，直接裁剪多余部分');
        videoRates = [1.0];
        found = true;
      }
      if (found) {
        selectedClips = tmpClips;
        selectedDur = tmpDur;
        order = selectedClips.map(f => allClips.indexOf(f)).join(',');
      }
    } while ((!found || usedOrders.has(order)) && tryCount < 100);
    usedOrders.add(order);
    if (!selectedClips || selectedClips.length === 0) {
      if (tryCount >= 100) {
        console.log(`第${successCount + 1}个视频重试已达最大次数（100），跳过。`);
        logToFile(`第${successCount + 1}个视频重试已达最大次数（100），跳过。`);
      }
      console.log(`第${successCount + 1}个视频未能选出合适片段，已跳过。`);
      logToFile(`第${successCount + 1}个视频未能选出合适片段，已跳过。`);
      tryIndex++;
      continue;
    }
    // 添加open片段到selectedClips的开头
    if (openAssign.length > 0 && openAssign[successCount]) {
      // 如果openAssign[successCount]是数组（多个开头片段），则直接合并
      // 否则保持原有逻辑（单个开头片段）
      if (Array.isArray(openAssign[successCount])) {
        selectedClips = openAssign[successCount].concat(selectedClips);
      } else {
        selectedClips = [openAssign[successCount]].concat(selectedClips);
      }
    }
    // 新增：最小分辨率自动放大处理（保持 idList 基于原文件名）
    const originalForIds = selectedClips.slice();
    if (resizeMinWidth && resizeMinHeight) {
      const resizeCacheDir = path.join(clipsDir, '_resized_clips');
      for (let i = 0; i < selectedClips.length; i++) {
        const c = selectedClips[i];
        const rPath = await ensureMinResolution(c, resizeCacheDir, resizeMinWidth, resizeMinHeight);
        if (rPath !== c) {
          concatBar.interrupt(`第${successCount + 1}个视频 放大 ${path.basename(c)} -> ${path.basename(rPath)}`);
          selectedClips[i] = rPath;
        }
      }
    }
    // 生成本视频的片段标识数组（使用原始片段名，不受放大缓存命名影响）
    const idList = originalForIds.map(f => {
      const base = path.parse(path.basename(f)).name;
      if (/^[a-z]+_\d+$/.test(base)) return base;
      return base;
    });
    // 生成输出文件名：前缀+日期（年月日）+编号
    const now = new Date();
    const y = now.getFullYear();
    const m = (now.getMonth() + 1).toString().padStart(2, '0');
    const d = now.getDate().toString().padStart(2, '0');
    const dateStr = `${y}${m}${d}`;
    // 统计 outputDir 下当日已存在的同前缀最大序号，并结合状态文件生成下一序号（不因删除而回退）
    const videoIdx = fs.existsSync(outputDir)
      ? getNextVideoIndex(outputDir, videoNamePrefix, dateStr)
      : 1;
    const outFileName = `${videoNamePrefix}_${dateStr}_${videoIdx}.mp4`;
    const outPath = path.join(batchDir, outFileName);
    // 先用临时名合成
    const tempOutName = `${videoNamePrefix}_${dateStr}_temp_${videoIdx}.mp4`;
    const tempOutPath = path.join(batchDir, tempOutName);
    try {
      // 检查选中的片段文件
      console.log(`第${successCount + 1}个视频选中的片段:`, selectedClips.map(f => path.basename(f)));
      logToFile(`第${successCount + 1}个视频选中的片段:`, selectedClips.map(f => path.basename(f)));

      // 先尝试简单的拼接测试
      try {
        const testTempPath = path.join(batchDir, `test_${Date.now()}.mp4`);
        await concatClips(selectedClips, testTempPath, batchDir);
        console.log(`第${successCount + 1}个视频基础拼接测试成功`);
        logToFile(`第${successCount + 1}个视频基础拼接测试成功`);
        // 删除测试文件
        if (fs.existsSync(testTempPath)) {
          fs.unlinkSync(testTempPath);
        }
      } catch (testError) {
        console.error(`第${successCount + 1}个视频基础拼接测试失败:`, testError.message);
        logToFile(`第${successCount + 1}个视频基础拼接测试失败:`, testError.message);
        throw testError;
      }

      await concatClipsWithAudio(selectedClips, audioPath, tempOutPath, batchDir, 1.0, videoRates,
        msg => concatBar.interrupt(`第${successCount + 1}个视频 ${msg}`)
      );
      fs.renameSync(tempOutPath, outPath);
      // 成功后更新当日最大序号状态，防止后续因删除导致回退
      try { writeLastIndex(outputDir, videoNamePrefix, dateStr, videoIdx); } catch (_) {}
      const endTime = Date.now();
      const cost = ((endTime - startTime) / 1000).toFixed(2);
      videoTimes.push({
        index: successCount + 1,
        file: outFileName,
        time: cost
      });
      concatBar.interrupt(`第${successCount + 1}个视频合成完成: ${outFileName}，耗时${cost}秒`);
      logToFile(`第${successCount + 1}个视频合成完成: ${outFileName}，耗时${cost}秒`);
      // 记录到对象
      allVideoIdsObj[outFileName] = { ids: idList, music: musicFiles[audioIdx] };
      
      // 更新合成记录
      updateSynthesisLog(outFileName, idList, musicFiles[audioIdx]);
      
      successCount++;
    } catch (error) {
      console.error(`第${successCount + 1}个视频合成失败:`, error.message);
      logToFile(`第${successCount + 1}个视频合成失败:`, error.message);
      // 清理临时文件
      if (fs.existsSync(tempOutPath)) {
        try {
          fs.unlinkSync(tempOutPath);
        } catch (e) {
          console.error('清理临时文件失败:', e.message);
          logToFile('清理临时文件失败:', e.message);
        }
      }
      // 增加计数器，避免无限循环
      successCount++;
      // 如果失败次数过多，退出循环
      if (successCount >= numNewVideos * 2) {
        console.log('失败次数过多，停止处理');
        logToFile('失败次数过多，停止处理');
        break;
      }
    }
  }

// 输出到 js 文件（对象格式） - 保留原有功能
/*
const jsOut = `// 每个视频的片段标识
const videoIds = ${JSON.stringify(allVideoIdsObj, null, 2)};
module.exports = { videoIds }
`;
fs.writeFileSync(path.join(batchDir, 'video_ids.js'), jsOut);
console.log(`全部合成完成，片段标识已输出到 ${batchDir}/video_ids.js`);
logToFile(`全部合成完成，片段标识已输出到 ${batchDir}/video_ids.js`);
*/
  // 记录本轮最后一次用到的音频索引
  const newLastIdx = (musicStartIdx + successCount - 1 + musicFiles.length) % musicFiles.length;
  fs.writeFileSync(lastMusicIdxPath, JSON.stringify({
    inputDir: config.inputDir,
    musicDir: config.musicDir,
    lastMusicIdx: newLastIdx
  }, null, 2));

  // 删除output及子文件夹下所有以temp开头的临时视频
  function deleteTempFiles(dir) {
    const files = fs.readdirSync(dir);
    for (const file of files) {
      const fullPath = path.join(dir, file);
      if (fs.statSync(fullPath).isDirectory()) {
        deleteTempFiles(fullPath);
      } else if (/^temp.*\.mp4$/i.test(file)) {
        fs.unlinkSync(fullPath);
      }
    }
  }
  deleteTempFiles(outputDir);
  // 彻底删除本次批量的临时片段文件夹
  if (fs.existsSync(tempClipsDir)) {
    try {
      fs.removeSync(tempClipsDir);
      console.log('已清理本次批量的临时片段文件夹 temp_clips');
    } catch (e) {
      console.error('清理 temp_clips 文件夹失败:', e.message);
    }
  }

  if (totalRetry > 0) {
    console.log(`本次生成过程中发生了${totalRetry}次重试。`);
    logToFile(`本次生成过程中发生了${totalRetry}次重试。`);
  } else {
    console.log('本次生成未发生重试。');
    logToFile('本次生成未发生重试。');
  }

  // 输出所有视频合成耗时
  console.log('\n全部视频合成耗时统计:');
  logToFile('全部视频合成耗时统计:');
  if (videoTimes.length === 0) {
    console.log('无成功合成的视频。');
    logToFile('无成功合成的视频。');
  } else {
    videoTimes.forEach(v => {
      console.log(`第${v.index}个: ${v.file}，耗时${v.time}秒`);
      logToFile(`第${v.index}个: ${v.file}，耗时${v.time}秒`);
    });
  }
}

// 基于已存在文件的最大序号与持久化状态计算下一个序号，避免删除导致回退或复用
function getFileMaxVideoIndex(rootDir, prefix, dateStr) {
  let maxIdx = 0;
  const escape = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`^${escape(prefix)}_${dateStr}_(\\d+)\\.mp4$`, 'i');
  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        walk(full);
      } else if (ent.isFile()) {
        const m = ent.name.match(re);
        if (m) {
          const idx = parseInt(m[1], 10);
          if (Number.isFinite(idx) && idx > maxIdx) maxIdx = idx;
        }
      }
    }
  }
  if (fs.existsSync(rootDir)) walk(rootDir);
  return maxIdx;
}

function getLastIndexStatePath(rootDir) {
  return path.join(rootDir, 'last_video_index.json');
}

function readLastIndex(rootDir, prefix, dateStr) {
  const statePath = getLastIndexStatePath(rootDir);
  try {
    if (fs.existsSync(statePath)) {
      const data = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      const key = `${prefix}_${dateStr}`;
      const v = data[key];
      if (Number.isFinite(v)) return v;
    }
  } catch (_) {}
  return 0;
}

function writeLastIndex(rootDir, prefix, dateStr, idx) {
  const statePath = getLastIndexStatePath(rootDir);
  let data = {};
  try {
    if (fs.existsSync(statePath)) {
      data = JSON.parse(fs.readFileSync(statePath, 'utf8')) || {};
    }
  } catch (_) {}
  const key = `${prefix}_${dateStr}`;
  if (!Number.isFinite(data[key]) || idx > data[key]) {
    data[key] = idx;
    try { fs.writeFileSync(statePath, JSON.stringify(data, null, 2)); } catch (_) {}
  }
}

function getNextVideoIndex(rootDir, prefix, dateStr) {
  const fileMax = getFileMaxVideoIndex(rootDir, prefix, dateStr);
  const stateMax = readLastIndex(rootDir, prefix, dateStr);
  return Math.max(fileMax, stateMax) + 1;
}

composeVideosWithOpen();