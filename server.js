const express = require("express");
const axios = require("axios");
const path = require("path");
const cors = require("cors");
const http = require("http");
const os = require("os");
const fs = require("fs");
const multer = require("multer");
const { exec } = require("child_process");
const { promisify } = require("util");
const execAsync = promisify(exec);

// ==========================================
// 1. 全局配置与环境初始化
// ==========================================
const SERVER_PORT = process.env.PORT || 3000;
const WDA_PORT = process.env.WDA_PORT || 8100;
const MJPEG_PORT = process.env.MJPEG_PORT || 9100;

// 尝试自动获取 tidevice 路径，如果环境变量没设，则尝试默认路径
const USER_HOME = os.homedir();
const TIDEVICE_PATH =
  process.env.TIDEVICE_PATH ||
  path.join(USER_HOME, "Library/Python/3.9/bin/tidevice");

const WDA_CTRL = `http://127.0.0.1:${WDA_PORT}`;
const MJPEG_URL = `http://127.0.0.1:${MJPEG_PORT}`;
const CHROME_BUNDLE_ID = "com.google.chrome.ios";
const CHROME_FOLDER_NAME = "Chrome";

console.log(`🔧 服务启动配置:`);
console.log(`   - Web控制台: http://localhost:${SERVER_PORT}`);
console.log(`   - WDA控制:   ${WDA_CTRL}`);
console.log(`   - 视频流:    ${MJPEG_URL}`);
console.log(`   - TiDevice:  ${TIDEVICE_PATH}`);

const app = express();
app.use(cors());
app.use(express.json());

// 内存中缓存设备配置，避免频繁读盘
let cachedDeviceConfig = null;
const configPath = path.join(__dirname, "config.json");

function loadDeviceConfig() {
  try {
    if (fs.existsSync(configPath)) {
      cachedDeviceConfig = JSON.parse(fs.readFileSync(configPath, "utf8"));
      console.log("📄 设备配置文件已加载");
    }
  } catch (e) {
    console.error("⚠️ 配置文件加载失败:", e.message);
  }
}
// 启动加载并监听变化
loadDeviceConfig();
fs.watchFile(configPath, () => {
  console.log("🔄 检测到配置文件变化，重新加载...");
  loadDeviceConfig();
});

// Multer 配置
const upload = multer({
  dest: path.join(__dirname, "uploads"),
  limits: { fileSize: 2 * 1024 * 1024 * 1024 }, // 2GB
});

// ==========================================
// 2. WDA Session 管理 (核心优化: 健壮性)
// ==========================================
let _currentSessionId = null;

/**
 * 智能获取 Session ID
 * 1. 检查内存中是否有 ID
 * 2. 检查 WDA 状态，验证 ID 是否存活
 * 3. 如果失效，自动创建新 Session 并应用优化配置
 */
async function getSessionId() {
  // 1. 尝试复用并验证
  if (_currentSessionId) {
    // 并不是每次都请求 status，可以加个简单的内存时间戳优化，这里为了稳健每次都查一下
    // 但为了性能，我们假设如果最近10秒用过就是好的？为了绝对稳健，还是走一下catch
    try {
      // 简单的一个 ping 操作来保活
      await axios.get(`${WDA_CTRL}/session/${_currentSessionId}/status`, {
        timeout: 1000,
      });
      return _currentSessionId;
    } catch (e) {
      console.log("⚠️ Session 失效，准备重建...");
      _currentSessionId = null;
    }
  }

  // 2. 尝试从 WDA 获取现有 Session (避免重复创建)
  try {
    const statusRes = await axios.get(`${WDA_CTRL}/status`, { timeout: 2000 });
    if (statusRes.data.sessionId) {
      _currentSessionId = statusRes.data.sessionId;
      await configureWdaSettings(_currentSessionId);
      return _currentSessionId;
    }
  } catch (e) {
    console.log("⚠️ WDA 未响应或无 Session:", e.message);
  }

  // 3. 创建新 Session
  console.log("🔄 正在创建新的 WDA Session...");
  try {
    const createRes = await axios.post(`${WDA_CTRL}/session`, {
      capabilities: {
        alwaysMatch: {
          arguments: [],
          environment: {},
          shouldWaitForQuiescence: false, // 关键：禁止 WDA 等待页面静止，大幅提升动态页面响应
        },
      },
    });
    _currentSessionId = createRes.data.sessionId;
    await configureWdaSettings(_currentSessionId);
    console.log(`✅ 新 Session 创建成功: ${_currentSessionId}`);
    return _currentSessionId;
  } catch (error) {
    console.error("❌ 致命错误: 无法创建 WDA Session", error.message);
    throw error;
  }
}

/**
 * 下发 WDA 优化配置 (解决 TikTok 卡顿的关键)
 */
async function configureWdaSettings(sessionId) {
  try {
    console.log(`⚙️ 正在应用 WDA 性能优化参数...`);
    await axios.post(`${WDA_CTRL}/session/${sessionId}/appium/settings`, {
      settings: {
        // 截图质量 (1-100)，越低越快
        mjpegServerScreenshotQuality: 10,
        // 帧率限制，防止 USB 拥堵
        mjpegServerFramerate: 10,
        // 缩放比例 (1-100)，50表示宽高各缩小一半，数据量减少75%
        mjpegScalingFactor: 25,
        // 截图类型优化
        screenshotQuality: 1,
        // 禁用动画检测，提升操作响应
        waitForIdleTimeout: 0,
      },
    });
  } catch (e) {
    console.warn("⚠️ WDA 配置应用部分失败 (可能 WDA 版本过低)，但不影响运行");
  }
}

// 缓存屏幕尺寸
let _deviceSize = null;
async function getScreenSize() {
  if (_deviceSize) return _deviceSize;
  try {
    const sid = await getSessionId();
    const res = await axios.get(`${WDA_CTRL}/session/${sid}/window/rect`);
    _deviceSize = {
      width: res.data.value.width,
      height: res.data.value.height,
    };
    return _deviceSize;
  } catch (e) {
    return { width: 375, height: 812 }; // 默认值 fallback
  }
}

// ==========================================
// 3. 工具函数: 智能等待与查找
// ==========================================

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 核心工具: 轮询查找元素，直到超时 (替代 setTimeout)
async function waitForElement(sessionId, text, timeout = 5000) {
  const startTime = Date.now();
  while (Date.now() - startTime < timeout) {
    try {
      // 尝试 Label 匹配
      let body = {
        using: "class chain",
        value: `**/XCUIElementTypeButton[\`label CONTAINS "${text}"\`]`,
      };
      let res = await axios.post(
        `${WDA_CTRL}/session/${sessionId}/element`,
        body
      );

      if (!res.data.value.ELEMENT) {
        // 尝试 StaticText 匹配
        body.value = `**/XCUIElementTypeStaticText[\`label CONTAINS "${text}"\`]`;
        res = await axios.post(
          `${WDA_CTRL}/session/${sessionId}/element`,
          body
        );
      }

      if (res.data.value.ELEMENT) {
        return res.data.value.ELEMENT; // 找到了
      }
    } catch (e) {}
    await sleep(500); // 没找到，休息 0.5s 再试
  }
  return null; // 超时没找到
}

// 点击指定的元素 ID
async function clickElement(sessionId, elementId) {
  try {
    await axios.post(
      `${WDA_CTRL}/session/${sessionId}/element/${elementId}/click`
    );
    return true;
  } catch (e) {
    return false;
  }
}

// ==========================================
// 4. 业务逻辑: Chrome 文件自动化保存
// ==========================================
async function saveFromChromeFolder(filename) {
  const sessionId = await getSessionId();
  const screen = await getScreenSize();

  console.log(`🤖 [WDA] 启动“文件”App...`);
  await axios.post(
    `${WDA_CTRL}/session/${sessionId}/appium/device/activate_app`,
    {
      bundleId: "com.apple.DocumentsApp",
    }
  );

  // 辅助：查找并点击
  const findAndTap = async (text, timeout = 3000) => {
    const el = await waitForElement(sessionId, text, timeout);
    if (el) {
      console.log(`    🖱️ 点击: ${text}`);
      await clickElement(sessionId, el);
      return true;
    }
    return false;
  };

  // 1. 回退到根目录 (尝试多次)
  await findAndTap("浏览", 2000);
  await findAndTap("浏览", 1000);

  // 2. 进入本地存储
  let entered = await findAndTap("我的 iPhone");
  if (!entered) entered = await findAndTap("On My iPhone");

  // 3. 进入 Chrome 文件夹
  // 如果没找到 Chrome 文件夹，可能是界面没刷新或在下面，稍微滑一下
  let folderEl = await waitForElement(sessionId, CHROME_FOLDER_NAME, 3000);
  if (!folderEl) {
    console.log("    👇 没找到文件夹，尝试下滑刷新...");
    // 执行一个下滑动作
    await axios.post(`${WDA_CTRL}/session/${sessionId}/actions`, {
      actions: [
        {
          type: "pointer",
          id: "finger1",
          parameters: { pointerType: "touch" },
          actions: [
            { type: "pointerMove", duration: 0, x: 200, y: 300 },
            { type: "pointerDown", button: 0 },
            { type: "pointerMove", duration: 300, x: 200, y: 600 }, // 下拉
            { type: "pointerUp", button: 0 },
          ],
        },
      ],
    });
    await sleep(1000);
  }

  const folderClicked = await findAndTap(CHROME_FOLDER_NAME, 3000);

  if (folderClicked) {
    // 4. 点击具体文件
    console.log(`    📁 寻找文件: ${filename}`);
    // 文件出现可能需要一点时间（iCloud 同步等），给 5 秒
    const fileClicked = await findAndTap(filename, 5000);

    if (fileClicked) {
      await sleep(1500); // 等待预览图加载
      console.log(`    🚀 点击分享按钮...`);
      // 分享按钮通常没有文字，只能靠左下角坐标
      // iPhone 左下角坐标 (安全区内)
      await axios.post(`${WDA_CTRL}/session/${sessionId}/actions`, {
        actions: [
          {
            type: "pointer",
            id: "finger1",
            parameters: { pointerType: "touch" },
            actions: [
              {
                type: "pointerMove",
                duration: 0,
                x: 30,
                y: screen.height - 50,
              },
              { type: "pointerDown", button: 0 },
              { type: "pause", duration: 100 },
              { type: "pointerUp", button: 0 },
            ],
          },
        ],
      });

      // 5. 等待分享菜单弹出并保存
      console.log(`    💾 寻找保存按钮...`);
      await sleep(1000); // 菜单动画

      const ext = filename.toLowerCase().split(".").pop();
      const isImage = ["jpg", "jpeg", "png", "heic"].includes(ext);

      const targets = isImage
        ? ["存储图像", "存储到照片", "Save Image", "Save to Photos"]
        : ["保存视频", "存储视频", "Save Video"];

      for (const t of targets) {
        if (await findAndTap(t, 1000)) {
          console.log(`✅ [成功] 已点击 "${t}"`);
          break;
        }
      }
    } else {
      console.error(`❌ 超时未找到文件: ${filename}`);
    }
  } else {
    console.error(`❌ 未找到 Chrome 文件夹`);
  }
}

// ==========================================
// 5. API 路由定义
// ==========================================

// --- 设备 UDID 查找逻辑 ---
function getDeviceUDID() {
  if (!cachedDeviceConfig) loadDeviceConfig();
  if (!cachedDeviceConfig) return null;

  // 逻辑：通过当前运行的 SERVER_PORT 反推是哪个设备
  // 假设 config.json 里 defined: local_port (WDA), web_port (Server)

  // 1. 尝试直接匹配 web_port
  let device = cachedDeviceConfig.devices.find(
    (d) => d.enable && d.local_port + 2 === Number(SERVER_PORT)
  );
  // 2. 尝试匹配 wda_port
  if (!device)
    device = cachedDeviceConfig.devices.find(
      (d) => d.enable && d.local_port === Number(WDA_PORT)
    );

  return device ? device.udid : null;
}

// --- 视频流代理 (MJPEG) ---
app.get("/api/stream", (req, res) => {
  res.set({
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Content-Type": "multipart/x-mixed-replace; boundary=--BoundaryString", // 预设 Header，防止 WDA 还没返回时浏览器不知道类型
  });

  const proxyReq = http.get(MJPEG_URL, (streamRes) => {
    // 透传 Header，特别是 Content-Type
    res.writeHead(streamRes.statusCode, streamRes.headers);
    streamRes.pipe(res);
  });

  proxyReq.on("error", (e) => {
    // 静默失败，不要崩溃
    if (!res.headersSent) res.status(500).end();
  });

  // 客户端关闭页面时，立即断开与 WDA 的连接，节省带宽
  req.on("close", () => {
    proxyReq.destroy();
  });
});

// --- 文件上传 ---
app.post("/api/upload", upload.single("video"), async (req, res) => {
  console.log(`[API] /api/upload - File: ${req.file?.originalname}`);
  if (!req.file) return res.status(400).json({ error: "No file" });

  const udid = getDeviceUDID();
  if (!udid) {
    fs.unlinkSync(req.file.path);
    return res.status(500).json({ error: "Device mapping failed" });
  }

  const remotePath = `/Documents/${req.file.originalname}`;
  const cmd = `"${TIDEVICE_PATH}" -u ${udid} fsync -B ${CHROME_BUNDLE_ID} push "${req.file.path}" "${remotePath}"`;

  try {
    console.log(`    执行推流: ${cmd}`);
    await execAsync(cmd);

    // 异步触发自动化，不阻塞 HTTP 响应
    saveFromChromeFolder(req.file.originalname).catch((e) =>
      console.error("Auto-save failed:", e)
    );

    res.json({ success: true, message: "File pushed, processing..." });
  } catch (e) {
    console.error("Upload failed:", e.message);
    res.status(500).json({ error: e.message });
  } finally {
    // 清理临时文件
    if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
  }
});

// --- 触摸操作 (Tap) ---
app.post("/api/tap", async (req, res) => {
  try {
    const { x, y, viewWidth, viewHeight } = req.body;
    const screen = await getScreenSize();

    const realX = Math.round((x / viewWidth) * screen.width);
    const realY = Math.round((y / viewHeight) * screen.height);

    const sid = await getSessionId();

    // 使用 perform action
    await axios.post(`${WDA_CTRL}/session/${sid}/actions`, {
      actions: [
        {
          type: "pointer",
          id: "finger1",
          parameters: { pointerType: "touch" },
          actions: [
            { type: "pointerMove", duration: 0, x: realX, y: realY },
            { type: "pointerDown", button: 0 },
            { type: "pause", duration: 50 },
            { type: "pointerUp", button: 0 },
          ],
        },
      ],
    });
    res.json({ success: true });
  } catch (e) {
    console.error("Tap failed:", e.message);
    // 如果是因为 Session 无效导致的，置空它
    if (e.message.includes("session")) _currentSessionId = null;
    res.status(500).json({ error: e.message });
  }
});

// --- 滑动操作 (Swipe) ---
app.post("/api/swipe", async (req, res) => {
  // Fire-and-forget 模式，提高手感
  res.json({ success: true });

  try {
    const { startX, startY, endX, endY, viewWidth, viewHeight } = req.body;
    const screen = await getScreenSize();
    const sid = await getSessionId();

    const rSX = Math.round((startX / viewWidth) * screen.width);
    const rSY = Math.round((startY / viewHeight) * screen.height);
    const rEX = Math.round((endX / viewWidth) * screen.width);
    const rEY = Math.round((endY / viewHeight) * screen.height);

    // 快速滑动: duration 设小一点 (比如 50-100ms)
    await axios.post(`${WDA_CTRL}/session/${sid}/actions`, {
      actions: [
        {
          type: "pointer",
          id: "finger1",
          parameters: { pointerType: "touch" },
          actions: [
            { type: "pointerMove", duration: 0, x: rSX, y: rSY },
            { type: "pointerDown", button: 0 },
            { type: "pointerMove", duration: 100, x: rEX, y: rEY },
            { type: "pointerUp", button: 0 },
          ],
        },
      ],
    });
  } catch (e) {
    console.error("Swipe bg error:", e.message);
  }
});

// --- Home 键 ---
app.post("/api/home", async (req, res) => {
  try {
    await axios.post(`${WDA_CTRL}/wda/homescreen`);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// --- 剪贴板同步 (PC -> iOS) ---
app.post("/api/clipboard", async (req, res) => {
  try {
    const text = req.body.text || (await execAsync("pbpaste")).stdout.trim();
    if (!text) return res.status(400).json({ error: "Empty text" });

    const sid = await getSessionId();
    const base64Content = Buffer.from(text).toString("base64");

    // 1. 直接尝试设置
    try {
      await axios.post(`${WDA_CTRL}/session/${sid}/wda/setPasteboard`, {
        content: base64Content,
        contentType: "plaintext",
        label: "RemoteCopy",
      });
    } catch (e) {
      // 2. 如果失败，可能是 App 未激活，激活 Runner 再试
      console.log("尝试激活 Runner 后重试粘贴板...");
      await axios.post(`${WDA_CTRL}/session/${sid}/wda/apps/launch`, {
        bundleId: "com.woodrain.xiao.xctrunner",
      });
      await sleep(1000);
      await axios.post(`${WDA_CTRL}/session/${sid}/wda/setPasteboard`, {
        content: base64Content,
        contentType: "plaintext",
        label: "RemoteCopy",
      });
    }

    // 3. 自动切回桌面 (可选，看需求)
    await axios.post(`${WDA_CTRL}/wda/homescreen`);

    res.json({ success: true });
  } catch (e) {
    console.error("Clipboard failed:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// 获取本机 IP
function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === "IPv4" && !iface.internal) return iface.address;
    }
  }
  return "localhost";
}

app.listen(SERVER_PORT, "0.0.0.0", () => {
  console.log(`🚀 服务运行中: http://${getLocalIP()}:${SERVER_PORT}`);
});
