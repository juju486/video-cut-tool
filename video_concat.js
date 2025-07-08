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
const config = yaml.load(fs.readFileSync(path.join(__dirname, 'config.yaml'), 'utf8'));
const clipsDir = path.join(__dirname, config.clipsDir || 'clips');
const openDir = path.join(__dirname, config.openDir || 'open');
const outputDir = path.join(__dirname, config.outputDir || 'output');
const musicDir = path.join(__dirname, 'music');
const numNewVideos = config.numNewVideos || 3;
const clipsPerVideo = config.clipsPerVideo || 10;
const minVideoDuration = config.minVideoDuration;
const maxVideoDuration = config.maxVideoDuration;
const minAudioRate = config.minAudioRate || 0.95;
const maxAudioRate = config.maxAudioRate || 1.05;
const minVideoRate = config.minVideoRate || 0.95;
const maxVideoRate = config.maxVideoRate || 1.05;
const minClipDuration = config.minClipDuration || 1.5;
const maxClipDuration = config.maxClipDuration || 30;
const maxAVDiff = config.maxAVDiff || 0.2;

const minLastClip = 1.5; // 最后一个片段不能少于1.5秒

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
async function concatClipsWithAudio(clips, audioPath, outPath, outputDir, audioRate, videoRates) {
  // 先拼接视频片段为一个临时视频
  const tempVideo = path.join(outputDir, `temp_${Date.now()}.mp4`);
  await concatClips(clips, tempVideo, outputDir);
  // 如果需要裁剪最后一个片段
  let finalVideo = tempVideo;
  if (clips.cutLastTo) {
    // 裁剪最后一个片段
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
      const args = [
        '-i', tempVideo,
        '-ss', lastStart.toString(),
        '-t', lastLen.toString(),
        '-c', 'copy',
        '-y', cutVideo
      ];
      const { spawn } = require('child_process');
      const ffmpeg = spawn('ffmpeg', args, { stdio: 'ignore' });
      ffmpeg.on('close', code => code === 0 ? resolve() : reject(new Error('ffmpeg error')));
      ffmpeg.on('error', err => reject(err));
    });
    finalVideo = cutVideo;
    fs.unlinkSync(tempVideo);
  }
  // 构造ffmpeg命令：调整音频速率、视频速率，合成输出
  const tempOut = path.join(outputDir, `out_${Date.now()}.mp4`);
  await new Promise((resolve, reject) => {
    const args = [
      '-i', finalVideo,
      '-i', audioPath,
      '-filter_complex',
      `[1:a]atempo=${audioRate}[a];[0:v]setpts=${1/videoRates[0]}*PTS[v]`,
      '-map', '[v]',
      '-map', '[a]',
      '-shortest',
      '-y',
      tempOut
    ];
    const { spawn } = require('child_process');
    const ffmpeg = spawn('ffmpeg', args, { stdio: 'ignore' });
    ffmpeg.on('close', code => {
      if (finalVideo !== tempVideo) fs.unlinkSync(finalVideo);
      code === 0 ? resolve() : reject(new Error('ffmpeg error'));
    });
    ffmpeg.on('error', err => {
      if (finalVideo !== tempVideo) fs.unlinkSync(finalVideo);
      reject(err);
    });
  });
  // 最后一步：用音频时长精确裁剪，防止卡帧
  const audioDuration = await getAudioDuration(audioPath);
  const tempCutted = path.join(outputDir, `cutted_${Date.now()}.mp4`);
  await new Promise((resolve, reject) => {
    const args = [
      '-i', tempOut,
      '-t', audioDuration.toString(),
      '-c', 'copy',
      '-y', tempCutted
    ];
    const { spawn } = require('child_process');
    const ffmpeg = spawn('ffmpeg', args, { stdio: 'ignore' });
    ffmpeg.on('close', code => {
      fs.unlinkSync(tempOut);
      code === 0 ? resolve() : reject(new Error('ffmpeg error'));
    });
    ffmpeg.on('error', err => {
      fs.unlinkSync(tempOut);
      reject(err);
    });
  });
  // 再次封装修正索引，彻底消除卡帧
  await new Promise((resolve, reject) => {
    const args = [
      '-i', tempCutted,
      '-c', 'copy',
      '-map', '0',
      '-movflags', '+faststart',
      '-y', outPath
    ];
    const { spawn } = require('child_process');
    const ffmpeg = spawn('ffmpeg', args, { stdio: 'ignore' });
    ffmpeg.on('close', code => {
      fs.unlinkSync(tempCutted);
      code === 0 ? resolve() : reject(new Error('ffmpeg error'));
    });
    ffmpeg.on('error', err => {
      fs.unlinkSync(tempCutted);
      reject(err);
    });
  });
}

async function composeVideosWithOpen() {
  await fs.ensureDir(outputDir);
  // 生成本次批量的子文件夹名
  const now = new Date();
  const pad = n => n.toString().padStart(2, '0');
  const folderName = `${now.getFullYear()}${pad(now.getMonth()+1)}${pad(now.getDate())}_${pad(now.getHours())}${pad(now.getMinutes())}`;
  const batchDir = path.join(outputDir, folderName);
  await fs.ensureDir(batchDir);
  const allClips = fs.readdirSync(clipsDir).filter(f => /\.mp4$/i.test(f)).map(f => path.join(clipsDir, f));
  const openFiles = fs.existsSync(openDir)
    ? fs.readdirSync(openDir).filter(f => /\.mp4$/i.test(f)).map(f => path.join(openDir, f))
    : [];
  if (allClips.length === 0) {
    console.log('clips 文件夹下无片段，无法合成');
    return;
  }
  // 音频文件列表
  const musicFiles = getMusicFiles();
  if (musicFiles.length === 0) {
    console.log('music 文件夹下无音频，无法合成');
    return;
  }
  // 计算每个开头片段应被使用次数
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
  const concatBar = new ProgressBar('合成新视频进度 [:bar] :current/:total', { total: numNewVideos, width: 30 });
  // 记录所有视频的片段标识
  const allVideoIds = [];
  let successCount = 0;
  let tryIndex = 0;
  let totalRetry = 0;
  while (successCount < numNewVideos) {
    // 1. 选音频
    const audioIdx = tryIndex % musicFiles.length;
    const audioPath = path.join(musicDir, musicFiles[audioIdx]);
    const audioDuration = await getAudioDuration(audioPath);
    // 2. 精确选片段
    let selectedClips = [], selectedDur = 0, order, videoRates, audioRate;
    let tryCount = 0;
    let found = false;
    do {
      tryCount++;
      if (tryCount > 1) {
        console.log(`第${successCount+1}个视频第${tryCount}次重试...`);
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
      if (diff < -maxAVDiff) {
        if (Math.abs(diff) > 1.5) {
          console.log('片段总时长小于音频，差值大于1.5s，继续选片段...');
          continue;
        } else {
          let aRate = tmpDur / audioDuration;
          if (aRate >= minAudioRate && aRate <= maxAudioRate) {
            console.log(`片段总时长小于音频，差值小于1.5s，调整音频速率为: ${aRate.toFixed(4)}`);
            audioRate = aRate;
            videoRates = [1.0];
            found = true;
          } else {
            aRate = minAudioRate;
            let newAudioLen = audioDuration * aRate;
            let remain = tmpDur - newAudioLen;
            let vRate = 1.0;
            if (Math.abs(remain) <= maxAVDiff) {
              vRate = tmpDur / newAudioLen;
              if (vRate >= minVideoRate && vRate <= maxVideoRate) {
                console.log(`片段总时长小于音频，音频速率调整到最小${aRate.toFixed(4)}，视频速率调整为: ${vRate.toFixed(4)}`);
                audioRate = aRate;
                videoRates = [vRate];
                found = true;
              }
            }
          }
        }
      } else if (diff > maxAVDiff) {
        if (diff > 2) {
          console.log('片段总时长大于音频，差值大于2s，重新选片段...');
          continue;
        } else {
          let aRate = 1.0;
          let vRate = audioDuration / tmpDur;
          if (vRate >= minVideoRate && vRate <= maxVideoRate) {
            console.log(`片段总时长大于音频，差值小于2s，调整视频速率为: ${vRate.toFixed(4)}`);
            audioRate = aRate;
            videoRates = [vRate];
            found = true;
          } else {
            vRate = maxVideoRate;
            let newVideoLen = tmpDur * vRate;
            let remain = newVideoLen - audioDuration;
            if (Math.abs(remain) <= maxAVDiff) {
              aRate = newVideoLen / audioDuration;
              if (aRate >= minAudioRate && aRate <= maxAudioRate) {
                console.log(`片段总时长大于音频，视频速率调整到最大${vRate.toFixed(4)}，音频速率调整为: ${aRate.toFixed(4)}`);
                audioRate = aRate;
                videoRates = [vRate];
                found = true;
              }
            }
          }
        }
      } else {
        console.log('片段总时长与音频时长差值在允许范围内，直接裁剪多余部分');
        audioRate = 1.0;
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
    if (!found || !selectedClips || selectedClips.length === 0) {
      if (tryCount >= 100) {
        console.log(`第${successCount+1}个视频重试已达最大次数（100），跳过。`);
      }
      console.log(`第${successCount+1}个视频未能选出合适片段，已跳过。`);
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
    allVideoIds.push(idList);
    // 生成输出文件名：openDir名+inputDir名+视频时长+音频文件名
    const openName = config.openDir || 'open';
    const inputName = config.inputDir || 'input';
    // 先用临时名合成
    const tempOutName = `${openName}_${inputName}_temp_${successCount}.mp4`;
    const tempOutPath = path.join(batchDir, tempOutName);
    await concatClipsWithAudio(selectedClips, audioPath, tempOutPath, batchDir, audioRate, videoRates);
    // 获取最终成品视频的时长
    const finalVideoDuration = await getClipDuration(tempOutPath);
    const durationStr = finalVideoDuration.toFixed(1);
    const audioBase = path.parse(musicFiles[audioIdx]).name;
    const outFileName = `${openName}_${inputName}_${durationStr}s_${audioBase}.mp4`;
    const outPath = path.join(batchDir, outFileName);
    fs.renameSync(tempOutPath, outPath);
    concatBar.tick();
    successCount++;
    tryIndex++;
  }
  // 输出到 js 文件
  const jsOut = `// 每个视频的片段标识\nconst videoIds = ${JSON.stringify(allVideoIds, null, 2)};\nmodule.exports = { videoIds };\n`;
  fs.writeFileSync(path.join(batchDir, 'video_ids.js'), jsOut);
  console.log(`全部合成完成，片段标识已输出到 ${batchDir}/video_ids.js`);

  // 删除output及子文件夹下所有以temp开头的临时视频
  function deleteTempFiles(dir) {
    const files = fs.readdirSync(dir);
    for (const file of files) {
      const fullPath = path.join(dir, file);
      if (fs.statSync(fullPath).isDirectory()) {
        deleteTempFiles(fullPath);
      } else if (/^temp.*\.mp4$/i.test(file)) {
        fs.unlinkSync(fullPath);
        console.log('已删除临时文件:', fullPath);
      }
    }
  }
  deleteTempFiles(outputDir);

  if (totalRetry > 0) {
    console.log(`本次生成过程中发生了${totalRetry}次重试。`);
  } else {
    console.log('本次生成未发生重试。');
  }
}

composeVideosWithOpen();
