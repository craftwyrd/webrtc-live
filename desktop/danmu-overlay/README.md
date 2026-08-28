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
- Click the online-count button to open the audience panel. After joining the
  voice room there, it shows each voice member's microphone state and lets the
  streamer adjust every remote member's playback volume independently.
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

Voice controls use the Microsoft Edge WebView2 Runtime to run the same LiveKit
browser client as the web room. Windows 10/11 normally include this runtime;
install the Evergreen WebView2 Runtime if the desktop program reports that the
voice component cannot start. The desktop client requests a short-lived token
from `/api/voice/token`, so the server must have the same LiveKit environment
variables configured as the web application.

## Host microphone moderation

The lock icon on a remote voice member blocks or restores that member's ability
to publish microphone audio. Blocking is enforced by LiveKit and remains in
effect if the member leaves and rejoins. Configure the application container
with these values before using it:

```text
LIVEKIT_API_URL=http://127.0.0.1:7880
VOICE_MODERATOR_TOKEN=<a long random secret>
```

Enter the same secret in the overlay settings under **主持人令牌**. The desktop
program sends it only as the `X-Voice-Moderator-Token` header for the protected
moderation endpoint. Keep it private; without it, the lock control is disabled
by the server.

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
