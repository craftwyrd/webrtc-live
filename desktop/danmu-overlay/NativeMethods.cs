using System.Runtime.InteropServices;

namespace CraftWyrd.DanmuOverlay;

internal static class NativeMethods
{
  public const int HotkeyId = 0x4D44;
  public const int WmHotkey = 0x0312;
  public const uint ModControl = 0x0002;
  public const uint ModShift = 0x0004;
  public const uint ModNoRepeat = 0x4000;
  public const uint VkF10 = 0x79;

  private const int GwlExStyle = -20;
  private const long WsExTransparent = 0x00000020L;
  private const long WsExNoActivate = 0x08000000L;

  [DllImport("user32.dll", SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool RegisterHotKey(nint window, int id, uint modifiers, uint virtualKey);

  [DllImport("user32.dll", SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool UnregisterHotKey(nint window, int id);

  [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW", SetLastError = true)]
  private static extern nint GetWindowLongPtr64(nint window, int index);

  [DllImport("user32.dll", EntryPoint = "SetWindowLongPtrW", SetLastError = true)]
  private static extern nint SetWindowLongPtr64(nint window, int index, nint value);

  [DllImport("user32.dll", EntryPoint = "GetWindowLongW", SetLastError = true)]
  private static extern int GetWindowLong32(nint window, int index);

  [DllImport("user32.dll", EntryPoint = "SetWindowLongW", SetLastError = true)]
  private static extern int SetWindowLong32(nint window, int index, int value);

  public static void SetClickThrough(nint window, bool enabled)
  {
    var style = IntPtr.Size == 8 ? GetWindowLongPtr64(window, GwlExStyle).ToInt64() : GetWindowLong32(window, GwlExStyle);
    style = enabled
      ? style | WsExTransparent | WsExNoActivate
      : style & ~WsExTransparent & ~WsExNoActivate;

    if (IntPtr.Size == 8) SetWindowLongPtr64(window, GwlExStyle, new nint(style));
    else SetWindowLong32(window, GwlExStyle, unchecked((int)style));
  }
}
