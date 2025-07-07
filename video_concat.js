const fs = require('fs-extra');
const path = require('path');
const ProgressBar = require('progress');
const {
  concatClips,
  shuffle
} = require('./video_utils');

const clipsDir = path.join(__dirname, 'clips');
const openDir = path.join(__dirname, 'open');
const outputDir = path.join(__dirname, 'output');

// 生成别名（支持任意数量，a-z, aa-zz, ...）
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

async function composeVideosWithOpen(numNewVideos = 3, clipsPerVideo = 10) {
  await fs.ensureDir(outputDir);
  const allClips = fs.readdirSync(clipsDir).filter(f => /\.mp4$/i.test(f)).map(f => path.join(clipsDir, f));
  const openFiles = fs.existsSync(openDir)
    ? fs.readdirSync(openDir).filter(f => /\.mp4$/i.test(f)).map(f => path.join(openDir, f))
    : [];
  if (allClips.length === 0) {
    console.log('clips 文件夹下无片段，无法合成');
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
  // 生成别名映射
  const allFiles = Array.from(new Set(allClips.map(f => {
    const match = /^([a-z]+)_\d+\.mp4$/i.exec(path.basename(f));
    return match ? match[1] : path.parse(path.basename(f)).name;
  })));
  const aliasArr = genAliasArr(allFiles.length);
  const aliasMap = {};
  allFiles.forEach((name, idx) => {
    aliasMap[aliasArr[idx]] = name;
  });
  // 记录所有视频的片段标识
  const allVideoIds = [];
  for (let i = 0; i < numNewVideos; i++) {
    let order;
    let selectedClips;
    do {
      const idxs = shuffle([...Array(allClips.length).keys()]).slice(0, clipsPerVideo);
      order = idxs.join(',');
      selectedClips = idxs.map(idx => allClips[idx]);
    } while (usedOrders.has(order));
    usedOrders.add(order);
    if (openAssign.length > 0) {
      selectedClips = [openAssign[i]].concat(selectedClips);
    }
    // 生成本视频的片段标识数组
    const idList = selectedClips.map(f => {
      const base = path.parse(path.basename(f)).name;
      // 只要是 a_0 这种格式就直接用
      if (/^[a-z]+_\d+$/.test(base)) return base;
      // open 片段或其他，直接用文件名
      return base;
    });
    allVideoIds.push(idList);
    // 不再生成 txt 文件
    const outPath = path.join(outputDir, `new_video_${i + 1}.mp4`);
    await concatClips(selectedClips, outPath, outputDir);
    concatBar.tick();
  }
  // 输出到 js 文件
  const jsOut = `// 片段来源别名映射\nconst aliasMap = ${JSON.stringify(aliasMap, null, 2)};\n// 每个视频的片段标识\nconst videoIds = ${JSON.stringify(allVideoIds, null, 2)};\nmodule.exports = { aliasMap, videoIds };\n`;
  fs.writeFileSync(path.join(outputDir, 'video_ids.js'), jsOut);
  console.log('全部合成完成，片段标识已输出到 output/video_ids.js');
}

// 参数可自定义
composeVideosWithOpen(3, 10);
