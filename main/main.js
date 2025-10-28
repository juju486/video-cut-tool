const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const path = require('path');
const fs = require('fs-extra');
const yaml = require('js-yaml');
const { spawn } = require('child_process');

// 定义常量
const CONFIG_FILE_PATH = path.join(__dirname, '../config.yaml');
const VIDEO_SPLIT_SCRIPT = path.join(__dirname, '../scripts/video_split.js');
const VIDEO_CONCAT_SCRIPT = path.join(__dirname, '../scripts/video_concat.js');

// 当前运行的任务
let currentTask = null;
let currentTaskType = null;

// Handle creating/removing shortcuts on Windows when installing/uninstalling.
if (require('electron-squirrel-startup')) {
  app.quit();
}

const createWindow = () => {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  // and load the index.html of the app.
  if (process.env.NODE_ENV === 'development') {
    mainWindow.loadURL('http://localhost:3000');
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }
};

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.on('ready', createWindow);

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});

// IPC handlers
ipcMain.handle('select-directory', async () => {
  const result = await dialog.showOpenDialog({
    properties: ['openDirectory']
  });
  
  if (!result.canceled) {
    return result.filePaths[0];
  }
  return null;
});

ipcMain.handle('read-config', async () => {
  try {
    if (await fs.exists(CONFIG_FILE_PATH)) {
      const configContent = await fs.readFile(CONFIG_FILE_PATH, 'utf8');
      const config = yaml.load(configContent);
      return config;
    }
    return {};
  } catch (error) {
    console.error('Failed to read config:', error);
    return {};
  }
});

ipcMain.handle('save-config', async (event, configData) => {
  try {
    // 读取现有配置
    let config = {};
    if (await fs.exists(CONFIG_FILE_PATH)) {
      const fileContents = await fs.readFile(CONFIG_FILE_PATH, 'utf8');
      config = yaml.load(fileContents) || {};
    }
    
    // 更新配置项
    config.inputDir = configData.inputDir;
    config.clipsDir = configData.clipsDir;
    config.musicDir = configData.musicDir;
    config.outputDir = configData.outputDir;
    config.videoNamePrefix = configData.videoNamePrefix;
    config.numNewVideos = parseInt(configData.numNewVideos);
    config.sceneThreshold = parseFloat(configData.sceneThreshold);
    
    // 写入配置文件
    const yamlStr = yaml.dump(config);
    await fs.writeFile(CONFIG_FILE_PATH, yamlStr, 'utf8');
    
    return { success: true };
  } catch (error) {
    console.error('Failed to save config:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('read-config-file', async () => {
  try {
    if (await fs.exists(CONFIG_FILE_PATH)) {
      const configContent = await fs.readFile(CONFIG_FILE_PATH, 'utf8');
      return configContent;
    }
    return '';
  } catch (error) {
    console.error('Failed to read config file:', error);
    throw error;
  }
});

ipcMain.handle('save-config-file', async (event, configContent) => {
  try {
    await fs.writeFile(CONFIG_FILE_PATH, configContent, 'utf8');
    return { success: true };
  } catch (error) {
    console.error('Failed to save config file:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('run-video-split', async (event) => {
  // 检查是否有任务正在运行
  if (currentTask) {
    return { success: false, error: `有任务正在运行: ${currentTaskType}` };
  }

  return new Promise((resolve) => {
    // 检查脚本文件是否存在
    if (!fs.existsSync(VIDEO_SPLIT_SCRIPT)) {
      resolve({ success: false, error: '视频分割脚本不存在' });
      return;
    }

    // 执行视频分割脚本，添加环境变量以修复progress库兼容性问题
    currentTask = spawn('node', [VIDEO_SPLIT_SCRIPT], {
      cwd: path.dirname(VIDEO_SPLIT_SCRIPT),
      env: {
        ...process.env,
        // 禁用progress库的TTY相关功能以避免Electron环境中的兼容性问题
        PROGRESS_NO_TTY: '1',
        FORCE_COLOR: '0',
        // 明确指定标准输入输出流，避免TTY相关问题
        ELECTRON_RUN_AS_NODE: '1'
      },
      stdio: ['pipe', 'pipe', 'pipe', 'ipc']
    });
    
    currentTaskType = '视频分割';

    let stdout = '';
    let stderr = '';

    currentTask.stdout.on('data', (data) => {
      stdout += data.toString();
      // 发送进度信息到渲染进程
      event.sender.send('log-message', data.toString());
    });

    currentTask.stderr.on('data', (data) => {
      stderr += data.toString();
      // 发送错误信息到渲染进程
      event.sender.send('log-message', data.toString());
    });

    // 处理来自子进程的IPC消息
    currentTask.on('message', (message) => {
      if (message && message.type === 'progress') {
        // 发送进度更新到渲染进程
        event.sender.send('update-progress-message', message.message);
      } else if (message && message.type === 'log') {
        // 发送日志消息到渲染进程
        event.sender.send('log-message', message.message);
      }
    });

    currentTask.on('close', (code) => {
      const taskType = currentTaskType;
      currentTask = null;
      currentTaskType = null;
      
      if (code === 0) {
        resolve({ success: true, message: `${taskType}完成` });
      } else {
        resolve({ success: false, error: `脚本执行失败，退出码: ${code}`, stdout, stderr });
      }
    });

    currentTask.on('error', (error) => {
      currentTask = null;
      currentTaskType = null;
      resolve({ success: false, error: `启动脚本失败: ${error.message}` });
    });
  });
});

ipcMain.handle('run-video-concat', async (event) => {
  // 检查是否有任务正在运行
  if (currentTask) {
    return { success: false, error: `有任务正在运行: ${currentTaskType}` };
  }

  return new Promise((resolve) => {
    // 检查脚本文件是否存在
    if (!fs.existsSync(VIDEO_CONCAT_SCRIPT)) {
      resolve({ success: false, error: '视频合成脚本不存在' });
      return;
    }

    // 执行视频合成脚本，添加环境变量以修复progress库兼容性问题
    currentTask = spawn('node', [VIDEO_CONCAT_SCRIPT], {
      cwd: path.dirname(VIDEO_CONCAT_SCRIPT),
      env: {
        ...process.env,
        // 禁用progress库的TTY相关功能以避免Electron环境中的兼容性问题
        PROGRESS_NO_TTY: '1',
        FORCE_COLOR: '0',
        // 明确指定标准输入输出流，避免TTY相关问题
        ELECTRON_RUN_AS_NODE: '1'
      },
      stdio: ['pipe', 'pipe', 'pipe', 'ipc']
    });
    
    currentTaskType = '视频合成';

    let stdout = '';
    let stderr = '';

    currentTask.stdout.on('data', (data) => {
      stdout += data.toString();
      // 发送进度信息到渲染进程
      event.sender.send('log-message', data.toString());
    });

    currentTask.stderr.on('data', (data) => {
      stderr += data.toString();
      // 发送错误信息到渲染进程
      event.sender.send('log-message', data.toString());
    });

    // 处理来自子进程的IPC消息
    currentTask.on('message', (message) => {
      if (message && message.type === 'progress') {
        // 发送进度更新到渲染进程
        event.sender.send('update-progress-message', message.message);
      } else if (message && message.type === 'log') {
        // 发送日志消息到渲染进程
        event.sender.send('log-message', message.message);
      }
    });

    currentTask.on('close', (code) => {
      const taskType = currentTaskType;
      currentTask = null;
      currentTaskType = null;
      
      if (code === 0) {
        resolve({ success: true, message: `${taskType}完成` });
      } else {
        resolve({ success: false, error: `脚本执行失败，退出码: ${code}`, stdout, stderr });
      }
    });

    currentTask.on('error', (error) => {
      currentTask = null;
      currentTaskType = null;
      resolve({ success: false, error: `启动脚本失败: ${error.message}` });
    });
  });
});

ipcMain.handle('stop-current-task', async () => {
  if (currentTask) {
    try {
      // 终止当前任务
      currentTask.kill('SIGTERM');
      const taskType = currentTaskType;
      currentTask = null;
      currentTaskType = null;
      return { success: true, message: `已停止${taskType}任务` };
    } catch (error) {
      return { success: false, error: `停止任务失败: ${error.message}` };
    }
  } else {
    return { success: false, error: '当前没有正在运行的任务' };
  }
});

ipcMain.handle('get-directories', async () => {
  try {
    const basePath = path.join(__dirname, '../');
    const directories = await fs.readdir(basePath, { withFileTypes: true });
    const dirs = directories
      .filter(dirent => dirent.isDirectory())
      .map(dirent => dirent.name);
    return dirs;
  } catch (error) {
    console.error('Failed to get directories:', error);
    return [];
  }
});

ipcMain.handle('get-directory-content', async (event, dirPath) => {
  try {
    const fullPath = path.join(__dirname, '../', dirPath);
    const items = await fs.readdir(fullPath, { withFileTypes: true });
    const content = items.map(item => ({
      name: item.name,
      isDirectory: item.isDirectory(),
      path: path.join(dirPath, item.name)
    }));
    return content;
  } catch (error) {
    console.error(`Failed to get content of directory ${dirPath}:`, error);
    return [];
  }
});

ipcMain.handle('open-directory', async (event, dirPath) => {
  if (!dirPath) {
    return { success: false, error: '目录路径不能为空' };
  }

  try {
    // 确保路径是相对于项目根路径的
    const projectRoot = path.join(__dirname, '../');
    let fullPath = dirPath;
    
    // 如果路径不是绝对路径，则将其解析为相对于项目根路径
    if (!path.isAbsolute(dirPath)) {
      fullPath = path.join(projectRoot, dirPath);
    }
    
    // 检查目录是否存在
    if (!fs.existsSync(fullPath)) {
      // 尝试创建目录
      await fs.ensureDir(fullPath);
    }

    // 使用系统默认方式打开目录
    shell.openPath(fullPath);
    return { success: true };
  } catch (error) {
    console.error('Failed to open directory:', error);
    return { success: false, error: error.message };
  }
});

ipcMain.handle('play-sound', async (event, type) => {
  try {
    // 使用系统提示音
    if (type === 'success') {
      // 在Windows上播放系统默认提示音（成功）
      if (process.platform === 'win32') {
        // 使用PowerShell播放系统提示音
        const { exec } = require('child_process');
        exec('powershell -c "[console]::beep(800, 200); [console]::beep(1000, 200); [console]::beep(1200, 300)"');
      } else {
        // 在其他平台上播放提示音
        process.stdout.write('\x07');
      }
    } else if (type === 'error') {
      // 在Windows上播放系统默认提示音（错误）
      if (process.platform === 'win32') {
        // 使用PowerShell播放系统错误提示音
        const { exec } = require('child_process');
        exec('powershell -c "[console]::beep(200, 500)"');
      } else {
        // 在其他平台上播放错误提示音
        process.stdout.write('\x07');
      }
    }
    
    return { success: true };
  } catch (error) {
    console.error('Failed to play sound:', error);
    return { success: false, error: error.message };
  }
});
