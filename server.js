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

const app = express();
app.use(cors());
app.use(express.json());

// ==========================================
// 高级网络客户端配置
// ==========================================
const httpAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 10,
  keepAliveMsecs: 1000,
});

const wdaClient = axios.create({
  baseURL: WDA_CTRL,
  timeout: 20000, // 10秒超时
  httpAgent: httpAgent,
  headers: {
    Connection: "keep-alive",
    "Content-Type": "application/json",
  },
});

wdaClient.interceptors.response.use(null, async (error) => {
  const { config } = error;
  if (!config || config.__isRetry) return Promise.reject(error);
  if (
    error.code === "ECONNABORTED" ||
    (error.message && error.message.includes("Network Error"))
  ) {
    console.warn(`⚠️ 请求超时，尝试自动重试: ${config.url}`);
    config.__isRetry = true;
    try {
      return await wdaClient(config);
    } catch (retryError) {
      return Promise.reject(retryError);
    }
  }
  return Promise.reject(error);
});

// ==========================================
// 配置文件管理
// ==========================================
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
loadDeviceConfig();
fs.watchFile(configPath, () => {
  console.log("🔄 检测到配置文件变化，重新加载...");
  loadDeviceConfig();
});

const upload = multer({
  dest: path.join(__dirname, "uploads"),
  limits: { fileSize: 2 * 1024 * 1024 * 1024 },
});

// ==========================================
// 2. WDA Session 管理
// ==========================================
let _currentSessionId = null;

async function getSessionId() {
  if (_currentSessionId) {
    try {
      await wdaClient.get(`/session/${_currentSessionId}/status`, {
        timeout: 1000,
      });
      return _currentSessionId;
    } catch (e) {
      _currentSessionId = null;
    }
  }

  try {
    const statusRes = await wdaClient.get("/status", { timeout: 2000 });
    if (statusRes.data.sessionId) {
      _currentSessionId = statusRes.data.sessionId;
      await configureWdaSettings(_currentSessionId);
      return _currentSessionId;
    }
  } catch (e) {}

  console.log("🔄 创建新 Session...");
  try {
    const createRes = await wdaClient.post("/session", {
      capabilities: {
        alwaysMatch: {
          arguments: [],
          environment: {},
          shouldWaitForQuiescence: false,
        },
      },
    });
    _currentSessionId = createRes.data.sessionId;
    await configureWdaSettings(_currentSessionId);
    return _currentSessionId;
  } catch (error) {
    console.error("❌ 无法创建 Session", error.message);
    throw error;
  }
}

/**
 * [关键] WDA 极致性能配置 (针对 TikTok)
 */
async function configureWdaSettings(sessionId) {
  try {
    console.log(`⚙️ 应用 WDA 防卡死/低画质配置...`);
    await wdaClient.post(`/session/${sessionId}/appium/settings`, {
      settings: {
        mjpegScalingFactor: 25, // 画面缩小至 25%
        mjpegServerScreenshotQuality: 10, // 最低画质
        mjpegServerFramerate: 10, // 限制帧率
        screenshotQuality: 0,
        waitForIdleTimeout: 0,
        animationCoolOffTimeout: 0,
        // [新增] 限制 UI 层级解析深度，防止 TikTok 卡死
        snapshotMaxDepth: 50,
        // [新增] 减少按键延迟
        interKeyDelay: 0,
      },
    });
  } catch (e) {
    console.warn("⚠️ WDA 配置部分失败:", e.message);
  }
}

let _deviceSize = null;
async function getScreenSize() {
  if (_deviceSize) return _deviceSize;
  try {
    const sid = await getSessionId();
    const res = await wdaClient.get(`/session/${sid}/window/rect`);
    _deviceSize = {
      width: res.data.value.width,
      height: res.data.value.height,
    };
    return _deviceSize;
  } catch (e) {
    return { width: 375, height: 812 };
  }
}

// ==========================================
// 3. 工具函数
// ==========================================
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function waitForElement(sessionId, text, timeout = 5000) {
  const startTime = Date.now();
  while (Date.now() - startTime < timeout) {
    try {
      let body = {
        using: "class chain",
        value: `**/XCUIElementTypeButton[\`label CONTAINS "${text}"\`]`,
      };
      let res = await wdaClient.post(`/session/${sessionId}/element`, body);
      if (!res.data.value.ELEMENT) {
        body.value = `**/XCUIElementTypeStaticText[\`label CONTAINS "${text}"\`]`;
        res = await wdaClient.post(`/session/${sessionId}/element`, body);
      }
      if (res.data.value.ELEMENT) return res.data.value.ELEMENT;
    } catch (e) {}
    await sleep(500);
  }
  return null;
}

async function clickElement(sessionId, elementId) {
  try {
    await wdaClient.post(`/session/${sessionId}/element/${elementId}/click`);
    return true;
  } catch (e) {
    return false;
  }
}

// ==========================================
// 4. Chrome 文件保存逻辑
// ==========================================
async function saveFromChromeFolder(filename) {
  // ... (保持原有 Chrome 逻辑不变) ...
  // 为了节省篇幅，这里复用您之前的逻辑，因为这部分没问题
  // 核心改动在于 wdaClient 的引入和 session 配置
  const sessionId = await getSessionId();
  const screen = await getScreenSize();

  await wdaClient.post(`/session/${sessionId}/appium/device/activate_app`, {
    bundleId: "com.apple.DocumentsApp",
  });

  const findAndTap = async (text, timeout = 3000) => {
    const el = await waitForElement(sessionId, text, timeout);
    if (el) {
      await clickElement(sessionId, el);
      return true;
    }
    return false;
  };

  // 简化版流程
  await findAndTap("浏览", 1000);
  let entered = await findAndTap("我的 iPhone");
  if (!entered) entered = await findAndTap("On My iPhone");

  if (await findAndTap(CHROME_FOLDER_NAME, 3000)) {
    if (await findAndTap(filename, 5000)) {
      await sleep(1500);
      await wdaClient.post(`/session/${sessionId}/actions`, {
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
      await sleep(1000);
      const isImage = /\.(jpg|png|heic)$/i.test(filename);
      const targets = isImage
        ? ["存储图像", "Save Image"]
        : ["保存视频", "Save Video"];
      for (const t of targets) {
        if (await findAndTap(t, 1000)) break;
      }
    }
  }
}

// ==========================================
// 5. API 路由
// ==========================================

function getDeviceUDID() {
  if (!cachedDeviceConfig) loadDeviceConfig();
  if (!cachedDeviceConfig) return null;
  let device = cachedDeviceConfig.devices.find(
    (d) => d.enable && d.local_port + 2 === Number(SERVER_PORT)
  );
  if (!device)
    device = cachedDeviceConfig.devices.find(
      (d) => d.enable && d.local_port === Number(WDA_PORT)
    );
  return device ? device.udid : null;
}

app.get("/api/stream", (req, res) => {
  res.set({
    "Access-Control-Allow-Origin": "*",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "Content-Type": "multipart/x-mixed-replace; boundary=--BoundaryString",
  });
  const proxyReq = http.get(MJPEG_URL, (streamRes) => {
    res.writeHead(streamRes.statusCode, streamRes.headers);
    streamRes.pipe(res);
  });
  proxyReq.on("error", (e) => {
    if (!res.headersSent) res.status(500).end();
  });
  req.on("close", () => proxyReq.destroy());
});

app.post("/api/upload", upload.single("video"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file" });
  const udid = getDeviceUDID();
  if (!udid) {
    fs.unlinkSync(req.file.path);
    return res.status(500).json({ error: "Device mapping failed" });
  }
  const remotePath = `/Documents/${req.file.originalname}`;
  const cmd = `"${TIDEVICE_PATH}" -u ${udid} fsync -B ${CHROME_BUNDLE_ID} push "${req.file.path}" "${remotePath}"`;
  try {
    await execAsync(cmd);
    saveFromChromeFolder(req.file.originalname).catch((e) =>
      console.error("Auto-save failed:", e)
    );
    res.json({ success: true, message: "File pushed, processing..." });
  } catch (e) {
    res.status(500).json({ error: e.message });
  } finally {
    if (fs.existsSync(req.file.path)) fs.unlinkSync(req.file.path);
  }
});

// ==========================================
// [新增] TikTok 专用：盲操作接口 (解决超时)
// ==========================================

// 1. 盲点 (Blind Tap) - 传入百分比 (0.0 - 1.0)
app.post("/api/tiktok/tap", async (req, res) => {
  try {
    const { xPct, yPct } = req.body; // 例如: { xPct: 0.5, yPct: 0.5 } 点中心
    const screen = await getScreenSize();
    const sid = await getSessionId();

    const realX = Math.round(screen.width * xPct);
    const realY = Math.round(screen.height * yPct);

    console.log(
      `🎯 [TikTok Blind Tap] (${xPct}, ${yPct}) -> (${realX}, ${realY})`
    );

    await wdaClient.post(`/session/${sid}/actions`, {
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
    console.error("Blind Tap Failed:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// 2. 盲滑 (Next Video) - 极速上滑
app.post("/api/tiktok/next", async (req, res) => {
  // Fire-and-forget: 立即返回成功，不等待 WDA
  res.json({ success: true });

  try {
    const screen = await getScreenSize();
    const sid = await getSessionId();

    await wdaClient.post(`/session/${sid}/actions`, {
      actions: [
        {
          type: "pointer",
          id: "finger1",
          parameters: { pointerType: "touch" },
          actions: [
            // 从屏幕 80% 处开始
            {
              type: "pointerMove",
              duration: 0,
              x: screen.width / 2,
              y: screen.height * 0.8,
            },
            { type: "pointerDown", button: 0 },
            // 快速划到 20% 处，耗时 150ms
            {
              type: "pointerMove",
              duration: 150,
              x: screen.width / 2,
              y: screen.height * 0.2,
            },
            { type: "pointerUp", button: 0 },
          ],
        },
      ],
    });
  } catch (e) {
    console.error("Next Video Failed:", e.message);
  }
});

// ==========================================
// 常规接口
// ==========================================

app.post("/api/tap", async (req, res) => {
  try {
    const { x, y, viewWidth, viewHeight } = req.body;
    const screen = await getScreenSize();
    const realX = Math.round((x / viewWidth) * screen.width);
    const realY = Math.round((y / viewHeight) * screen.height);
    const sid = await getSessionId();

    await wdaClient.post(`/session/${sid}/actions`, {
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
    if (e.message.includes("session")) _currentSessionId = null;
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/swipe", async (req, res) => {
  res.json({ success: true });
  try {
    const { startX, startY, endX, endY, viewWidth, viewHeight } = req.body;
    const screen = await getScreenSize();
    const sid = await getSessionId();
    const rSX = Math.round((startX / viewWidth) * screen.width);
    const rSY = Math.round((startY / viewHeight) * screen.height);
    const rEX = Math.round((endX / viewWidth) * screen.width);
    const rEY = Math.round((endY / viewHeight) * screen.height);

    await wdaClient.post(`/session/${sid}/actions`, {
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

app.post("/api/home", async (req, res) => {
  try {
    await wdaClient.post(`/wda/homescreen`);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/api/clipboard", async (req, res) => {
  try {
    const text = req.body.text || (await execAsync("pbpaste")).stdout.trim();
    if (!text) return res.status(400).json({ error: "Empty text" });
    const sid = await getSessionId();
    const base64Content = Buffer.from(text).toString("base64");
    try {
      await wdaClient.post(`/session/${sid}/wda/setPasteboard`, {
        content: base64Content,
        contentType: "plaintext",
        label: "RemoteCopy",
      });
    } catch (e) {
      await wdaClient.post(`/session/${sid}/wda/apps/launch`, {
        bundleId: "com.woodrain.xiao.xctrunner",
      });
      await sleep(1000);
      await wdaClient.post(`/session/${sid}/wda/setPasteboard`, {
        content: base64Content,
        contentType: "plaintext",
        label: "RemoteCopy",
      });
    }
    await wdaClient.post(`/wda/homescreen`);
    res.json({ success: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

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
