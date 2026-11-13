// The bridge's Windows helper. windows.js starts Windows PowerShell 5.1 with
//
//   Add-Type -LiteralPath <this file> -ReferencedAssemblies System.Drawing,System.Web.Extensions
//   [OrcaWow.Helper]::Run()
//
// so this is compiled on the player's PC each time the bridge starts, by the compiler
// inside .NET Framework 4.x, which ships with Windows 10 and 11. That compiler stops at
// C# 5: no string interpolation, no ?. operator, no expression-bodied members, no
// `out var`, no nameof.
//
// Protocol
//
// Request (stdin): one line of UTF-8 JSON ending in \n.
//     {"id":<int>,"op":"<name>", ...arguments}
// Reply (stdout): one line of UTF-8 JSON ending in \n, then exactly `bytes` raw bytes.
//     {"id":<same>,"ok":true, ...fields,"bytes":<n>}
//     {"id":<same>,"ok":false,"error":"<what went wrong>","bytes":0}
// Requests are answered one at a time, in order. Before the first request the helper
// writes one frame with no id:
//     {"ready":true,"bytes":0}
//
//   op        arguments             reply fields                                  data
//   procs     name                  procs: [{pid, path|null, startMs}]            none
//   windows   pid, title            windows: [{hwnd, pid, title, visible,         none
//                                    minimized, x, y, width, height}]
//   grab      hwnd, w, h            state, via, width, height                     width*height*3 bytes, RGB
//             or x, y, w, h         (no hwnd: copy the screen at x,y)
//   shot      hwnd, quality         state, width, height                          a JPEG file
//
//   state: "ok" | "gone" (not a window any more) | "minimized" | "cloaked" (on another
//          virtual desktop) | "hung" (not answering, and reading it needed PrintWindow).
//          The other fields and the data are only sent with "ok".
//   via:   "screen" | "window", how grab read the pixels.
//
// All positions and sizes are physical pixels of the whole desktop. The helper exits
// with code 0 when stdin closes, and when the bridge's process (T3WOW_PARENT_PID) is
// gone. Anything written to stderr is for people: windows.js puts it in its error
// message.

using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Drawing2D;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

namespace OrcaWow {
  public static class Helper {
    [StructLayout(LayoutKind.Sequential)] struct FILETIME { public uint Low, High; }
    [StructLayout(LayoutKind.Sequential)] struct RECT { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] struct POINT { public int X, Y; }
    delegate bool EnumWindowsProc(IntPtr hwnd, IntPtr lParam);

    [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder path, ref uint size);
    [DllImport("kernel32.dll")] static extern bool GetProcessTimes(IntPtr process, out FILETIME created, out FILETIME exited, out FILETIME kernel, out FILETIME user);
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] static extern bool SetProcessDPIAware();
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc callback, IntPtr lParam);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr hwnd, out RECT rect);
    [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr hwnd, ref POINT point);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int max);
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT point);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr hwnd, uint flags);
    [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
    [DllImport("user32.dll")] static extern bool IsHungAppWindow(IntPtr hwnd);
    [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr hwnd);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hwnd, int attribute, out int value, int size);

    const uint PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;
    // A FILETIME counts 100 ns steps from 1601. The bridge wants ms from 1970.
    const long MS_FROM_1601_TO_1970 = 11644473600000;
    static readonly IntPtr PER_MONITOR_AWARE_V2 = new IntPtr(-4);
    const uint GA_ROOT = 2;
    const uint PW_CLIENTONLY = 1, PW_RENDERFULLCONTENT = 2;
    const int DWMWA_CLOAKED = 14;
    // The strip as the addon draws it, INSET pixels right of and below the top-left of
    // the client area, clear of a corner the desktop rounds. Older addons drew it in the
    // corner itself.
    const int CELL = 3, CELLS_PER_ROW = 160, MAX_ROWS = 40, INSET = 9;
    const int COVER_STEP = 16;

    delegate byte[] Operation(Dictionary<string, object> request, Dictionary<string, object> reply);

    static readonly Dictionary<string, Operation> operations = new Dictionary<string, Operation> {
      { "procs", Procs },
      { "windows", Windows },
      { "grab", Grab },
      { "shot", Shot },
    };

    static readonly JavaScriptSerializer json = new JavaScriptSerializer();
    static Stream output;

    static Bitmap canvas;
    static byte[] row, rgb;

    /// The only entry point. Returns when stdin closes.
    public static void Run() {
      // Before any window or drawing call. Without it Windows scales every coordinate
      // and resamples the pixels, which the decoder can't read.
      try {
        if (!SetProcessDpiAwarenessContext(PER_MONITOR_AWARE_V2)) SetProcessDPIAware();
      } catch (EntryPointNotFoundException) {
        // Windows 10 before version 1703.
        SetProcessDPIAware();
      }
      WatchParent();
      output = Console.OpenStandardOutput();
      StreamReader input = new StreamReader(Console.OpenStandardInput(), new UTF8Encoding(false));
      Dictionary<string, object> hello = new Dictionary<string, object>();
      hello["ready"] = true;
      Reply(hello, null);
      string line;
      while ((line = input.ReadLine()) != null) {
        Dictionary<string, object> reply = new Dictionary<string, object>();
        byte[] data = null;
        try {
          Dictionary<string, object> request = json.Deserialize<Dictionary<string, object>>(line);
          reply["id"] = request["id"];
          string op = (string)request["op"];
          Operation operation;
          if (!operations.TryGetValue(op, out operation)) throw new ArgumentException("the helper has no operation called " + op);
          data = operation(request, reply);
          reply["ok"] = true;
        } catch (Exception e) {
          object id;
          reply.TryGetValue("id", out id);
          reply = new Dictionary<string, object>();
          reply["id"] = id;
          reply["ok"] = false;
          reply["error"] = e.Message;
          data = null;
        }
        Reply(reply, data);
      }
    }

    /// Stdin closing is how the helper normally learns the bridge is gone. This thread
    /// covers the case where the main thread is stuck inside a Windows call and can't
    /// notice.
    static void WatchParent() {
      int pid;
      if (!int.TryParse(Environment.GetEnvironmentVariable("T3WOW_PARENT_PID"), out pid)) return;
      Thread watcher = new Thread(delegate() {
        try {
          Process.GetProcessById(pid).WaitForExit();
        } catch (ArgumentException) {
          // Gone already.
        } catch (Exception) {
          return;
        }
        Environment.Exit(0);
      });
      watcher.IsBackground = true;
      watcher.Start();
    }

    static void Reply(Dictionary<string, object> head, byte[] data) {
      head["bytes"] = data == null ? 0 : data.Length;
      byte[] line = Encoding.UTF8.GetBytes(json.Serialize(head) + "\n");
      try {
        output.Write(line, 0, line.Length);
        if (data != null) output.Write(data, 0, data.Length);
        output.Flush();
      } catch (IOException) {
        Environment.Exit(0);
      }
    }

    /// The path and start time come from OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION),
    /// not from Process.MainModule and Process.StartTime, which fail with "Access is
    /// denied" when the game runs as administrator and the bridge doesn't.
    static byte[] Procs(Dictionary<string, object> request, Dictionary<string, object> reply) {
      List<object> procs = new List<object>();
      foreach (Process process in Process.GetProcessesByName((string)request["name"])) {
        using (process) {
          IntPtr handle = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, (uint)process.Id);
          if (handle == IntPtr.Zero) continue;
          try {
            FILETIME created, exited, kernel, user;
            if (!GetProcessTimes(handle, out created, out exited, out kernel, out user)) continue;
            StringBuilder path = new StringBuilder(1024);
            uint size = (uint)path.Capacity;
            Dictionary<string, object> entry = new Dictionary<string, object>();
            entry["pid"] = process.Id;
            entry["path"] = QueryFullProcessImageName(handle, 0, path, ref size) ? path.ToString() : null;
            entry["startMs"] = (long)((((ulong)created.High << 32) | created.Low) / 10000) - MS_FROM_1601_TO_1970;
            procs.Add(entry);
          } finally {
            CloseHandle(handle);
          }
        }
      }
      reply["procs"] = procs;
      return null;
    }

    /// x, y, width and height describe the client area, the part the game draws. The
    /// outer window rectangle would be wrong by the title bar and by the invisible resize
    /// border Windows 10 and 11 add, which is about as wide as the slack the decoder has.
    static byte[] Windows(Dictionary<string, object> request, Dictionary<string, object> reply) {
      uint pid = Convert.ToUInt32(request["pid"]);
      string wanted = (string)request["title"];
      List<object> windows = new List<object>();
      EnumWindows(delegate(IntPtr hwnd, IntPtr unused) {
        uint owner;
        GetWindowThreadProcessId(hwnd, out owner);
        StringBuilder title = new StringBuilder(256);
        GetWindowText(hwnd, title, title.Capacity);
        if (owner != pid && title.ToString() != wanted) return true;
        RECT client;
        GetClientRect(hwnd, out client);
        POINT origin = new POINT();
        ClientToScreen(hwnd, ref origin);
        Dictionary<string, object> window = new Dictionary<string, object>();
        window["hwnd"] = hwnd.ToInt64();
        window["pid"] = owner;
        window["title"] = title.ToString();
        window["visible"] = IsWindowVisible(hwnd);
        window["minimized"] = IsIconic(hwnd);
        window["x"] = origin.X;
        window["y"] = origin.Y;
        window["width"] = client.Right;
        window["height"] = client.Bottom;
        windows.Add(window);
        return true;
      }, IntPtr.Zero);
      reply["windows"] = windows;
      return null;
    }

    /// Two ways to read a window (measured on a 3840x2160 HDR display, game window
    /// 2992x1683, both with correct colours):
    ///  - "screen": copy that rectangle of the screen. 17 ms, and the cost doesn't grow
    ///    with the window. It reads whatever is on screen there.
    ///  - "window": PrintWindow, which has Windows render the whole client area. 45 ms,
    ///    growing with the window, but it reads the game even when something covers it.
    /// So the screen copy is the normal path, and PrintWindow covers the case the copy
    /// gets wrong: another window over the corner, or the corner off screen.
    static byte[] Grab(Dictionary<string, object> request, Dictionary<string, object> reply) {
      int w = Convert.ToInt32(request["w"]), h = Convert.ToInt32(request["h"]);
      POINT origin = new POINT();
      bool fromScreen = true;
      Bitmap pixels;
      if (request.ContainsKey("hwnd")) {
        IntPtr hwnd = new IntPtr(Convert.ToInt64(request["hwnd"]));
        string state = State(hwnd);
        reply["state"] = state;
        if (state != "ok") return null;
        RECT client;
        GetClientRect(hwnd, out client);
        ClientToScreen(hwnd, ref origin);
        w = Math.Min(w, client.Right);
        h = Math.Min(h, client.Bottom);
        fromScreen = Uncovered(hwnd, origin, w, h);
        pixels = fromScreen ? Canvas(w, h) : Print(hwnd, client);
        if (pixels == null) {
          reply["state"] = "hung";
          return null;
        }
      } else {
        origin.X = Convert.ToInt32(request["x"]);
        origin.Y = Convert.ToInt32(request["y"]);
        reply["state"] = "ok";
        pixels = Canvas(w, h);
      }
      if (fromScreen) {
        using (Graphics graphics = Graphics.FromImage(pixels)) {
          graphics.CopyFromScreen(origin.X, origin.Y, 0, 0, new Size(w, h), CopyPixelOperation.SourceCopy);
        }
      }
      reply["via"] = fromScreen ? "screen" : "window";
      reply["width"] = w;
      reply["height"] = h;
      return Rgb(pixels, w, h);
    }

    static byte[] Shot(Dictionary<string, object> request, Dictionary<string, object> reply) {
      IntPtr hwnd = new IntPtr(Convert.ToInt64(request["hwnd"]));
      string state = State(hwnd);
      reply["state"] = state;
      if (state != "ok") return null;
      RECT client;
      GetClientRect(hwnd, out client);
      Bitmap full = Print(hwnd, client);
      if (full == null) {
        reply["state"] = "hung";
        return null;
      }
      uint dpi = 96;
      try {
        dpi = Math.Max(96u, GetDpiForWindow(hwnd));
      } catch (EntryPointNotFoundException) {
        // Windows 10 before version 1607.
      }
      int width = Math.Max(1, (int)((client.Right * 96L + dpi / 2) / dpi));
      int height = Math.Max(1, (int)((client.Bottom * 96L + dpi / 2) / dpi));
      reply["width"] = width;
      reply["height"] = height;
      using (Bitmap scaled = new Bitmap(width, height, PixelFormat.Format24bppRgb))
      using (MemoryStream jpeg = new MemoryStream())
      using (EncoderParameters parameters = new EncoderParameters(1)) {
        using (Graphics graphics = Graphics.FromImage(scaled)) {
          graphics.InterpolationMode = InterpolationMode.HighQualityBicubic;
          graphics.DrawImage(full, new Rectangle(0, 0, width, height));
        }
        parameters.Param[0] = new EncoderParameter(System.Drawing.Imaging.Encoder.Quality, Convert.ToInt64(request["quality"]));
        scaled.Save(jpeg, Array.Find(ImageCodecInfo.GetImageEncoders(), delegate(ImageCodecInfo codec) { return codec.FormatID == ImageFormat.Jpeg.Guid; }), parameters);
        return jpeg.ToArray();
      }
    }

    static string State(IntPtr hwnd) {
      if (!IsWindow(hwnd)) return "gone";
      if (IsIconic(hwnd)) return "minimized";
      int cloaked;
      if (DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, out cloaked, sizeof(int)) == 0 && cloaked != 0) return "cloaked";
      return "ok";
    }

    /// Looks at one point every COVER_STEP pixels from the corner across the strip and
    /// along its far edges, so both where the addon draws it and where older addons drew
    /// it. That sees every window at least COVER_STEP pixels wide and high that is over
    /// any part of the strip. A smaller one can sit between the points. Each point costs
    /// 1.7 us (measured), so the 288 here cost 0.5 ms a grab.
    ///
    /// A point off every monitor has no window, so a corner dragged off screen counts as
    /// covered. WindowFromPoint skips click-through overlays.
    static bool Uncovered(IntPtr hwnd, POINT origin, int w, int h) {
      int right = Math.Min(w, INSET + CELLS_PER_ROW * CELL) - 1, bottom = Math.Min(h, INSET + MAX_ROWS * CELL) - 1;
      for (int x = 0; ; x = Math.Min(x + COVER_STEP, right)) {
        for (int y = 0; ; y = Math.Min(y + COVER_STEP, bottom)) {
          POINT point;
          point.X = origin.X + x;
          point.Y = origin.Y + y;
          if (GetAncestor(WindowFromPoint(point), GA_ROOT) != hwnd) return false;
          if (y == bottom) break;
        }
        if (x == right) break;
      }
      return true;
    }

    static Bitmap Canvas(int width, int height) {
      if (canvas == null || canvas.Width != width || canvas.Height != height) {
        if (canvas != null) canvas.Dispose();
        canvas = new Bitmap(width, height, PixelFormat.Format32bppRgb);
      }
      return canvas;
    }

    /// Null for a window Windows calls hung, which it does once the window's thread has
    /// read no message for 5 s. PrintWindow waits for that thread for as long as it takes
    /// (measured: 8 s), and the helper can do nothing else meanwhile. In the first 5 s the
    /// wait still happens, and the bridge's time limit on the request ends it.
    static Bitmap Print(IntPtr hwnd, RECT client) {
      if (IsHungAppWindow(hwnd)) return null;
      Bitmap onto = Canvas(client.Right, client.Bottom);
      using (Graphics graphics = Graphics.FromImage(onto)) {
        IntPtr hdc = graphics.GetHdc();
        try {
          if (!PrintWindow(hwnd, hdc, PW_CLIENTONLY | PW_RENDERFULLCONTENT)) throw new InvalidOperationException("Windows couldn't draw the game window");
        } finally {
          graphics.ReleaseHdc(hdc);
        }
      }
      return onto;
    }

    static byte[] Rgb(Bitmap bitmap, int w, int h) {
      if (row == null || row.Length != w * 4) row = new byte[w * 4];
      if (rgb == null || rgb.Length != w * h * 3) rgb = new byte[w * h * 3];
      BitmapData bits = bitmap.LockBits(new Rectangle(0, 0, w, h), ImageLockMode.ReadOnly, PixelFormat.Format32bppRgb);
      try {
        int at = 0;
        for (int y = 0; y < h; y++) {
          Marshal.Copy(new IntPtr(bits.Scan0.ToInt64() + (long)y * bits.Stride), row, 0, row.Length);
          for (int i = 0; i < row.Length; i += 4) {
            rgb[at++] = row[i + 2];
            rgb[at++] = row[i + 1];
            rgb[at++] = row[i];
          }
        }
      } finally {
        bitmap.UnlockBits(bits);
      }
      return rgb;
    }
  }
}
