const fs = require('fs-extra');
const path = require('path');
const ProgressBar = require('progress');
const {
  getVideoFiles,
  getSceneChangeFrames,
  splitVideoToClipsWithAlias,
  splitVideoByFrameSelect
} = require('./video_utils');

const inputDir = path.join(__dirname, 'input');
const clipsDir = path.join(__dirname, 'clips');

// 选择分割方案：true=帧级精确分割，false=原方案（减2帧）
const useFrameAccurateSplit = false;

(async () => {
  await fs.ensureDir(clipsDir);
  console.log('已创建 clips 目录');
  const videoFiles = getVideoFiles(inputDir);
  console.log('检测到视频文件:', videoFiles);
  if (videoFiles.length === 0) {
    console.log('input 文件夹下未检测到视频文件，程序退出');
    return;
  }
  // 分配别名
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
  const aliasArr = genAliasArr(videoFiles.length);
  const aliasMap = {};
  videoFiles.forEach((file, idx) => {
    aliasMap[aliasArr[idx]] = path.parse(file).name;
  });
  let totalSplitTasks = 0;
  for (const file of videoFiles) {
    const filePath = path.join(inputDir, file);
    console.log('正在分析转场点:', file);
    const sceneFrames = await getSceneChangeFrames(filePath, 0.4);
    console.log('转场点:', sceneFrames);
    if (sceneFrames.length < 2) continue;
    totalSplitTasks += sceneFrames.length - 1;
  }
  if (totalSplitTasks === 0) {
    console.log('未检测到可分割的转场点，程序退出');
    return;
  }
  const splitBar = new ProgressBar('分割片段进度 [:bar] :current/:total', { total: totalSplitTasks, width: 30 });
  for (const [idx, file] of videoFiles.entries()) {
    const filePath = path.join(inputDir, file);
    const sceneFrames = await getSceneChangeFrames(filePath, 0.4);
    if (sceneFrames.length < 2) continue;
    const alias = aliasArr[idx];
    if (useFrameAccurateSplit) {
      await splitVideoByFrameSelect(filePath, sceneFrames, alias, clipsDir, () => splitBar.tick());
    } else {
      await splitVideoToClipsWithAlias(filePath, sceneFrames, alias, clipsDir, () => splitBar.tick(), 2);
    }
  }
  fs.writeFileSync(path.join(clipsDir, 'alias_map.json'), JSON.stringify(aliasMap, null, 2));
  console.log('分割完成，所有片段已输出到 clips 文件夹。');
})();
