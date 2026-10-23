// WASAPI loopback 采集器（无第三方依赖，legacy csc 可编译）
//
// 用法：
//   loopback-capture.exe --record <秒数> <输出.raw>   录一段到文件（自测用）
//   loopback-capture.exe --serve [端口]               监听 127.0.0.1，有客户端连上才采集
//
// 协议：极简 HTTP。GET / 返回 200 + 头部 X-Sample-Rate / X-Channels / X-Sample-Format，
// 之后持续输出原始 PCM（小端 float32 交织），直到客户端断开。
using System;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Text;

/* 版本信息（写进 PE 资源，资源管理器"详细信息"里可见） */
[assembly: System.Reflection.AssemblyTitle("dsh-spectrum-rail loopback helper")]
[assembly: System.Reflection.AssemblyDescription("WASAPI loopback capture streamed over local HTTP for the dsh-spectrum-rail plugin.")]
[assembly: System.Reflection.AssemblyProduct("dsh-spectrum-rail")]
[assembly: System.Reflection.AssemblyCompany("dsh-spectrum-rail contributors")]
[assembly: System.Reflection.AssemblyCopyright("MIT License")]
[assembly: System.Reflection.AssemblyVersion("0.1.1.0")]
[assembly: System.Reflection.AssemblyFileVersion("0.1.1.0")]
[assembly: System.Reflection.AssemblyInformationalVersion("0.1.1")]

class LoopbackCapture
{
    const int CLSCTX_ALL = 0x17;
    const int eRender = 0;
    const int eConsole = 0;
    const int AUDCLNT_SHAREMODE_SHARED = 0;
    const int AUDCLNT_STREAMFLAGS_LOOPBACK = 0x00020000;
    const int AUDCLNT_BUFFERFLAGS_SILENT = 0x2;

    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    class MMDeviceEnumeratorComObject { }

    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceEnumerator
    {
        int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
        [PreserveSig] int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice endpoint);
    }

    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDevice
    {
        [PreserveSig] int Activate(ref Guid iid, int clsCtx, IntPtr activationParams,
            [MarshalAs(UnmanagedType.IUnknown)] out object iface);
    }

    [ComImport, Guid("1CB9AD4C-DBFA-4C32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioClient
    {
        [PreserveSig] int Initialize(int shareMode, int streamFlags, long bufferDuration, long periodicity,
            IntPtr format, IntPtr sessionGuid);
        [PreserveSig] int GetBufferSize(out uint frames);
        [PreserveSig] int GetStreamLatency(out long latency);
        [PreserveSig] int GetCurrentPadding(out uint padding);
        [PreserveSig] int IsFormatSupported(int shareMode, IntPtr format, out IntPtr closest);
        [PreserveSig] int GetMixFormat(out IntPtr format);
        [PreserveSig] int GetDevicePeriod(out long defaultPeriod, out long minimumPeriod);
        [PreserveSig] int Start();
        [PreserveSig] int Stop();
        [PreserveSig] int Reset();
        [PreserveSig] int SetEventHandle(IntPtr handle);
        [PreserveSig] int GetService(ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object service);
    }

    [ComImport, Guid("C8ADBD64-E71E-48A0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioCaptureClient
    {
        [PreserveSig] int GetBuffer(out IntPtr data, out uint frames, out uint flags,
            out long devicePosition, out long qpcPosition);
        [PreserveSig] int ReleaseBuffer(uint frames);
        [PreserveSig] int GetNextPacketSize(out uint frames);
    }

    [StructLayout(LayoutKind.Sequential, Pack = 2)]
    struct WAVEFORMATEX
    {
        public ushort wFormatTag;
        public ushort nChannels;
        public uint nSamplesPerSec;
        public uint nAvgBytesPerSec;
        public ushort nBlockAlign;
        public ushort wBitsPerSample;
        public ushort cbSize;
    }

    [DllImport("ole32.dll")]
    static extern int CoInitializeEx(IntPtr reserved, int coInit);

    class Capture
    {
        public IAudioClient Client;
        public IAudioCaptureClient CaptureClient;
        public WAVEFORMATEX Format;
        public IntPtr FormatPtr;
    }

    static Capture OpenCapture(out int error)
    {
        error = 0;
        object enumeratorObject = new MMDeviceEnumeratorComObject();
        var enumerator = (IMMDeviceEnumerator)enumeratorObject;

        IMMDevice device;
        int hr = enumerator.GetDefaultAudioEndpoint(eRender, eConsole, out device);
        if (hr != 0) { error = hr; return null; }

        Guid iidAudioClient = typeof(IAudioClient).GUID;
        object clientObject;
        hr = device.Activate(ref iidAudioClient, CLSCTX_ALL, IntPtr.Zero, out clientObject);
        if (hr != 0) { error = hr; return null; }
        var client = (IAudioClient)clientObject;

        IntPtr formatPtr;
        hr = client.GetMixFormat(out formatPtr);
        if (hr != 0) { error = hr; return null; }
        var format = (WAVEFORMATEX)Marshal.PtrToStructure(formatPtr, typeof(WAVEFORMATEX));

        hr = client.Initialize(AUDCLNT_SHAREMODE_SHARED, AUDCLNT_STREAMFLAGS_LOOPBACK,
            2000000, 0, formatPtr, IntPtr.Zero);
        if (hr != 0) { error = hr; return null; }

        Guid iidCapture = typeof(IAudioCaptureClient).GUID;
        object captureObject;
        hr = client.GetService(ref iidCapture, out captureObject);
        if (hr != 0) { error = hr; return null; }

        return new Capture
        {
            Client = client,
            CaptureClient = (IAudioCaptureClient)captureObject,
            Format = format,
            FormatPtr = formatPtr
        };
    }

    /// 一帧一帧地取，回调返回 false 表示停止。
    static void Pump(Capture capture, Func<byte[], int, bool> sink)
    {
        int hr = capture.Client.Start();
        if (hr != 0) return;

        try
        {
            while (true)
            {
                uint packet;
                hr = capture.CaptureClient.GetNextPacketSize(out packet);
                if (hr != 0) break;
                if (packet == 0) { System.Threading.Thread.Sleep(2); continue; }

                while (packet > 0)
                {
                    IntPtr data;
                    uint frames;
                    uint flags;
                    long devicePosition, qpcPosition;
                    hr = capture.CaptureClient.GetBuffer(out data, out frames, out flags, out devicePosition, out qpcPosition);
                    if (hr != 0) break;

                    int bytes = checked((int)frames * capture.Format.nBlockAlign);
                    if (bytes > 0)
                    {
                        if ((flags & AUDCLNT_BUFFERFLAGS_SILENT) != 0 || data == IntPtr.Zero)
                        {
                            var silence = new byte[bytes];
                            if (!sink(silence, bytes)) break;
                        }
                        else
                        {
                            var chunk = new byte[bytes];
                            Marshal.Copy(data, chunk, 0, bytes);
                            if (!sink(chunk, bytes)) { capture.CaptureClient.ReleaseBuffer(frames); break; }
                        }
                    }
                    capture.CaptureClient.ReleaseBuffer(frames);

                    hr = capture.CaptureClient.GetNextPacketSize(out packet);
                    if (hr != 0) break;
                }
            }
        }
        finally
        {
            capture.Client.Stop();
        }
    }

    static int Main(string[] args)
    {
        CoInitializeEx(IntPtr.Zero, 0); // MTA

        string mode = args.Length > 0 ? args[0] : "--serve";

        if (mode == "--version")
        {
            Console.Out.WriteLine("dsh-spectrum-rail helper 0.1.1");
            return 0;
        }

        if (mode == "--record")
        {
            int seconds = args.Length > 1 ? int.Parse(args[1]) : 4;
            string output = args.Length > 2 ? args[2] : "capture.raw";

            int error;
            var capture = OpenCapture(out error);
            if (capture == null) { Console.Error.WriteLine("open failed: 0x" + error.ToString("X8")); return 1; }

            var buffer = new MemoryStream();
            DateTime deadline = DateTime.UtcNow.AddSeconds(seconds);
            long frames = 0;
            Pump(capture, delegate(byte[] chunk, int bytes)
            {
                buffer.Write(chunk, 0, bytes);
                frames += bytes / Math.Max(1, (int)capture.Format.nBlockAlign);
                return DateTime.UtcNow < deadline;
            });

            File.WriteAllBytes(output, buffer.ToArray());
            Console.Error.WriteLine("ch=" + capture.Format.nChannels + " rate=" + capture.Format.nSamplesPerSec +
                " bits=" + capture.Format.wBitsPerSample + " bytes=" + buffer.Length);
            return 0;
        }

        // 服务模式：固定端口优先，被占用就换一个
        int port = args.Length > 1 ? int.Parse(args[1]) : 45999;
        TcpListener listener = null;
        for (int attempt = 0; attempt < 12 && listener == null; attempt++)
        {
            try
            {
                var candidate = new TcpListener(IPAddress.Loopback, port + attempt);
                candidate.Start();
                listener = candidate;
                port = port + attempt;
            }
            catch (SocketException)
            {
                // 端口被占用，试下一个
            }
        }
        if (listener == null) { Console.Error.WriteLine("no free port"); return 2; }

        Console.Out.WriteLine("LISTENING " + port);
        Console.Out.Flush();
        Console.Error.WriteLine("serving on 127.0.0.1:" + port);

        object gate = new object();
        int active = 0;

        while (true)
        {
            TcpClient client;
            try { client = listener.AcceptTcpClient(); }
            catch (Exception) { continue; }

            bool admitted = false;
            lock (gate)
            {
                if (active < 8) { active++; admitted = true; }
            }
            if (!admitted) { try { client.Close(); } catch (Exception) { } continue; }

            var worker = new System.Threading.Thread(delegate()
            {
                try { ServeClient(client); }
                catch (Exception) { /* 单个连接出错不影响服务 */ }
                finally
                {
                    try { client.Close(); } catch (Exception) { }
                    lock (gate) { active--; }
                }
            });
            worker.IsBackground = true;
            worker.Start();
        }
    }

    /// 一个客户端：探测请求立刻回 204；真正的 GET 才打开采集并持续推流。
    static void ServeClient(TcpClient client)
    {
        client.NoDelay = true;
        var stream = client.GetStream();

        string requestLine = ReadRequestLine(stream);
        var parts = requestLine.Split(' ');
        string method = parts.Length > 0 && parts[0].Length > 0 ? parts[0] : "GET";
        string path = parts.Length > 1 ? parts[1] : "/";

        if (method == "OPTIONS" || method == "HEAD" || path.IndexOf("?probe", StringComparison.Ordinal) >= 0)
        {
            WriteAscii(stream, "HTTP/1.1 204 No Content\r\n" +
                "Access-Control-Allow-Origin: *\r\n" +
                "Access-Control-Allow-Methods: GET, OPTIONS\r\n" +
                "Access-Control-Allow-Private-Network: true\r\n" +
                "Access-Control-Expose-Headers: X-DSH-Spectrum, X-Sample-Rate, X-Channels, X-Bits\r\n" +
                "X-DSH-Spectrum: 1\r\n" +
                "Content-Length: 0\r\nConnection: close\r\n\r\n");
            return;
        }

        int error;
        var capture = OpenCapture(out error);
        if (capture == null)
        {
            WriteAscii(stream, "HTTP/1.1 503 Service Unavailable\r\nAccess-Control-Allow-Origin: *\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
            return;
        }

        var header = new StringBuilder();
        header.Append("HTTP/1.1 200 OK\r\n");
        header.Append("Content-Type: application/octet-stream\r\n");
        header.Append("X-Sample-Rate: ").Append(capture.Format.nSamplesPerSec).Append("\r\n");
        header.Append("X-Channels: ").Append(capture.Format.nChannels).Append("\r\n");
        header.Append("X-Bits: ").Append(capture.Format.wBitsPerSample).Append("\r\n");
        header.Append("Access-Control-Allow-Origin: *\r\n");
        header.Append("Access-Control-Allow-Private-Network: true\r\n");
        header.Append("Access-Control-Expose-Headers: X-Sample-Rate, X-Channels, X-Bits\r\n");
        header.Append("Cache-Control: no-store\r\n");
        header.Append("Connection: close\r\n\r\n");
        WriteAscii(stream, header.ToString());

        try
        {
            Pump(capture, delegate(byte[] chunk, int bytes)
            {
                try
                {
                    stream.Write(chunk, 0, bytes);
                    return true;
                }
                catch (IOException) { return false; }
                catch (ObjectDisposedException) { return false; }
            });
        }
        catch (Exception)
        {
            // 客户端断开或设备被占用
        }
    }

    /// 读完整个请求头（到空行），再返回首行。
    /// 必须把请求读干净：带未读数据直接 close 会让 Windows 发 RST，把响应数据一起丢掉。
    static string ReadRequestLine(Stream stream)
    {
        var buffer = new byte[4096];
        var total = 0;
        try
        {
            stream.ReadTimeout = 1000;
            while (total < buffer.Length)
            {
                int read = stream.Read(buffer, total, Math.Min(256, buffer.Length - total));
                if (read <= 0) break;
                total += read;
                if (total >= 4 &&
                    buffer[total - 4] == 13 && buffer[total - 3] == 10 &&
                    buffer[total - 2] == 13 && buffer[total - 1] == 10) break;
            }
            stream.ReadTimeout = 0;
        }
        catch (Exception)
        {
            // 读不到请求行也没关系
        }
        var first = Encoding.ASCII.GetString(buffer, 0, total);
        int eol = first.IndexOf("\r\n", StringComparison.Ordinal);
        if (eol >= 0) first = first.Substring(0, eol);
        first = first.Trim();
        return first.Length > 0 ? first : "GET /";
    }

    static void WriteAscii(Stream stream, string text)
    {
        var bytes = Encoding.ASCII.GetBytes(text);
        stream.Write(bytes, 0, bytes.Length);
        stream.Flush();
    }
}
