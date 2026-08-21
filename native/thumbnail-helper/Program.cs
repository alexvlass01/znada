using System;
using System.Collections.Generic;
using System.IO;

namespace Znada.ThumbnailHelper
{
    internal static class Program
    {
        private static int Main(string[] args)
        {
            Protocol.ConfigureConsole();

            if (args.Length > 0 && String.Equals(args[0], "--version", StringComparison.OrdinalIgnoreCase))
            {
                Console.Out.WriteLine("Znada.ThumbnailHelper " + Protocol.HelperVersion + " protocol=" + Protocol.Version);
                return 0;
            }
            if (args.Length > 0 && String.Equals(args[0], "--self-test", StringComparison.OrdinalIgnoreCase))
            {
                Console.Out.WriteLine("Znada.ThumbnailHelper self-test ok protocol=" + Protocol.Version);
                return 0;
            }

            Protocol.WriteReady();
            string line;
            while ((line = Console.In.ReadLine()) != null)
            {
                if (String.IsNullOrWhiteSpace(line)) continue;
                if (line.Length > Protocol.MaxRequestChars)
                {
                    Protocol.WriteError(0, "bad_request", "Request is too large", false);
                    continue;
                }

                long id = 0;
                try
                {
                    Dictionary<string, object> request = Protocol.ParseObject(line);
                    id = Protocol.LongValue(request, "id", 0);
                    if (id <= 0 || id > 9007199254740991L)
                        throw new HelperFailure("bad_request", "Request id is invalid", false);
                    if (Protocol.LongValue(request, "protocolVersion", -1) != Protocol.Version)
                        throw new HelperFailure("bad_request", "Protocol version is incompatible", false);
                    if (!String.Equals(Protocol.StringValue(request, "type"), "request", StringComparison.Ordinal))
                        throw new HelperFailure("bad_request", "Message type is invalid", false);

                    string op = Protocol.StringValue(request, "op");
                    if (String.Equals(op, "ping", StringComparison.Ordinal))
                    {
                        Protocol.WriteSuccess(id, new Dictionary<string, object> { { "pong", true } });
                        continue;
                    }
                    if (String.Equals(op, "shutdown", StringComparison.Ordinal))
                    {
                        Protocol.WriteSuccess(id, new Dictionary<string, object> { { "shuttingDown", true } });
                        return 0;
                    }
                    if (!String.Equals(op, "thumbnail", StringComparison.Ordinal))
                        throw new HelperFailure("bad_request", "Operation is unknown", false);

                    string path = Protocol.StringValue(request, "path");
                    int size = checked((int)Protocol.LongValue(request, "size", 0));
                    if (size < 16 || size > 1024)
                        throw new HelperFailure("bad_request", "Thumbnail size is invalid", false);

                    int jpegQuality = 82;
                    Dictionary<string, object> encoding = Protocol.ObjectValue(request, "encoding");
                    if (encoding != null)
                    {
                        string mode = Protocol.StringValue(encoding, "mode");
                        if (!String.IsNullOrEmpty(mode) && !String.Equals(mode, "auto", StringComparison.Ordinal))
                            throw new HelperFailure("bad_request", "Encoding mode is invalid", false);
                        jpegQuality = checked((int)Protocol.LongValue(encoding, "jpegQuality", 82));
                    }

                    ExtractedThumbnail thumbnail = ShellThumbnailExtractor.Extract(path, size, jpegQuality);
                    if (thumbnail.Bytes == null || thumbnail.Bytes.Length == 0)
                        throw new HelperFailure("encode_failed", "Thumbnail encoding returned no data", false);
                    if (thumbnail.Bytes.Length > Protocol.MaxPayloadBytes)
                        throw new HelperFailure("payload_too_large", "Encoded thumbnail is too large", false);

                    Protocol.WriteSuccess(id, new Dictionary<string, object>
                    {
                        { "delivery", "inline" },
                        { "mime", thumbnail.Mime },
                        { "width", thumbnail.Width },
                        { "height", thumbnail.Height },
                        { "dataBase64", Convert.ToBase64String(thumbnail.Bytes) },
                        { "encodedBytes", thumbnail.Bytes.Length },
                        { "alpha", thumbnail.Alpha },
                        { "windowsCache", thumbnail.WindowsCache },
                        { "lowQuality", thumbnail.LowQuality },
                        { "durationMs", thumbnail.DurationMs }
                    });
                }
                catch (HelperFailure failure)
                {
                    Protocol.WriteError(id, failure.Code, failure.Message, failure.Retriable);
                }
                catch (OverflowException)
                {
                    Protocol.WriteError(id, "bad_request", "Numeric request field is invalid", false);
                }
                catch (IOException)
                {
                    Protocol.WriteError(id, "extract_failed", "Source file could not be read", true);
                }
                catch
                {
                    Protocol.WriteError(id, "internal", "Thumbnail helper failed", false);
                }
            }
            return 0;
        }
    }
}
