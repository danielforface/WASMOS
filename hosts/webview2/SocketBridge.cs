using System.Collections.Concurrent;
using System.Net.Sockets;
using System.Text.Json;
using Microsoft.Web.WebView2.Core;

namespace WasmArchitectNativeHost;

/// <summary>
/// Narrow host ABI: it exposes TCP client byte streams, not HTTP, a proxy,
/// a local server or RTSP logic. RTSP remains entirely inside the WASM app.
/// </summary>
internal sealed class SocketBridge : IAsyncDisposable
{
    private const int MaxWriteBytes = 16 * 1024 * 1024;
    private readonly CoreWebView2 _webView;
    private readonly Control _ui;
    private readonly ConcurrentDictionary<int, TcpConnection> _connections = new();
    private int _disposed;

    public SocketBridge(CoreWebView2 webView, Control ui)
    {
        _webView = webView;
        _ui = ui;
    }

    public void Handle(string json)
    {
        if (Volatile.Read(ref _disposed) != 0) return;
        _ = HandleAsync(json);
    }

    private async Task HandleAsync(string json)
    {
        try
        {
            using JsonDocument document = JsonDocument.Parse(json);
            JsonElement root = document.RootElement;
            string type = RequiredString(root, "type");
            int id = RequiredInt32(root, "id");

            switch (type)
            {
                case "tcp-open":
                    await OpenAsync(
                        id,
                        RequiredString(root, "host"),
                        RequiredInt32(root, "port"),
                        OptionalBoolean(root, "keepAlive"),
                        OptionalBoolean(root, "noDelay"));
                    break;

                case "tcp-write":
                    await WriteAsync(
                        id,
                        RequiredInt32(root, "requestId"),
                        RequiredString(root, "data"));
                    break;

                case "tcp-close":
                    await CloseByIdAsync(id, notifyPage: true);
                    break;

                default:
                    await SendErrorAsync(id, $"Unsupported host command: {type}");
                    break;
            }
        }
        catch (Exception ex)
        {
            await PostAsync(new { type = "host-error", error = SafeError(ex) });
        }
    }

    private async Task OpenAsync(int id, string host, int port, bool keepAlive, bool noDelay)
    {
        host = host.Trim();
        if (host.Length is < 1 or > 253)
        {
            await SendErrorAsync(id, "Invalid TCP host name.");
            return;
        }

        if (port is < 1 or > 65535)
        {
            await SendErrorAsync(id, "TCP port must be between 1 and 65535.");
            return;
        }

        var connection = new TcpConnection(id, host, port);
        if (!_connections.TryAdd(id, connection))
        {
            await SendErrorAsync(id, "Socket id already exists.");
            return;
        }

        try
        {
            await connection.Client.ConnectAsync(host, port, connection.Cancellation.Token);
            connection.Client.NoDelay = noDelay;
            connection.Client.Client.SetSocketOption(
                SocketOptionLevel.Socket,
                SocketOptionName.KeepAlive,
                keepAlive);
            connection.Stream = connection.Client.GetStream();

            await PostAsync(new { type = "tcp-opened", id });
            await ReadLoopAsync(connection);
        }
        catch (OperationCanceledException) when (connection.Cancellation.IsCancellationRequested)
        {
            // Expected during an explicit close or app shutdown.
        }
        catch (Exception ex)
        {
            await SendErrorAsync(id, SafeError(ex));
        }
        finally
        {
            await CloseConnectionAsync(connection, notifyPage: true);
        }
    }

    private async Task ReadLoopAsync(TcpConnection connection)
    {
        byte[] buffer = new byte[64 * 1024];

        while (!connection.Cancellation.IsCancellationRequested)
        {
            NetworkStream stream = connection.Stream
                ?? throw new IOException("TCP stream is not open.");

            int count = await stream.ReadAsync(buffer, connection.Cancellation.Token);
            if (count == 0) return;

            await PostAsync(new
            {
                type = "tcp-data",
                id = connection.Id,
                data = Convert.ToBase64String(buffer, 0, count)
            });
        }
    }

    private async Task WriteAsync(int id, int requestId, string base64)
    {
        if (!_connections.TryGetValue(id, out TcpConnection? connection) ||
            connection.Stream is null)
        {
            await SendErrorAsync(id, "TCP socket is not open.", requestId);
            return;
        }

        byte[] bytes;
        try
        {
            bytes = Convert.FromBase64String(base64);
        }
        catch (FormatException)
        {
            await SendErrorAsync(id, "Invalid base64 TCP payload.", requestId);
            return;
        }

        if (bytes.Length > MaxWriteBytes)
        {
            await SendErrorAsync(id, $"TCP write exceeds {MaxWriteBytes} bytes.", requestId);
            return;
        }

        try
        {
            await connection.WriteGate.WaitAsync(connection.Cancellation.Token);
            try
            {
                await connection.Stream.WriteAsync(bytes, connection.Cancellation.Token);
                await connection.Stream.FlushAsync(connection.Cancellation.Token);
            }
            finally
            {
                connection.WriteGate.Release();
            }

            await PostAsync(new { type = "tcp-write-ok", id, requestId });
        }
        catch (OperationCanceledException) when (connection.Cancellation.IsCancellationRequested)
        {
            await SendErrorAsync(id, "TCP socket was closed.", requestId);
        }
        catch (Exception ex)
        {
            await SendErrorAsync(id, SafeError(ex), requestId);
            await CloseConnectionAsync(connection, notifyPage: true);
        }
    }

    private async Task CloseByIdAsync(int id, bool notifyPage)
    {
        if (_connections.TryGetValue(id, out TcpConnection? connection))
            await CloseConnectionAsync(connection, notifyPage);
        else if (notifyPage)
            await PostAsync(new { type = "tcp-closed", id });
    }

    private async Task CloseConnectionAsync(TcpConnection connection, bool notifyPage)
    {
        if (Interlocked.Exchange(ref connection.Closed, 1) != 0) return;

        _connections.TryRemove(connection.Id, out _);
        connection.Cancellation.Cancel();

        try { connection.Stream?.Close(); } catch { }
        try { connection.Client.Close(); } catch { }
        connection.WriteGate.Dispose();
        connection.Cancellation.Dispose();

        if (notifyPage && Volatile.Read(ref _disposed) == 0)
            await PostAsync(new { type = "tcp-closed", id = connection.Id });
    }

    private Task SendErrorAsync(int id, string error, int? requestId = null)
    {
        return PostAsync(new { type = "tcp-error", id, requestId, error });
    }

    private Task PostAsync(object message)
    {
        if (Volatile.Read(ref _disposed) != 0 || _ui.IsDisposed)
            return Task.CompletedTask;

        string json = JsonSerializer.Serialize(message);
        var completion = new TaskCompletionSource(TaskCreationOptions.RunContinuationsAsynchronously);

        void Send()
        {
            try
            {
                if (Volatile.Read(ref _disposed) == 0 && !_ui.IsDisposed)
                    _webView.PostWebMessageAsJson(json);
                completion.TrySetResult();
            }
            catch (Exception ex)
            {
                completion.TrySetException(ex);
            }
        }

        try
        {
            if (_ui.InvokeRequired) _ui.BeginInvoke((Action)Send);
            else Send();
        }
        catch (Exception ex)
        {
            completion.TrySetException(ex);
        }

        return completion.Task;
    }

    private static string RequiredString(JsonElement element, string name)
    {
        if (!element.TryGetProperty(name, out JsonElement value) || value.ValueKind != JsonValueKind.String)
            throw new InvalidDataException($"Missing string property '{name}'.");
        return value.GetString() ?? string.Empty;
    }

    private static int RequiredInt32(JsonElement element, string name)
    {
        if (!element.TryGetProperty(name, out JsonElement value) || !value.TryGetInt32(out int result))
            throw new InvalidDataException($"Missing integer property '{name}'.");
        return result;
    }

    private static bool OptionalBoolean(JsonElement element, string name)
    {
        return element.TryGetProperty(name, out JsonElement value) && value.ValueKind == JsonValueKind.True;
    }

    private static string SafeError(Exception ex)
    {
        string message = ex.GetBaseException().Message;
        return message.Length <= 1000 ? message : message[..1000];
    }

    public async ValueTask DisposeAsync()
    {
        if (Interlocked.Exchange(ref _disposed, 1) != 0) return;

        foreach (TcpConnection connection in _connections.Values)
            await CloseConnectionAsync(connection, notifyPage: false);
    }

    private sealed class TcpConnection
    {
        public int Id { get; }
        public string Host { get; }
        public int Port { get; }
        public TcpClient Client { get; } = new();
        public CancellationTokenSource Cancellation { get; } = new();
        public SemaphoreSlim WriteGate { get; } = new(1, 1);
        public NetworkStream? Stream { get; set; }
        public int Closed;

        public TcpConnection(int id, string host, int port)
        {
            Id = id;
            Host = host;
            Port = port;
        }
    }
}
