// PowerShell compiles this the way it compiles src/windows-helper.cs, so it keeps to
// C# 5 as well.

using System;
using System.Drawing;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;

namespace OrcaWow {
  public static class StripWindow {
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr hwnd);

    // Drawn where the addon draws it: INSET pixels right of and below the client area's
    // top-left.
    const int CELL = 3, CELLS_PER_ROW = 160, INSET = 9;
    const int WS_EX_TOPMOST = 0x8, WS_EX_TOOLWINDOW = 0x80, WS_EX_NOACTIVATE = 0x08000000;

    class Quiet : Form {
      protected override bool ShowWithoutActivation { get { return true; } }

      protected override CreateParams CreateParams {
        get {
          CreateParams p = base.CreateParams;
          p.ExStyle |= WS_EX_TOPMOST | WS_EX_TOOLWINDOW | WS_EX_NOACTIVATE;
          return p;
        }
      }
    }

    public static void Run() {
      // Per-monitor aware, so one cell is CELL physical pixels on a scaled display too.
      SetProcessDpiAwarenessContext(new IntPtr(-4));
      string cells = Environment.GetEnvironmentVariable("T3WOW_STRIP_CELLS");
      string[] at = Environment.GetEnvironmentVariable("T3WOW_STRIP_AT").Split(',');
      Brush[] colours = new Brush[8];
      for (int v = 0; v < 8; v++) colours[v] = new SolidBrush(Color.FromArgb((v & 4) != 0 ? 255 : 0, (v & 2) != 0 ? 255 : 0, (v & 1) != 0 ? 255 : 0));

      Quiet game = new Quiet();
      game.Text = Environment.GetEnvironmentVariable("T3WOW_STRIP_TITLE");
      game.FormBorderStyle = FormBorderStyle.FixedToolWindow;
      game.StartPosition = FormStartPosition.Manual;
      game.AutoScaleMode = AutoScaleMode.None;
      game.Location = new Point(int.Parse(at[0]), int.Parse(at[1]));
      game.ClientSize = new Size(700, 220);
      game.BackColor = Color.FromArgb(40, 40, 48);
      game.Paint += delegate(object sender, PaintEventArgs e) {
        for (int i = 0; i < cells.Length; i++) {
          e.Graphics.FillRectangle(colours[cells[i] - '0'], INSET + (i % CELLS_PER_ROW) * CELL, INSET + (i / CELLS_PER_ROW) * CELL, CELL, CELL);
        }
      };

      Quiet cover = new Quiet();
      cover.FormBorderStyle = FormBorderStyle.None;
      cover.StartPosition = FormStartPosition.Manual;
      cover.AutoScaleMode = AutoScaleMode.None;
      cover.BackColor = Color.SlateGray;

      game.Shown += delegate(object sender, EventArgs e) {
        Thread commands = new Thread(delegate() {
          TextReader input = new StreamReader(Console.OpenStandardInput());
          string line;
          try {
            while ((line = input.ReadLine()) != null) {
              string[] words = line.Split(' ');
              game.BeginInvoke((MethodInvoker)delegate() {
                if (words[0] == "hang") Thread.Sleep(int.Parse(words[1]));
                if (words[0] == "cover") cover.Bounds = new Rectangle(game.PointToScreen(new Point(int.Parse(words[1]), int.Parse(words[2]))), new Size(int.Parse(words[3]), int.Parse(words[4])));
                cover.Visible = words[0] == "cover";
              });
            }
            game.BeginInvoke((MethodInvoker)delegate() { game.Close(); });
          } catch (InvalidOperationException) {
            // The window closed first.
          }
        });
        commands.IsBackground = true;
        commands.Start();
        byte[] shown = System.Text.Encoding.ASCII.GetBytes("shown " + GetDpiForWindow(game.Handle) + "\n");
        Console.OpenStandardOutput().Write(shown, 0, shown.Length);
      };

      System.Windows.Forms.Timer deadline = new System.Windows.Forms.Timer();
      deadline.Interval = 20000;
      deadline.Tick += delegate(object sender, EventArgs e) { game.Close(); };
      deadline.Start();

      Application.Run(game);
    }
  }
}
