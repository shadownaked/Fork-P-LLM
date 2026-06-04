# Plan: 为 Fork-P-LLM 构建 Windows x64 可执行文件

## 摘要

为 `shadownaked/Fork-P-LLM` 仓库添加 electron-builder 构建配置，通过 GitHub Actions CI 自动生成 Win11 x64 的 **安装版 EXE（NSIS）** 和 **便携版 EXE（Portable）**。

---

## 当前状态分析

### 项目架构
- **Electron 主进程**：`src/` → TypeScript 编译到 `dist/`
- **React 渲染进程**：`renderer/src/` → Vite 构建到 `renderer/dist/`
- **生产模式路径**：[main.ts#L389](file:///workspace/Fork-P-LLM/src/main.ts#L389) 中 `getRendererPath()` 在 packaged 模式下查找 `resources/renderer/index.html`

### 当前缺失
| 项目 | 状态 |
|------|------|
| `electron-builder` 依赖 | 未安装 |
| `"build"` 配置（electron-builder） | 不存在 |
| `"dist:win"` npm script | 不存在（CI 引用但未定义） |
| `.gitignore` 中 `release/` | 未排除 |
| CI artifact glob 路径 | 不匹配 electron-builder 的实际输出命名 |

### 已有 CI 工作流
[build-windows.yml](file:///workspace/Fork-P-LLM/.github/workflows/build-windows.yml) 已存在，包含：
- 使用 npmmirror 镜像加速
- `npm ci` 安装依赖
- 构建流程：`renderer build` → `tsc` → `npm run dist:win`
- Artifact 上传（glob 路径需要修正）

---

## 修改计划

### 1. `package.json` — 添加 electron-builder 和构建配置

**修改内容**：

#### 1a. 添加 `electron-builder` 到 devDependencies
```json
"electron-builder": "^25.1.8"
```

#### 1b. 添加 `"build"` 配置（electron-builder）
```json
"build": {
  "appId": "com.proxyllm.app",
  "productName": "ProxyLLM",
  "directories": {
    "output": "release"
  },
  "files": [
    "dist/**/*",
    "config/**/*",
    "package.json"
  ],
  "extraResources": [
    {
      "from": "renderer/dist",
      "to": "renderer"
    }
  ],
  "win": {
    "target": [
      {
        "target": "nsis",
        "arch": ["x64"]
      },
      {
        "target": "portable",
        "arch": ["x64"]
      }
    ]
  },
  "nsis": {
    "oneClick": false,
    "allowToChangeInstallationDirectory": true
  }
}
```

**说明**：
- `files`：主进程编译产物 `dist/` + 配置 `config/` 打入 asar
- `extraResources`：将 `renderer/dist/` 的内容复制到 `resources/renderer/`，与 [main.ts#L389](file:///workspace/Fork-P-LLM/src/main.ts#L389) 的生产路径 `resources/renderer/index.html` 对应
- `win.target`：同时生成 NSIS 安装版和 portable 便携版，均为 x64

#### 1c. 添加 `"dist:win"` script
```json
"dist:win": "electron-builder --win --x64"
```

---

### 2. `.gitignore` — 排除构建产物

添加 `release/` 到 `.gitignore`，防止 CI 构建产物被误提交。

---

### 3. `.github/workflows/build-windows.yml` — 修正 artifact 路径

将 artifact 上传的 glob 从：
```yaml
release/ProxyLLM Setup*.exe
release/ProxyLLM-*.exe
```
改为：
```yaml
release/*.exe
```

**原因**：electron-builder 的 NSIS 输出为 `ProxyLLM Setup 1.0.0.exe`，Portable 输出为 `ProxyLLM 1.0.0.exe`（无横杠）。用 `release/*.exe` 统一匹配所有 exe。

---

### 4. 提交推送触发 CI

修改完成后，commit 并 push 到 `main` 分支，CI 将自动触发构建。

---

## 假设与决策

1. **GitHub Actions runner**：使用 `windows-latest`（Windows Server 2022/2025），与 Win11 x64 二进制兼容
2. **electron-builder 版本**：`^25.1.8`，当前稳定版本，支持 NSIS + portable 双目标
3. **架构**：仅 x64，不包含 arm64
4. **不需要代码签名**：未配置证书，生成的 exe 在运行时会有 Windows SmartScreen 警告，但可正常运行
5. **renderer/index.html**：Vite 构建后生成的是 SPA 入口，所有资源路径为相对路径 `./assets/...`，`extraResources` 方案保持路径结构不变

---

## 验证步骤

1. 推送后观察 GitHub Actions 运行状态
2. 确认 CI 构建成功，Artifact 中包含两个 exe 文件：
   - `ProxyLLM Setup 1.0.0.exe`（安装版）
   - `ProxyLLM 1.0.0.exe`（便携版）
3. 下载 Artifact 在 Win11 x64 上测试运行