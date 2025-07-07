# 视频批量剪辑与合成工具

## 目录结构

- input/   —— 待分割的原始视频文件夹
- clips/   —— 分割后的视频片段自动输出到此
- open/    —— 用作合成时开头片段的视频（可选）
- output/  —— 合成后的视频输出到此
- video_utils.js   —— 公共工具模块
- video_split.js   —— 只分割，不合成
- video_concat.js  —— 只合成，不分割
- video_batch_edit.js —— 分割+合成一体化

## 依赖环境

- Node.js 16+
- ffmpeg/ffprobe 已安装并加入环境变量
- 依赖包：fs-extra、progress

安装依赖：

```
npm install fs-extra progress
```

## 使用说明

### 1. 分割视频片段

将待处理视频放入 input 文件夹，运行：

```
node video_split.js
```

分割片段将输出到 clips 文件夹。

### 2. 合成新视频

如需用 open 文件夹中的片段作为开头，将片段放入 open 文件夹。

运行：

```
node video_concat.js
```

clips 文件夹中的片段将被随机组合，open 文件夹中的片段将被平均分配为新视频的开头。

### 3. 一体化处理

直接运行：

```
node video_batch_edit.js
```

自动完成分割和合成。

## 参数调整

- 可在各 js 文件顶部修改生成视频数量、每个视频片段数等参数。
- 合成时如 open 文件夹为空，则不会强制添加开头片段。

## 注意事项

- 建议 clips、output、open 文件夹不要手动删除片段，避免合成出错。
- 分割和合成均有进度条显示。
- 分割精度依赖 ffmpeg 场景检测和重新编码，速度与视频长度和机器性能有关。

## 常见问题

- 若无输出或报错，请检查 ffmpeg 是否安装并加入环境变量。
- 若 clips 文件夹为空，需先运行分割脚本。
- 若 open 文件夹为空，合成时不会自动加开头片段。

---
如有更多需求或问题，欢迎反馈！
