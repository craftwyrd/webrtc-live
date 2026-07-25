export async function waitForIceGathering(peerConnection, timeoutMs = 2500) {
  if (peerConnection.iceGatheringState === 'complete') return

  await new Promise((resolve) => {
    const timeout = window.setTimeout(done, timeoutMs)
    function done() {
      window.clearTimeout(timeout)
      peerConnection.removeEventListener('icegatheringstatechange', handleChange)
      resolve()
    }
    function handleChange() {
      if (peerConnection.iceGatheringState === 'complete') done()
    }
    peerConnection.addEventListener('icegatheringstatechange', handleChange)
  })
}

export function connectionLabel(state) {
  return {
    new: '准备连接',
    connecting: '正在连接',
    connected: '连接正常',
    disconnected: '连接中断',
    failed: '连接失败',
    closed: '已停止',
  }[state] || state
}
