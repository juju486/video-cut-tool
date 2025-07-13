const fs = require('fs-extra');
const path = require('path');
const yaml = require('js-yaml');
const { spawn } = require('child_process');

// 读取配置
const config = yaml.load(fs.readFileSync(path.join(__dirname, '../config.yaml'), 'utf8'));
const inputDir = path.join(__dirname, '../', config.inputDir || 'input');
const musicDir = path.join(__dirname, '../', config.audioExtractDir || 'music');
const inputAliasMapPath = path.join(inputDir, 'alias_map.json');
const audioAliasMapPath = path.join(musicDir, 'alias_map.json');

async function extractAudio(videoPath, audioPath) {
  return new Promise((resolve, reject) => {
    // -vn: 不处理视频流，-acodec mp3: 转换为MP3格式
    const args = ['-i', videoPath, '-vn', '-acodec', 'mp3', '-b:a', '128k', '-y', audioPath];
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

// 生成递归目录的别名映射
async function generateRecursiveAliasMap(inputDir, aliasMapPath) {
  await fs.ensureDir(inputDir);
  
  // 递归获取所有视频文件
  function getAllVideoFiles(dir) {
    const files = [];
    const items = fs.readdirSync(dir);
    
    for (const item of items) {
      const fullPath = path.join(dir, item);
      const stat = fs.statSync(fullPath);
      
      if (stat.isDirectory()) {
        files.push(...getAllVideoFiles(fullPath));
      } else if (/\.(mp4|mov|avi|mkv)$/i.test(item)) {
        files.push(fullPath);
      }
    }
    
    return files;
  }
  
  const videoFiles = getAllVideoFiles(inputDir);
  let aliasMap = {};
  
  if (fs.existsSync(aliasMapPath)) {
    try {
      aliasMap = await fs.readJson(aliasMapPath);
    } catch (e) {
      aliasMap = {};
    }
  }
  
  // 获取inputDir的最后一部分作为前缀
  const inputDirName = path.basename(inputDir);
  
  // 生成别名
  function genAliasArr(n) {
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
  
  // 为每个视频文件生成别名
  let idx = 0;
  for (const filePath of videoFiles) {
    const name = path.parse(filePath).name;
    if (!Object.values(aliasMap).includes(name)) {
      // 找到未用的别名
      let alias;
      while (true) {
        const shortAlias = genAliasArr(idx + 1)[idx];
        alias = `${inputDirName}_${shortAlias}`;
        if (!aliasMap[alias]) break;
        idx++;
      }
      aliasMap[alias] = name;
      idx++;
    }
  }
  
  await fs.writeJson(aliasMapPath, aliasMap, { spaces: 2 });
  return aliasMap;
}



(async () => {
  await fs.ensureDir(musicDir);
  
  // 读取输入目录的映射（递归处理所有子目录）
  const inputAliasMap = await generateRecursiveAliasMap(inputDir, inputAliasMapPath);
  const nameToAlias = Object.fromEntries(Object.entries(inputAliasMap).map(([k, v]) => [v, k]));
  
  // 读取或创建音频输出目录的映射
  let audioAliasMap = {};
  if (fs.existsSync(audioAliasMapPath)) {
    try {
      audioAliasMap = await fs.readJson(audioAliasMapPath);
    } catch (e) {
      audioAliasMap = {};
    }
  }
  
  // 递归获取所有视频文件（包括子目录）
  function getAllVideoFiles(dir) {
    const files = [];
    const items = fs.readdirSync(dir);
    
    for (const item of items) {
      const fullPath = path.join(dir, item);
      const stat = fs.statSync(fullPath);
      
      if (stat.isDirectory()) {
        // 递归处理子目录
        files.push(...getAllVideoFiles(fullPath));
      } else if (/\.(mp4|mov|avi|mkv)$/i.test(item)) {
        // 添加视频文件
        files.push(fullPath);
      }
    }
    
    return files;
  }
  
  const videoFiles = getAllVideoFiles(inputDir);

  for (const filePath of videoFiles) {
    const basename = path.parse(filePath).name;
    const alias = nameToAlias[basename];
    if (!alias) {
      console.log(`未找到别名映射，跳过: ${filePath}`);
      continue;
    }
    
    // 检查是否已经在音频映射中
    if (audioAliasMap[alias]) {
      console.log(`${filePath} 已在音频映射中，跳过提取`);
      continue;
    }
    
    // 先用临时名提取音频
    const tempAudioPath = path.join(musicDir, `${alias}_temp.mp3`);
    console.log(`正在提取: ${filePath} -> ${tempAudioPath}`);
    try {
      await extractAudio(filePath, tempAudioPath);
      // 获取音频时长
      const audioDuration = await getAudioDuration(tempAudioPath);
      const durationStr = audioDuration.toFixed(1);
      const finalAudioPath = path.join(musicDir, `${alias}_${durationStr}s.mp3`);
      fs.renameSync(tempAudioPath, finalAudioPath);
      
      // 添加到音频映射中
      audioAliasMap[alias] = `${alias}_${durationStr}s.mp3`;
      await fs.writeJson(audioAliasMapPath, audioAliasMap, { spaces: 2 });
      
      console.log(`完成: ${finalAudioPath}`);
    } catch (e) {
      console.error(`提取失败: ${filePath}`, e);
    }
  }
  console.log('全部音频提取完成。');
})(); 