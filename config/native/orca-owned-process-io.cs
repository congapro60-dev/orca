using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using System.Web.Script.Serialization;
using Microsoft.Win32.SafeHandles;

    // Child receives only these three pipe handles, never the launcher's proof/output handle.
internal sealed class OrcaOwnedProcessIo : IDisposable
{
    [StructLayout(LayoutKind.Sequential)]
    struct SecurityAttributes { public uint length; public IntPtr descriptor; public int inherit; }
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CreatePipe(out IntPtr read, out IntPtr write, ref SecurityAttributes attributes, uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool InitializeProcThreadAttributeList(IntPtr attributes, int count, uint flags, ref UIntPtr bytes);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool UpdateProcThreadAttribute(IntPtr attributes, uint flags, UIntPtr attribute, IntPtr value, UIntPtr bytes, IntPtr previous, IntPtr returnedBytes);
    [DllImport("kernel32.dll")]
    static extern void DeleteProcThreadAttributeList(IntPtr attributes);
    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")]
    static extern bool TerminateJobObject(IntPtr job, uint code);

    IntPtr inputRead, inputWrite, outputRead, outputWrite, errorRead, errorWrite;
    IntPtr attributes, handleList, jobList;
    bool initialized;
    readonly object outputLock = new object();
    Exception failure;
    Thread stdoutPump, stderrPump;
    long inputEofTimestamp = -1;
    const int MAX_FRAME_BYTES = 4096;
    public OrcaOwnedProcessTree.StartupInfoEx Startup;

    static void Check(bool result, string operation)
    {
        if (!result) throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), operation);
    }

    public OrcaOwnedProcessIo(IntPtr job, bool framed)
    {
        try
        {
            if (framed)
            {
                var security = new SecurityAttributes { length = (uint)Marshal.SizeOf(typeof(SecurityAttributes)), inherit = 1 };
                Check(CreatePipe(out inputRead, out inputWrite, ref security, 0), "Create stdin pipe");
                Check(CreatePipe(out outputRead, out outputWrite, ref security, 0), "Create stdout pipe");
                Check(CreatePipe(out errorRead, out errorWrite, ref security, 0), "Create stderr pipe");
                Check(SetHandleInformation(inputWrite, 1, 0), "Non-inheritable stdin writer");
                Check(SetHandleInformation(outputRead, 1, 0), "Non-inheritable stdout reader");
                Check(SetHandleInformation(errorRead, 1, 0), "Non-inheritable stderr reader");
            }
            UIntPtr size = UIntPtr.Zero;
            int attributeCount = framed ? 2 : 1;
            InitializeProcThreadAttributeList(IntPtr.Zero, attributeCount, 0, ref size);
            attributes = Marshal.AllocHGlobal(checked((int)size.ToUInt64()));
            Check(InitializeProcThreadAttributeList(attributes, attributeCount, 0, ref size), "Initialize process attributes");
            initialized = true;
            // JOB_LIST makes containment atomic with creation; unsupported hosts fail closed.
            jobList = Marshal.AllocHGlobal(IntPtr.Size);
            Marshal.WriteIntPtr(jobList, job);
            Check(UpdateProcThreadAttribute(attributes, 0, new UIntPtr(0x0002000D), jobList,
                new UIntPtr((uint)IntPtr.Size), IntPtr.Zero, IntPtr.Zero), "Set atomic job list");
            Startup = new OrcaOwnedProcessTree.StartupInfoEx();
            Startup.startup.cb = (uint)Marshal.SizeOf(Startup);
            if (framed)
            {
                handleList = Marshal.AllocHGlobal(IntPtr.Size * 3);
                Marshal.WriteIntPtr(handleList, 0, inputRead);
                Marshal.WriteIntPtr(handleList, IntPtr.Size, outputWrite);
                Marshal.WriteIntPtr(handleList, IntPtr.Size * 2, errorWrite);
                Check(UpdateProcThreadAttribute(attributes, 0, new UIntPtr(0x00020002), handleList,
                    new UIntPtr((uint)(IntPtr.Size * 3)), IntPtr.Zero, IntPtr.Zero), "Set handle whitelist");
                Startup.startup.flags = 0x00000100; // STARTF_USESTDHANDLES
                Startup.startup.stdin = inputRead;
                Startup.startup.stdout = outputWrite;
                Startup.startup.stderr = errorWrite;
            }
            Startup.attributes = attributes;
        }
        catch { Dispose(); throw; }
    }

    FileStream Pipe(IntPtr handle, FileAccess access)
    {
        return new FileStream(new SafeFileHandle(handle, false), access, 4096, false);
    }

    public void Start(IntPtr job)
    {
        Close(ref inputRead); Close(ref outputWrite); Close(ref errorWrite);
        stdoutPump = Pump(outputRead, "stdout", job);
        stderrPump = Pump(errorRead, "stderr", job);
        var input = new Thread(() => {
            try
            {
                using (var destination = Pipe(inputWrite, FileAccess.Write))
                {
                    var source = Console.OpenStandardInput();
                    var buffer = new byte[4096];
                    int count;
                    while ((count = source.Read(buffer, 0, buffer.Length)) > 0)
                    { destination.Write(buffer, 0, count); destination.Flush(); }
                    Interlocked.Exchange(ref inputEofTimestamp, Stopwatch.GetTimestamp());
                    Close(ref inputWrite);
                }
            }
            catch (IOException) { /* Root may already have closed its stdin. */ }
        });
        input.IsBackground = true;
        input.Start();
    }

    public int InputGraceRemainingMilliseconds
    {
        get
        {
            long eof = Interlocked.Read(ref inputEofTimestamp);
            if (eof < 0) return Int32.MaxValue;
            long elapsed = (Stopwatch.GetTimestamp() - eof) * 1000 / Stopwatch.Frequency;
            return (int)Math.Max(0, 2000 - elapsed);
        }
    }

    Thread Pump(IntPtr handle, string kind, IntPtr job)
    {
        var pump = new Thread(() => {
            try
            {
                using (var source = Pipe(handle, FileAccess.Read))
                {
                    var buffer = new byte[4096];
                    int count;
                    while ((count = source.Read(buffer, 0, Math.Min(buffer.Length, MAX_FRAME_BYTES))) > 0)
                    { Emit(new Dictionary<string, object> { { "kind", kind }, { "data", Convert.ToBase64String(buffer, 0, count) } }); }
                }
            }
            catch (Exception error) { Interlocked.CompareExchange(ref failure, error, null); TerminateJobObject(job, 125); }
        });
        pump.IsBackground = true;
        pump.Start();
        return pump;
    }

    public void Finish(uint rootPid, uint totalProcesses, uint childExitCode, int drainTimeout)
    {
        var drain = Stopwatch.StartNew();
        if (!stdoutPump.Join(Math.Min(1000, drainTimeout)) ||
            !stderrPump.Join((int)Math.Min(1000, Math.Max(0, drainTimeout - drain.ElapsedMilliseconds))))
            throw new IOException("Framed output did not drain");
        if (failure != null) throw new IOException("Framed output failed", failure);
        Emit(new Dictionary<string, object> {
            { "kind", "jobExited" }, { "rootPid", rootPid }, { "activeProcesses", 0 },
            { "totalProcesses", totalProcesses }, { "childExitCode", childExitCode }
        });
    }

    void Emit(Dictionary<string, object> frame)
    {
        lock (outputLock) { Console.WriteLine(new JavaScriptSerializer().Serialize(frame)); }
    }

    static void Close(ref IntPtr handle)
    {
        if (handle != IntPtr.Zero) { CloseHandle(handle); handle = IntPtr.Zero; }
    }

    public void Dispose()
    {
        Close(ref inputRead); Close(ref inputWrite); Close(ref outputRead); Close(ref outputWrite); Close(ref errorRead); Close(ref errorWrite);
        if (initialized) { DeleteProcThreadAttributeList(attributes); initialized = false; }
        if (attributes != IntPtr.Zero) { Marshal.FreeHGlobal(attributes); attributes = IntPtr.Zero; }
        if (handleList != IntPtr.Zero) { Marshal.FreeHGlobal(handleList); handleList = IntPtr.Zero; }
        if (jobList != IntPtr.Zero) { Marshal.FreeHGlobal(jobList); jobList = IntPtr.Zero; }
    }
}
