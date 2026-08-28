using System.Globalization;
using System.Windows;
using Brush = System.Windows.Media.Brush;
using Color = System.Windows.Media.Color;
using SolidColorBrush = System.Windows.Media.SolidColorBrush;

namespace CraftWyrd.DanmuOverlay;

public sealed class AudienceMember
{
  private AudienceMember(string id, string name, string color, VoiceParticipant? voiceParticipant)
  {
    Id = id;
    Name = name;
    Initial = string.IsNullOrWhiteSpace(name) ? "?" : StringInfo.GetNextTextElement(name);
    AvatarBrush = ResolveAvatarBrush(color);
    IsVoiceMember = voiceParticipant is not null;
    IsRemoteVoice = voiceParticipant is { IsLocal: false };
    MicrophoneBlocked = voiceParticipant?.MicrophoneBlocked ?? false;
    Volume = voiceParticipant?.Volume ?? 1;
    SpeakerMuted = IsRemoteVoice && Volume <= 0;
    Status = voiceParticipant is null
      ? "正在观看"
      : MicrophoneBlocked ? "主播已禁麦" : "语音中";
    MicrophoneGlyph = voiceParticipant is null ? "\uE7B3" : "\uE720";
    MicrophoneMuted = voiceParticipant is { MicrophoneEnabled: false };
    MicrophoneToolTip = voiceParticipant is null
      ? "未加入语音房"
      : voiceParticipant.MicrophoneEnabled ? "麦克风已开启" : "麦克风已关闭";
    MicrophoneBrush = voiceParticipant is { MicrophoneEnabled: true } ? OpenMicrophoneBrush : MutedMicrophoneBrush;
    MicrophoneBackground = voiceParticipant is null ? WatchingBackgroundBrush : voiceParticipant.MicrophoneEnabled ? OpenMicrophoneBackgroundBrush : MutedMicrophoneBackgroundBrush;
    SpeakerToolTip = SpeakerMuted ? "恢复此成员声音" : "静音此成员";
    SpeakerBrush = SpeakerMuted ? MutedSpeakerBrush : OpenSpeakerBrush;
    MicrophoneModerationToolTip = MicrophoneBlocked ? "解除成员禁麦" : "禁止成员开麦";
    MicrophoneModerationBrush = MicrophoneBlocked ? MutedSpeakerBrush : OpenSpeakerBrush;
  }

  public string Id { get; }
  public string Name { get; }
  public string Initial { get; }
  public string Status { get; }
  public bool IsVoiceMember { get; }
  public bool IsRemoteVoice { get; }
  public bool MicrophoneBlocked { get; }
  public double Volume { get; set; }
  public bool SpeakerMuted { get; }
  public Visibility RemoteVoiceVisibility => IsRemoteVoice ? Visibility.Visible : Visibility.Collapsed;
  public string MicrophoneGlyph { get; }
  public bool MicrophoneMuted { get; }
  public string MicrophoneToolTip { get; }
  public Brush AvatarBrush { get; }
  public Brush MicrophoneBrush { get; }
  public Brush MicrophoneBackground { get; }
  public string SpeakerToolTip { get; }
  public Brush SpeakerBrush { get; }
  public string MicrophoneModerationToolTip { get; }
  public Brush MicrophoneModerationBrush { get; }

  public static AudienceMember From(OnlineUser user, VoiceParticipant? voiceParticipant) =>
    new(user.Id, user.Name, user.Color, voiceParticipant);

  public static AudienceMember FromVoiceOnly(VoiceParticipant voiceParticipant) =>
    new(voiceParticipant.Id, voiceParticipant.Name, "peach", voiceParticipant);

  private static Brush ResolveAvatarBrush(string color) => color switch
  {
    "pink" => CreateBrush(255, 130, 163),
    "mint" => CreateBrush(91, 210, 151),
    "lavender" => CreateBrush(190, 157, 255),
    "peach" => CreateBrush(255, 155, 108),
    "sky" => CreateBrush(95, 190, 235),
    _ => CreateBrush(242, 184, 75),
  };

  private static readonly Brush OpenMicrophoneBrush = CreateBrush(91, 210, 151);
  private static readonly Brush MutedMicrophoneBrush = CreateBrush(213, 220, 216);
  private static readonly Brush OpenMicrophoneBackgroundBrush = CreateBrush(47, 91, 210, 151);
  private static readonly Brush MutedMicrophoneBackgroundBrush = CreateBrush(47, 213, 220, 216);
  private static readonly Brush WatchingBackgroundBrush = CreateBrush(35, 213, 220, 216);
  private static readonly Brush OpenSpeakerBrush = CreateBrush(213, 220, 216);
  private static readonly Brush MutedSpeakerBrush = CreateBrush(255, 107, 85);

  private static Brush CreateBrush(byte red, byte green, byte blue) => CreateBrush(255, red, green, blue);

  private static Brush CreateBrush(byte alpha, byte red, byte green, byte blue)
  {
    var brush = new SolidColorBrush(Color.FromArgb(alpha, red, green, blue));
    brush.Freeze();
    return brush;
  }
}
