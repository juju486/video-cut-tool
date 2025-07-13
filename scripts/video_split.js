const fs = require('fs-extra');
const path = require('path');
const yaml = require('js-yaml');
const ProgressBar = require('progress');
const {
  getVideoFiles,
  getSceneChangeFrames,
  splitVideoToClipsWithAlias,
  splitVideoByFrameSelect,
  generateOrUpdateAliasMap
} = require('./video_utils');
const { getAliasKey } = require('./alias_utils');
const { spawn } = require('child_process');

async function reencodeClip(inputPath, outputPath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-i', inputPath,
      '-c:v', 'libx264',
      '-c:a', 'aac',
      '-strict', '-2',
      '-y', outputPath
    ];
    const ffmpeg = spawn('ffmpeg', args, { stdio: 'ignore' });
    ffmpeg.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error('重编码失败: ' + inputPath));
    });
    ffmpeg.on('error', reject);
  });
}

// 读取配置
const config = yaml.load(fs.readFileSync(path.join(__dirname, '../config.yaml'), 'utf8'));
const inputDir = path.join(__dirname, '../', config.inputDir || 'input');
const clipsDir = path.join(__dirname, '../', config.clipsDir || 'clips');
const aliasMapPath = path.join(inputDir, 'alias_map.json');
const doneDir = path.join(inputDir, '已分析');
const todoDir = path.join(inputDir, '未分析');

// 选择分割方案：true=帧级精确分割，false=原方案（减2帧）
const useFrameAccurateSplit = config.useFrameAccurateSplit || false;

(async () => {
  await fs.ensureDir(clipsDir);
  await fs.ensureDir(doneDir);
  await fs.ensureDir(todoDir);
  // 首次运行时，将input下所有视频移到未分析
  const allInputFiles = fs.readdirSync(inputDir).filter(f => /\.(mp4|mov|avi|mkv)$/i.test(f));
  for (const file of allInputFiles) {
    const src = path.join(inputDir, file);
    const dst = path.join(todoDir, file);
    if (!fs.existsSync(dst)) {
      fs.renameSync(src, dst);
    }
  }
  // 生成/补全 alias_map.json
  const aliasMap = await generateOrUpdateAliasMap(todoDir, aliasMapPath);
  // 反查别名到原文件名
  const aliasToName = aliasMap;
  const nameToAlias = Object.fromEntries(Object.entries(aliasMap).map(([k, v]) => [v, k]));
  const videoFiles = getVideoFiles(todoDir);
  console.log('待分析视频文件:', videoFiles);
  if (videoFiles.length === 0) {
    console.log('未分析文件夹下未检测到视频文件，程序退出');
    return;
  }
  
  // 检查已存在的片段文件
  function checkExistingClips(alias) {
    const existingClips = fs.readdirSync(clipsDir).filter(f => f.startsWith(`${alias}_`) && f.endsWith('.mp4'));
    return existingClips.length > 0;
  }
  
  for (const file of videoFiles) {
    const filePath = path.join(todoDir, file);
    const basename = path.parse(file).name;
    const alias = nameToAlias[basename];
    
    // 检查是否已经处理过
    if (alias && checkExistingClips(alias)) {
      console.log(`${file} 已存在对应片段，跳过处理`);
      // 直接移到已分析
      fs.renameSync(filePath, path.join(doneDir, file));
      continue;
    }
    
    console.log('正在分析转场点:', file);
    const sceneFrames = await getSceneChangeFrames(filePath, config.sceneThreshold || 0.4);
    console.log('转场点:', sceneFrames);
    if (sceneFrames.length < 2) {
      // 分析后无可分割，直接移到已分析
      fs.renameSync(filePath, path.join(doneDir, file));
      continue;
    }
    
    let totalSplitTasks = sceneFrames.length - 1;
    const splitBar = new ProgressBar(`分割片段进度 [:bar] :current/:total (${file})`, { total: totalSplitTasks, width: 30 });
    let splitClips = [];
    if (useFrameAccurateSplit) {
      splitClips = await splitVideoByFrameSelect(filePath, sceneFrames, alias, clipsDir, () => splitBar.tick());
    } else {
      splitClips = await splitVideoToClipsWithAlias(filePath, sceneFrames, alias, clipsDir, () => splitBar.tick(), config.minusFrames || 2);
    }
    // 分割后立即重编码每个片段
    for (const clipPath of splitClips) {
      const tempPath = clipPath + '.reencode.mp4';
      console.log('重编码片段:', path.basename(clipPath));
      await reencodeClip(clipPath, tempPath);
      fs.renameSync(tempPath, clipPath); // 用重编码后文件覆盖原片段
    }
    // 分割完成后移到已分析
    fs.renameSync(filePath, path.join(doneDir, file));
    console.log(`${file} 分割完成，已移至已分析。`);
    
    // 重新加载映射，以防有新文件加入
    const updatedAliasMap = await generateOrUpdateAliasMap(todoDir, aliasMapPath);
    Object.assign(aliasMap, updatedAliasMap);
    Object.assign(nameToAlias, Object.fromEntries(Object.entries(updatedAliasMap).map(([k, v]) => [v, k])));
  }
  console.log('全部分割完成，所有片段已输出到 clips 文件夹。');
})();
