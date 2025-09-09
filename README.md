# 视频批量剪辑与合成工具

一个功能强大的视频处理工具，支持视频分割、智能合成、片段去重和相似度检测。

## 功能特性

- 🎬 **智能视频分割**：基于场景检测自动分割视频片段
- 🎵 **音频同步合成**：支持背景音乐，智能调整音视频速率
- 🔍 **片段去重检测**：基于时长和内容哈希的精确去重
- 🖼️ **相似度检测**：多帧感知哈希算法检测相似片段
- ⚙️ **灵活配置**：YAML配置文件支持参数调整
- 📊 **进度监控**：详细的进度条和日志输出
- 🗂️ **文件管理**：自动整理文件结构，避免重复处理

## 目录结构

```
video-cut-tool/
├── input/                    # 待分割的原始视频文件夹
│   ├── 未分析/              # 待处理的视频
│   └── 已分析/              # 已处理完成的视频
├── clips/                    # 分割后的视频片段
│   └── alias_map.json       # 片段别名映射文件
├── open/                     # 用作合成时开头片段的视频（可选）
├── output/                   # 合成后的视频输出
│   └── video_ids.js         # 视频ID记录文件
├── music/                    # 背景音乐文件夹（可选）
│   └── alias_map.json       # 音频提取映射文件
├── config.yaml              # 配置文件
├── video_utils.js           # 公共工具模块
├── video_split.js           # 视频分割模块
├── video_concat.js          # 视频合成模块
├── video_batch_edit.js      # 分割+合成一体化
├── extract_audio.js         # 音频提取模块
├── dedup_clips.js           # 片段去重检测
└── dedup_clips_similar.js   # 相似度检测
```

## 依赖环境

- **Node.js** 16+
- **ffmpeg/ffprobe** 已安装并加入环境变量
- **依赖包**：fs-extra、progress、js-yaml、jimp

### 安装依赖

```bash
npm install fs-extra progress js-yaml jimp
```

## 配置文件

项目使用 `config.yaml` 进行参数配置，所有脚本都会读取此配置文件中的设置：

```yaml
# 目录配置
directories:
  clipsDir: clips            # 片段输出目录
  inputDir: input/未分析     # 输入视频目录
  openDir: open              # 开头片段目录
  musicDir: music            # 音频文件目录
  audioExtractDir: music     # 音频提取输出目录
  outputDir: output          # 合成输出目录

# 视频合成参数
video_concat:
  numNewVideos: 10           # 目标生成视频数量
  clipsPerVideo: 3           # 每个视频的片段数量
  minClipDuration: 3         # 片段最短时长（秒）
  maxClipDuration: 8         # 片段最长时间（秒）
  
# 音视频调整参数
audio_video_adjustment:
  minVideoRate: 0.8          # 视频速率最小调整倍数
  maxVideoRate: 1.2          # 视频速率最大调整倍数
  minAudioRate: 0.9          # 音频速率最小调整倍数
  maxAudioRate: 1.1          # 音频速率最大调整倍数
  maxAVDiff: 0.5             # 音视频允许最大差值（秒）

# 去重检测参数
dedup:
  similarity_threshold: 85   # 相似度阈值（百分比）
  frame_positions: [10, 50, 90]  # 检测帧位置（百分比）
```

## 使用说明

### 1. 视频分割

将待处理视频放入 `input/未分析` 文件夹，运行：

```bash
node video_split.js
```

- 自动分析视频场景并分割
- 智能检查是否已处理过，避免重复分割
- 分割完成后移动到 `input/已分析` 文件夹
- 分割片段输出到 `clips` 文件夹
- 支持增量处理，新增文件会自动生成映射并分割

### 2. 视频合成

#### 基础合成
```bash
node video_concat.js
```

#### 带背景音乐的合成
1. 将音频文件放入 `music` 文件夹
2. 运行合成脚本
3. 系统会按顺序循环分配音频给每个视频

#### 带开头片段的合成
1. 将开头片段放入 `open` 文件夹
2. 运行合成脚本
3. 开头片段会被平均分配为新视频的开头

### 3. 一体化处理

```bash
node video_batch_edit.js
```

自动完成分割和合成流程。

### 4. 音频提取

从视频文件中提取音频：
```bash
node extract_audio.js
```

功能特点：
- 自动从 `input` 文件夹中的视频提取音频（包括所有子目录）
- 基于音频输出目录的映射文件判断是否已提取
- 输出到配置的音频目录（默认 `music`）
- 文件名格式：`别名_时长.mp3`
- 支持 MP3 格式，128k 比特率
- 映射关系保存在 `music/alias_map.json` 中
- 支持递归处理，自动扫描所有子目录中的视频文件

### 文件映射规则

项目使用智能文件映射系统：
- 输入文件会生成简短的别名用于片段命名
- 映射格式：`inputDir名称_简称`
- 例如：`input/冰丝打底裤` 目录下的文件会生成 `冰丝打底裤_a`、`冰丝打底裤_b` 等别名
- 映射关系保存在 `input/alias_map.json` 文件中

### 5. 片段去重检测

#### 精确去重（基于时长和内容）
```bash
node dedup_clips.js
```

检测完全重复的片段，基于：
- 视频时长
- 文件内容MD5哈希

#### 相似度检测（基于视觉内容）
```bash
node dedup_clips_similar.js
```

检测相似片段，基于：
- 多帧感知哈希（aHash）
- 汉明距离计算
- 可配置相似度阈值

## 高级功能

### 智能音视频同步

- 根据音频时长动态选择视频片段
- 优先调整视频速率，保持音频质量
- 精确裁剪确保音视频同步
- 支持配置速率调整区间

### 文件管理优化

- 自动创建时间戳子文件夹
- 生成文件包含时长和音频信息
- 自动清理临时文件
- 避免重复处理已分析视频

### 进度监控

- 主进度条显示整体进度
- 子步骤进度提示
- 详细的处理日志
- 错误重试机制
- 智能错误处理，单个视频失败不影响整体流程
- 详细的FFmpeg错误信息输出
- 路径问题自动修复，支持Windows路径分隔符
- 防止无限循环，失败次数过多时自动停止

## 输出文件命名

### 合成视频命名格式：
```
YYYY-MM-DD_HH-MM-SS/视频_时长_音频文件名.mp4
```

示例：
```
2024-01-15_14-30-25/视频_15.2s_背景音乐1.mp3.mp4
```

### 片段文件命名格式：
```
inputDir名称_简称_序号.mp4
```

示例：
```
冰丝打底裤_a_0.mp4
冰丝打底裤_a_1.mp4
冰丝打底裤_b_0.mp4
```

## 注意事项

- 确保 `ffmpeg` 已正确安装并加入环境变量
- 建议不要手动删除 `clips`、`output`、`open` 文件夹中的文件
- 分割精度依赖 ffmpeg 场景检测，处理速度与视频长度和机器性能相关
- 相似度检测需要安装 `jimp` 库进行图像处理

## 常见问题

### Q: 合成视频音频一直是同一条？
A: 检查 `music` 文件夹中是否有多个音频文件，系统会按顺序循环使用。

### Q: 进度条卡住不动？
A: 检查是否有大量视频需要处理，系统会显示详细的子步骤进度。

### Q: 相似度检测报错？
A: 确保已安装 `jimp` 库：`npm install jimp`

### Q: 没有输出或报错？
A: 检查 ffmpeg 是否安装并加入环境变量。

### Q: clips 文件夹为空？
A: 需要先运行分割脚本生成片段。

## 技术实现

- **视频处理**：基于 ffmpeg 的场景检测和音视频处理
- **图像处理**：使用 Jimp 库进行感知哈希计算
- **文件管理**：fs-extra 提供增强的文件操作
- **进度显示**：progress 库实现进度条
- **配置管理**：js-yaml 解析 YAML 配置文件

---

如有更多需求或问题，欢迎反馈！

## 6. 视频信息扫描

用于获取指定文件夹下所有视频的宽高比、码率、大小、分辨率、时长，并以 JSON 形式保存到该文件夹的 `video_info.json`。

- 使用配置目录（优先读取 `config.yaml` 的 `inputDir`，否则默认 `input/`） :
  ```powershell
  node video_scan_info.js
  ```
- 指定扫描目录：
  ```powershell
  node video_scan_info.js -d "input/811"
  node video_scan_info.js --dir clips/811
  ```

输出示例（节选）：
```json
{
  "scannedDir": "input/811",
  "generatedAt": "2024-01-01T12:00:00.000Z",
  "total": 12,
  "videos": [
    {
      "file": "a/b/c.mp4",
      "size": "12.3 MB",
      "duration": "00:00:12.345",
      "width": 1080,
      "height": 1920,
      "resolution": "1080x1920",
      "aspectRatio": "9:16",
      "aspectRatioFloat": 0.5625,
      "bitrate": { "bps": 1200000, "kbps": 1200.0 },
      "fps": 29.97
    }
  ]
}
```

注意：需要本机已安装 ffmpeg/ffprobe 并加入环境变量。

## 7. 分辨率统一（最小分辨率）

当指定文件夹中的视频分辨率小于设定最小宽高时，自动等比放大至不小于该最小分辨率（输出尺寸取偶数，避免编码器报错）。

- 在 config.yaml 中定义最小宽高（任选一种写法） :
  ```yaml
  # 顶层键
  resizeMinWidth: 720
  resizeMinHeight: 1280

  # 或嵌套写法
  resize:
    minWidth: 720
    minHeight: 1280

  # 或通用顶层键（作为兜底）
  minWidth: 720
  minHeight: 1280
  ```

- 命令示例（PowerShell）：
  ```powershell
  # 使用 config.yaml 的 inputDir（或默认 input/），输出到 _resized 保留目录结构
  node video_resize_min_resolution.js

  # 指定目录，输出到 _resized
  node video_resize_min_resolution.js -d "input/811"

  # 覆盖原文件（谨慎使用）
  node video_resize_min_resolution.js --dir clips/811 --overwrite

  # 仅预览将处理哪些文件
  node video_resize_min_resolution.js -d "input/811" --dry-run
  ```

- 说明：
  - 仅当 width < minWidth 或 height < minHeight 时才处理；
  - 按最大缩放因子等比放大，确保两边都不小于阈值；
  - 输出尺寸会向上取偶数；
  - 不覆盖时输出到“目标目录/_resized/相对路径”；
  - 需要 ffmpeg/ffprobe 可用。
