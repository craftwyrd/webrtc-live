using System.Net.Http;
using System.IO;
using System.Text;
using System.Text.Json;
using System.Windows;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;

namespace CraftWyrd.DanmuOverlay;

public enum VoiceConnectionState
{
  Idle,
  Connecting,
  Connected,
  Disconnected,
}

public sealed record VoiceStatus(
  VoiceConnectionState State,
  string Message,
  bool MicrophoneEnabled,
  bool ListeningMuted);

public sealed record VoiceParticipant(
  string Id,
  string Name,
  bool IsLocal,
  bool MicrophoneEnabled,
  bool MicrophoneBlocked,
  double Volume);

public sealed class VoiceBridge : IAsyncDisposable
{
  private static readonly HttpClient HttpClient = new();
  private readonly string _userDataDirectory;
  private readonly string _bridgePagePath;
  private Window? _hostWindow;
  private WebView2? _webView;
  private TaskCompletionSource? _readySignal;
  private bool _disposed;
  private bool _microphonePermissionRequested;

  public event Action<VoiceStatus>? StatusChanged;
  public event Action<IReadOnlyList<VoiceParticipant>>? ParticipantsChanged;

  public VoiceBridge()
  {
    _userDataDirectory = Path.Combine(
      Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
      "CraftWyrd",
      "DanmuOverlay",
      "webview2");
    _bridgePagePath = Path.Combine(_userDataDirectory, "voice-bridge.html");
  }

  public async Task ConnectAsync(AppSettings settings)
  {
    ThrowIfDisposed();
    await EnsureInitializedAsync();
    PublishStatus(VoiceConnectionState.Connecting, "正在进入语音房", false, false);
    try
    {
      var token = await FetchTokenAsync(settings);
      await SendCommandAsync(new
      {
        command = "connect",
        url = token.Url,
        token = token.Token,
      });
    }
    catch (Exception error)
    {
      PublishStatus(VoiceConnectionState.Disconnected, FriendlyError(error), false, false);
      throw;
    }
  }

  public Task DisconnectAsync() => SendCommandAsync(new { command = "disconnect" });

  public Task SetMicrophoneEnabledAsync(bool enabled)
  {
    _microphonePermissionRequested = enabled;
    return SendCommandAsync(new { command = "setMicrophoneEnabled", enabled });
  }

  public Task ToggleListeningMutedAsync() => SendCommandAsync(new { command = "toggleListeningMuted" });

  public Task SetMicrophoneVolumeAsync(double volume) => SendCommandAsync(new
  {
    command = "setMicrophoneVolume",
    volume = Math.Clamp(volume, 0, 2),
  });

  public Task SetListeningVolumeAsync(double volume) => SendCommandAsync(new
  {
    command = "setListeningVolume",
    volume = Math.Clamp(volume, 0, 1),
  });

  public Task SetParticipantVolumeAsync(string participantId, double volume) => SendCommandAsync(new
  {
    command = "setParticipantVolume",
    participantId,
    volume = Math.Clamp(volume, 0, 1),
  });

  public Task ToggleParticipantMutedAsync(string participantId) => SendCommandAsync(new
  {
    command = "toggleParticipantMuted",
    participantId,
  });

  public async Task SetParticipantMicrophoneBlockedAsync(AppSettings settings, string participantId, bool blocked)
  {
    if (string.IsNullOrWhiteSpace(settings.VoiceModeratorToken)) throw new InvalidOperationException("请先在设置中填写主持人令牌");
    var endpoint = BuildApiUri(settings, "/api/voice/moderation/microphone");
    using var request = new HttpRequestMessage(HttpMethod.Post, endpoint)
    {
      Content = new StringContent(JsonSerializer.Serialize(new
      {
        app = settings.App,
        stream = settings.Stream,
        identity = participantId,
        muted = blocked,
      }), Encoding.UTF8, "application/json"),
    };
    request.Headers.TryAddWithoutValidation("X-Voice-Moderator-Token", settings.VoiceModeratorToken);
    using var response = await HttpClient.SendAsync(request);
    if (response.IsSuccessStatusCode) return;
    var body = await response.Content.ReadAsStringAsync();
    throw new InvalidOperationException(ReadErrorMessage(body) ?? $"禁麦服务返回 {(int)response.StatusCode}");
  }

  public async ValueTask DisposeAsync()
  {
    if (_disposed) return;
    _disposed = true;
    try
    {
      if (_webView?.CoreWebView2 is not null) await SendCommandAsync(new { command = "disconnect" });
    }
    catch
    {
      // The host process is exiting, so an already closed WebView is harmless.
    }

    _webView?.Dispose();
    _hostWindow?.Close();
    _webView = null;
    _hostWindow = null;
  }

  private async Task EnsureInitializedAsync()
  {
    if (_webView?.CoreWebView2 is not null) return;

    Directory.CreateDirectory(_userDataDirectory);
    File.WriteAllText(_bridgePagePath, BootstrapHtml, new UTF8Encoding(encoderShouldEmitUTF8Identifier: false));
    _hostWindow = new Window
    {
      Width = 2,
      Height = 2,
      Left = SystemParameters.VirtualScreenLeft - 40,
      Top = SystemParameters.VirtualScreenTop - 40,
      ShowInTaskbar = false,
      ShowActivated = false,
      WindowStyle = WindowStyle.None,
      ResizeMode = ResizeMode.NoResize,
      Background = System.Windows.Media.Brushes.Black,
    };
    _webView = new WebView2 { Width = 2, Height = 2 };
    _hostWindow.Content = _webView;
    _hostWindow.Show();

    var environment = await CoreWebView2Environment.CreateAsync(
      userDataFolder: _userDataDirectory,
      options: new CoreWebView2EnvironmentOptions("--autoplay-policy=no-user-gesture-required"));
    await _webView.EnsureCoreWebView2Async(environment);
    _webView.CoreWebView2.Settings.IsWebMessageEnabled = true;
    _webView.CoreWebView2.WebMessageReceived += WebView_WebMessageReceived;
    _webView.CoreWebView2.PermissionRequested += WebView_PermissionRequested;
    _readySignal = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);
    _webView.CoreWebView2.SetVirtualHostNameToFolderMapping(
      "voice.bridge.local",
      _userDataDirectory,
      CoreWebView2HostResourceAccessKind.DenyCors);
    _webView.CoreWebView2.Navigate("https://voice.bridge.local/voice-bridge.html");
    await _readySignal.Task.WaitAsync(TimeSpan.FromSeconds(15));
  }

  private void WebView_PermissionRequested(object? sender, CoreWebView2PermissionRequestedEventArgs eventArgs)
  {
    if (eventArgs.PermissionKind == CoreWebView2PermissionKind.Microphone && _microphonePermissionRequested)
    {
      eventArgs.State = CoreWebView2PermissionState.Allow;
      _microphonePermissionRequested = false;
    }
  }

  private void WebView_WebMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs eventArgs)
  {
    try
    {
      using var document = JsonDocument.Parse(eventArgs.WebMessageAsJson);
      var root = document.RootElement;
      var type = ReadString(root, "type");
      switch (type)
      {
        case "ready":
          _readySignal?.TrySetResult();
          break;
        case "status":
          PublishStatus(
            ParseVoiceState(ReadString(root, "state")),
            ReadString(root, "message"),
            ReadBoolean(root, "microphoneEnabled"),
            ReadBoolean(root, "listeningMuted"));
          break;
        case "participants":
          ParticipantsChanged?.Invoke(ParseParticipants(root));
          break;
        case "error":
          PublishStatus(
            ParseVoiceState(ReadString(root, "state")),
            ReadString(root, "message"),
            ReadBoolean(root, "microphoneEnabled"),
            ReadBoolean(root, "listeningMuted"));
          break;
      }
    }
    catch (JsonException)
    {
      // Ignore malformed renderer messages and wait for the next state update.
    }
  }

  private async Task SendCommandAsync(object command)
  {
    if (_webView?.CoreWebView2 is null) return;
    _webView.CoreWebView2.PostWebMessageAsJson(JsonSerializer.Serialize(command));
    await Task.CompletedTask;
  }

  private static async Task<VoiceToken> FetchTokenAsync(AppSettings settings)
  {
    var endpoint = BuildApiUri(settings, "/api/voice/token");
    using var request = new HttpRequestMessage(HttpMethod.Post, endpoint)
    {
      Content = new StringContent(JsonSerializer.Serialize(new
      {
        app = settings.App,
        stream = settings.Stream,
        identity = settings.VoiceIdentity,
        name = settings.VoiceDisplayName,
      }), Encoding.UTF8, "application/json"),
    };
    using var response = await HttpClient.SendAsync(request);
    var body = await response.Content.ReadAsStringAsync();
    if (!response.IsSuccessStatusCode)
    {
      throw new InvalidOperationException(ReadErrorMessage(body) ?? $"语音服务返回 {(int)response.StatusCode}");
    }

    using var document = JsonDocument.Parse(body);
    var root = document.RootElement;
    var url = ReadString(root, "url");
    var token = ReadString(root, "token");
    if (string.IsNullOrWhiteSpace(url) || string.IsNullOrWhiteSpace(token)) throw new InvalidOperationException("语音服务未返回连接信息");
    return new VoiceToken(url, token);
  }

  private static Uri BuildApiUri(AppSettings settings, string path)
  {
    var source = settings.ServerUrl.Contains("://", StringComparison.Ordinal)
      ? settings.ServerUrl
      : $"https://{settings.ServerUrl}";
    if (!Uri.TryCreate(source, UriKind.Absolute, out var server)) throw new UriFormatException("服务器地址格式无效");
    if (server.Scheme is "ws" or "wss")
    {
      var builder = new UriBuilder(server)
      {
        Scheme = server.Scheme == "wss" ? "https" : "http",
        Port = server.IsDefaultPort ? -1 : server.Port,
      };
      server = builder.Uri;
    }
    if (server.Scheme is not ("http" or "https")) throw new UriFormatException("服务器地址只支持 HTTP 或 HTTPS");
    return new UriBuilder(server) { Path = path, Query = string.Empty, Fragment = string.Empty }.Uri;
  }

  private static IReadOnlyList<VoiceParticipant> ParseParticipants(JsonElement root)
  {
    if (!root.TryGetProperty("participants", out var values) || values.ValueKind != JsonValueKind.Array) return [];
    return values.EnumerateArray()
      .Select(value => new VoiceParticipant(
        ReadString(value, "id"),
        ReadString(value, "name"),
        ReadBoolean(value, "isLocal"),
        ReadBoolean(value, "microphoneEnabled"),
        ReadBoolean(value, "microphoneBlocked"),
        ReadDouble(value, "volume", 1)))
      .Where(participant => !string.IsNullOrWhiteSpace(participant.Id))
      .ToArray();
  }

  private static VoiceConnectionState ParseVoiceState(string state) => state switch
  {
    "connecting" => VoiceConnectionState.Connecting,
    "connected" => VoiceConnectionState.Connected,
    "idle" => VoiceConnectionState.Idle,
    _ => VoiceConnectionState.Disconnected,
  };

  private static string FriendlyError(Exception error) => error switch
  {
    HttpRequestException => "无法连接语音服务",
    TaskCanceledException => "语音连接超时",
    _ => error.Message,
  };

  private static string? ReadErrorMessage(string body)
  {
    try
    {
      using var document = JsonDocument.Parse(body);
      return ReadString(document.RootElement, "error");
    }
    catch (JsonException)
    {
      return null;
    }
  }

  private static string ReadString(JsonElement element, string propertyName) =>
    element.TryGetProperty(propertyName, out var property) && property.ValueKind == JsonValueKind.String
      ? property.GetString() ?? string.Empty
      : string.Empty;

  private static bool ReadBoolean(JsonElement element, string propertyName) =>
    element.TryGetProperty(propertyName, out var property) && property.ValueKind is JsonValueKind.True or JsonValueKind.False && property.GetBoolean();

  private static double ReadDouble(JsonElement element, string propertyName, double fallback) =>
    element.TryGetProperty(propertyName, out var property) && property.TryGetDouble(out var value) ? value : fallback;

  private void PublishStatus(VoiceConnectionState state, string message, bool microphoneEnabled, bool listeningMuted) =>
    StatusChanged?.Invoke(new VoiceStatus(state, message, microphoneEnabled, listeningMuted));

  private void ThrowIfDisposed()
  {
    if (_disposed) throw new ObjectDisposedException(nameof(VoiceBridge));
  }

  private sealed record VoiceToken(string Url, string Token);

  private const string BootstrapHtml = """
<!doctype html><html><head><meta charset="utf-8"></head><body><script type="module">
let sdk, room, microphoneEnabled = false, listeningMuted = false, microphoneVolume = 1, listeningVolume = 1, microphoneGainProcessor;
const participantVolumes = new Map();
const lastAudibleParticipantVolumes = new Map();
const attachedTracks = new Map();
const post = (type, payload = {}) => window.chrome.webview.postMessage({ type, ...payload });
const clamp = (value, maximum = 2) => Math.min(maximum, Math.max(0, Number(value) || 0));
async function loadSdk() { if (!sdk) sdk = await import('https://cdn.jsdelivr.net/npm/livekit-client@2.22.1/+esm'); }
function remoteVolume(participant) { return participantVolumes.get(participant.identity) ?? 1; }
function applyVolume(participant) { participant.setVolume(Math.min(1, (listeningMuted ? 0 : listeningVolume) * remoteVolume(participant))); }
function applyAllVolumes() { if (room) room.remoteParticipants.forEach(applyVolume); }
function createMicrophoneGainProcessor() {
  let source, gain, destination, context;
  return {
    name: 'desktop-microphone-gain',
    processedTrack: undefined,
    setVolume(value) {
      microphoneVolume = clamp(value);
      if (gain && context) gain.gain.setTargetAtTime(microphoneVolume, context.currentTime, 0.02);
    },
    async init({ track, audioContext }) {
      context = audioContext;
      if (!context) throw new Error('浏览器未初始化音频上下文');
      source = context.createMediaStreamSource(new MediaStream([track]));
      gain = context.createGain();
      destination = context.createMediaStreamDestination();
      source.connect(gain); gain.connect(destination);
      this.processedTrack = destination.stream.getAudioTracks()[0];
      this.setVolume(microphoneVolume);
    },
    async restart(options) { await this.destroy(); await this.init(options); },
    async destroy() {
      source?.disconnect(); gain?.disconnect();
      destination?.stream.getTracks().forEach(track => track.stop());
      this.processedTrack = undefined;
    },
  };
}
async function applyMicrophoneVolume() {
  const publication = room?.localParticipant.getTrackPublication(sdk.Track.Source.Microphone);
  const track = publication?.track;
  if (!track || !microphoneEnabled) return;
  if (!microphoneGainProcessor) {
    microphoneGainProcessor = createMicrophoneGainProcessor();
    await track.setProcessor(microphoneGainProcessor, false);
  }
  microphoneGainProcessor.setVolume(microphoneVolume);
}
function detachTrack(track) {
  const key = track.sid || track.mediaStreamTrack?.id;
  const elements = attachedTracks.get(key) || track.detach?.() || [];
  elements.forEach(element => element.remove());
  attachedTracks.delete(key);
}
function attachTrack(track) {
  detachTrack(track);
  const element = track.attach();
  const elements = Array.isArray(element) ? element : [element];
  elements.forEach(item => { item.autoplay = true; item.playsInline = true; document.body.appendChild(item); item.play?.().catch(() => {}); });
  attachedTracks.set(track.sid || track.mediaStreamTrack?.id, elements);
}
function reportParticipants() {
  if (!room) return post('participants', { participants: [] });
  const local = room.localParticipant;
  const localEntry = local ? [{ id: local.identity, name: local.name || local.identity, isLocal: true, microphoneEnabled, microphoneBlocked: local.permissions?.canPublish === false, volume: 1 }] : [];
  const remoteEntries = Array.from(room.remoteParticipants.values()).map(participant => ({
    id: participant.identity,
    name: participant.name || participant.identity,
    isLocal: false,
    microphoneEnabled: Array.from(participant.audioTrackPublications.values()).some(publication => !publication.isMuted),
    microphoneBlocked: participant.permissions?.canPublish === false,
    volume: remoteVolume(participant),
  }));
  post('participants', { participants: [...localEntry, ...remoteEntries] });
}
function reportStatus(state, message) { post('status', { state, message, microphoneEnabled, listeningMuted }); }
function bindRoomEvents() {
  room.on(sdk.RoomEvent.ParticipantConnected, reportParticipants);
  room.on(sdk.RoomEvent.ParticipantDisconnected, reportParticipants);
  room.on(sdk.RoomEvent.ParticipantNameChanged, reportParticipants);
  room.on(sdk.RoomEvent.TrackMuted, reportParticipants);
  room.on(sdk.RoomEvent.TrackUnmuted, reportParticipants);
  room.on(sdk.RoomEvent.ParticipantPermissionsChanged, reportParticipants);
  room.on(sdk.RoomEvent.TrackSubscribed, (track, _publication, participant) => { if (track.kind === sdk.Track.Kind.Audio) { attachTrack(track); applyVolume(participant); } reportParticipants(); });
  room.on(sdk.RoomEvent.TrackUnsubscribed, track => { detachTrack(track); reportParticipants(); });
  room.on(sdk.RoomEvent.ConnectionStateChanged, state => { if (state === 'connected') reportStatus('connected', '正在监听语音房'); if (state === 'reconnecting') reportStatus('connecting', '语音房重连中'); });
  room.on(sdk.RoomEvent.Disconnected, () => { microphoneEnabled = false; listeningMuted = false; reportStatus('idle', '未加入语音房'); reportParticipants(); });
}
async function disconnect(notify = true) {
  for (const elements of attachedTracks.values()) elements.forEach(element => element.remove());
  attachedTracks.clear();
  if (room) room.disconnect();
  room = undefined; microphoneEnabled = false; listeningMuted = false; microphoneGainProcessor = undefined;
  if (notify) { reportStatus('idle', '未加入语音房'); reportParticipants(); }
}
async function connect({ url, token }) {
  await disconnect(false); reportStatus('connecting', '正在进入语音房');
  try {
    await loadSdk(); room = new sdk.Room({ adaptiveStream: false, dynacast: false }); bindRoomEvents();
    await room.connect(url, token, { autoSubscribe: true });
    reportStatus('connected', '正在监听语音房'); reportParticipants();
  } catch (error) { post('error', { message: error?.message || String(error) }); await disconnect(false); }
}
async function receive(command) {
  if (command.command === 'connect') return connect(command);
  if (command.command === 'disconnect') return disconnect();
  if (!room) return;
  if (command.command === 'setMicrophoneEnabled') { microphoneEnabled = Boolean(command.enabled); await room.localParticipant.setMicrophoneEnabled(microphoneEnabled, microphoneEnabled ? { echoCancellation: true, noiseSuppression: true, autoGainControl: true } : undefined); if (microphoneEnabled) await applyMicrophoneVolume(); reportStatus('connected', microphoneEnabled ? '麦克风已开启' : '麦克风已关闭'); reportParticipants(); }
  if (command.command === 'toggleListeningMuted') { listeningMuted = !listeningMuted; applyAllVolumes(); reportStatus('connected', listeningMuted ? '已静音语音房' : '正在监听语音房'); }
  if (command.command === 'setMicrophoneVolume') { microphoneVolume = clamp(command.volume); if (microphoneGainProcessor) microphoneGainProcessor.setVolume(microphoneVolume); }
  if (command.command === 'setListeningVolume') { listeningVolume = clamp(command.volume, 1); applyAllVolumes(); }
  if (command.command === 'setParticipantVolume') { const volume = clamp(command.volume, 1); participantVolumes.set(command.participantId, volume); if (volume > 0) lastAudibleParticipantVolumes.set(command.participantId, volume); const participant = room.remoteParticipants.get(command.participantId); if (participant) applyVolume(participant); reportParticipants(); }
  if (command.command === 'toggleParticipantMuted') { const volume = remoteVolume({ identity: command.participantId }); if (volume > 0) { lastAudibleParticipantVolumes.set(command.participantId, volume); participantVolumes.set(command.participantId, 0); } else { participantVolumes.set(command.participantId, lastAudibleParticipantVolumes.get(command.participantId) || 1); } const participant = room.remoteParticipants.get(command.participantId); if (participant) applyVolume(participant); reportParticipants(); }
}
window.chrome.webview.addEventListener('message', event => receive(event.data).catch(error => post('error', {
  state: room ? 'connected' : 'disconnected',
  message: error?.message || String(error),
  microphoneEnabled,
  listeningMuted,
})));
post('ready');
</script></body></html>
""";
}
