/**
 * Electron兼容的进度条实现
 * 替代node-progress库在Electron环境中的问题
 */

class ElectronProgressBar {
  constructor(fmt, options) {
    this.fmt = fmt;
    this.curr = options.curr || 0;
    this.total = options.total || 100;
    this.width = options.width || 50;
    this.complete = options.complete || '=';
    this.incomplete = options.incomplete || '-';
    this.head = options.head || (this.complete && this.complete[this.complete.length - 1]);
    
    // 用于跟踪最后绘制的内容
    this.lastDraw = '';
    
    // 检查是否在Electron环境中运行
    this.isElectron = typeof process !== 'undefined' && 
                     typeof process.versions === 'object' && 
                     !!process.versions.electron;
    
    // 在Electron环境中存储上一次输出的行数
    this.lastLines = 0;
    
    // 初始化显示
    this.render();
  }

  /**
   * 更新进度
   */
  update(ratio) {
    const percent = Math.floor(ratio * 100);
    const completeLength = Math.round(ratio * this.width);
    const complete = Array(Math.max(0, completeLength + 1)).join(this.complete);
    const incomplete = Array(Math.max(0, this.width - completeLength + 1)).join(this.incomplete);
    
    let str = this.fmt;
    str = str.replace(':current', this.curr);
    str = str.replace(':total', this.total);
    str = str.replace(':percent', percent + '%');
    str = str.replace(':bar', complete + incomplete);
    
    if (this.isElectron) {
      // 在Electron环境中，直接输出而不使用TTY方法
      // 使用IPC发送进度更新到主进程
      if (process.send) {
        process.send({ type: 'progress', message: '\r' + str });
      } else {
        console.log(str);
      }
    } else {
      // 在普通Node环境中，使用标准输出
      // 清除上一次输出
      if (this.lastLines > 0) {
        process.stdout.write('\r\x1b[K' + str);
      } else {
        process.stdout.write('\r' + str);
      }
      this.lastLines = str.split('\n').length;
    }
    
    this.lastDraw = str;
    
    if (percent >= 100 && this.callback) {
      this.callback(this);
    }
    
    return this;
  }

  /**
   * 更新当前进度值
   */
  tick(len) {
    if (typeof len === 'number') {
      this.curr += len;
    } else {
      this.curr++;
    }
    
    const ratio = this.total > 0 ? this.curr / this.total : 0;
    this.update(ratio);
    
    return this;
  }

  /**
   * "interrupt"方法的安全实现
   * 避免使用TTY方法
   */
  interrupt(message) {
    // 通过IPC发送消息到主进程
    if (this.isElectron && process.send) {
      process.send({ type: 'log', message: message });
    } else if (this.isElectron) {
      console.log(message);
    } else {
      // 在普通Node环境中
      process.stdout.write('\n' + message + '\n');
    }
    
    // 重新显示进度条
    if (this.lastDraw) {
      if (this.isElectron && process.send) {
        process.send({ type: 'progress', message: '\r' + this.lastDraw });
      } else if (this.isElectron) {
        console.log(this.lastDraw);
      } else {
        process.stdout.write('\r' + this.lastDraw);
      }
    }
  }

  /**
   * render方法 - 重新渲染进度条
   */
  render() {
    const ratio = this.total > 0 ? this.curr / this.total : 0;
    this.update(ratio);
    return this;
  }

  /**
   * 设置完成回调
   */
  setCallback(callback) {
    this.callback = callback;
    return this;
  }
}

module.exports = ElectronProgressBar;