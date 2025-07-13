const fs = require('fs-extra');
const path = require('path');
const { spawn } = require('child_process');
const ProgressBar = require('progress');
const { getAliasKey } = require('./alias_utils');

function getVideoFiles(dir) {
  return fs.readdirSync(dir).filter(f => /\.(mp4|mov|avi|mkv)$/i.test(f));
}

function getSceneChangeFrames(filePath, threshold = 0.4) {
  return new Promise((resolve, reject) => {
    const args = [
      '-i', filePath,
      '-filter_complex', `select='gt(scene,${threshold})',showinfo`,
      '-vsync', 'vfr',
      '-f', 'null',
      '-'
    ];
    const ffmpeg = spawn('ffmpeg', args);
    let stderr = '';
    ffmpeg.stderr.on('data', chunk => stderr += chunk.toString());
    ffmpeg.on('error', err => reject(err));
    ffmpeg.on('close', () => {
      const regex = /pts_time:([\d\.]+)/g;
      let match;
      const times = [];
      while ((match = regex.exec(stderr)) !== null) {
        times.push(parseFloat(match[1]));
      }
      if (times[0] !== 0) times.unshift(0);
      resolve(times);
    });
  });
}

function shuffle(arr) {
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}

async function getFps(filePath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-v', '0',
      '-of', 'csv=p=0',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=r_frame_rate',
      '-print_format', 'default',
      filePath
    ];
    const ffprobe = spawn('ffprobe', args);
    let data = '';
    ffprobe.stdout.on('data', chunk => data += chunk);
    ffprobe.on('error', err => reject(err));
    ffprobe.on('close', () => {
      // r_frame_rate 形如 30/1
      const match = data.match(/(\d+\/?\d*)/);
      let fps = 25;
      if (match) {
        const parts = match[1].split('/');
        fps = parts.length === 2 ? (parseFloat(parts[0]) / parseFloat(parts[1])) : parseFloat(parts[0]);
      }
      resolve(fps);
    });
  });
}

async function splitVideoToClips(filePath, sceneFrames, basename, clipsDir, progressCb) {
  const clips = [];
  for (let i = 0; i < sceneFrames.length - 1; i++) {
    const start = sceneFrames[i];
    const duration = sceneFrames[i + 1] - sceneFrames[i];
    const outPath = path.join(clipsDir, `clip_${basename}_${i}.mp4`);
    await new Promise((resolve, reject) => {
      const args = [
        '-ss', start.toString(),
        '-i', filePath,
        '-t', duration.toString(),
        '-an',
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-y',
        outPath
      ];
      const ffmpeg = spawn('ffmpeg', args);
      ffmpeg.on('close', code => code === 0 ? resolve() : reject(new Error('ffmpeg error')));
      ffmpeg.on('error', err => {
        reject(err);
      });
    });
    clips.push(outPath);
    if (progressCb) progressCb();
  }
  return clips;
}

async function splitVideoToClipsWithAlias(filePath, sceneFrames, alias, clipsDir, progressCb, minusFrames = 1) {
  const clips = [];
  const basename = alias;
  const fps = await getFps(filePath);
  const frameDuration = 1 / fps;
  for (let i = 0; i < sceneFrames.length - 1; i++) {
    const start = sceneFrames[i];
    let duration = sceneFrames[i + 1] - sceneFrames[i] - frameDuration * minusFrames; // 去掉末尾若干帧
    if (duration <= 0) duration = 0.01; // 防止负数
    const outPath = path.join(clipsDir, `${basename}_${i}.mp4`);
    await new Promise((resolve, reject) => {
      const args = [
        '-ss', start.toString(),
        '-i', filePath,
        '-t', duration.toString(),
        '-an',
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-y',
        outPath
      ];
      const ffmpeg = spawn('ffmpeg', args);
      ffmpeg.on('close', code => code === 0 ? resolve() : reject(new Error('ffmpeg error')));
      ffmpeg.on('error', err => reject(err));
    });
    clips.push(outPath);
    if (progressCb) progressCb();
  }
  return clips;
}

async function getFrameTimeMap(filePath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-select_streams', 'v:0',
      '-show_frames',
      '-print_format', 'json',
      '-show_entries', 'frame=pkt_pts_time,pkt_dts_time,coded_picture_number',
      filePath
    ];
    const ffprobe = spawn('ffprobe', args);
    let data = '';
    ffprobe.stdout.on('data', chunk => data += chunk);
    ffprobe.on('error', err => reject(err));
    ffprobe.on('close', () => {
      try {
        const json = JSON.parse(data);
        // 返回 [{frame:0, time:0.0}, ...]
        const arr = json.frames.map((f, idx) => ({
          frame: f.coded_picture_number !== undefined ? f.coded_picture_number : idx,
          time: parseFloat(f.pkt_pts_time || f.pkt_dts_time)
        })).filter(f => !isNaN(f.time));
        resolve(arr);
      } catch (e) {
        reject(e);
      }
    });
  });
}

async function splitVideoByFrameSelect(filePath, sceneFrames, alias, clipsDir, progressCb) {
  const clips = [];
  const basename = alias;
  const frameMap = await getFrameTimeMap(filePath);
  for (let i = 0; i < sceneFrames.length - 1; i++) {
    // 找到分割点对应的帧号区间
    const startTime = sceneFrames[i];
    const endTime = sceneFrames[i + 1];
    const startFrame = frameMap.find(f => f.time >= startTime)?.frame || 0;
    const endFrame = frameMap.find(f => f.time >= endTime)?.frame || (frameMap.length - 1);
    const outPath = path.join(clipsDir, `${basename}_${i}.mp4`);
    await new Promise((resolve, reject) => {
      const args = [
        '-i', filePath,
        '-vf', `select='between(n\,${startFrame}\,${endFrame-1})',setpts=N/FRAME_RATE/TB`,
        '-an',
        '-c:v', 'libx264',
        '-preset', 'ultrafast',
        '-y',
        outPath
      ];
      const ffmpeg = spawn('ffmpeg', args);
      ffmpeg.on('close', code => code === 0 ? resolve() : reject(new Error('ffmpeg error')));
      ffmpeg.on('error', err => {
        reject(err);
      });
    });
    clips.push(outPath);
    if (progressCb) progressCb();
  }
  return clips;
}

async function concatClips(clips, outPath, outputDir) {
  const bar = new ProgressBar('拼接进度 [:bar] :current/:total', { total: 1, width: 30 });
  const listFile = path.join(outputDir, 'concat_list.txt');
  
  // 检查所有片段文件是否存在
  for (const clip of clips) {
    if (!fs.existsSync(clip)) {
      throw new Error(`片段文件不存在: ${clip}`);
    }
  }
  
  // 使用绝对路径并正确处理路径分隔符
  const listContent = clips.map(f => {
    const absolutePath = path.resolve(f);
    // 在Windows上使用正斜杠，避免路径问题
    const normalizedPath = absolutePath.replace(/\\/g, '/');
    return `file '${normalizedPath}'`;
  }).join('\n');
  
  fs.writeFileSync(listFile, listContent);
  
  await new Promise((resolve, reject) => {
    const args = [
      '-y',
      '-f', 'concat',
      '-safe', '0',
      '-i', listFile,
      '-c', 'copy',
      outPath
    ];
    const ffmpeg = spawn('ffmpeg', args, { stdio: 'pipe' });
    
    let stderrData = '';
    ffmpeg.stderr.on('data', chunk => {
      stderrData += chunk.toString();
    });
    
    ffmpeg.on('close', code => {
      bar.tick();
      if (code === 0) {
        resolve();
      } else {
        console.error('FFmpeg concat 错误输出:', stderrData);
        reject(new Error(`ffmpeg concat error (code: ${code}): ${stderrData}`));
      }
    });
    
    ffmpeg.on('error', err => {
      console.error('FFmpeg concat 进程错误:', err);
      reject(err);
    });
  });
  
  // 清理临时文件
  if (fs.existsSync(listFile)) {
    fs.unlinkSync(listFile);
  }
}

// 获取视频片段时长（秒）
function getClipDuration(filePath) {
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

function genShortAliasArr(n) {
  const arr = [];
  const chars = 'abcdefghijklmnopqrstuvwxyz';
  for (let i = 0; i < n; i++) {
    let s = '';
    let x = i;
    do {
      s = chars[x % 26] + s;
      x = Math.floor(x / 26) - 1;
    } while (x >= 0);
    arr.push(s);
  }
  return arr;
}

async function generateOrUpdateAliasMap(inputDir, aliasMapPath) {
  await fs.ensureDir(inputDir);
  const videoFiles = fs.readdirSync(inputDir).filter(f => /\.(mp4|mov|avi|mkv)$/i.test(f));
  videoFiles.sort(); // 按文件名排序，保证分配一致
  let aliasMap = {};
  if (fs.existsSync(aliasMapPath)) {
    try {
      aliasMap = await fs.readJson(aliasMapPath);
    } catch (e) {
      aliasMap = {};
    }
  }
  // 反查已分配的短别名，避免重复
  const usedShorts = new Set(Object.keys(aliasMap).map(k => k.split('_').pop()));
  const dirKey = (() => {
    let d = path.basename(inputDir.replace(/[\\/]+$/, ''));
    if (d === '未分析') d = path.basename(path.dirname(inputDir));
    return d;
  })();
  let shortIdx = 0;
  for (const file of videoFiles) {
    const baseName = path.parse(file).name;
    // 检查是否已分配
    let found = false;
    for (const [k, v] of Object.entries(aliasMap)) {
      if (v === baseName && k.startsWith(dirKey + '_')) {
        found = true;
        break;
      }
    }
    if (!found) {
      // 分配新短别名
      let shortAlias;
      while (true) {
        shortAlias = genShortAliasArr(shortIdx + 1)[shortIdx];
        if (!usedShorts.has(shortAlias)) break;
        shortIdx++;
      }
      aliasMap[`${dirKey}_${shortAlias}`] = baseName;
      usedShorts.add(shortAlias);
      shortIdx++;
    }
  }
  await fs.writeJson(aliasMapPath, aliasMap, { spaces: 2 });
  return aliasMap;
}

module.exports = {
  getVideoFiles,
  getSceneChangeFrames,
  splitVideoToClips,
  splitVideoToClipsWithAlias,
  concatClips,
  shuffle,
  getFrameTimeMap,
  splitVideoByFrameSelect,
  getClipDuration,
  generateOrUpdateAliasMap,
};
