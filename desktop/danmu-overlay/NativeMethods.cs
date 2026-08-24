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

  [DllImport("user32.dll", SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool RegisterHotKey(nint window, int id, uint modifiers, uint virtualKey);

  [DllImport("user32.dll", SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool UnregisterHotKey(nint window, int id);

  [DllImport("user32.dll", SetLastError = true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool DestroyIcon(nint icon);
}
