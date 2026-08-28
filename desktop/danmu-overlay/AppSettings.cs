namespace CraftWyrd.DanmuOverlay;

public sealed class AppSettings
{
  public string ServerUrl { get; set; } = "https://srs.drivod.top";
  public string App { get; set; } = "live";
  public string Stream { get; set; } = "livestream";
  public string VoiceIdentity { get; set; } = string.Empty;
  public string VoiceDisplayName { get; set; } = "主播桌面";
  public string VoiceModeratorToken { get; set; } = string.Empty;
  public double BackgroundOpacity { get; set; } = 0.28;
  public double FontSize { get; set; } = 17;
  public int MaxMessages { get; set; } = 8;
  public bool AlwaysOnTop { get; set; } = true;
  public bool IsLocked { get; set; }
  public double? Left { get; set; }
  public double? Top { get; set; }
  public double Width { get; set; } = 430;
  public double Height { get; set; } = 540;

  public void Normalize()
  {
    ServerUrl = string.IsNullOrWhiteSpace(ServerUrl) ? "https://srs.drivod.top" : ServerUrl.Trim();
    App = string.IsNullOrWhiteSpace(App) ? "live" : App.Trim();
    Stream = string.IsNullOrWhiteSpace(Stream) ? "livestream" : Stream.Trim();
    VoiceIdentity = string.IsNullOrWhiteSpace(VoiceIdentity) ? $"overlay:{Guid.NewGuid():N}" : VoiceIdentity.Trim();
    VoiceDisplayName = string.IsNullOrWhiteSpace(VoiceDisplayName) ? "主播桌面" : VoiceDisplayName.Trim()[..Math.Min(VoiceDisplayName.Trim().Length, 32)];
    VoiceModeratorToken = VoiceModeratorToken.Trim();
    BackgroundOpacity = Math.Clamp(BackgroundOpacity, 0.08, 0.9);
    FontSize = Math.Clamp(FontSize, 13, 30);
    MaxMessages = Math.Clamp(MaxMessages, 3, 16);
    Width = Math.Clamp(Width, 320, 900);
    Height = Math.Clamp(Height, 240, 1200);
  }

  public AppSettings Copy() => (AppSettings)MemberwiseClone();
}

public sealed record ChatMessage(
  string Id,
  string Name,
  string Text,
  string Color,
  DateTimeOffset SentAt);

public sealed record OnlineUser(
  string Id,
  string Name,
  string Avatar,
  string Color);
