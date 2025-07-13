const path = require('path');
// 用于生成 alias_map 的键名
function getAliasKey(inputDir, fileName) {
  let dirKey = path.basename(inputDir.replace(/[\\/]+$/, ''));
  // 如果目录名是'未分析'，则用上一级目录名
  if (dirKey === '未分析') {
    dirKey = path.basename(path.dirname(inputDir));
  }
  const baseName = path.parse(fileName).name;
  return `${dirKey}_${baseName}`;
}

module.exports = { getAliasKey }; 