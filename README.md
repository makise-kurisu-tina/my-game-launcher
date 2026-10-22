# My Game Launcher

面向 Windows 的本地游戏启动器。它不接管游戏安装，也不修改游戏文件，只做一件事：把你散落在各个文件夹里的 `.exe` 收进一个统一的库，从这里启动，并记录每款游戏实际玩了多少时间。

## 功能

**游戏库**
- 选择 `.exe` 导入游戏，自动推导工作目录
- 编辑名称、分类与启动参数
- 收藏、搜索、按名称 / 最近启动 / 游玩时长排序
- 右键卡片可移出游戏库、编辑或打开所在文件夹
- 移除记录不会删除本地的游戏文件

**启动与统计**
- 从库中直接启动游戏，启动后自动统计本次游玩时长并累加到总时长
- 记录最近启动时间与启动次数
- 运行中的游戏可以一键停止（结束整个进程树）
- 关闭启动器不会结束正在运行的游戏；下次打开时会重新接管这些进程的追踪与计时

**封面**
- 从 Steam 搜索封面并下载到本地缓存，也可以选择本地图片
- 封面以自定义协议从缓存目录直接加载，不占用页面内存

**数据**
- 游戏库、封面缓存、窗口大小与运行状态全部保存在本机
- 深色 / 浅色 / 跟随系统三种主题
- 重新扫描路径、移除失效记录、导入 / 导出 JSON 备份

## 环境要求

- Windows 10 / 11
- Node.js 18 或更高版本

## 开发

```powershell
npm install
npm start
```

## 打包

```powershell
npm run dist
```

`dist` 前会先执行 `npm run icon`，从 `build/icon.svg` 生成打包所需的多尺寸 `build/icon-convert/icon.ico`。
安装包输出到 `dist/` 目录（`My-Game-Launcher-<版本>-Setup.exe`）。

只做免安装目录版可以用：

```powershell
npm run pack
```

## 数据存放位置

应用数据保存在 `%APPDATA%\my-game-launcher`：

| 文件 / 目录 | 说明 |
| --- | --- |
| `library/games.json` | 游戏库数据 |
| `library/covers/` | 下载或选择的封面缓存 |
| `window-state.json` | 上次的窗口尺寸 |
| `running.json` | 仍在运行的游戏进程快照 |

在应用内点击「打开数据文件夹」可以直接跳转过去。删除整个目录等同于恢复出厂设置。

## 项目结构

```
main.js              主进程：窗口、IPC、进程管理、封面协议、数据读写
preload.js           通过 contextBridge 暴露给渲染层的受限 API
renderer/
  index.html         界面结构
  styles.css         样式与主题变量
  app.js             渲染层逻辑
scripts/make-icon.mjs  从 SVG 生成 ico（打包前自动执行）
build/icon.svg       图标源文件
```

渲染层不启用 Node 集成，开启上下文隔离与沙箱，仅能通过 `preload.js` 暴露的接口访问系统能力；封面读取走自定义 `cover://` 协议，并限制在封面缓存目录内。

## License

MIT
