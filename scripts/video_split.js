const fs = require('fs-extra');
const path = require('path');
const yaml = require('js-yaml');
const ProgressBar = require('./electron_progress'); // 使用我们自定义的Electron兼容进度条
const {
  getVideoFiles,
  getSceneChangeFrames,
  splitVideoToClipsWithAlias,
  splitVideoByFrameSelect,
  generateOrUpdateAliasMap,
  // 新增：诊断/修复工具
  runFfmpegLogged,
  quickFixVideo,
} = require('./video_utils');
const { getAliasKey } = require('./alias_utils');
const { spawn } = require('child_process');

async function reencodeClip(inputPath, outputPath) {
  // 使用统一封装与日志
  const args = [
    '-hide_banner', '-loglevel', 'error', '-nostdin',
    '-i', inputPath.replace(/\\/g, '/'),
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-movflags', '+faststart',
    '-y', outputPath.replace(/\\/g, '/')
  ];
  await runFfmpegLogged(args, `reencode_clip_${path.parse(inputPath).name}`, 600);
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
  const allInputFiles = fs.readdirSync(inputDir).filter(f => /(\.(mp4|mov|avi|mkv))$/i.test(f));
  for (const file of allInputFiles) {
    const src = path.join(inputDir, file);
    const dst = path.join(todoDir, file);
    if (!fs.existsSync(dst)) {
      try { fs.renameSync(src, dst); } catch (e) {}
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
      try { fs.renameSync(filePath, path.join(doneDir, file)); } catch (e) {}
      continue;
    }
    
    // 1) 场景检测，失败则 quickFix 后重试
    console.log('正在分析转场点:', file);
    let sceneFrames = [];
    let usedInput = filePath;
    try {
      sceneFrames = await getSceneChangeFrames(usedInput, config.sceneThreshold || 0.4);
    } catch (err) {
      console.error('场景检测失败，尝试快速修复后重试。错误:', err.message);
      try {
        const fixed = await quickFixVideo(usedInput);
        console.log('已生成修复文件，重新检测场景:', path.basename(fixed));
        usedInput = fixed;
        sceneFrames = await getSceneChangeFrames(usedInput, config.sceneThreshold || 0.4);
      } catch (e2) {
        console.error('修复后仍无法检测场景，跳过该文件。日志位于 output/ffmpeg_logs/');
        // 将问题文件移至已分析/失败子目录，避免反复尝试
        const failedDir = path.join(doneDir, '检测失败');
        await fs.ensureDir(failedDir);
        try { fs.renameSync(filePath, path.join(failedDir, file)); } catch (_) {}
        continue;
      }
    }
    console.log('转场点:', sceneFrames);
    if (!sceneFrames || sceneFrames.length < 2) {
      // 分析后无转场点，移到无转场点文件夹
      const noSceneDir = path.join(inputDir, '无转场点');
      await fs.ensureDir(noSceneDir);
      try { fs.renameSync(filePath, path.join(noSceneDir, file)); } catch (e) {}
      console.log(`${file} 无转场点，已移至无转场点文件夹。`);
      continue;
    }
    
    // 2) 分割片段，失败则 quickFix 后重试
    let totalSplitTasks = sceneFrames.length - 1;
    const splitBar = new ProgressBar(`分割片段进度 [:bar] :current/:total (${file})`, { total: totalSplitTasks, width: 30 });
    let splitClips = [];
    async function doSplit(inputForSplit) {
      if (useFrameAccurateSplit) {
        return await splitVideoByFrameSelect(inputForSplit, sceneFrames, alias, clipsDir, () => splitBar.tick());
      } else {
        return await splitVideoToClipsWithAlias(inputForSplit, sceneFrames, alias, clipsDir, () => splitBar.tick(), config.minusFrames || 2);
      }
    }
    try {
      splitClips = await doSplit(usedInput);
    } catch (err) {
      console.error('分割失败，尝试快速修复后重试。错误:', err.message);
      try {
        const fixed = await quickFixVideo(usedInput);
        console.log('已生成修复文件，重新分割:', path.basename(fixed));
        usedInput = fixed;
        // 重置进度条
        splitBar.curr = 0; splitBar.render();
        splitClips = await doSplit(usedInput);
      } catch (e2) {
        console.error('修复后仍无法分割，跳过该文件。日志位于 output/ffmpeg_logs/');
        const failedDir = path.join(doneDir, '分割失败');
        await fs.ensureDir(failedDir);
        try { fs.renameSync(filePath, path.join(failedDir, file)); } catch (_) {}
        continue;
      }
    }

    // 3) 分割后重编码，进一步提升兼容性
    for (const clipPath of splitClips) {
      const tempPath = clipPath + '.reencode.mp4';
      console.log('重编码片段:', path.basename(clipPath));
      try {
        await reencodeClip(clipPath, tempPath);
        fs.renameSync(tempPath, clipPath);
      } catch (e) {
        console.warn('片段重编码失败，保留原片段:', path.basename(clipPath), e.message);
        try { if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath); } catch (_) {}
      }
    }

    // 4) 成功后移动到已分析
    try { fs.renameSync(filePath, path.join(doneDir, file)); } catch (e) {}
    console.log(`${file} 分割完成，已移至已分析。`);
    
    // 5) 重新加载映射，以防有新文件加入
    try {
      const updatedAliasMap = await generateOrUpdateAliasMap(todoDir, aliasMapPath);
      Object.assign(aliasMap, updatedAliasMap);
      Object.assign(nameToAlias, Object.fromEntries(Object.entries(updatedAliasMap).map(([k, v]) => [v, k])));
    } catch (e) {}
  }
  console.log('全部分割完成，所有片段已输出到 clips 文件夹。');
})();
