# Cent Android App — 设计文档

**日期**：2026-07-26
**版本**：v1.0
**类型**：原生混合壳（Level 2 Hybrid Native Shell）

---

## 目标

为 Cent 记账应用构建 Android 手机客户端，以 WebView 套壳 + 原生 UI 框架的方式，复用全部 React 业务代码，同时提供接近原生 App 的交互体验。通过 GitHub Release 分发 APK。

## 架构总览

```
┌──────────────────────────────────────────────────────┐
│                  Android Native Shell                 │
│  ┌──────────┐  ┌─────────────────────────────────┐   │
│  │ 原生 App  │  │         WebView 内容区           │   │
│  │  Bar     │  │                                 │   │
│  │          │  │  React Router (MemoryRouter)     │   │
│  │  [标题]  │  │  ┌──────────┐ ┌──────────────┐  │   │
│  │          │  │  │  Home    │ │  Stat        │  │   │
│  ├──────────┤  │  │  (流水)   │ │  (统计)       │  │   │
│  │          │  │  ├──────────┤ ├──────────────┤  │   │
│  │ WebView  │  │  │  Search  │ │  Settings    │  │   │
│  │          │  │  │  (搜索)   │ │  (设置)       │  │   │
│  │          │  │  └──────────┘ └──────────────┘  │   │
│  ├──────────┤  │                                 │   │
│  │ 原生底栏  │  │  ↑ 内容由 React 渲染             │   │
│  │ Tab Bar  │  │  ↑ 壳由 Kotlin 渲染              │   │
│  └──────────┘  └─────────────────────────────────┘   │
│                                                      │
│  Bridge: window.CentZenNative ↔ Kotlin Interface      │
└──────────────────────────────────────────────────────┘
```

**核心原则**：

- **壳是原生的**：App Bar、底部 Tab、FAB 按钮用 Kotlin/Jetpack Compose 写，提供原生动画、手势、触觉反馈
- **内容是 Web 的**：WebView 只渲染内容区（React Router `<Outlet />`），React 代码 100% 复用，不改业务逻辑
- **桥接借力 Zen**：`@glink25/zen` 已定义 `window.CentZenNative` 双向通信协议，Android 端对接 `CentZenNative.postMessage()`

**关键决策**：将 React `<Navigation />` 替换为原生 Tab Bar + FAB，路由状态由原生控制，通过桥接通知 WebView 切换页面。`MemoryRouter` 保持不变。

## 项目结构

```
cent-monorepo/
├── apps/
│   ├── cent/              ← 不变：现有 Vite + React
│   └── android/           ← 新建：Android (Kotlin) 项目
│       ├── build.gradle.kts
│       ├── settings.gradle.kts
│       ├── gradle.properties
│       ├── gradle/
│       │   └── wrapper/
│       └── app/
│           ├── build.gradle.kts
│           └── src/
│               └── main/
│                   ├── AndroidManifest.xml
│                   ├── assets/
│                   │   └── web/         ← pnpm build 产物放这里
│                   ├── java/com/cent/app/
│                   │   ├── MainActivity.kt
│                   │   ├── CentApplication.kt
│                   │   ├── webview/
│                   │   │   ├── CentWebViewClient.kt
│                   │   │   └── CentWebChromeClient.kt
│                   │   ├── bridge/
│                   │   │   └── CentNativeBridge.kt   ← window.CentZenNative 对接
│                   │   ├── ui/
│                   │   │   ├── MainScreen.kt         ← Scaffold: TabBar + WebView
│                   │   │   ├── BottomTabBar.kt
│                   │   │   └── FabButton.kt
│                   │   └── util/
│                   │       └── AssetLoader.kt
│                   └── res/
├── packages/             ← 不变
└── pnpm-workspace.yaml
```

- `apps/android/` 是标准 Gradle + Kotlin 项目，不在 pnpm workspace 中
- `app/src/main/assets/web/` 存放 vite build 产物
- `bridge/CentNativeBridge.kt` 用 `@JavascriptInterface` 暴露接口给 WebView
- `ui/` 用 Jetpack Compose 写原生组件

## 桥接协议

### 已有协议（Zen 模块定义）

Zen 已定义三种宿主发现优先级，Android 走第 3 条：

```
1. window.ZenHost
2. window.parent.ZenHost
3. window.CentZenNative          ← Android 使用
4. window.webkit.messageHandlers.CentZenNative  ← iOS
```

已有消息类型：

| 分类 | 消息 | 方向 |
|------|------|------|
| Component | `getInit`, `getZenContext`, `listZenPosts`, `mutateZenPosts` | Web → Native |
| AI | `requestAI`, `cancelAIRequest`, `callAITool` | Web → Native |
| All | `__ZenNativeCallbacks[id]` | Native → Web（回调） |

Android 端通过 `CentZenNative.postMessage(jsonString)` 接收，原生代码通过 `window.__ZenNativeCallbacks[id]` 回调返回结果。

### 新增扩展消息

| 方向 | 消息 | 用途 |
|------|------|------|
| Web → Native | `navigate` | Web 请求原生切换 Tab |
| Native → Web | `navigateTo(path)` | 原生点击 Tab → Web 路由跳转 |
| Web → Native | `share` | 调用 Android 系统分享面板 |
| Native → Web | `onBack()` | 原生返回键 → Web 处理返回逻辑 |

**Kotlin 桥接核心接口**：

```kotlin
class CentNativeBridge(private val context: Context) {
    
    @JavascriptInterface
    fun postMessage(json: String) {
        val msg = parseMessage(json)
        when (msg.type) {
            "getInit"       -> handleGetInit(msg.id)
            "getZenContext" -> handleGetZenContext(msg.id, msg.payload)
            "requestAI"     -> handleRequestAI(msg.id, msg.payload)
            "callAITool"    -> handleCallAITool(msg.id, msg.payload)
            "navigate"      -> handleNavigate(msg.payload)
            "share"         -> handleShare(msg.payload)
        }
    }

    fun callJS(function: String, vararg args: String) {
        webView.post {
            webView.evaluateJavascript(
                "window.$function(${args.join(",")})", null
            )
        }
    }
}
```

**设计要点**：
- 不修改 Zen 现有协议，只在 CentNativeBridge 中扩展
- JSON 序列化用 `kotlinx.serialization`
- WebView 初始化时注入 `window.CentZenNative`，确保在 React 挂载前就绪

## 原生 UI 组件

### 组件拆分

```
┌─────────────────────────────────────────┐
│  Top App Bar                            │
│  [Cent]              [🔍] [⚙️] [⋯]     │  ← 标题 + 搜索/设置入口
├─────────────────────────────────────────┤
│                                         │
│  WebView 内容区                          │
│  (Home / Stat / Search 页面组件)         │
│                                         │
├─────────────────────────────────────────┤
│  [📋 流水]  [📊 统计]  [🔍 搜索]        │  ← 原生 Bottom Tab Bar (3项)
│                                         │
└─────────────────────────────────────────┘
         ╭──────────────╮
         │  ⊕ 快速记账   │               ← 原生 FAB (Material 3, 带触觉反馈)
         ╰──────────────╯
```

### 原生侧（Kotlin / Jetpack Compose）

| 组件 | 文件 | 说明 |
|------|------|------|
| `TopAppBar` | `MainScreen.kt`（内置） | Material 3 CenterAlignedTopAppBar，标题 "Cent"，右侧搜索和设置图标 |
| `BottomTabBar` | `BottomTabBar.kt` | Material 3 NavigationBar，3 个 Tab，点击通过桥接调 `navigateTo(path)` |
| `FabButton` | `FabButton.kt` | Material 3 LargeFloatingActionButton，触觉反馈，通过桥接调 React `goAddBill()` |
| `MainScreen` | `MainScreen.kt` | Scaffold 组合上述组件 + WebView |

### WebView 侧适配（React，最小改动）

| 文件 | 改动 | 量级 |
|------|------|------|
| `components/navigation.tsx` | 检测 `window.CentZenNative` → return null | 2 行 |
| `components/add-button/` | FAB 点击逻辑暴露为全局函数，供原生 FAB 调用 | 小 |
| `components/settings/` | 设置面板支持被原生触发的独立入口 | 小（可能已有） |
| `route.tsx` | 无需改动 | 0 |

```tsx
// navigation.tsx 改动
const isAndroidNative = typeof window !== "undefined" 
  && "CentZenNative" in window;

export default function Navigation() {
  if (isAndroidNative) return null;  // 原生替代，不渲染
  // ... 原有逻辑不变
}
```

### 典型交互流：切换 Tab

```
用户点击原生 Tab "统计"
  → Kotlin: onTabSelected("/stat")
  → webView.evaluateJavascript("window.__centNavigate('/stat')")
  → React: navigate("/stat")
  → WebView 渲染 Stat 页面
```

## 构建流程

### 本地构建脚本

`scripts/build-android.sh`：

```bash
#!/bin/bash
set -e

echo "1/3 构建 Web 资源..."
pnpm --filter cent build

echo "2/3 复制到 Android assets..."
rm -rf apps/android/app/src/main/assets/web
cp -r dist apps/android/app/src/main/assets/web

echo "3/3 打包 APK..."
cd apps/android
./gradlew assembleRelease

echo "✅ APK → apps/android/app/build/outputs/apk/release/app-release.apk"
```

### CI（GitHub Actions）

`apps/android` 目录放 Android 项目，CI 配置在 `.github/workflows/android-release.yml`：

- **触发条件**：推送 `v*` tag 或手动触发（`workflow_dispatch`）
- **环境**：ubuntu-latest + Node 22 + Java 21 + pnpm 10
- **签名**：自签名 keystore，存储在 GitHub Secrets，CI 构建时注入
- **产物**：`upload-artifact` 上传 APK 到 workflow run，手动附加到 GitHub Release

### 版本号同步

以 `apps/cent/package.json` 的 `version` 字段（当前 `2.0`）为 source of truth，构建脚本读取并写入 Android `versionName`。

## 技术栈

| 层 | 技术 |
|----|------|
| Web 应用 | React 19, Vite 8, TypeScript 5.8, Tailwind CSS 4 |
| Android 壳 | Kotlin 2.x, Jetpack Compose, Material 3 |
| 构建 | Gradle (Kotlin DSL), AGP 8.x |
| 桥接 | `@JavascriptInterface` + `kotlinx.serialization` |
| 最低 Android 版本 | API 26 (Android 8.0) |
| 目标 SDK | API 35 (Android 15) |

## 不做的

- ❌ 不上架 Google Play（当前只做 GitHub Release）
- ❌ 不重写 UI 层（React 代码 100% 保留）
- ❌ 不修改 `@glink25/zen` 协议（只扩展）
- ❌ 不引入 Capacitor / Tauri / React Native 等跨平台框架
- ❌ 首版不做推送通知和桌面小组件（后续迭代再考虑）

## 实现顺序建议

1. **搭建 Android 项目骨架**：Gradle 配置、空 Activity + WebView 加载本地 HTML
2. **桥接层**：`CentNativeBridge.kt` 实现 `@JavascriptInterface`，验证双向通信
3. **原生导航栏**：BottomTabBar + FAB + TopAppBar，替代 React Navigation
4. **React 端适配**：Navigation 返回 null、暴露全局函数
5. **构建脚本 + CI**：本地脚本 + GitHub Actions
6. **内测验证**：签名 APK，真机测试
