using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

// Prototype only: --framed separates child bytes from launcher-owned containment frames.
internal static class OrcaOwnedProcessTree
{
    const uint CREATE_SUSPENDED = 0x00000004;
    const uint CREATE_NO_WINDOW = 0x08000000;
    const uint KILL_ON_JOB_CLOSE = 0x00002000;
    const uint WAIT_OBJECT_0 = 0;
    const uint WAIT_TIMEOUT = 258;

    [StructLayout(LayoutKind.Sequential)]
    internal struct StartupInfo
    {
        public uint cb;
        public IntPtr reserved, desktop, title;
        public uint x, y, xSize, ySize, xChars, yChars, fillAttribute, flags;
        public ushort showWindow, reservedBytes;
        public IntPtr reservedPointer, stdin, stdout, stderr;
    }
    [StructLayout(LayoutKind.Sequential)]
    internal struct StartupInfoEx { public StartupInfo startup; public IntPtr attributes; }
    [StructLayout(LayoutKind.Sequential)]
    struct ProcessInfo { public IntPtr process, thread; public uint pid, tid; }
    [StructLayout(LayoutKind.Sequential)]
    struct BasicLimits
    {
        public long processTime, jobTime;
        public uint flags;
        public UIntPtr minimumWorkingSet, maximumWorkingSet;
        public uint activeProcessLimit;
        public UIntPtr affinity;
        public uint priorityClass, schedulingClass;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct IoCounters { public ulong readOps, writeOps, otherOps, readBytes, writeBytes, otherBytes; }
    [StructLayout(LayoutKind.Sequential)]
    struct ExtendedLimits
    {
        public BasicLimits basic;
        public IoCounters io;
        public UIntPtr processMemoryLimit, jobMemoryLimit, peakProcessMemory, peakJobMemory;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct Accounting
    {
        public long userTime, kernelTime, periodUserTime, periodKernelTime;
        public uint faults, totalProcesses, activeProcesses, terminatedProcesses;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr CreateJobObject(IntPtr attributes, string name);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr job, int infoClass, ref ExtendedLimits limits, uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool QueryInformationJobObject(IntPtr job, int infoClass, out Accounting accounting, uint size, IntPtr returnedSize);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CreateProcess(string executable, StringBuilder command, IntPtr processAttributes,
        IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string cwd,
        ref StartupInfoEx startup, out ProcessInfo process);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetExitCodeProcess(IntPtr process, out uint exitCode);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool TerminateJobObject(IntPtr job, uint exitCode);
    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr handle);

    static void Check(bool success, string operation)
    {
        if (!success) throw new Win32Exception(Marshal.GetLastWin32Error(), operation);
    }

    static string Quote(string value)
    {
        var output = new StringBuilder("\"");
        int backslashes = 0;
        foreach (char c in value)
        {
            if (c == '\\') { backslashes++; continue; }
            output.Append('\\', c == '"' ? backslashes * 2 + 1 : backslashes);
            output.Append(c);
            backslashes = 0;
        }
        output.Append('\\', backslashes * 2);
        return output.Append('"').ToString();
    }

    static int Main(string[] args)
    {
        IntPtr job = IntPtr.Zero;
        ProcessInfo child = new ProcessInfo();
        OrcaOwnedProcessIo io = null;
        var clock = Stopwatch.StartNew();
        uint rootTimeout = 10000;
        try
        {
            Console.OutputEncoding = new UTF8Encoding(false);
            bool framed = args.Length > 0 && args[0] == "--framed";
            if (framed) { var rest = new string[args.Length - 1]; Array.Copy(args, 1, rest, 0, rest.Length); args = rest; }
            if (args.Length > 0 && args[0].StartsWith("--timeout-ms=", StringComparison.Ordinal))
            {
                if (!UInt32.TryParse(args[0].Substring(13), out rootTimeout) || rootTimeout < 1000 || rootTimeout > 600000)
                    throw new ArgumentException("Invalid bounded launcher timeout");
                var rest = new string[args.Length - 1]; Array.Copy(args, 1, rest, 0, rest.Length); args = rest;
            }
            if (args.Length < 2 || !Path.IsPathRooted(args[0]) || !File.Exists(args[0]) ||
                !Path.IsPathRooted(args[1]) || !Directory.Exists(args[1]))
                throw new ArgumentException("Expected absolute executable and working directory");
            job = CreateJobObject(IntPtr.Zero, null);
            Check(job != IntPtr.Zero, "CreateJobObject");
            var limits = new ExtendedLimits();
            // No BREAKAWAY_OK: detached console children still inherit job ownership.
            limits.basic.flags = KILL_ON_JOB_CLOSE;
            Check(SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(limits)), "SetInformationJobObject");
            var command = new StringBuilder(Quote(args[0]));
            for (int i = 2; i < args.Length; i++) command.Append(' ').Append(Quote(args[i]));
            io = new OrcaOwnedProcessIo(job, framed);
            var startup = io.Startup;
            Check(CreateProcess(args[0], command, IntPtr.Zero, IntPtr.Zero, framed,
                CREATE_SUSPENDED | CREATE_NO_WINDOW | 0x00080000u, IntPtr.Zero, args[1], ref startup, out child), "CreateProcess");
            if (framed) io.Start(job);
            Check(ResumeThread(child.thread) != UInt32.MaxValue, "ResumeThread");
            while (true)
            {
                uint wait = WaitForSingleObject(child.process, 0);
                if (wait == WAIT_OBJECT_0) break;
                Check(wait == WAIT_TIMEOUT, "WaitForSingleObject");
                long remaining = rootTimeout - clock.ElapsedMilliseconds;
                if (remaining <= 0) throw new TimeoutException("Bounded root wait did not complete");
                if (framed) remaining = Math.Min(remaining, io.InputGraceRemainingMilliseconds);
                if (remaining == 0) break;
                wait = WaitForSingleObject(child.process, (uint)Math.Min(25, remaining));
                if (wait == WAIT_OBJECT_0) break;
                Check(wait == WAIT_TIMEOUT, "WaitForSingleObject");
            }
            Check(TerminateJobObject(job, 125), "TerminateJobObject");
            long deadline = Math.Min(rootTimeout, clock.ElapsedMilliseconds + 3000);
            if (WaitForSingleObject(child.process, (uint)Math.Max(0, deadline - clock.ElapsedMilliseconds)) != WAIT_OBJECT_0)
                throw new TimeoutException("Terminated root did not exit");
            uint exitCode;
            Check(GetExitCodeProcess(child.process, out exitCode), "GetExitCodeProcess");
            Accounting finalAccounting;
            while (true)
            {
                Accounting accounting;
                Check(QueryInformationJobObject(job, 1, out accounting, (uint)Marshal.SizeOf(typeof(Accounting)), IntPtr.Zero), "QueryInformationJobObject");
                if (accounting.activeProcesses == 0) { finalAccounting = accounting; break; }
                if (clock.ElapsedMilliseconds >= deadline) throw new TimeoutException("Job still contains live processes");
                Thread.Sleep((int)Math.Min(10, Math.Max(0, deadline - clock.ElapsedMilliseconds)));
            }
            if (framed) io.Finish(child.pid, finalAccounting.totalProcesses, exitCode,
                (int)Math.Min(2000, Math.Max(0, rootTimeout - clock.ElapsedMilliseconds)));
            else Console.WriteLine("{\"jobVerdict\":\"exited\",\"activeProcesses\":0,\"totalProcesses\":" + finalAccounting.totalProcesses + ",\"childExitCode\":" + exitCode + "}");
            return 0;
        }
        catch (Exception error)
        {
            Console.Error.WriteLine(error.GetType().Name + ": " + error.Message);
            return 1;
        }
        finally
        {
            if (child.process != IntPtr.Zero)
            {
                TerminateJobObject(job, 125);
                WaitForSingleObject(child.process, (uint)Math.Min(3000, Math.Max(0, rootTimeout - clock.ElapsedMilliseconds)));
                CloseHandle(child.thread);
                CloseHandle(child.process);
            }
            if (job != IntPtr.Zero) CloseHandle(job);
            if (io != null) io.Dispose();
        }
    }
}
