using System.Diagnostics;
using System.IO.Compression;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;

// Only this application payload is extracted. No login, elevation or network download.
internal static class Program
{
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int MessageBoxW(nint hwnd, string text, string title, uint flags);
    private static byte[] Resource(string name)
    {
        using var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(name)
            ?? throw new InvalidDataException("Missing application resource");
        using var bytes = new MemoryStream();
        stream.CopyTo(bytes);
        return bytes.ToArray();
    }
    private static string Hash(byte[] bytes) => Convert.ToHexString(SHA256.HashData(bytes)).ToLowerInvariant();
    private static string SafePath(string root, string name)
    {
        var full = Path.GetFullPath(Path.Combine(root, name));
        if (Path.IsPathRooted(name) || !full.StartsWith(Path.GetFullPath(root) + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase))
            throw new InvalidDataException("Invalid payload path");
        return full;
    }
    private static void RejectLinkedDirectory(string directory)
    {
        for (var cursor = Path.GetFullPath(directory); !string.IsNullOrEmpty(cursor); cursor = Path.GetDirectoryName(cursor))
            if (Directory.Exists(cursor) && (File.GetAttributes(cursor) & FileAttributes.ReparsePoint) != 0)
                throw new InvalidDataException("Linked installation directory is not supported");
    }
    private static void Verify(string root, Dictionary<string, string> manifest)
    {
        RejectLinkedDirectory(root);
        foreach (var entry in manifest)
        {
            var file = SafePath(root, entry.Key);
            for (var cursor = file; cursor.Length > root.Length; cursor = Path.GetDirectoryName(cursor)!)
                if ((File.GetAttributes(cursor) & FileAttributes.ReparsePoint) != 0)
                    throw new InvalidDataException("Linked application payload");
            if (Hash(File.ReadAllBytes(file)) != entry.Value)
                throw new InvalidDataException("Application file verification failed: " + entry.Key);
        }
    }
    private static void Extract(string root, byte[] payload, Dictionary<string, string> manifest)
    {
        var temporary = root + ".extract-" + Guid.NewGuid().ToString("N");
        Directory.CreateDirectory(temporary);
        try
        {
            using var memory = new MemoryStream(payload, false);
            using var archive = new ZipArchive(memory, ZipArchiveMode.Read);
            foreach (var entry in archive.Entries)
            {
                if (entry.FullName.EndsWith('/') || entry.FullName.EndsWith('\\')) continue;
                var name = entry.FullName.Replace('\\', '/');
                if (!manifest.ContainsKey(name)) throw new InvalidDataException("Unexpected payload entry");
                var output = SafePath(temporary, name);
                Directory.CreateDirectory(Path.GetDirectoryName(output)!);
                using var input = entry.Open();
                using var file = new FileStream(output, FileMode.CreateNew, FileAccess.Write);
                input.CopyTo(file);
            }
            Verify(temporary, manifest);
            Directory.Move(temporary, root);
        }
        finally { if (Directory.Exists(temporary)) Directory.Delete(temporary, true); }
    }
    private static (byte[] Payload, string Hash, Dictionary<string, string> Manifest) Bundle()
    {
        var payload = Resource("CallMyPromts.Payload");
        var expected = Encoding.UTF8.GetString(Resource("CallMyPromts.Hash")).Trim();
        if (Hash(payload) != expected) throw new InvalidDataException("Corrupt application payload");
        var manifest = JsonSerializer.Deserialize<Dictionary<string, string>>(Resource("CallMyPromts.Manifest"))
            ?? throw new InvalidDataException("Invalid application manifest");
        return (payload, expected, manifest);
    }
    private static void SelfTest(byte[] payload, Dictionary<string, string> manifest)
    {
        using var memory = new MemoryStream(payload, false);
        using var zip = new ZipArchive(memory, ZipArchiveMode.Read);
        var entries = zip.Entries.Where(e => !e.FullName.EndsWith('/') && !e.FullName.EndsWith('\\'))
            .ToDictionary(e => e.FullName.Replace('\\', '/'), StringComparer.Ordinal);
        if (entries.Count != manifest.Count) throw new InvalidDataException("Unexpected payload entries");
        foreach (var item in manifest)
        {
            if (!entries.TryGetValue(item.Key, out var entry)) throw new InvalidDataException("Missing payload entry: " + item.Key);
            using var input = entry.Open();
            using var bytes = new MemoryStream(); input.CopyTo(bytes);
            if (Hash(bytes.ToArray()) != item.Value) throw new InvalidDataException("Corrupt payload entry");
        }
    }
    private static void Launch(string root, string home)
    {
        var start = new ProcessStartInfo(Path.Combine(root, "vendor", "node.exe"))
        {
            WorkingDirectory = root, UseShellExecute = false, CreateNoWindow = true,
            RedirectStandardOutput = true, RedirectStandardError = true
        };
        start.ArgumentList.Add(Path.Combine(root, "packaging", "portable-start.cjs"));
        start.Environment["DECK_AHK"] = Path.Combine(root, "vendor", "AutoHotkey64.exe");
        start.Environment["CALLMYPROMPTS_HOME"] = home;
        using var child = Process.Start(start) ?? throw new IOException("Unable to launch application");
        var output = child.StandardOutput.ReadToEndAsync();
        var error = child.StandardError.ReadToEndAsync();
        if (!child.WaitForExit(20000)) throw new IOException("Launch confirmation timed out; check the tray before retrying");
        Task.WaitAll(output, error);
        if (child.ExitCode != 0) throw new IOException("Application launch failed; exit code " + child.ExitCode);
    }
    private static void InstallAndLaunch(byte[] payload, string expected, Dictionary<string, string> manifest)
    {
        using var mutex = new Mutex(false, "Local\\CallMyPromts.Paper.Launch");
        var locked = false;
        try
        {
            try { locked = mutex.WaitOne(TimeSpan.FromSeconds(20)); }
            catch (AbandonedMutexException) { locked = true; }
            if (!locked) throw new IOException("Application launch is already in progress");
            var home = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "CallMyPromts");
            var parent = Path.Combine(home, "runtime");
            RejectLinkedDirectory(parent); Directory.CreateDirectory(parent);
            var root = Path.Combine(parent, expected[..20]);
            if (!Directory.Exists(root)) Extract(root, payload, manifest);
            Verify(root, manifest);
            Launch(root, home);
        }
        finally { if (locked) mutex.ReleaseMutex(); }
    }
    [STAThread]
    private static int Main(string[] args)
    {
        var selfTest = args.Length == 1 && args[0] == "--self-test";
        try
        {
            if (args.Length != 0 && !selfTest) throw new ArgumentException("Unknown launch option");
            var (payload, expected, manifest) = Bundle();
            if (selfTest)
            {
                SelfTest(payload, manifest);
                Console.WriteLine(JsonSerializer.Serialize(new { ok = true, files = manifest.Count, payloadSha256 = expected, userDataChanged = false }));
            }
            else InstallAndLaunch(payload, expected, manifest);
            return 0;
        }
        catch (Exception error)
        {
            if (selfTest) Console.Error.WriteLine(error.Message);
            else MessageBoxW(0, error.Message, "CallMyPromts", 0x10);
            return 1;
        }
    }
}
