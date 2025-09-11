// // 确保MediaBunny已加载
// if (typeof MediaBunny === 'undefined') {
//     console.error('MediaBunny未正确加载，请检查网络连接或CDN地址');
//     alert('录制功能依赖的库加载失败，请刷新页面重试');
// }

let peerConnection = null;
let currentStreamUrl =
  "http://drivod.top:1985/rtc/v1/whep/?app=live&stream=livestream";
const videoElement = document.getElementById("video");
const refreshBtn = document.getElementById("refreshBtn");
const fullscreenBtn = document.getElementById("fullscreenBtn");
const recordBtn = document.getElementById("recordBtn");
const statusText = document.getElementById("statusText");
const streamUrlInput = document.getElementById("streamUrlInput");
const startStreamBtn = document.getElementById("startStreamBtn");

// 视频控制元素
const playPauseBtn = document.getElementById("playPauseBtn");
const muteBtn = document.getElementById("muteBtn");
const volumeSlider = document.getElementById("volumeSlider");
const videoFullscreenBtn = document.getElementById("videoFullscreenBtn");

// 录制相关变量
let mediaRecorder = null;
let recordedChunks = [];
let isRecording = false;
let recordingStartTime = null;
let recordingTimer = null;
const MAX_RECORDING_DURATION = 10 * 60 * 1000; // 10分钟最大录制时长

// 初始化播放器
async function initPlayer() {
  try {
    statusText.textContent = "准备就绪，点击'开始拉流'按钮开始播放";

    // 初始化视频控制
    initVideoControls();

    // 初始化按钮事件
    startStreamBtn.addEventListener("click", async () => {
      const inputUrl = streamUrlInput.value.trim();
      currentStreamUrl =
        inputUrl ||
        "http://drivod.top:1985/rtc/v1/whep/?app=live&stream=livestream";
      await startPlay();
    });

    // 初始化录制按钮
    recordBtn.addEventListener("click", toggleRecording);
  } catch (error) {
    console.error("初始化失败:", error);
    statusText.textContent = `初始化失败: ${error.message}`;
  }
}

// 初始化视频控制
function initVideoControls() {
  // 播放/暂停控制
  playPauseBtn.addEventListener("click", () => {
    if (videoElement.paused) {
      videoElement.play();
      playPauseBtn.textContent = "⏸️";
    } else {
      videoElement.pause();
      playPauseBtn.textContent = "▶️";
    }
  });

  // 静音控制
  muteBtn.addEventListener("click", () => {
    videoElement.muted = !videoElement.muted;
    muteBtn.textContent = videoElement.muted ? "🔇" : "🔊";
    volumeSlider.value = videoElement.muted ? 0 : videoElement.volume;
  });

  // 音量控制
  volumeSlider.addEventListener("input", () => {
    videoElement.volume = volumeSlider.value;
    videoElement.muted = volumeSlider.value == 0;
    muteBtn.textContent = volumeSlider.value == 0 ? "🔇" : "🔊";
  });

  // 视频全屏按钮
  videoFullscreenBtn.addEventListener("click", () => {
    if (videoElement.requestFullscreen) {
      videoElement.requestFullscreen();
    } else if (videoElement.webkitRequestFullscreen) {
      videoElement.webkitRequestFullscreen();
    } else if (videoElement.msRequestFullscreen) {
      videoElement.msRequestFullscreen();
    }
  });

  // 同步初始状态
  videoElement.addEventListener("play", () => {
    playPauseBtn.textContent = "⏸️";
  });

  videoElement.addEventListener("pause", () => {
    playPauseBtn.textContent = "▶️";
  });

  videoElement.addEventListener("volumechange", () => {
    if (!videoElement.muted) {
      volumeSlider.value = videoElement.volume;
    }
  });
}

// 启动播放
async function startPlay() {
  // 清理旧的连接
  if (peerConnection) {
    peerConnection.close();
  }

  if (!videoElement.srcObject) {
    videoElement.srcObject = new MediaStream();
  } else {
    // 清除现有的轨道
    videoElement.srcObject.getTracks().forEach((track) => track.stop());
    videoElement.srcObject = new MediaStream();
  }

  statusText.textContent = "正在建立WebRTC连接...";
  refreshBtn.disabled = true;
  startStreamBtn.disabled = true;

  peerConnection = new RTCPeerConnection({
    iceServers: [{ urls: "stun:drivod.top:5349" }],
    bundlePolicy: "max-bundle",
  });

  // 处理ICE候选
  peerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      console.log("ICE candidate:", event.candidate);
    }
  };

  // 处理连接状态变化
  peerConnection.oniceconnectionstatechange = () => {
    statusText.textContent = `ICE状态: ${peerConnection.iceConnectionState}`;
    console.log("ICE connection state:", peerConnection.iceConnectionState);

    if (peerConnection.iceConnectionState === "connected") {
      statusText.textContent = "直播连接成功";
      refreshBtn.disabled = false;
      startStreamBtn.disabled = false;
    } else if (
      peerConnection.iceConnectionState === "disconnected" ||
      peerConnection.iceConnectionState === "failed"
    ) {
      statusText.textContent = `连接断开: ${peerConnection.iceConnectionState}`;
      refreshBtn.disabled = false;
      startStreamBtn.disabled = false;
    }
  };

  // 添加媒体轨道监听
  peerConnection.ontrack = (event) => {
    console.log("收到轨道:", event.track.kind);

    if (!videoElement.srcObject) {
      videoElement.srcObject = new MediaStream();
    }

    // 移除同类型的旧轨道
    videoElement.srcObject
      .getTracks()
      .filter((track) => track.kind === event.track.kind)
      .forEach((track) => {
        track.stop();
        videoElement.srcObject.removeTrack(track);
      });

    // 添加新轨道
    videoElement.srcObject.addTrack(event.track);
    statusText.textContent = `已接收 ${event.track.kind} 轨道`;
  };

  // 创建Offer
  const offer = await peerConnection.createOffer({
    offerToReceiveAudio: true,
    offerToReceiveVideo: true,
  });
  await peerConnection.setLocalDescription(offer);

  // WHEP协议交互
  try {
    statusText.textContent = "正在与服务器协商...";
    const response = await fetch(currentStreamUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/sdp",
        Accept: "application/sdp",
      },
      body: offer.sdp,
    });

    if (!response.ok) {
      throw new Error(`服务器返回错误: ${response.status}`);
    }

    const answerSDP = await response.text();
    await peerConnection.setRemoteDescription({
      type: "answer",
      sdp: answerSDP,
    });

    console.log("WHEP播放已启动");
  } catch (error) {
    console.error("WHEP协商失败:", error);
    statusText.textContent = `连接失败: ${error.message}`;
    refreshBtn.disabled = false;
    startStreamBtn.disabled = false;
    throw error;
  }
}

// 刷新直播
refreshBtn.addEventListener("click", async () => {
  try {
    statusText.textContent = "正在刷新直播...";
    await startPlay();
  } catch (error) {
    console.error("刷新失败:", error);
    statusText.textContent = `刷新失败: ${error.message}`;
  }
});

// 全屏功能
fullscreenBtn.addEventListener("click", () => {
  if (videoElement.requestFullscreen) {
    videoElement.requestFullscreen();
  } else if (videoElement.webkitRequestFullscreen) {
    videoElement.webkitRequestFullscreen();
  } else if (videoElement.msRequestFullscreen) {
    videoElement.msRequestFullscreen();
  }
});

function toggleRecording() {
  if (!isRecording) {
    startRecording();
  } else {
    stopRecording();
  }
}

// 检查是否支持 MediaRecorder
function checkMediaRecorderSupport() {
  if (!window.MediaRecorder) {
    console.error("MediaRecorder API 不支持");
    alert("您的浏览器不支持录制功能，请使用 Chrome、Edge 或 Firefox 最新版");
    return false;
  }
  return true;
}

// 开始录制
async function startRecording() {
  if (!checkMediaRecorderSupport()) return;

  if (!videoElement.srcObject) {
    alert("没有可录制的视频流");
    return;
  }

  if (isRecording) return;

  try {
    const stream = videoElement.srcObject;
    recordedChunks = [];

    // 获取支持的 MIME 类型
    const mimeType = getSupportedMimeType();
    if (!mimeType) {
      throw new Error("浏览器不支持任何可用的录制格式");
    }

    // 创建 MediaRecorder
    mediaRecorder = new MediaRecorder(stream, {
      mimeType: mimeType,
      videoBitsPerSecond: 2500000, // 2.5 Mbps
      audioBitsPerSecond: 128000, // 128 Kbps
    });

    // 收集数据
    mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0) {
        recordedChunks.push(event.data);
      }
    };

    // 处理录制结束
    mediaRecorder.onstop = () => {
      saveRecording();
    };

    // 处理错误
    mediaRecorder.onerror = (event) => {
      console.error("录制错误:", event.error);
      alert(`录制错误: ${event.error.message}`);
      stopRecording();
    };

    // 开始录制（每1秒收集一次数据）
    mediaRecorder.start(1000);

    isRecording = true;
    recordBtn.textContent = "停止录制";
    recordBtn.classList.add("recording");

    // 显示录制时间
    recordingStartTime = new Date();
    updateRecordingTime();
    recordingTimer = setInterval(updateRecordingTime, 1000);

    statusText.innerHTML = `<span class="recording-indicator"></span>正在录制...`;
  } catch (error) {
    console.error("录制初始化失败:", error);
    alert(`录制初始化失败: ${error.message}`);
    stopRecording();
  }
}

// 获取支持的 MIME 类型
function getSupportedMimeType() {
  const mimeTypes = [
    "video/webm;codecs=avc1,opus", // Chrome/Firefox
    "video/webm;codecs=h264,opus", // Chrome
    "video/webm;codecs=vp9,opus", // Chrome
    "video/mp4;codecs=avc1,aac", // Safari
    "video/webm", // 通用
  ];

  return (
    mimeTypes.find((mimeType) => MediaRecorder.isTypeSupported(mimeType)) ||
    null
  );
}

// 停止录制
function stopRecording() {
  if (!isRecording) return;

  isRecording = false;
  clearInterval(recordingTimer);
  statusText.textContent = "录制已停止，正在生成文件...";

  if (mediaRecorder && mediaRecorder.state !== "inactive") {
    mediaRecorder.stop();
  }

  // 停止所有轨道（可选）
  if (videoElement.srcObject) {
    videoElement.srcObject.getTracks().forEach((track) => track.stop());
  }

  recordBtn.textContent = "开始录制";
  recordBtn.classList.remove("recording");
}

// 保存录制文件
function saveRecording() {
  const blob = new Blob(recordedChunks, { type: recordedChunks[0].type });
  const url = URL.createObjectURL(blob);

  const a = document.createElement("a");
  a.style.display = "none";
  a.href = url;

  // 生成文件名
  const now = new Date();
  const timestamp = `${now.getFullYear()}-${(now.getMonth() + 1)
    .toString()
    .padStart(2, "0")}-${now.getDate().toString().padStart(2, "0")}_${now
    .getHours()
    .toString()
    .padStart(2, "0")}-${now.getMinutes().toString().padStart(2, "0")}-${now
    .getSeconds()
    .toString()
    .padStart(2, "0")}`;

  // 根据 MIME 类型确定文件扩展名
  const ext = blob.type.includes("mp4") ? "mp4" : "webm";
  a.download = `录制_${timestamp}.${ext}`;

  document.body.appendChild(a);
  a.click();

  // 清理
  setTimeout(() => {
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  }, 100);
}

// 更新录制时间（保持不变）
function updateRecordingTime() {
  if (!isRecording) return;

  const now = new Date();
  const duration = Math.floor((now - recordingStartTime) / 1000);
  const minutes = Math.floor(duration / 60)
    .toString()
    .padStart(2, "0");
  const seconds = (duration % 60).toString().padStart(2, "0");

  if (now - recordingStartTime > MAX_RECORDING_DURATION) {
    stopRecording();
    alert("已达到最大录制时长(10分钟)，录制已自动停止");
    return;
  }

  statusText.innerHTML = `<span class="recording-indicator"></span>正在录制... ${minutes}:${seconds}`;
}

// 窗口大小变化时调整视频
window.addEventListener("resize", () => {
  // 可以添加额外的布局调整逻辑
});

// 初始化播放器
document.addEventListener("DOMContentLoaded", initPlayer);
