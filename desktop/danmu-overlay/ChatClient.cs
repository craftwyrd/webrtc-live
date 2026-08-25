using System.IO;
using System.Net.WebSockets;
using System.Text;
using System.Text.Json;

namespace CraftWyrd.DanmuOverlay;

public enum ChatConnectionState
{
  Disconnected,
  Connecting,
  Connected,
}

public sealed class ChatClient : IAsyncDisposable
{
  private readonly SemaphoreSlim _restartLock = new(1, 1);
  private CancellationTokenSource? _lifetime;
  private Task? _runTask;

  public event Action<ChatMessage>? MessageReceived;
  public event Action<int>? ViewerCountChanged;
  public event Action<ChatConnectionState, string>? StateChanged;

  public async Task RestartAsync(AppSettings settings)
  {
    await _restartLock.WaitAsync();
    try
    {
      await StopCurrentAsync();
      var snapshot = settings.Copy();
      snapshot.Normalize();
      _lifetime = new CancellationTokenSource();
      _runTask = RunAsync(snapshot, _lifetime.Token);
    }
    finally
    {
      _restartLock.Release();
    }
  }

  public async ValueTask DisposeAsync()
  {
    await _restartLock.WaitAsync();
    try
    {
      await StopCurrentAsync();
    }
    finally
    {
      _restartLock.Release();
      _restartLock.Dispose();
    }
  }

  private async Task StopCurrentAsync()
  {
    if (_lifetime is null) return;
    _lifetime.Cancel();
    try
    {
      if (_runTask is not null) await _runTask;
    }
    catch (OperationCanceledException)
    {
    }
    finally
    {
      _lifetime.Dispose();
      _lifetime = null;
      _runTask = null;
    }
  }

  private async Task RunAsync(AppSettings settings, CancellationToken cancellationToken)
  {
    var retryDelay = TimeSpan.FromSeconds(1);
    while (!cancellationToken.IsCancellationRequested)
    {
      try
      {
        ViewerCountChanged?.Invoke(0);
        StateChanged?.Invoke(ChatConnectionState.Connecting, "正在连接");
        using var socket = new ClientWebSocket();
        socket.Options.KeepAliveInterval = TimeSpan.FromSeconds(20);
        await socket.ConnectAsync(BuildObserverUri(settings), cancellationToken);
        StateChanged?.Invoke(ChatConnectionState.Connected, "实时连接");
        retryDelay = TimeSpan.FromSeconds(1);
        await ReceiveLoopAsync(socket, cancellationToken);
      }
      catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
      {
        break;
      }
      catch (Exception error)
      {
        ViewerCountChanged?.Invoke(0);
        StateChanged?.Invoke(ChatConnectionState.Disconnected, FriendlyError(error));
      }

      if (cancellationToken.IsCancellationRequested) break;
      StateChanged?.Invoke(ChatConnectionState.Disconnected, $"{retryDelay.TotalSeconds:0} 秒后重连");
      await Task.Delay(retryDelay, cancellationToken);
      retryDelay = TimeSpan.FromSeconds(Math.Min(retryDelay.TotalSeconds * 2, 10));
    }

    ViewerCountChanged?.Invoke(0);
    StateChanged?.Invoke(ChatConnectionState.Disconnected, "已断开");
  }

  private async Task ReceiveLoopAsync(ClientWebSocket socket, CancellationToken cancellationToken)
  {
    var buffer = new byte[8192];
    using var payload = new MemoryStream();

    while (socket.State == WebSocketState.Open && !cancellationToken.IsCancellationRequested)
    {
      payload.SetLength(0);
      WebSocketReceiveResult result;
      do
      {
        result = await socket.ReceiveAsync(new ArraySegment<byte>(buffer), cancellationToken);
        if (result.MessageType == WebSocketMessageType.Close) return;
        payload.Write(buffer, 0, result.Count);
        if (payload.Length > 64 * 1024) throw new InvalidDataException("弹幕消息过大");
      }
      while (!result.EndOfMessage);

      if (result.MessageType != WebSocketMessageType.Text) continue;
      ProcessPayload(Encoding.UTF8.GetString(payload.GetBuffer(), 0, (int)payload.Length));
    }
  }

  private void ProcessPayload(string payload)
  {
    try
    {
      using var document = JsonDocument.Parse(payload);
      var root = document.RootElement;
      var type = root.GetProperty("type").GetString();
      if (type == "chat_history" && root.TryGetProperty("messages", out var history))
      {
        foreach (var message in history.EnumerateArray()) EmitMessage(message);
      }
      else if (type == "chat_message" && root.TryGetProperty("message", out var message))
      {
        EmitMessage(message);
      }
      else if (type == "presence" && root.TryGetProperty("users", out var users) && users.ValueKind == JsonValueKind.Array)
      {
        ViewerCountChanged?.Invoke(users.GetArrayLength());
      }
    }
    catch (JsonException)
    {
    }
  }

  private void EmitMessage(JsonElement message)
  {
    if (message.TryGetProperty("type", out var messageType) && messageType.GetString() == "system") return;

    var id = ReadString(message, "id");
    var name = ReadString(message, "name");
    var text = ReadString(message, "text");
    var color = ReadString(message, "color");
    var contentType = ReadString(message, "contentType");
    if (contentType == "image") text = string.IsNullOrWhiteSpace(text) ? "[图片]" : $"[图片] {text}";
    if (string.IsNullOrWhiteSpace(name) || string.IsNullOrWhiteSpace(text)) return;

    var sentAt = DateTimeOffset.TryParse(ReadString(message, "sentAt"), out var timestamp)
      ? timestamp
      : DateTimeOffset.Now;
    MessageReceived?.Invoke(new ChatMessage(
      string.IsNullOrWhiteSpace(id) ? Guid.NewGuid().ToString("N") : id,
      name,
      text,
      color,
      sentAt));
  }

  private static string ReadString(JsonElement element, string propertyName)
  {
    return element.TryGetProperty(propertyName, out var property) && property.ValueKind == JsonValueKind.String
      ? property.GetString() ?? string.Empty
      : string.Empty;
  }

  private static Uri BuildObserverUri(AppSettings settings)
  {
    var source = settings.ServerUrl.Contains("://", StringComparison.Ordinal)
      ? settings.ServerUrl
      : $"https://{settings.ServerUrl}";
    if (!Uri.TryCreate(source, UriKind.Absolute, out var server)) throw new UriFormatException("服务器地址格式无效");
    if (!new[] { "http", "https", "ws", "wss" }.Contains(server.Scheme, StringComparer.OrdinalIgnoreCase))
    {
      throw new UriFormatException("服务器地址只支持 HTTP、HTTPS、WS 或 WSS");
    }

    var scheme = server.Scheme.ToLowerInvariant() switch
    {
      "https" => "wss",
      "http" => "ws",
      _ => server.Scheme,
    };
    var query = string.Join("&", new Dictionary<string, string>
    {
      ["app"] = settings.App,
      ["stream"] = settings.Stream,
      ["connectionId"] = $"overlay:{Guid.NewGuid():N}",
      ["role"] = "observer",
    }.Select(pair => $"{Uri.EscapeDataString(pair.Key)}={Uri.EscapeDataString(pair.Value)}"));

    return new UriBuilder(server)
    {
      Scheme = scheme,
      Port = server.IsDefaultPort ? -1 : server.Port,
      Path = "/ws/presence",
      Query = query,
      Fragment = string.Empty,
    }.Uri;
  }

  private static string FriendlyError(Exception error)
  {
    return error switch
    {
      UriFormatException => error.Message,
      WebSocketException => "连接失败",
      _ => "连接中断",
    };
  }
}
