using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.WinForms;

namespace WasmArchitectNativeHost;

internal sealed class MainForm : Form
{
    private const string AppHost = "wasm.local";
    private readonly WebView2 _webView;
    private SocketBridge? _socketBridge;
    private bool _initialized;

    public MainForm()
    {
        Text = "WASM Architect Studio — Native TCP Host";
        Width = 1500;
        Height = 960;
        StartPosition = FormStartPosition.CenterScreen;
        BackColor = Color.FromArgb(7, 10, 16);

        _webView = new WebView2
        {
            Dock = DockStyle.Fill,
            DefaultBackgroundColor = Color.FromArgb(7, 10, 16)
        };

        Controls.Add(_webView);
        Shown += OnShown;
        FormClosing += OnFormClosing;
    }

    private async void OnShown(object? sender, EventArgs e)
    {
        if (_initialized) return;
        _initialized = true;

        try
        {
            await InitializeWebViewAsync();
        }
        catch (Exception ex)
        {
            MessageBox.Show(
                this,
                "The native host could not start.\n\n" + ex,
                "WASM Architect Native Host",
                MessageBoxButtons.OK,
                MessageBoxIcon.Error);
            Close();
        }
    }

    private async Task InitializeWebViewAsync()
    {
        string baseDirectory = AppContext.BaseDirectory;
        string wwwDirectory = Path.GetFullPath(Path.Combine(baseDirectory, "www"));
        string bridgeFile = Path.GetFullPath(Path.Combine(baseDirectory, "bridge", "native-socket-bridge.js"));
        string indexFile = Path.Combine(wwwDirectory, "index.html");

        if (!File.Exists(indexFile))
            throw new FileNotFoundException("Missing Studio page.", indexFile);
        if (!File.Exists(bridgeFile))
            throw new FileNotFoundException("Missing native socket bridge.", bridgeFile);

        string userDataDirectory = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "WasmArchitectNativeHost",
            "WebView2");

        Directory.CreateDirectory(userDataDirectory);

        CoreWebView2Environment environment = await CoreWebView2Environment.CreateAsync(
            browserExecutableFolder: null,
            userDataFolder: userDataDirectory);

        await _webView.EnsureCoreWebView2Async(environment);
        CoreWebView2 core = _webView.CoreWebView2;

        core.Settings.IsWebMessageEnabled = true;
        core.Settings.AreHostObjectsAllowed = false;
        core.Settings.AreDevToolsEnabled = true;
        core.Settings.AreDefaultContextMenusEnabled = true;
        core.Settings.IsStatusBarEnabled = true;

        core.SetVirtualHostNameToFolderMapping(
            AppHost,
            wwwDirectory,
            CoreWebView2HostResourceAccessKind.Allow);

        string bootstrapScript = await File.ReadAllTextAsync(bridgeFile);
        await core.AddScriptToExecuteOnDocumentCreatedAsync(bootstrapScript);

        _socketBridge = new SocketBridge(core, this);
        core.WebMessageReceived += OnWebMessageReceived;
        core.NavigationStarting += OnNavigationStarting;
        core.ProcessFailed += OnProcessFailed;
        core.NewWindowRequested += OnNewWindowRequested;

        core.Navigate($"https://{AppHost}/index.html");
    }

    private void OnWebMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
    {
        if (_socketBridge is null) return;
        if (!Uri.TryCreate(e.Source, UriKind.Absolute, out Uri? source) ||
            source.Scheme != Uri.UriSchemeHttps ||
            !string.Equals(source.Host, AppHost, StringComparison.OrdinalIgnoreCase))
            return;

        try
        {
            _socketBridge.Handle(e.TryGetWebMessageAsString());
        }
        catch (Exception ex)
        {
            System.Diagnostics.Debug.WriteLine(ex);
        }
    }

    private void OnNavigationStarting(object? sender, CoreWebView2NavigationStartingEventArgs e)
    {
        if (Uri.TryCreate(e.Uri, UriKind.Absolute, out Uri? target) &&
            target.Scheme == Uri.UriSchemeHttps &&
            string.Equals(target.Host, AppHost, StringComparison.OrdinalIgnoreCase))
            return;

        e.Cancel = true;
        if (Uri.TryCreate(e.Uri, UriKind.Absolute, out target) &&
            (target.Scheme == Uri.UriSchemeHttp || target.Scheme == Uri.UriSchemeHttps))
        {
            System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(target.AbsoluteUri)
            {
                UseShellExecute = true
            });
        }
    }

    private void OnNewWindowRequested(object? sender, CoreWebView2NewWindowRequestedEventArgs e)
    {
        e.Handled = true;
        if (Uri.TryCreate(e.Uri, UriKind.Absolute, out Uri? uri) &&
            (uri.Scheme == Uri.UriSchemeHttp || uri.Scheme == Uri.UriSchemeHttps))
        {
            System.Diagnostics.Process.Start(new System.Diagnostics.ProcessStartInfo(uri.AbsoluteUri)
            {
                UseShellExecute = true
            });
        }
    }

    private void OnProcessFailed(object? sender, CoreWebView2ProcessFailedEventArgs e)
    {
        BeginInvoke((Action)(() =>
            Text = $"WASM Architect Studio — WebView failure: {e.ProcessFailedKind}"));
    }

    private async void OnFormClosing(object? sender, FormClosingEventArgs e)
    {
        if (_socketBridge is not null)
        {
            await _socketBridge.DisposeAsync();
            _socketBridge = null;
        }
    }
}
