const yaml = require('js-yaml');
const fs = require('fs-extra');
const path = require('path');
const ProgressBar = require('progress');
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
// 音频长度控制参数
const minAudioDuration = config.minAudioDuration || 30;  // 最小音频时长(秒)
const maxAudioDuration = config.maxAudioDuration || 180; // 最大音频时长(秒)

// 获取音频文件列表
function getMusicFiles() {
  return fs.readdirSync(musicDir).filter(f => /\.(aac|mp3|wav|m4a)$/i.test(f)).sort();
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
    await new Promise((resolve, reject) => {
      const args = [
        '-i', finalVideo,
        '-filter:v', `setpts=${(1/vRate).toFixed(6)}*PTS`,
        '-an',
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
  await new Promise((resolve, reject) => {
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

    // 合成音视频参数统一用libx264+aac
    let args;
    args = [
      '-i', normalizedVideoPath,
      '-i', normalizedAudioPath,
      '-c:v', 'libx264',
      '-c:a', 'aac',
      '-strict', '-2',
      '-shortest',
      '-y',
      normalizedOutPath
    ];
    // console.log('使用简单合成模式（不调整速率）');

    // console.log('FFmpeg命令:', args.join(' '));

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

  await new Promise((resolve, reject) => {
    // 检查输入文件是否存在
    if (!fs.existsSync(tempOut)) {
      reject(new Error(`输入文件不存在: ${tempOut}`));
      return;
    }

    // 确保路径使用正斜杠
    const normalizedTempOut = tempOut.replace(/\\/g, '/');
    const normalizedTempCutted = tempCutted.replace(/\\/g, '/');

    // 裁剪步骤参数统一用libx264+aac
    const args = [
      '-i', normalizedTempOut,
      '-t', audioDuration.toString(),
      '-c:v', 'libx264',
      '-c:a', 'aac',
      '-strict', '-2',
      '-y', normalizedTempCutted
    ];

    // console.log('裁剪FFmpeg命令:', args.join(' '));

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

  await new Promise((resolve, reject) => {
    // 检查临时文件是否存在
    if (!fs.existsSync(tempCutted)) {
      reject(new Error(`临时文件不存在: ${tempCutted}`));
      return;
    }

    // 确保路径使用正斜杠
    const normalizedTempCutted = tempCutted.replace(/\\/g, '/');
    const normalizedOutPath = outPath.replace(/\\/g, '/');

    // 封装修正步骤参数统一用libx264+aac
    const args = [
      '-i', normalizedTempCutted,
      '-c:v', 'libx264',
      '-c:a', 'aac',
      '-strict', '-2',
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
  const logPath = path.join(batchDir, 'batch_log.txt');
  function logToFile(...args) {
    const msg = args.map(x => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ');
    fs.appendFileSync(logPath, `[${new Date().toLocaleString()}] ${msg}\n`);
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
  if (openFiles.length > 0) {
    const base = Math.floor(numNewVideos / openFiles.length);
    let remain = numNewVideos % openFiles.length;
    for (let i = 0; i < openFiles.length; i++) {
      for (let j = 0; j < base; j++) openAssign.push(openFiles[i]);
      if (remain > 0) { openAssign.push(openFiles[i]); remain--; }
    }
    // 打乱开头分配顺序
    for (let i = openAssign.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [openAssign[i], openAssign[j]] = [openAssign[j], openAssign[i]];
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
    // 1. 选音频：确保音频时长在指定范围内
    let audioPath = null;
    let audioDuration = 0;
    let validAudioFound = false;
    let audioAttempts = 0;
    const maxAudioAttempts = musicFiles.length; // 最大尝试次数为音频文件总数

    while (!validAudioFound && audioAttempts < maxAudioAttempts) {
      const audioIdx = (musicStartIdx + successCount + audioAttempts) % musicFiles.length;
      audioPath = path.join(musicDir, musicFiles[audioIdx]);

      // 检查音频文件是否存在
      if (!fs.existsSync(audioPath)) {
        console.error(`音频文件不存在: ${audioPath}`);
        logToFile(`音频文件不存在: ${audioPath}`);
        audioAttempts++;
        continue;
      }

      audioDuration = await getAudioDuration(audioPath);
      
      // 检查音频时长是否在有效范围内
      if (audioDuration >= minAudioDuration && audioDuration <= maxAudioDuration) {
        validAudioFound = true;
        console.log(`正在生成第${successCount + 1}个视频，使用音频: ${musicFiles[audioIdx]}，时长: ${audioDuration.toFixed(2)}s`);
        logToFile(`正在生成第${successCount + 1}个视频，使用音频: ${musicFiles[audioIdx]}，时长: ${audioDuration.toFixed(2)}s`);
      } else {
        console.log(`音频 ${musicFiles[audioIdx]} 时长 ${audioDuration.toFixed(2)}s 不在范围内 [${minAudioDuration}s-${maxAudioDuration}s]，尝试下一个`);
        logToFile(`音频 ${musicFiles[audioIdx]} 时长 ${audioDuration.toFixed(2)}s 不在范围内 [${minAudioDuration}s-${maxAudioDuration}s]，尝试下一个`);
        audioAttempts++;
      }
    }

    if (!validAudioFound) {
      console.error(`未找到符合时长要求的音频文件，跳过当前视频生成`);
      logToFile(`未找到符合时长要求的音频文件，跳过当前视频生成`);
      successCount++;
      continue;
    }
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
    if (openAssign.length > 0) {
      selectedClips = [openAssign[successCount]].concat(selectedClips);
    }
    // 生成本视频的片段标识数组
    const idList = selectedClips.map(f => {
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
    // 统计当前 batchDir 下已存在的同前缀同日期视频数量，编号递增
    let existCount = 0;
    if (fs.existsSync(batchDir)) {
      const existFiles = fs.readdirSync(batchDir).filter(f => f.startsWith(`${videoNamePrefix}${dateStr}_`) && f.endsWith('.mp4'));
      existCount = existFiles.length;
    }
    const videoIdx = existCount + 1;
    const outFileName = `${videoNamePrefix}${dateStr}_${videoIdx}.mp4`;
    const outPath = path.join(batchDir, outFileName);
    // 先用临时名合成
    const tempOutName = `${videoNamePrefix}${dateStr}_temp_${videoIdx}.mp4`;
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
  // 输出到 js 文件（对象格式）
  const jsOut = `// 每个视频的片段标识\nconst videoIds = ${JSON.stringify(allVideoIdsObj, null, 2)};\nmodule.exports = { videoIds }\n`;
  fs.writeFileSync(path.join(batchDir, 'video_ids.js'), jsOut);
  console.log(`全部合成完成，片段标识已输出到 ${batchDir}/video_ids.js`);
  logToFile(`全部合成完成，片段标识已输出到 ${batchDir}/video_ids.js`);
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

composeVideosWithOpen();