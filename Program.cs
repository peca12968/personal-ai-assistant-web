using System.Net;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

var builder = WebApplication.CreateBuilder(args);
builder.Services.AddHttpClient("localBridge", client => client.Timeout = TimeSpan.FromSeconds(40))
    .ConfigurePrimaryHttpMessageHandler(() => new HttpClientHandler
    {
        AllowAutoRedirect = false,
        UseCookies = false,
        UseProxy = false
    });
var app = builder.Build();
var runtimePath = Path.GetFullPath(app.Configuration["RuntimePath"] ?? "runtime", app.Environment.ContentRootPath);
var readable = new HashSet<string> { "view", "status", "learning", "trash" };
var writable = new HashSet<string>
{
    "new", "ask", "retry", "confirm", "withdraw", "learn", "stop", "select",
    "mode", "trash", "restore", "purge"
};

app.Use(async (context, next) =>
{
    if (context.Connection.RemoteIpAddress is not { } peer || !IPAddress.IsLoopback(peer)
        || context.Request.Host.Host != "127.0.0.1")
    {
        context.Response.StatusCode = StatusCodes.Status403Forbidden;
        return;
    }
    context.Response.Headers.CacheControl = "no-store";
    context.Response.Headers["Referrer-Policy"] = "no-referrer";
    context.Response.Headers["X-Content-Type-Options"] = "nosniff";
    context.Response.Headers["Content-Security-Policy"] =
        "default-src 'self'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'";
    await next();
});
app.UseDefaultFiles();
app.UseStaticFiles();

app.MapMethods("/api/{operation}", new[] { "GET", "POST" }, async (
    HttpContext http, string operation, IHttpClientFactory clients) =>
{
    var request = http.Request;
    var read = HttpMethods.IsGet(request.Method);
    if (!(read ? readable : writable).Contains(operation))
    {
        await Error(http, StatusCodes.Status404NotFound, "找不到這個本機操作。");
        return;
    }

    var key = await ReadText(Path.Combine(runtimePath, "site.key"), http.RequestAborted);
    if (key is null || !TokenEquals(request.Headers.Authorization.ToString(), "Bearer " + key.Trim()))
    {
        await Error(http, StatusCodes.Status401Unauthorized, "請從桌面捷徑開啟此頁。");
        return;
    }

    if (!read && request.Headers.Origin.ToString() != $"{request.Scheme}://{request.Host}")
    {
        await Error(http, StatusCodes.Status403Forbidden, "無法核對桌面視窗來源。");
        return;
    }

    const int maxBody = 128 * 1024;
    var size = request.ContentLength ?? 0;
    if (!read && (size < 1 || size > maxBody || !request.HasJsonContentType()))
    {
        await Error(http, StatusCodes.Status400BadRequest, "本機操作需要 128 KiB 以內的 JSON。");
        return;
    }

    var descriptor = await ReadText(Path.Combine(runtimePath, "bridge.json"), http.RequestAborted);
    if (!TryBridge(descriptor, out var target, out var bridgeKey))
    {
        await Error(http, StatusCodes.Status503ServiceUnavailable, "桌面助理尚未連線。請重新開啟桌面捷徑。");
        return;
    }

    var endpoint = new Uri(target, "/api/" + operation + request.QueryString);
    using var forward = new HttpRequestMessage(read ? HttpMethod.Get : HttpMethod.Post, endpoint);
    forward.Headers.Authorization = new AuthenticationHeaderValue("Bearer", bridgeKey);
    if (!read)
    {
        forward.Headers.TryAddWithoutValidation("Origin", target.GetLeftPart(UriPartial.Authority));
        var body = new byte[checked((int)size)];
        await request.Body.ReadExactlyAsync(body, http.RequestAborted);
        forward.Content = new ByteArrayContent(body);
        forward.Content.Headers.ContentType = new MediaTypeHeaderValue("application/json");
    }
    try
    {
        using var client = clients.CreateClient("localBridge");
        using var reply = await client.SendAsync(forward, HttpCompletionOption.ResponseHeadersRead, http.RequestAborted);
        http.Response.StatusCode = (int)reply.StatusCode;
        http.Response.ContentType = "application/json; charset=utf-8";
        await reply.Content.CopyToAsync(http.Response.Body, http.RequestAborted);
    }
    catch (HttpRequestException)
    {
        if (!http.Response.HasStarted)
            await Error(http, StatusCodes.Status503ServiceUnavailable, "桌面助理尚未連線。請重新開啟桌面捷徑。");
    }
    catch (OperationCanceledException) when (!http.RequestAborted.IsCancellationRequested)
    {
        if (!http.Response.HasStarted)
            await Error(http, StatusCodes.Status504GatewayTimeout, "本機程序尚未回報，請查看目前狀態。");
    }
});

app.Run();

static async Task<string?> ReadText(string file, CancellationToken cancel)
{
    try
    {
        var info = new FileInfo(file);
        return info.Exists && info.Length <= 4096 ? await File.ReadAllTextAsync(file, cancel) : null;
    }
    catch (IOException) { return null; }
    catch (UnauthorizedAccessException) { return null; }
}

static bool TokenEquals(string actual, string expected)
{
    if (expected.Length < 40 || actual.Length != expected.Length)
        return false;
    return CryptographicOperations.FixedTimeEquals(Encoding.UTF8.GetBytes(actual), Encoding.UTF8.GetBytes(expected));
}

static bool TryBridge(string? json, out Uri target, out string bridgeKey)
{
    target = null!;
    bridgeKey = "";
    if (json is null)
        return false;
    try
    {
        using var doc = JsonDocument.Parse(json);
        var address = doc.RootElement.GetProperty("address").GetString();
        var key = doc.RootElement.GetProperty("key").GetString();
        if (!Uri.TryCreate(address, UriKind.Absolute, out var uri) || uri.Scheme != "http"
            || uri.Host != "127.0.0.1" || uri.IsDefaultPort || uri.AbsolutePath != "/"
            || uri.UserInfo.Length != 0 || uri.Query.Length != 0 || uri.Fragment.Length != 0
            || string.IsNullOrEmpty(key) || key.Length < 32
            || key.Any(character => !char.IsAsciiLetterOrDigit(character) && character != '-' && character != '_'))
            return false;
        target = uri;
        bridgeKey = key;
        return true;
    }
    catch (Exception exception) when (exception is JsonException or KeyNotFoundException or InvalidOperationException)
    {
        return false;
    }
}

static Task Error(HttpContext http, int status, string message)
{
    http.Response.StatusCode = status;
    return http.Response.WriteAsJsonAsync(new { error = message }, cancellationToken: http.RequestAborted);
}
