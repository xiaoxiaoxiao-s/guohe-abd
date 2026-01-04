const express = require("express");
const axios = require("axios");
const path = require("path");
const cors = require("cors");
const http = require("http"); // <--- 必须引入这个原生模块

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ==========================================
// 核心修改 1: 从环境变量读取端口配置
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
app.get("/api/stream", (req, res) => {
  // 使用原生 http 模块发起请求，建立直连通道
  const proxyReq = http.get(MJPEG_URL, (streamRes) => {
    // 1. 把 WDA 返回的响应头直接复制给前端 (保持 multipart/x-mixed-replace)
    res.writeHead(streamRes.statusCode, streamRes.headers);

    // 2. 建立管道：WDA的数据 -> Node -> 前端 (不经过任何处理)
    streamRes.pipe(res);
  });

  // 错误处理
  proxyReq.on("error", (e) => {
    console.error("❌ 视频流转发失败:", e.message);
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
              // duration 优化：从500ms减小到150ms，实现快速响应
              { type: "pointerMove", duration: 150, x: realEndX, y: realEndY },
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

// API: 获取设备屏幕尺寸
app.get("/api/device/size", async (req, res) => {
  try {
    const size = await getScreenSize();
    res.json(size);
  } catch (error) {
    console.error("获取设备尺寸失败:", error.message);
    res.status(500).json({ error: "获取设备尺寸失败" });
  }
});

// 确保根路径返回 index.html
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

app.listen(SERVER_PORT, () => {
  console.log(`🚀 服务已启动: http://localhost:${SERVER_PORT}`);
  console.log(`📱 访问控制界面: http://localhost:${SERVER_PORT}`);
});
