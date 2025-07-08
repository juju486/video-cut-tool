const fs = require('fs-extra');
const path = require('path');
const { spawn } = require('child_process');
const { generateOrUpdateAliasMap } = require('./video_utils');

const inputDir = path.join(__dirname, 'input');
const musicDir = path.join(__dirname, 'music');
const aliasMapPath = path.join(inputDir, 'alias_map.json');

async function extractAudio(videoPath, audioPath) {
  return new Promise((resolve, reject) => {
    // -vn: 不处理视频流，-acodec copy: 直接拷贝音频流
    const args = ['-i', videoPath, '-vn', '-acodec', 'copy', '-y', audioPath];
    const ffmpeg = spawn('ffmpeg', args, { stdio: 'inherit' });
    ffmpeg.on('close', code => code === 0 ? resolve() : reject(new Error('ffmpeg error')));
    ffmpeg.on('error', err => reject(err));
  });
}

async function getAudioDuration(filePath) {
  return new Promise((resolve, reject) => {
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

(async () => {
  await fs.ensureDir(musicDir);
  // 生成/补全 alias_map.json
  const aliasMap = await generateOrUpdateAliasMap(inputDir, aliasMapPath);
  // 反查别名到原文件名
  const nameToAlias = Object.fromEntries(Object.entries(aliasMap).map(([k, v]) => [v, k]));
  const videoFiles = fs.readdirSync(inputDir).filter(f => /\.(mp4|mov|avi|mkv)$/i.test(f));

  for (const file of videoFiles) {
    const basename = path.parse(file).name;
    const alias = nameToAlias[basename];
    if (!alias) {
      console.log(`未找到别名映射，跳过: ${file}`);
      continue;
    }
    const ext = path.extname(file).toLowerCase();
    // 先用临时名提取音频
    const tempAudioPath = path.join(musicDir, `${alias}_temp.aac`);
    const videoPath = path.join(inputDir, file);
    console.log(`正在提取: ${file} -> ${tempAudioPath}`);
    try {
      await extractAudio(videoPath, tempAudioPath);
      // 获取音频时长
      const audioDuration = await getAudioDuration(tempAudioPath);
      const durationStr = audioDuration.toFixed(1);
      const audioPath = path.join(musicDir, `${alias}_${durationStr}s.aac`);
      fs.renameSync(tempAudioPath, audioPath);
      console.log(`完成: ${audioPath}`);
    } catch (e) {
      console.error(`提取失败: ${file}`, e);
    }
  }
  console.log('全部音频提取完成。');
})(); 