# CraftWyrd Danmu Overlay

Windows-only transparent live chat overlay for the CraftWyrd Live room.

## Run locally

The project targets `net9.0-windows` and needs the .NET 9 SDK on a Windows
machine with the WPF and Windows Desktop workloads available:

```powershell
dotnet run --project .\DanmuOverlay.csproj
```

The first launch defaults to:

- Server: `https://srs.drivod.top`
- App: `live`
- Stream: `livestream`

Use **保存并连接** after changing the room. Settings and the last window
position are saved in `%LOCALAPPDATA%\CraftWyrd\DanmuOverlay\settings.json`.

## Window controls

- Drag the header to move the overlay.
- Drag the bottom-right corner to resize it.
- Adjust background opacity, font size, retained message count, and topmost
  behavior in the control panel.
- **Ctrl + Shift + F10** toggles lock mode. The same shortcut works when a game
  has focus.
- Locked mode keeps the compact toolbar visible, disables moving and resizing,
  and leaves the lock icon available to unlock without memorizing the shortcut.
- Closing the window hides it to the system tray. Use the tray menu to show,
  unlock, or exit the application.

The window and tray use `favicon.ico` from this folder. It can be a regular
image file even though the filename is kept for compatibility with the web
favicon; the current file is decoded at runtime for the Windows tray icon.

The connection uses the server's read-only `role=observer` WebSocket identity:
it receives chat messages, cannot send messages, is not counted as an online
viewer, and does not create join/leave system messages.

## Publish

On a Windows build machine with the .NET SDK installed:

```powershell
dotnet publish .\DanmuOverlay.csproj -c Release -r win-x64 --self-contained true -p:PublishSingleFile=true -o .\artifacts\win-x64
```

The resulting executable can be copied to the streaming PC. `bin/`, `obj/`,
and `artifacts/` are intentionally ignored in this folder.

The current repository build also produces
`artifacts\framework-dependent\CraftWyrd.DanmuOverlay.exe`. That smaller build
requires the .NET 9 Desktop Runtime on the target PC. Use the self-contained
publish command when the target PC should not install .NET separately; it may
download the matching Windows runtime packs from NuGet during publish.
