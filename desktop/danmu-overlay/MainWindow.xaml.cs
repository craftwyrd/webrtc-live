using System.Collections.ObjectModel;
using System.ComponentModel;
using System.IO;
using System.Windows;
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
  private readonly SettingsStore _settingsStore = new();
  private readonly ChatClient _chatClient = new();
  private readonly HashSet<string> _messageIds = new(StringComparer.Ordinal);
  private readonly Forms.NotifyIcon _trayIcon;
  private readonly Forms.ToolStripMenuItem _trayLockItem;
  private readonly Stream? _trayIconStream;
  private readonly System.Drawing.Bitmap? _trayIconBitmap;
  private readonly System.Drawing.Icon? _trayIconImage;
  private AppSettings _settings;
  private HwndSource? _windowSource;
  private nint _windowHandle;
  private bool _allowClose;
  private bool _hotkeyRegistered;
  private bool _initialized;

  public ObservableCollection<OverlayMessage> Messages { get; } = [];

  public MainWindow()
  {
    _settings = _settingsStore.Load();
    InitializeComponent();
    DataContext = this;
    Icon = new BitmapImage(new Uri("pack://application:,,,/favicon.ico"));

    _trayLockItem = new Forms.ToolStripMenuItem("锁定浮窗");
    _trayLockItem.Click += (_, _) => Dispatcher.Invoke(ToggleLock);
    var trayMenu = new Forms.ContextMenuStrip();
    trayMenu.Items.Add("显示并解锁", null, (_, _) => Dispatcher.Invoke(ShowAndUnlock));
    trayMenu.Items.Add(_trayLockItem);
    trayMenu.Items.Add("隐藏", null, (_, _) => Dispatcher.Invoke(Hide));
    trayMenu.Items.Add(new Forms.ToolStripSeparator());
    trayMenu.Items.Add("退出", null, async (_, _) => await Dispatcher.InvokeAsync(ExitApplicationAsync));
    var iconResource = WpfApplication.GetResourceStream(new Uri("pack://application:,,,/favicon.ico"));
    _trayIconStream = iconResource?.Stream;
    if (_trayIconStream is not null)
    {
      // The supplied favicon is a JPEG despite its .ico name; WPF can decode it,
      // while WinForms needs a native icon handle for the tray image.
      _trayIconBitmap = new System.Drawing.Bitmap(_trayIconStream);
      _trayIconImage = System.Drawing.Icon.FromHandle(_trayIconBitmap.GetHicon());
    }
    _trayIcon = new Forms.NotifyIcon
    {
      ContextMenuStrip = trayMenu,
      Icon = _trayIconImage ?? System.Drawing.SystemIcons.Application,
      Text = "CraftWyrd 直播弹幕",
      Visible = true,
    };
    _trayIcon.DoubleClick += (_, _) => Dispatcher.Invoke(ShowAndUnlock);

    _chatClient.MessageReceived += message => Dispatcher.InvokeAsync(() => AddMessage(message));
    _chatClient.StateChanged += (state, message) => Dispatcher.InvokeAsync(() => UpdateConnectionState(state, message));

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
    await _chatClient.RestartAsync(_settings);
  }

  private void SettingsButton_Click(object sender, RoutedEventArgs e)
  {
    SettingsPanel.Visibility = SettingsPanel.Visibility == Visibility.Visible
      ? Visibility.Collapsed
      : Visibility.Visible;
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
    if (e.GetPosition(EditChrome).X > EditChrome.ActualWidth - 116) return;
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
    if (_hotkeyRegistered) NativeMethods.UnregisterHotKey(_windowHandle, NativeMethods.HotkeyId);
    _windowSource?.RemoveHook(WindowMessageHook);
    _trayIcon.Visible = false;
    _trayIcon.Dispose();
    _trayIconImage?.Dispose();
    _trayIconBitmap?.Dispose();
    _trayIconStream?.Dispose();
    Close();
    WpfApplication.Current.Shutdown();
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
