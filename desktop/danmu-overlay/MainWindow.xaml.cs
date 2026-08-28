using System.Collections.ObjectModel;
using System.ComponentModel;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Controls.Primitives;
using System.Windows.Input;
using System.Windows.Interop;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using Forms = System.Windows.Forms;
using Brush = System.Windows.Media.Brush;
using Color = System.Windows.Media.Color;
using WpfApplication = System.Windows.Application;

namespace CraftWyrd.DanmuOverlay;

public partial class MainWindow : Window
{
  private const string IconResourceName = "CraftWyrd.DanmuOverlay.favicon.ico";
  private readonly SettingsStore _settingsStore = new();
  private readonly ChatClient _chatClient = new();
  private readonly VoiceBridge _voiceBridge = new();
  private readonly HashSet<string> _messageIds = new(StringComparer.Ordinal);
  private readonly Forms.NotifyIcon _trayIcon;
  private readonly Forms.ToolStripMenuItem _trayLockItem;
  private readonly System.Drawing.Icon? _trayIconImage;
  private AppSettings _settings;
  private HwndSource? _windowSource;
  private nint _windowHandle;
  private bool _allowClose;
  private bool _hotkeyRegistered;
  private bool _initialized;
  private bool _refreshingAudience;
  private IReadOnlyList<OnlineUser> _onlineUsers = [];
  private IReadOnlyList<VoiceParticipant> _voiceParticipants = [];
  private VoiceStatus _voiceStatus = new(VoiceConnectionState.Idle, "未加入语音房", false, false);

  public ObservableCollection<OverlayMessage> Messages { get; } = [];
  public ObservableCollection<AudienceMember> AudienceMembers { get; } = [];

  public MainWindow()
  {
    _settings = _settingsStore.Load();
    InitializeComponent();
    DataContext = this;
    var windowIcon = TryLoadWindowIcon();
    if (windowIcon is not null) Icon = windowIcon;

    _trayLockItem = new Forms.ToolStripMenuItem("锁定浮窗");
    _trayLockItem.Click += (_, _) => Dispatcher.Invoke(ToggleLock);
    var trayMenu = new Forms.ContextMenuStrip();
    trayMenu.Items.Add("显示并解锁", null, (_, _) => Dispatcher.Invoke(ShowAndUnlock));
    trayMenu.Items.Add(_trayLockItem);
    trayMenu.Items.Add("隐藏", null, (_, _) => Dispatcher.Invoke(Hide));
    trayMenu.Items.Add(new Forms.ToolStripSeparator());
    trayMenu.Items.Add("退出", null, async (_, _) => await Dispatcher.InvokeAsync(ExitApplicationAsync));
    _trayIconImage = TryLoadTrayIcon();
    _trayIcon = new Forms.NotifyIcon
    {
      ContextMenuStrip = trayMenu,
      Icon = _trayIconImage ?? System.Drawing.SystemIcons.Application,
      Text = "CraftWyrd 直播弹幕",
      Visible = true,
    };
    _trayIcon.DoubleClick += (_, _) => Dispatcher.Invoke(ShowAndUnlock);

    _chatClient.MessageReceived += message => Dispatcher.InvokeAsync(() => AddMessage(message));
    _chatClient.ViewerCountChanged += count => Dispatcher.InvokeAsync(() => UpdateViewerCount(count));
    _chatClient.OnlineUsersChanged += users => Dispatcher.InvokeAsync(() => UpdateOnlineUsers(users));
    _chatClient.StateChanged += (state, message) => Dispatcher.InvokeAsync(() => UpdateConnectionState(state, message));
    _voiceBridge.StatusChanged += status => Dispatcher.InvokeAsync(() => UpdateVoiceStatus(status));
    _voiceBridge.ParticipantsChanged += participants => Dispatcher.InvokeAsync(() => UpdateVoiceParticipants(participants));

    Loaded += MainWindow_Loaded;
    SourceInitialized += MainWindow_SourceInitialized;
    Closing += MainWindow_Closing;
  }

  private async void MainWindow_Loaded(object sender, RoutedEventArgs e)
  {
    if (_initialized) return;
    _initialized = true;
    ApplySettingsToControls();
    RestoreWindowGeometry();
    ApplyVisualSettings();
    ApplyLockState();
    await _chatClient.RestartAsync(_settings);
  }

  private void MainWindow_SourceInitialized(object? sender, EventArgs e)
  {
    _windowHandle = new WindowInteropHelper(this).Handle;
    _windowSource = HwndSource.FromHwnd(_windowHandle);
    _windowSource?.AddHook(WindowMessageHook);
    _hotkeyRegistered = NativeMethods.RegisterHotKey(
      _windowHandle,
      NativeMethods.HotkeyId,
      NativeMethods.ModControl | NativeMethods.ModShift | NativeMethods.ModNoRepeat,
      NativeMethods.VkF10);
    ApplyLockState();
  }

  private void MainWindow_Closing(object? sender, CancelEventArgs e)
  {
    if (_allowClose) return;
    e.Cancel = true;
    CaptureWindowGeometry();
    SaveSettings();
    Hide();
  }

  private nint WindowMessageHook(nint window, int message, nint wordParameter, nint longParameter, ref bool handled)
  {
    if (message == NativeMethods.WmHotkey && wordParameter.ToInt32() == NativeMethods.HotkeyId)
    {
      ToggleLock();
      handled = true;
    }
    return nint.Zero;
  }

  private async void ApplyButton_Click(object sender, RoutedEventArgs e)
  {
    var previousRoom = $"{_settings.App}/{_settings.Stream}";
    SyncSettingsFromControls();
    if (previousRoom != $"{_settings.App}/{_settings.Stream}") ClearMessages();
    ApplyVisualSettings();
    SaveSettings();
    SettingsPanel.Visibility = Visibility.Collapsed;
    if (previousRoom != $"{_settings.App}/{_settings.Stream}") await _voiceBridge.DisconnectAsync();
    await _chatClient.RestartAsync(_settings);
  }

  private void SettingsButton_Click(object sender, RoutedEventArgs e)
  {
    SettingsPanel.Visibility = SettingsPanel.Visibility == Visibility.Visible
      ? Visibility.Collapsed
      : Visibility.Visible;
  }

  private void ClearButton_Click(object sender, RoutedEventArgs e) => ClearMessages();

  private void OnlineCountButton_Click(object sender, RoutedEventArgs e)
  {
    if (AudiencePanel.Visibility == Visibility.Visible)
    {
      CloseAudiencePanel();
      return;
    }

    MessagesPanel.Visibility = Visibility.Collapsed;
    AudiencePanel.Visibility = Visibility.Visible;
    RefreshAudienceMembers();
  }

  private void CloseAudienceButton_Click(object sender, RoutedEventArgs e) => CloseAudiencePanel();

  private void CloseAudiencePanel()
  {
    AudiencePanel.Visibility = Visibility.Collapsed;
    MessagesPanel.Visibility = Visibility.Visible;
  }

  private async void VoiceConnectButton_Click(object sender, RoutedEventArgs e)
  {
    try
    {
      if (_voiceStatus.State is VoiceConnectionState.Connected or VoiceConnectionState.Connecting)
      {
        await _voiceBridge.DisconnectAsync();
      }
      else
      {
        await _voiceBridge.ConnectAsync(_settings);
      }
    }
    catch (Exception error)
    {
      UpdateVoiceStatus(new VoiceStatus(VoiceConnectionState.Disconnected, error.Message, false, false));
    }
  }

  private async void VoiceMicrophoneButton_Click(object sender, RoutedEventArgs e)
  {
    try
    {
      await _voiceBridge.SetMicrophoneEnabledAsync(!_voiceStatus.MicrophoneEnabled);
    }
    catch (Exception error)
    {
      UpdateVoiceStatus(new VoiceStatus(VoiceConnectionState.Connected, error.Message, _voiceStatus.MicrophoneEnabled, _voiceStatus.ListeningMuted));
    }
  }

  private async void VoiceListeningButton_Click(object sender, RoutedEventArgs e)
  {
    try
    {
      await _voiceBridge.ToggleListeningMutedAsync();
    }
    catch (Exception error)
    {
      UpdateVoiceStatus(new VoiceStatus(VoiceConnectionState.Connected, error.Message, _voiceStatus.MicrophoneEnabled, _voiceStatus.ListeningMuted));
    }
  }

  private void VoiceMicrophoneButton_MouseEnter(object sender, System.Windows.Input.MouseEventArgs e)
  {
    if (VoiceMicrophoneButton.IsEnabled) VoiceMicrophoneVolumePopup.IsOpen = true;
  }

  private void VoiceListeningButton_MouseEnter(object sender, System.Windows.Input.MouseEventArgs e)
  {
    if (VoiceListeningButton.IsEnabled) VoiceListeningVolumePopup.IsOpen = true;
  }

  private void VoiceVolumeSurface_MouseEnter(object sender, System.Windows.Input.MouseEventArgs e)
  {
    if (sender == VoiceMicrophoneVolumeSurface) VoiceMicrophoneVolumePopup.IsOpen = true;
    if (sender == VoiceListeningVolumeSurface) VoiceListeningVolumePopup.IsOpen = true;
  }

  private void VoiceVolumeButton_MouseLeave(object sender, System.Windows.Input.MouseEventArgs e) => CloseVoiceVolumePopupWhenUnhovered();

  private void VoiceVolumeSurface_MouseLeave(object sender, System.Windows.Input.MouseEventArgs e) => CloseVoiceVolumePopupWhenUnhovered();

  private async void CloseVoiceVolumePopupWhenUnhovered()
  {
    await Task.Delay(140);
    if (!VoiceMicrophoneButton.IsMouseOver && !VoiceMicrophoneVolumeSurface.IsMouseOver) VoiceMicrophoneVolumePopup.IsOpen = false;
    if (!VoiceListeningButton.IsMouseOver && !VoiceListeningVolumeSurface.IsMouseOver) VoiceListeningVolumePopup.IsOpen = false;
  }

  private async void VoiceMicrophoneVolumeSlider_ValueChanged(object sender, RoutedPropertyChangedEventArgs<double> e)
  {
    if (!_initialized) return;
    try
    {
      await _voiceBridge.SetMicrophoneVolumeAsync(e.NewValue);
    }
    catch
    {
      // Volume is retained locally and will apply after the microphone is enabled.
    }
  }

  private async void VoiceListeningVolumeSlider_ValueChanged(object sender, RoutedPropertyChangedEventArgs<double> e)
  {
    if (!_initialized) return;
    try
    {
      await _voiceBridge.SetListeningVolumeAsync(e.NewValue);
    }
    catch
    {
      // Volume is retained locally and will apply after joining the voice room.
    }
  }

  private async void AudienceVolumeSlider_Commit(object sender, RoutedEventArgs e)
  {
    if (!_initialized || _refreshingAudience || sender is not Slider { Tag: AudienceMember member } || !member.IsRemoteVoice) return;
    try
    {
      await _voiceBridge.SetParticipantVolumeAsync(member.Id, ((Slider)sender).Value);
    }
    catch
    {
      // The next renderer update restores the slider if the participant has left.
    }
  }

  private async void AudienceVolumeMuteButton_Click(object sender, RoutedEventArgs e)
  {
    if (!_initialized || sender is not System.Windows.Controls.Button { Tag: AudienceMember member } || !member.IsRemoteVoice) return;
    try
    {
      await _voiceBridge.ToggleParticipantMutedAsync(member.Id);
    }
    catch
    {
      // The next renderer update restores the member state if the participant has left.
    }
  }

  private async void AudienceMicrophoneModerationButton_Click(object sender, RoutedEventArgs e)
  {
    if (!_initialized || sender is not System.Windows.Controls.Button { Tag: AudienceMember member } || !member.IsRemoteVoice) return;
    try
    {
      await _voiceBridge.SetParticipantMicrophoneBlockedAsync(_settings, member.Id, !member.MicrophoneBlocked);
    }
    catch (Exception error)
    {
      UpdateVoiceStatus(new VoiceStatus(VoiceConnectionState.Connected, error.Message, _voiceStatus.MicrophoneEnabled, _voiceStatus.ListeningMuted));
    }
  }

  private void LockButton_Click(object sender, RoutedEventArgs e) => ToggleLock();

  private void HideButton_Click(object sender, RoutedEventArgs e)
  {
    CaptureWindowGeometry();
    SaveSettings();
    Hide();
  }

  private void DragArea_MouseLeftButtonDown(object sender, MouseButtonEventArgs e)
  {
    if (_settings.IsLocked || e.LeftButton != MouseButtonState.Pressed) return;
    if (e.GetPosition(EditChrome).X >= EditChrome.ActualWidth - ToolbarButtons.ActualWidth) return;
    DragMove();
  }

  private void ResizeGrip_DragDelta(object sender, DragDeltaEventArgs e)
  {
    if (_settings.IsLocked) return;
    Width = Math.Max(MinWidth, Width + e.HorizontalChange);
    Height = Math.Max(MinHeight, Height + e.VerticalChange);
  }

  private void OpacitySlider_ValueChanged(object sender, RoutedPropertyChangedEventArgs<double> e)
  {
    if (OpacityValue is null) return;
    OpacityValue.Text = $"{e.NewValue:0}%";
    _settings.BackgroundOpacity = e.NewValue / 100;
    ApplyVisualSettings();
  }

  private void FontSizeSlider_ValueChanged(object sender, RoutedPropertyChangedEventArgs<double> e)
  {
    if (FontSizeValue is null) return;
    FontSizeValue.Text = $"{e.NewValue:0}";
    _settings.FontSize = e.NewValue;
    ApplyMessageSizing();
  }

  private void MessageLimitSlider_ValueChanged(object sender, RoutedPropertyChangedEventArgs<double> e)
  {
    if (MessageLimitValue is null) return;
    MessageLimitValue.Text = $"{e.NewValue:0}";
    _settings.MaxMessages = (int)e.NewValue;
    TrimMessages();
  }

  private void ToggleLock()
  {
    _settings.IsLocked = !_settings.IsLocked;
    if (!IsVisible) Show();
    ApplyLockState();
    CaptureWindowGeometry();
    SaveSettings();
  }

  private void ShowAndUnlock()
  {
    if (!IsVisible) Show();
    if (WindowState == WindowState.Minimized) WindowState = WindowState.Normal;
    _settings.IsLocked = false;
    ApplyLockState();
    Activate();
  }

  private void ApplyLockState()
  {
    ResizeGrip.Visibility = _settings.IsLocked ? Visibility.Collapsed : Visibility.Visible;
    LockGlyph.Text = _settings.IsLocked ? "\uE785" : "\uE72E";
    LockButton.ToolTip = _settings.IsLocked ? "解锁浮窗位置和尺寸" : "锁定浮窗位置和尺寸";
    Surface.BorderBrush = _settings.IsLocked
      ? new SolidColorBrush(Color.FromArgb(126, 255, 107, 85))
      : new SolidColorBrush(Color.FromArgb(108, 230, 229, 223));
    _trayLockItem.Text = _settings.IsLocked ? "解锁浮窗" : "锁定浮窗";
  }

  private void ApplySettingsToControls()
  {
    ServerUrlBox.Text = _settings.ServerUrl;
    AppBox.Text = _settings.App;
    StreamBox.Text = _settings.Stream;
    VoiceModeratorTokenBox.Password = _settings.VoiceModeratorToken;
    OpacitySlider.Value = _settings.BackgroundOpacity * 100;
    FontSizeSlider.Value = _settings.FontSize;
    MessageLimitSlider.Value = _settings.MaxMessages;
    TopmostCheckBox.IsChecked = _settings.AlwaysOnTop;
  }

  private void SyncSettingsFromControls()
  {
    _settings.ServerUrl = ServerUrlBox.Text;
    _settings.App = AppBox.Text;
    _settings.Stream = StreamBox.Text;
    _settings.VoiceModeratorToken = VoiceModeratorTokenBox.Password;
    _settings.BackgroundOpacity = OpacitySlider.Value / 100;
    _settings.FontSize = FontSizeSlider.Value;
    _settings.MaxMessages = (int)MessageLimitSlider.Value;
    _settings.AlwaysOnTop = TopmostCheckBox.IsChecked == true;
    _settings.Normalize();
  }

  private void ApplyVisualSettings()
  {
    if (!IsInitialized) return;
    var surfaceAlpha = (byte)Math.Clamp((int)Math.Round(_settings.BackgroundOpacity * 255), 20, 230);
    var messageAlpha = (byte)Math.Clamp(surfaceAlpha + 22, 32, 238);
    Surface.Background = new SolidColorBrush(Color.FromArgb(surfaceAlpha, 17, 19, 20));
    Resources["MessageBackgroundBrush"] = new SolidColorBrush(Color.FromArgb(messageAlpha, 21, 23, 24));
    Topmost = _settings.AlwaysOnTop;
    ApplyMessageSizing();
  }

  private void ApplyMessageSizing()
  {
    foreach (var message in Messages)
    {
      message.FontSize = _settings.FontSize;
      message.LineHeight = _settings.FontSize * 1.45;
    }
  }

  private void AddMessage(ChatMessage message)
  {
    if (!_messageIds.Add(message.Id)) return;
    Messages.Add(new OverlayMessage(message, _settings.FontSize));
    TrimMessages();
    EmptyState.Visibility = Visibility.Collapsed;
    MessagesScroller.UpdateLayout();
    MessagesScroller.ScrollToEnd();
  }

  private void TrimMessages()
  {
    if (Messages is null) return;
    while (Messages.Count > _settings.MaxMessages)
    {
      _messageIds.Remove(Messages[0].Id);
      Messages.RemoveAt(0);
    }
    if (EmptyState is not null) EmptyState.Visibility = Messages.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
  }

  private void ClearMessages()
  {
    Messages.Clear();
    _messageIds.Clear();
    EmptyState.Visibility = Visibility.Visible;
  }

  private void UpdateViewerCount(int count)
  {
    OnlineCountText.Text = $"{Math.Max(0, count)} 人";
    AudienceSummaryText.Text = $"{Math.Max(0, count)} 人在线 · {_voiceParticipants.Count} 人语音中";
  }

  private void UpdateOnlineUsers(IReadOnlyList<OnlineUser> users)
  {
    _onlineUsers = users;
    UpdateViewerCount(users.Count);
    RefreshAudienceMembers();
  }

  private void UpdateVoiceParticipants(IReadOnlyList<VoiceParticipant> participants)
  {
    _voiceParticipants = participants;
    AudienceSummaryText.Text = $"{_onlineUsers.Count} 人在线 · {participants.Count} 人语音中";
    RefreshAudienceMembers();
  }

  private void UpdateVoiceStatus(VoiceStatus status)
  {
    _voiceStatus = status;
    var connected = status.State == VoiceConnectionState.Connected;
    var connecting = status.State == VoiceConnectionState.Connecting;
    VoiceStatusText.Text = status.Message;
    VoiceHintText.Text = connected
      ? $"{_voiceParticipants.Count} 人语音中 · 可单独调节音量"
      : connecting ? "正在连接 LiveKit 语音房" : "加入后可单独调节成员音量";
    VoiceConnectGlyph.Text = connected || connecting ? "\uE10A" : "\uE716";
    VoiceConnectButton.ToolTip = connected || connecting ? "离开语音房" : "进入语音房";
    VoiceConnectButton.IsEnabled = !connecting;
    VoiceMicrophoneButton.IsEnabled = connected;
    VoiceMicrophoneGlyph.Text = "\uE720";
    VoiceMicrophoneOffSlash.Visibility = status.MicrophoneEnabled ? Visibility.Collapsed : Visibility.Visible;
    VoiceMicrophoneButton.ToolTip = status.MicrophoneEnabled ? "关闭麦克风" : "开启麦克风";
    VoiceListeningButton.IsEnabled = connected;
    VoiceListeningGlyph.Text = status.ListeningMuted ? "\uE74F" : "\uE767";
    VoiceListeningButton.ToolTip = status.ListeningMuted ? "恢复语音房声音" : "静音语音房";
  }

  private void RefreshAudienceMembers()
  {
    if (!_initialized) return;
    _refreshingAudience = true;
    try
    {
      var voiceById = _voiceParticipants.ToDictionary(participant => participant.Id, StringComparer.Ordinal);
      var knownIds = new HashSet<string>(StringComparer.Ordinal);
      AudienceMembers.Clear();
      foreach (var user in _onlineUsers)
      {
        knownIds.Add(user.Id);
        voiceById.TryGetValue(user.Id, out var voiceParticipant);
        AudienceMembers.Add(AudienceMember.From(user, voiceParticipant));
      }

      foreach (var voiceParticipant in _voiceParticipants)
      {
        if (!knownIds.Contains(voiceParticipant.Id)) AudienceMembers.Add(AudienceMember.FromVoiceOnly(voiceParticipant));
      }

      AudienceEmptyState.Visibility = AudienceMembers.Count == 0 ? Visibility.Visible : Visibility.Collapsed;
    }
    finally
    {
      _refreshingAudience = false;
    }
  }

  private void UpdateConnectionState(ChatConnectionState state, string message)
  {
    StatusText.Text = message;
    StatusDot.Fill = state switch
    {
      ChatConnectionState.Connected => new SolidColorBrush(Color.FromRgb(91, 210, 151)),
      ChatConnectionState.Connecting => new SolidColorBrush(Color.FromRgb(242, 184, 75)),
      _ => new SolidColorBrush(Color.FromRgb(255, 107, 85)),
    };
    _trayIcon.Text = state == ChatConnectionState.Connected
      ? $"直播弹幕 · {_settings.App}/{_settings.Stream}"
      : $"直播弹幕 · {message}";
  }

  private void RestoreWindowGeometry()
  {
    Width = _settings.Width;
    Height = _settings.Height;
    var workArea = SystemParameters.WorkArea;
    Left = _settings.Left.HasValue
      ? Math.Clamp(_settings.Left.Value, SystemParameters.VirtualScreenLeft, SystemParameters.VirtualScreenLeft + SystemParameters.VirtualScreenWidth - Width)
      : workArea.Right - Width - 24;
    Top = _settings.Top.HasValue
      ? Math.Clamp(_settings.Top.Value, SystemParameters.VirtualScreenTop, SystemParameters.VirtualScreenTop + SystemParameters.VirtualScreenHeight - Height)
      : workArea.Top + 72;
  }

  private void CaptureWindowGeometry()
  {
    if (WindowState != WindowState.Normal) return;
    _settings.Left = Left;
    _settings.Top = Top;
    _settings.Width = ActualWidth;
    _settings.Height = ActualHeight;
  }

  private void SaveSettings()
  {
    try
    {
      _settingsStore.Save(_settings);
    }
    catch
    {
      UpdateConnectionState(ChatConnectionState.Disconnected, "设置保存失败");
    }
  }

  private async Task ExitApplicationAsync()
  {
    if (_allowClose) return;
    _allowClose = true;
    CaptureWindowGeometry();
    SaveSettings();
    await _chatClient.DisposeAsync();
    await _voiceBridge.DisposeAsync();
    if (_hotkeyRegistered) NativeMethods.UnregisterHotKey(_windowHandle, NativeMethods.HotkeyId);
    _windowSource?.RemoveHook(WindowMessageHook);
    _trayIcon.Visible = false;
    _trayIcon.Dispose();
    _trayIconImage?.Dispose();
    Close();
    WpfApplication.Current.Shutdown();
  }

  private static BitmapImage? TryLoadWindowIcon()
  {
    try
    {
      using var stream = typeof(MainWindow).Assembly.GetManifestResourceStream(IconResourceName);
      if (stream is null) return null;
      var image = new BitmapImage();
      image.BeginInit();
      image.CacheOption = BitmapCacheOption.OnLoad;
      image.StreamSource = stream;
      image.EndInit();
      image.Freeze();
      return image;
    }
    catch
    {
      return null;
    }
  }

  private static System.Drawing.Icon? TryLoadTrayIcon()
  {
    try
    {
      using var stream = typeof(MainWindow).Assembly.GetManifestResourceStream(IconResourceName);
      if (stream is null) return null;
      using var bitmap = new System.Drawing.Bitmap(stream);
      var iconHandle = bitmap.GetHicon();
      try
      {
        using var icon = System.Drawing.Icon.FromHandle(iconHandle);
        return (System.Drawing.Icon)icon.Clone();
      }
      finally
      {
        NativeMethods.DestroyIcon(iconHandle);
      }
    }
    catch
    {
      return null;
    }
  }
}

public sealed class OverlayMessage : INotifyPropertyChanged
{
  private double _fontSize;
  private double _lineHeight;

  public OverlayMessage(ChatMessage message, double fontSize)
  {
    Id = message.Id;
    Name = message.Name;
    Text = message.Text;
    Time = message.SentAt.ToLocalTime().ToString("HH:mm");
    AccentBrush = new SolidColorBrush(ResolveColor(message.Color));
    FontSize = fontSize;
    LineHeight = fontSize * 1.45;
  }

  public string Id { get; }
  public string Name { get; }
  public string Text { get; }
  public string Time { get; }
  public Brush AccentBrush { get; }

  public double FontSize
  {
    get => _fontSize;
    set
    {
      if (Math.Abs(_fontSize - value) < 0.01) return;
      _fontSize = value;
      PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(nameof(FontSize)));
    }
  }

  public double LineHeight
  {
    get => _lineHeight;
    set
    {
      if (Math.Abs(_lineHeight - value) < 0.01) return;
      _lineHeight = value;
      PropertyChanged?.Invoke(this, new PropertyChangedEventArgs(nameof(LineHeight)));
    }
  }

  public event PropertyChangedEventHandler? PropertyChanged;

  private static Color ResolveColor(string color) => color switch
  {
    "pink" => Color.FromRgb(255, 130, 163),
    "mint" => Color.FromRgb(91, 210, 151),
    "lavender" => Color.FromRgb(190, 157, 255),
    "peach" => Color.FromRgb(255, 155, 108),
    "sky" => Color.FromRgb(95, 190, 235),
    _ => Color.FromRgb(242, 184, 75),
  };
}
