// 默认推流地址
const SCREEN_WHIP_ENDPOINT =
  "https://drivod.top/rtc/v1/whip/?app=live&stream=livestream";

// 获取DOM元素
const screenVideo = document.getElementById("screenVideo");
const startScreenBtn = document.getElementById("startScreenBtn");
const stopScreenBtn = document.getElementById("stopScreenBtn");
const screenStatus = document.getElementById("screenStatus");
const captureSystemAudioCheckbox =
  document.getElementById("captureSystemAudio");
const streamUrlInput = document.getElementById("streamUrl");

// 视频设置元素
const screenWidthInput = document.getElementById("screenWidth");
const screenHeightInput = document.getElementById("screenHeight");
const screenFpsInput = document.getElementById("screenFps");
const screenBitrateInput = document.getElementById("screenBitrate");

// 全局变量
let screenStream;
let cameraStream;
let screenPeerConnection;
let cameraPeerConnection;
let audioContext;

// 设置状态信息
function setStatus(element, message, type = "info") {
  element.textContent = message;
  element.className = `status ${type}`;
}

// 创建空白音频轨道
async function createSilentAudioTrack() {
  if (!audioContext) {
    audioContext = new (window.AudioContext || window.webkitAudioContext)();
  }

  const oscillator = audioContext.createOscillator();
  const gainNode = audioContext.createGain();
  gainNode.gain.value = 0; // 静音

  oscillator.connect(gainNode);

  const dest = audioContext.createMediaStreamDestination();
  gainNode.connect(dest);

  oscillator.start();

  return dest.stream.getAudioTracks()[0];
}

// 确保流中有音频轨道
async function ensureAudioTrack(stream) {
  const audioTracks = stream.getAudioTracks();
  if (audioTracks.length === 0) {
    const silentAudioTrack = await createSilentAudioTrack();
    stream.addTrack(silentAudioTrack);
    console.log("添加了空白音轨");
  }
  return stream;
}

// 创建PeerConnection并处理SDP交换
async function createAndSetupPeerConnection(stream, endpoint, bitrate) {
  const pc = new RTCPeerConnection({
    iceServers: [{ urls: "stun:stun.l.google.com:19302" }],
  });

  // 添加所有轨道到连接
  stream.getTracks().forEach((track) => {
    pc.addTrack(track, stream);
  });

  // 创建offer并设置本地描述
  const offer = await pc.createOffer({
    offerToReceiveAudio: false,
    offerToReceiveVideo: false,
  });

  await pc.setLocalDescription(offer);

  // 设置码率参数
  if (bitrate) {
    const senders = pc.getSenders();
    senders.forEach((sender) => {
      if (sender.track.kind === "video") {
        const parameters = sender.getParameters();
        if (!parameters.encodings) {
          parameters.encodings = [{}];
        }
        parameters.encodings[0].maxBitrate = bitrate * 1000; // 转换为bps
        sender.setParameters(parameters).catch(console.error);
      }
    });
  }

  // 发送offer到服务器
  const response = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/sdp" },
    body: offer.sdp,
  });

  if (!response.ok) {
    throw new Error(`服务器返回错误: ${response.status}`);
  }

  // 获取answer并设置远程描述
  const answerSdp = await response.text();
  await pc.setRemoteDescription({
    type: "answer",
    sdp: answerSdp,
  });

  return pc;
}


// 开始屏幕推流（包含音频）
async function startScreenStreaming() {
  try {
    const captureSystemAudio = captureSystemAudioCheckbox.checked;
    const width = parseInt(screenWidthInput.value);
    const height = parseInt(screenHeightInput.value);
    const fps = parseInt(screenFpsInput.value);
    const bitrate = parseInt(screenBitrateInput.value);

    setStatus(screenStatus, "正在获取屏幕共享权限...");

    // 获取屏幕共享流
    const displayMediaOptions = {
      video: {
        width: { ideal: width },
        height: { ideal: height },
        frameRate: { ideal: fps },
      },
      audio: captureSystemAudio,
    };

    // 显示自定义提示
    if (captureSystemAudio) {
      if (
        !confirm(
          '要捕获系统音频，请选择"整个屏幕"或"浏览器标签页"。\n\n如果选择"窗口"，将无法捕获音频。\n\n是否继续？'
        )
      ) {
        setStatus(screenStatus, "用户取消了屏幕共享", "info");
        return;
      }
    }

    screenStream = await navigator.mediaDevices.getDisplayMedia(
      displayMediaOptions
    );

    // 检查用户实际选择了什么
    const videoTrack = screenStream.getVideoTracks()[0];
    const settings = videoTrack.getSettings();

    // 如果用户选择了窗口但要求捕获系统音频，提示用户
    if (captureSystemAudio && settings.displaySurface === "window") {
      alert(
        '您选择了窗口，无法捕获系统音频。\n\n要捕获系统音频，请选择"整个屏幕"或"浏览器标签页"。\n\n将使用静音音频轨道代替。'
      );
      screenStream = await ensureAudioTrack(screenStream);
    } else if (
      captureSystemAudio &&
      screenStream.getAudioTracks().length === 0
    ) {
      // 用户选择了整个屏幕或标签页但没有音频，添加空白音轨
      screenStream = await ensureAudioTrack(screenStream);
    } else if (!captureSystemAudio) {
      // 用户不要求系统音频，确保有空白音轨
      screenStream = await ensureAudioTrack(screenStream);
    }

    screenVideo.srcObject = screenStream;
    setStatus(screenStatus, "正在建立屏幕推流连接...");

    // 获取推流地址
    if (streamUrlInput.value == null) {
      streamUrlInput.value = SCREEN_WHIP_ENDPOINT.textContent;
    }
    const endpoint = streamUrlInput.value;
    console.log("屏幕推流地址:", endpoint);

    // 创建并设置PeerConnection
    screenPeerConnection = await createAndSetupPeerConnection(
      screenStream,
      endpoint,
      bitrate
    );

    // 设置ICE候选和连接状态回调
    screenPeerConnection.onicecandidate = (event) => {
      if (event.candidate) {
        console.log("屏幕 ICE candidate:", event.candidate);
      }
    };

    screenPeerConnection.onconnectionstatechange = () => {
      console.log("屏幕连接状态:", screenPeerConnection.connectionState);
      if (screenPeerConnection.connectionState === "connected") {
        setStatus(screenStatus, "屏幕推流已连接!", "success");
      } else if (screenPeerConnection.connectionState === "disconnected") {
        setStatus(screenStatus, "屏幕推流已断开", "error");
      }
    };

    // 监听屏幕共享停止事件
    screenStream.getVideoTracks()[0].onended = () => {
      stopScreenStreaming();
      setStatus(screenStatus, "用户停止了屏幕共享", "error");
    };

    startScreenBtn.disabled = true;
    stopScreenBtn.disabled = false;
  } catch (error) {
    console.error("屏幕推流错误:", error);
    setStatus(screenStatus, `屏幕推流错误: ${error.message}`, "error");
    stopScreenStreaming();
  }
}

// 停止屏幕推流
function stopScreenStreaming() {
  if (screenPeerConnection) {
    screenPeerConnection.close();
    screenPeerConnection = null;
  }

  if (screenStream) {
    screenStream.getTracks().forEach((track) => track.stop());
    screenStream = null;
    screenVideo.srcObject = null;
  }

  startScreenBtn.disabled = false;
  stopScreenBtn.disabled = true;

  setStatus(screenStatus, "屏幕推流已停止");
}

// 事件监听
startScreenBtn.addEventListener("click", startScreenStreaming);
stopScreenBtn.addEventListener("click", stopScreenStreaming);
