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
const localtunnel = require("localtunnel");

// ==========================================
// 核心修改 1: 从环境变量读取端口配置（必须在文件开头）
// ==========================================
// 如果没传参数，就用默认值 (兼容单机模式)
const SERVER_PORT = process.env.PORT || 3000; // 网页访问端口
const WDA_PORT = process.env.WDA_PORT || 8100; // WDA 控制端口
const MJPEG_PORT = process.env.MJPEG_PORT || 9100; // 视频流端口

console.log(
  `🔧 配置加载: Web端口=${SERVER_PORT} | WDA端口=${WDA_PORT} | 视频端口=${MJPEG_PORT}`
);

// 构建动态 URL
const WDA_CTRL = `http://127.0.0.1:${WDA_PORT}`;
const MJPEG_URL = `http://127.0.0.1:${MJPEG_PORT}`;

// ==========================================
// 1. 配置 Chrome 的参数
// ==========================================
// Google Chrome 的 iOS 包名
const CHROME_BUNDLE_ID = "com.google.chrome.ios";
// 在“文件”App 中显示的文件夹名字 (通常就是 "Chrome")
const CHROME_FOLDER_NAME = "Chrome";

const app = express();
app.use(cors());
app.use(express.json());

// 添加请求日志中间件（用于调试 GET 请求问题）
app.use((req, res, next) => {
  if (req.path.startsWith("/api/")) {
    console.log(`[请求日志] ${req.method} ${req.path} - 端口: ${SERVER_PORT}`);
    console.log(`[请求日志] URL: ${req.url}, 原始URL: ${req.originalUrl}`);
  }
  next();
});

// 配置 multer 用于文件上传
const upload = multer({
  dest: path.join(__dirname, "uploads"), // 临时存储目录
  limits: {
    fileSize: 2 * 1024 * 1024 * 1024, // 最大 2GB
  },
});

// 确保上传目录存在
const uploadsDir = path.join(__dirname, "uploads");
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

// ==========================================
// 文件上传接口: 将视频文件传输到 iOS 设备
// ==========================================
// 根据端口查找设备 UDID
function getDeviceUDID() {
  try {
    const configPath = path.join(__dirname, "config.json");
    if (!fs.existsSync(configPath)) {
      console.error(`[getDeviceUDID] 配置文件不存在: ${configPath}`);
      return null;
    }
    const config = JSON.parse(fs.readFileSync(configPath, "utf8"));

    console.log(
      `[getDeviceUDID] 当前端口: SERVER_PORT=${SERVER_PORT}, WDA_PORT=${WDA_PORT}, MJPEG_PORT=${MJPEG_PORT}`
    );

    // 尝试多种匹配方式：
    // 1. 通过 WEB_PORT 匹配 (local_port + 2)
    let device = config.devices.find(
      (d) => d.enable && d.local_port + 2 === Number(SERVER_PORT)
    );

    // 2. 如果没找到，通过 WDA_PORT 匹配 (local_port)
    if (!device) {
      device = config.devices.find(
        (d) => d.enable && d.local_port === Number(WDA_PORT)
      );
    }

    // 3. 如果还没找到，通过 MJPEG_PORT 匹配 (local_port + 1)
    if (!device) {
      device = config.devices.find(
        (d) => d.enable && d.local_port + 1 === Number(MJPEG_PORT)
      );
    }

    if (device) {
      console.log(
        `[getDeviceUDID] 找到设备: ${device.name}, UDID: ${device.udid}`
      );
      return device.udid;
    } else {
      console.error(`[getDeviceUDID] 未找到匹配的设备。可用设备:`);
      config.devices.forEach((d) => {
        if (d.enable) {
          console.error(
            `  - ${d.name}: local_port=${d.local_port}, web_port=${
              d.local_port + 2
            }, wda_port=${d.local_port}, mjpeg_port=${d.local_port + 1}`
          );
        }
      });
      return null;
    }
  } catch (error) {
    console.error("读取设备配置失败:", error.message);
    return null;
  }
}

// ==========================================
// 2. WDA 自动化: 去“文件”App的 Chrome 文件夹保存视频
// ==========================================
async function saveFromChromeFolder(filename) {
  const sessionId = await getSessionId();
  const screen = await getScreenSize();

  console.log(`🤖 [WDA] 启动“文件”App (访问 Chrome 容器)...`);

  // 1. 启动 iOS 自带的“文件” App
  await axios.post(
    `${WDA_CTRL}/session/${sessionId}/appium/device/activate_app`,
    {
      bundleId: "com.apple.DocumentsApp",
    }
  );

  await new Promise((r) => setTimeout(r, 2000));

  // --- 辅助点击函数 (通过文字) ---
  const tapText = async (text) => {
    try {
      // 优先用 label 查找
      const body = {
        using: "class chain",
        value: `**/XCUIElementTypeButton[\`label CONTAINS "${text}"\`]`,
      };
      // 备用: StaticText
      const body2 = {
        using: "class chain",
        value: `**/XCUIElementTypeStaticText[\`label CONTAINS "${text}"\`]`,
      };

      let ele = await axios.post(
        `${WDA_CTRL}/session/${sessionId}/element`,
        body
      );
      if (!ele.data.value.ELEMENT)
        ele = await axios.post(
          `${WDA_CTRL}/session/${sessionId}/element`,
          body2
        );

      if (ele.data.value.ELEMENT) {
        console.log(`    🖱️ 点击: ${text}`);
        await axios.post(
          `${WDA_CTRL}/session/${sessionId}/element/${ele.data.value.ELEMENT}/click`
        );
        return true;
      }
      return false;
    } catch (e) {
      return false;
    }
  };

  // --- 辅助点击函数 (通过坐标 - 用于分享按钮) ---
  const tapPoint = async (x, y) => {
    await axios.post(`${WDA_CTRL}/session/${sessionId}/actions`, {
      actions: [
        {
          type: "pointer",
          id: "finger1",
          parameters: { pointerType: "touch" },
          actions: [
            { type: "pointerMove", duration: 0, x: x, y: y },
            { type: "pointerDown", button: 0 },
            { type: "pause", duration: 100 },
            { type: "pointerUp", button: 0 },
          ],
        },
      ],
    });
  };

  // --- 自动化步骤 ---

  // 1. 确保回退到“浏览”根目录
  await tapText("浏览");
  await new Promise((r) => setTimeout(r, 500));
  await tapText("浏览"); // 多点一次确保回退
  await new Promise((r) => setTimeout(r, 500));

  // 2. 进入“我的 iPhone”
  // 注意：如果界面是英文，这里需要改成 "On My iPhone"
  let enterMyPhone = await tapText("我的 iPhone");
  if (!enterMyPhone) enterMyPhone = await tapText("On My iPhone");

  await new Promise((r) => setTimeout(r, 1000));

  // 3. 点击 "Chrome" 文件夹
  console.log(`    📂 寻找 ${CHROME_FOLDER_NAME} 文件夹...`);
  let folderClicked = await tapText(CHROME_FOLDER_NAME);

  // 如果没找到，尝试简单滑一下屏幕 (防止文件夹在下面)
  if (!folderClicked) {
    console.log("    👇 下滑查找文件夹...");
    await axios.post(`${WDA_CTRL}/session/${sessionId}/actions`, {
      actions: [
        {
          type: "pointer",
          id: "finger1",
          parameters: { pointerType: "touch" },
          actions: [
            { type: "pointerMove", duration: 0, x: 200, y: 500 },
            { type: "pointerDown", button: 0 },
            { type: "pointerMove", duration: 200, x: 200, y: 200 }, // 上滑手势
            { type: "pointerUp", button: 0 },
          ],
        },
      ],
    });
    await new Promise((r) => setTimeout(r, 1000));
    folderClicked = await tapText(CHROME_FOLDER_NAME);
  }

  if (folderClicked) {
    await new Promise((r) => setTimeout(r, 1000));

    // 4. 点击视频文件 (文件名)
    console.log(`    🎬 点击文件: ${filename}`);
    const fileClicked = await tapText(filename);

    if (fileClicked) {
      await new Promise((r) => setTimeout(r, 1500)); // 等待视频预览加载

      console.log(`    🚀 点击分享 (左下角)...`);
      // 5. 点击左下角分享按钮 (坐标适配绝大多数 iPhone)
      await tapPoint(30, screen.height - 50);

      await new Promise((r) => setTimeout(r, 1500)); // 等待菜单弹出

      // 6. 点击保存
      console.log(`    💾 点击保存...`);
      let saved = await tapText("保存视频");
      if (!saved) saved = await tapText("Save Video");

      if (saved) console.log(`✅ [完成] 视频已存入相册！`);
    } else {
      console.log(`❌ 未找到文件: ${filename}，可能是上传还没完成？`);
    }
  } else {
    console.log(
      `❌ 未找到 Chrome 文件夹，请确认手机已安装 Chrome 且打开过一次。`
    );
  }
}

// ==========================================
// 3. 上传接口 (Tidevice -> Chrome -> WDA)
// ==========================================
app.post("/api/upload", upload.single("video"), async (req, res) => {
  console.log(`[API] /api/upload (Chrome USB 模式)`);
  try {
    if (!req.file) return res.status(400).json({ error: "无文件" });

    const udid = getDeviceUDID();
    if (!udid) {
      fs.unlinkSync(req.file.path);
      return res.status(500).json({ error: "未找到设备" });
    }

    console.log(`📤 1. 正在通过 tidevice 推送到 Chrome...`);

    // ✅ 核心修复: 直接写死绝对路径，不再依赖环境变量
    const TIDEVICE_PATH = "/Users/xiaodekun/Library/Python/3.9/bin/tidevice";
    const remotePath = `/Documents/${req.file.originalname}`;

    // ✅ 构建命令
    const cmd = `${TIDEVICE_PATH} -u ${udid} fsync -B ${CHROME_BUNDLE_ID} push "${req.file.path}" "${remotePath}"`;

    console.log(`    执行命令: ${cmd}`);

    try {
      await execAsync(cmd);
      console.log(`    ✅ 推送成功!`);
    } catch (e) {
      console.error(`    ❌ 推送失败: ${e.message}`);
      fs.unlinkSync(req.file.path);
      return res
        .status(500)
        .json({ error: `USB 推送失败 (请检查路径或USB): ${e.message}` });
    }

    // 2. 触发 WDA 自动化 (异步)
    saveFromChromeFolder(req.file.originalname).catch((err) => {
      console.error("WDA 自动化出错:", err);
    });

    fs.unlinkSync(req.file.path);
    res.json({
      success: true,
      message: "文件已推送到 Chrome，正在自动打开文件 App 保存...",
    });
  } catch (error) {
    console.error("上传流程异常:", error);
    if (req.file) fs.unlinkSync(req.file.path);
    res.status(500).json({ error: error.message });
  }
});

let cachedSessionId = null;

// ==========================================
// 核心优化: 设置 WDA 压缩参数
// ==========================================
async function configureSettings(sessionId) {
  try {
    await axios.post(`${WDA_CTRL}/session/${sessionId}/appium/settings`, {
      settings: {
        mjpegServerScreenshotQuality: 30,
        mjpegServerFramerate: 30,
        mjpegScalingFactor: 50,
      },
    });
    console.log("✅ 画质优化配置已发送");
  } catch (e) {
    // 忽略不支持的错误
  }
}

// 获取 Session
async function getSessionId() {
  try {
    const statusRes = await axios.get(`${WDA_CTRL}/status`);
    if (statusRes.data.sessionId) {
      configureSettings(statusRes.data.sessionId);
      return statusRes.data.sessionId;
    }
  } catch (e) {}

  console.log("🔄 创建新 Session...");
  try {
    const createRes = await axios.post(`${WDA_CTRL}/session`, {
      capabilities: {
        alwaysMatch: {
          arguments: [],
          environment: {},
          shouldWaitForQuiescence: false,
        },
      },
    });
    cachedSessionId = createRes.data.sessionId;
    await configureSettings(cachedSessionId);
    return cachedSessionId;
  } catch (error) {
    console.error("❌ Session 创建失败:", error.message);
    throw error;
  }
}

// 获取屏幕尺寸
let DEVICE_SIZE = null;
async function getScreenSize() {
  if (DEVICE_SIZE) return DEVICE_SIZE;
  try {
    const sessionId = await getSessionId();
    const res = await axios.get(`${WDA_CTRL}/session/${sessionId}/window/rect`);
    DEVICE_SIZE = {
      width: res.data.value.width,
      height: res.data.value.height,
    };
    return DEVICE_SIZE;
  } catch (e) {
    return { width: 375, height: 812 };
  }
}

// ==========================================
// 💡 修正点: 视频流直接透传 (无缓冲)
// ==========================================
// 处理 OPTIONS 预检请求
app.options("/api/stream", (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
  res.status(200).end();
});

app.get("/api/stream", (req, res) => {
  // 先设置 CORS 头（必须在 writeHead 之前）
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");

  // 使用原生 http 模块发起请求，建立直连通道
  const proxyReq = http.get(MJPEG_URL, (streamRes) => {
    // 1. 复制响应头，但确保 CORS 头不被覆盖
    const headers = { ...streamRes.headers };

    // 强制设置 CORS 头（覆盖上游可能存在的头）
    headers["Access-Control-Allow-Origin"] = "*";
    headers["Access-Control-Allow-Methods"] = "GET, OPTIONS";
    headers["Access-Control-Allow-Headers"] = "*";

    // 保持 multipart/x-mixed-replace 内容类型
    res.writeHead(streamRes.statusCode, headers);

    // 2. 建立管道：WDA的数据 -> Node -> 前端 (不经过任何处理)
    streamRes.pipe(res);
  });

  // 错误处理
  proxyReq.on("error", (e) => {
    console.error("❌ 视频流转发失败:", e.message);
    // 确保错误响应也包含 CORS 头
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "*");
    res.status(500).end();
  });

  // 客户端断开时，销毁上游连接
  req.on("close", () => {
    proxyReq.destroy();
  });
});

// 点击接口
app.post("/api/tap", async (req, res) => {
  try {
    const { x, y, viewWidth, viewHeight } = req.body;
    const deviceSize = await getScreenSize();

    const realX = Math.round((x / viewWidth) * deviceSize.width);
    const realY = Math.round((y / viewHeight) * deviceSize.height);

    console.log(`🖱️ 点击: (${realX}, ${realY})`);

    const sessionId = await getSessionId();
    await axios.post(`${WDA_CTRL}/session/${sessionId}/actions`, {
      actions: [
        {
          type: "pointer",
          id: "finger1",
          parameters: { pointerType: "touch" },
          actions: [
            { type: "pointerMove", duration: 0, x: realX, y: realY },
            { type: "pointerDown", button: 0 },
            { type: "pause", duration: 50 }, // 稍微按久一点点，防止误触
            { type: "pointerUp", button: 0 },
          ],
        },
      ],
    });
    res.json({ success: true });
  } catch (error) {
    console.error("点击失败:", error.message);
    cachedSessionId = null;
    res.status(500).json({ error: "点击失败" });
  }
});

// ==========================================
// 新增接口: 滑动 / 拖拽 (Swipe)
// ==========================================
app.post("/api/swipe", async (req, res) => {
  try {
    const { startX, startY, endX, endY, viewWidth, viewHeight } = req.body;
    const deviceSize = await getScreenSize();

    // 1. 坐标换算 (起点和终点都要换算)
    const realStartX = Math.round((startX / viewWidth) * deviceSize.width);
    const realStartY = Math.round((startY / viewHeight) * deviceSize.height);
    const realEndX = Math.round((endX / viewWidth) * deviceSize.width);
    const realEndY = Math.round((endY / viewHeight) * deviceSize.height);

    console.log(
      `↔️ 滑动: (${realStartX},${realStartY}) -> (${realEndX},${realEndY})`
    );

    const sessionId = await getSessionId();

    // 2. 构建 W3C 滑动动作序列
    // 优化：减小duration到150ms，实现快速滑动
    const swipePromise = axios.post(
      `${WDA_CTRL}/session/${sessionId}/actions`,
      {
        actions: [
          {
            type: "pointer",
            id: "finger1",
            parameters: { pointerType: "touch" },
            actions: [
              {
                type: "pointerMove",
                duration: 0,
                x: realStartX,
                y: realStartY,
              },
              { type: "pointerDown", button: 0 },
              // duration 优化：减小到100ms，实现更快的滑动响应
              { type: "pointerMove", duration: 100, x: realEndX, y: realEndY },
              { type: "pointerUp", button: 0 },
            ],
          },
        ],
      }
    );

    // 立即返回响应，不等待WDA操作完成（fire and forget）
    res.json({ success: true });

    // 异步处理错误（不阻塞响应）
    swipePromise.catch((error) => {
      console.error("滑动操作失败:", error.message);
    });
  } catch (error) {
    console.error("滑动失败:", error.message);
    res.status(500).json({ error: "滑动失败" });
  }
});

// ==========================================
// 新增接口: 拖拽 (Drag) - 用于移动图标等
// ==========================================
app.post("/api/drag", async (req, res) => {
  try {
    const { startX, startY, endX, endY, viewWidth, viewHeight } = req.body;
    const deviceSize = await getScreenSize();

    // 1. 坐标换算
    const realStartX = Math.round((startX / viewWidth) * deviceSize.width);
    const realStartY = Math.round((startY / viewHeight) * deviceSize.height);
    const realEndX = Math.round((endX / viewWidth) * deviceSize.width);
    const realEndY = Math.round((endY / viewHeight) * deviceSize.height);

    console.log(
      `✊ 拖拽: (${realStartX},${realStartY}) -> (${realEndX},${realEndY})`
    );

    const sessionId = await getSessionId();

    // 2. 构建 W3C 拖拽动作序列
    await axios.post(`${WDA_CTRL}/session/${sessionId}/actions`, {
      actions: [
        {
          type: "pointer",
          id: "finger1",
          parameters: { pointerType: "touch" },
          actions: [
            { type: "pointerMove", duration: 0, x: realStartX, y: realStartY },
            { type: "pointerDown", button: 0 },
            // 关键区别：按下后暂停 1000ms (即 1秒)，模拟长按选中
            { type: "pause", duration: 1000 },
            // 然后慢慢移动到终点 (1000ms)，防止甩飞
            { type: "pointerMove", duration: 1000, x: realEndX, y: realEndY },
            { type: "pointerUp", button: 0 },
          ],
        },
      ],
    });
    res.json({ success: true });
  } catch (error) {
    console.error("拖拽失败:", error.message);
    res.status(500).json({ error: "拖拽失败" });
  }
});

// 1. Home 键 (回桌面)
app.post("/api/home", async (req, res) => {
  try {
    console.log("🏠 执行 Home 键操作");
    // WDA 原生接口: /wda/homescreen
    // 这比用 swipe 上滑要极其稳定
    await axios.post(`${WDA_CTRL}/wda/homescreen`);
    res.json({ success: true });
  } catch (error) {
    console.error("Home键失败:", error.message);
    res.status(500).json({ error: "Failed" });
  }
});

// 2. 多任务/最近应用 (App Switcher)
app.post("/api/app_switcher", async (req, res) => {
  try {
    console.log("🗂 打开多任务后台");
    const deviceSize = await getScreenSize();
    const sessionId = await getSessionId();

    // 逻辑：从屏幕最底部中间，慢慢滑到屏幕中心，然后松开
    // 这就是 iOS 打开多任务的标准手势
    const startX = Math.round(deviceSize.width / 2);
    const startY = deviceSize.height - 5; // 最底部
    const endY = Math.round(deviceSize.height / 2); // 中间

    await axios.post(`${WDA_CTRL}/session/${sessionId}/actions`, {
      actions: [
        {
          type: "pointer",
          id: "finger1",
          parameters: { pointerType: "touch" },
          actions: [
            { type: "pointerMove", duration: 0, x: startX, y: startY },
            { type: "pointerDown", button: 0 },
            // 慢一点滑，持续 500ms
            { type: "pointerMove", duration: 500, x: startX, y: endY },
            // 关键：在中间停顿 500ms，触发多任务
            { type: "pause", duration: 500 },
            { type: "pointerUp", button: 0 },
          ],
        },
      ],
    });
    res.json({ success: true });
  } catch (error) {
    console.error("多任务失败:", error.message);
    res.status(500).json({ error: "Failed" });
  }
});

// 3. 长按接口 (Long Press)
app.post("/api/longpress", async (req, res) => {
  try {
    const { x, y, viewWidth, viewHeight } = req.body;
    const deviceSize = await getScreenSize();

    const realX = Math.round((x / viewWidth) * deviceSize.width);
    const realY = Math.round((y / viewHeight) * deviceSize.height);

    console.log(`📌 长按: (${realX}, ${realY})`);

    const sessionId = await getSessionId();

    // 长按操作：按下后保持一段时间，然后松开
    await axios.post(`${WDA_CTRL}/session/${sessionId}/actions`, {
      actions: [
        {
          type: "pointer",
          id: "finger1",
          parameters: { pointerType: "touch" },
          actions: [
            { type: "pointerMove", duration: 0, x: realX, y: realY },
            { type: "pointerDown", button: 0 },
            // 关键：保持按下状态 1000ms，模拟长按
            { type: "pause", duration: 1000 },
            { type: "pointerUp", button: 0 },
          ],
        },
      ],
    });
    res.json({ success: true });
  } catch (error) {
    console.error("长按失败:", error.message);
    cachedSessionId = null;
    res.status(500).json({ error: "长按失败" });
  }
});

// API: 获取设备屏幕尺寸（GET 接口）
app.get("/api/device/size", async (req, res) => {
  try {
    const size = await getScreenSize();
    res.json(size);
  } catch (error) {
    console.error(`[API] ❌ 获取设备尺寸失败: ${error.message}`);
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.status(500).json({ error: "获取设备尺寸失败" });
  }
});

// API: 设置粘贴板内容
app.post("/api/clipboard", async (req, res) => {
  try {
    const { text } = req.body;
    if (!text || typeof text !== "string") {
      return res.status(400).json({ error: "无效的文本内容" });
    }

    console.log(`📋 设置粘贴板内容: ${text.substring(0, 50)}...`);

    const sessionId = await getSessionId();

    // 使用 WDA 的粘贴板 API
    // WDA 使用 /wda/setPasteboard 接口，需要传递 content 和 encoding
    await axios.post(`${WDA_CTRL}/wda/setPasteboard`, {
      content: text,
      encoding: "utf8",
    });

    console.log("✅ 粘贴板设置成功");
    res.json({ success: true, message: "粘贴板内容已设置" });
  } catch (error) {
    console.error("设置粘贴板失败:", error.message);
    res.status(500).json({ error: `设置粘贴板失败: ${error.message}` });
  }
});

// server.js 只提供 API 接口，不提供静态文件服务
// 静态文件由 dashboard-server.js 提供

// 获取本机 IP 地址
function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      // 跳过内部（即 127.0.0.1）和非 IPv4 地址
      if (iface.family === "IPv4" && !iface.internal) {
        return iface.address;
      }
    }
  }
  return "localhost";
}

app.listen(SERVER_PORT, "0.0.0.0", async () => {
  const localIP = getLocalIP();

  console.log(`🚀 服务已启动: http://0.0.0.0:${SERVER_PORT}`);
  console.log(`📱 本地访问: http://localhost:${SERVER_PORT}`);
  console.log(`🌐 外网访问: http://${localIP}:${SERVER_PORT}`);

  // // 启动 localtunnel（如果失败不影响主服务）
  // try {
  //   const tunnel = await localtunnel({
  //     port: SERVER_PORT, // port 应该是数字，不是 URL
  //   });
  //   console.log(`[🌍] Localtunnel 外网访问地址: ${tunnel.url}`);

  //   // 监听 tunnel 关闭事件
  //   tunnel.on("close", () => {
  //     console.log("[🌍] Localtunnel 已关闭");
  //   });
  // } catch (tunnelError) {
  //   console.warn(`[⚠️] Localtunnel 启动失败: ${tunnelError.message}`);
  //   console.warn(`[⚠️] 服务仍可正常使用，但无法通过 Localtunnel 外网访问`);
  // }
});
