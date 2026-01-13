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

// 增加请求体大小限制和超时时间（用于大文件上传）
app.use(express.json({ limit: "3gb" }));
app.use(express.urlencoded({ extended: true, limit: "3gb" }));

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
  timeout: 20000, // 20秒超时，给VPN环境更多宽容度
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
      // 快速保活检查
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
    return _cu;
    rrentSessionId;
  } catch (error) {
    console.error("❌ 无法创建 Session", error.message);
    throw error;
  }
}

/**
 * [优化] WDA 极致性能配置 (包含减少动作延迟)
 */
async function configureWdaSettings(sessionId) {
  try {
    console.log(`⚙️ 应用 WDA 防卡死/低画质/零延迟配置...`);
    await wdaClient.post(`/session/${sessionId}/appium/settings`, {
      settings: {
        // --- 视频流极限阉割 ---
        mjpegScalingFactor: 25, // 画面原有尺寸的 1/4
        mjpegServerScreenshotQuality: 5, // 画质降到 5 (极度模糊，但速度快)
        mjpegServerFramerate: 5, // [关键] 帧率降到 2 FPS (防卡死核心)

        // --- 动作响应优化 ---
        screenshotQuality: 0, // 截图质量最低
        waitForIdleTimeout: 0, // 永不等待空闲
        animationCoolOffTimeout: 0, // 无动画冷却
        actionAcknowledgmentTimeout: 0, // 不等待动作确认

        // --- 禁用 UI 树分析 (针对日志里的 hierarchy 错误) ---
        snapshotMaxDepth: 1, // [关键] 只看最顶层，不准深入分析
        useJSONSource: true, // 使用 JSON 格式源码 (通常比 XML 快)
        simpleIsVisibleCheck: true, // 简单的可见性检查
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
  const sessionId = await getSessionId();
  // 这里必须 await，因为后续坐标计算依赖它，但 Chrome 环境不像 TikTok 那么高压，所以可以等待
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
              { type: "pause", duration: 100 }, // 普通 APP 可以保留一点延迟确保稳定
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
// 5. API 路由 (Fire-and-Forget 模式改造)
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
  // 为大文件上传设置更长的超时时间（30分钟）
  req.setTimeout(30 * 60 * 1000); // 30分钟
  res.setTimeout(30 * 60 * 1000); // 30分钟

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
// [优化核心] TikTok 盲操作 - 极速模式
// ==========================================

// 1. 盲点 (Blind Tap)
app.post("/api/tiktok/tap", async (req, res) => {
  // [关键] 立即返回成功，不等待 WDA 响应！
  res.json({ success: true });

  try {
    const { xPct, yPct } = req.body;

    // [优化] 优先使用缓存尺寸，避免网络请求
    // 只有当 _deviceSize 为空时才去请求，如果请求也失败就用默认值
    let screen = _deviceSize;
    if (!screen) {
      try {
        screen = await getScreenSize();
      } catch (e) {}
    }
    if (!screen) screen = { width: 375, height: 812 };

    const sid = _currentSessionId;
    if (!sid) return; // 如果 Session 正在建立中，直接丢弃这次点击，防止阻塞

    const realX = Math.round(screen.width * xPct);
    const realY = Math.round(screen.height * yPct);

    console.log(`⚡️ [极速点击] (${realX}, ${realY})`);

    // [优化] 不使用 await，且去掉了 pause (实现瞬时点击)
    wdaClient
      .post(`/session/${sid}/actions`, {
        actions: [
          {
            type: "pointer",
            id: "finger1",
            parameters: { pointerType: "touch" },
            actions: [
              { type: "pointerMove", duration: 0, x: realX, y: realY },
              { type: "pointerDown", button: 0 },
              // { type: "pause", duration: 50 }, // <--- 已移除暂停，极大减少卡死概率
              { type: "pointerUp", button: 0 },
            ],
          },
        ],
      })
      .catch((e) => console.warn("后台点击指令执行异常:", e.message));
  } catch (e) {
    console.error("本地逻辑错误:", e.message);
  }
});

// 2. 盲滑 (Next Video)
app.post("/api/tiktok/next", async (req, res) => {
  // [关键] 立即返回成功
  res.json({ success: true });

  try {
    let screen = _deviceSize || { width: 375, height: 812 };
    const sid = _currentSessionId;
    if (!sid) return;

    wdaClient
      .post(`/session/${sid}/actions`, {
        actions: [
          {
            type: "pointer",
            id: "finger1",
            parameters: { pointerType: "touch" },
            actions: [
              {
                type: "pointerMove",
                duration: 0,
                x: screen.width / 2,
                y: screen.height * 0.8,
              },
              { type: "pointerDown", button: 0 },
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
      })
      .catch((e) => console.warn("后台滑动指令异常:", e.message));
  } catch (e) {
    console.error("Next Video Error:", e.message);
  }
});

// ==========================================
// 常规接口 (同样应用 Fire-and-Forget)
// ==========================================

app.post("/api/tap", async (req, res) => {
  res.json({ success: true }); // 立即返回

  try {
    const { x, y, viewWidth, viewHeight } = req.body;
    let screen = _deviceSize || { width: 375, height: 812 };

    // 即使没缓存，也不要 await getScreenSize() 阻塞，直接用默认值或异步去取
    if (!_deviceSize) getScreenSize(); // 触发一次异步更新，这次先用默认的或旧的

    const realX = Math.round((x / viewWidth) * screen.width);
    const realY = Math.round((y / viewHeight) * screen.height);

    const sid = _currentSessionId;
    if (!sid) return;

    wdaClient
      .post(`/session/${sid}/actions`, {
        actions: [
          {
            type: "pointer",
            id: "finger1",
            parameters: { pointerType: "touch" },
            actions: [
              { type: "pointerMove", duration: 0, x: realX, y: realY },
              { type: "pointerDown", button: 0 },
              // { type: "pause", duration: 50 }, // 移除暂停
              { type: "pointerUp", button: 0 },
            ],
          },
        ],
      })
      .catch((e) => {
        if (e.message.includes("session")) _currentSessionId = null;
        console.warn("常规点击异常:", e.message);
      });
  } catch (e) {
    console.error("Tap logic error:", e.message);
  }
});

app.post("/api/swipe", async (req, res) => {
  res.json({ success: true });

  try {
    const { startX, startY, endX, endY, viewWidth, viewHeight } = req.body;
    let screen = _deviceSize || { width: 375, height: 812 };
    const sid = _currentSessionId;
    if (!sid) return;

    const rSX = Math.round((startX / viewWidth) * screen.width);
    const rSY = Math.round((startY / viewHeight) * screen.height);
    const rEX = Math.round((endX / viewWidth) * screen.width);
    const rEY = Math.round((endY / viewHeight) * screen.height);

    wdaClient
      .post(`/session/${sid}/actions`, {
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
      })
      .catch((e) => console.warn("Swipe error:", e.message));
  } catch (e) {
    console.error("Swipe logic error:", e.message);
  }
});

app.post("/api/drag", async (req, res) => {
  res.json({ success: true });

  try {
    const { startX, startY, endX, endY, viewWidth, viewHeight } = req.body;
    let screen = _deviceSize || { width: 375, height: 812 };
    const sessionId = await getSessionId();

    if (!sessionId) return;

    const rSX = Math.round((startX / viewWidth) * screen.width);
    const rSY = Math.round((startY / viewHeight) * screen.height);
    const rEX = Math.round((endX / viewWidth) * screen.width);
    const rEY = Math.round((endY / viewHeight) * screen.height);

    // 拖拽使用更长的 duration (400ms) 来实现慢速拖拽效果
    wdaClient
      .post(`/session/${sessionId}/actions`, {
        actions: [
          {
            type: "pointer",
            id: "finger1",
            parameters: { pointerType: "touch" },
            actions: [
              { type: "pointerMove", duration: 0, x: rSX, y: rSY },
              { type: "pointerDown", button: 0 },
              { type: "pointerMove", duration: 400, x: rEX, y: rEY },
              { type: "pointerUp", button: 0 },
            ],
          },
        ],
      })
      .catch((e) => console.warn("Drag error:", e.message));
  } catch (e) {
    console.error("Drag logic error:", e.message);
  }
});

app.post("/api/longpress", async (req, res) => {
  res.json({ success: true }); // 立即返回

  try {
    const { x, y, viewWidth, viewHeight } = req.body;
    let screen = _deviceSize || { width: 375, height: 812 };

    // 即使没缓存，也不要 await getScreenSize() 阻塞，直接用默认值或异步去取
    if (!_deviceSize) getScreenSize(); // 触发一次异步更新，这次先用默认的或旧的

    const realX = Math.round((x / viewWidth) * screen.width);
    const realY = Math.round((y / viewHeight) * screen.height);

    const sid = _currentSessionId;
    if (!sid) return;

    console.log(`📌 [长按] (${realX}, ${realY})`);

    // 长按操作：按下后保持 1500ms，然后松开
    // 这样可以触发 iOS 的长按菜单（如粘贴菜单）
    wdaClient
      .post(`/session/${sid}/actions`, {
        actions: [
          {
            type: "pointer",
            id: "finger1",
            parameters: { pointerType: "touch" },
            actions: [
              { type: "pointerMove", duration: 0, x: realX, y: realY },
              { type: "pointerDown", button: 0 },
              { type: "pause", duration: 1500 }, // 保持按下状态 1.5 秒
              { type: "pointerUp", button: 0 },
            ],
          },
        ],
      })
      .catch((e) => {
        if (e.message.includes("session")) _currentSessionId = null;
        console.warn("长按操作异常:", e.message);
      });
  } catch (e) {
    console.error("Longpress logic error:", e.message);
  }
});

app.post("/api/home", async (req, res) => {
  res.json({ success: true });
  try {
    wdaClient.post(`/wda/homescreen`).catch(() => {});
  } catch (e) {}
});

app.post("/api/clipboard", async (req, res) => {
  res.json({ success: true }); // 立即返回

  // 后台处理
  (async () => {
    try {
      const text = req.body.text || (await execAsync("pbpaste")).stdout.trim();
      if (!text) return;

      let sid = await getSessionId(); // 剪贴板需要确保 Session 可用
      const base64Content = Buffer.from(text).toString("base64");

      await wdaClient.post(`/session/${sid}/wda/apps/launch`, {
        bundleId: "com.woodrain.dekun.xctrunner",
      });
      await sleep(1000);
      await wdaClient.post(`/session/${sid}/wda/setPasteboard`, {
        content: base64Content,
        contentType: "plaintext",
        label: "RemoteCopy",
      });

      await wdaClient.post(`/wda/homescreen`);
    } catch (e) {
      console.error("Clipboard bg error:", e.message);
    }
  })();
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

// 创建HTTP服务器并设置超时时间（支持大文件上传）
const server = http.createServer(app);
// 设置服务器超时时间为30分钟（1800000毫秒），用于支持大文件上传
server.timeout = 30 * 60 * 1000; // 30分钟
server.keepAliveTimeout = 30 * 60 * 1000; // 30分钟
server.headersTimeout = 30 * 60 * 1000; // 30分钟

server.listen(SERVER_PORT, "0.0.0.0", () => {
  console.log(`🚀 服务运行中: http://${getLocalIP()}:${SERVER_PORT}`);
  console.log(`⏱️  上传超时设置: 30分钟（支持大文件上传）`);
});
