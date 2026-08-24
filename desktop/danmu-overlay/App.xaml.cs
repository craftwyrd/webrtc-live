using System.Windows;
using WpfApplication = System.Windows.Application;

namespace CraftWyrd.DanmuOverlay;

public partial class App : WpfApplication
{
  protected override void OnStartup(StartupEventArgs e)
  {
    base.OnStartup(e);
    MainWindow = new MainWindow();
    MainWindow.Show();
  }
}
