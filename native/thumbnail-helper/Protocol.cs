using System;
using System.Collections.Generic;
using System.Text;
using System.Web.Script.Serialization;

namespace Znada.ThumbnailHelper
{
    internal sealed class HelperFailure : Exception
    {
        internal readonly string Code;
        internal readonly bool Retriable;

        internal HelperFailure(string code, string message, bool retriable)
            : base(message)
        {
            Code = code;
            Retriable = retriable;
        }
    }

    internal static class Protocol
    {
        internal const int Version = 1;
        internal const string HelperVersion = "1.0.0";
        internal const int MaxRequestChars = 128 * 1024;
        internal const int MaxPayloadBytes = 8 * 1024 * 1024;

        private static readonly JavaScriptSerializer Serializer = new JavaScriptSerializer
        {
            MaxJsonLength = int.MaxValue,
            RecursionLimit = 32
        };

        internal static void ConfigureConsole()
        {
            Console.InputEncoding = new UTF8Encoding(false);
            Console.OutputEncoding = new UTF8Encoding(false);
        }

        internal static Dictionary<string, object> ParseObject(string json)
        {
            try
            {
                object value = Serializer.DeserializeObject(json);
                Dictionary<string, object> result = value as Dictionary<string, object>;
                if (result == null) throw new HelperFailure("bad_request", "Request must be a JSON object", false);
                return result;
            }
            catch (HelperFailure)
            {
                throw;
            }
            catch
            {
                throw new HelperFailure("bad_request", "Request JSON is invalid", false);
            }
        }

        internal static void Write(object message)
        {
            Console.Out.WriteLine(Serializer.Serialize(message));
            Console.Out.Flush();
        }

        internal static void WriteReady()
        {
            Write(new Dictionary<string, object>
            {
                { "protocolVersion", Version },
                { "type", "ready" },
                { "pid", System.Diagnostics.Process.GetCurrentProcess().Id },
                { "helperVersion", HelperVersion },
                { "capabilities", new Dictionary<string, object>
                    {
                        { "maxSize", 1024 },
                        { "delivery", new[] { "inline" } },
                        { "encodings", new[] { "image/jpeg", "image/png" } },
                        { "windowsCache", true }
                    }
                }
            });
        }

        internal static void WriteSuccess(long id, Dictionary<string, object> result)
        {
            Write(new Dictionary<string, object>
            {
                { "protocolVersion", Version },
                { "type", "response" },
                { "id", id },
                { "ok", true },
                { "result", result }
            });
        }

        internal static void WriteError(long id, string code, string message, bool retriable)
        {
            Write(new Dictionary<string, object>
            {
                { "protocolVersion", Version },
                { "type", "response" },
                { "id", id },
                { "ok", false },
                { "error", new Dictionary<string, object>
                    {
                        { "code", code },
                        { "message", message },
                        { "retriable", retriable }
                    }
                }
            });
        }

        internal static string StringValue(Dictionary<string, object> input, string key)
        {
            object value;
            if (!input.TryGetValue(key, out value) || value == null) return String.Empty;
            return Convert.ToString(value, System.Globalization.CultureInfo.InvariantCulture) ?? String.Empty;
        }

        internal static long LongValue(Dictionary<string, object> input, string key, long fallback)
        {
            object value;
            if (!input.TryGetValue(key, out value) || value == null) return fallback;
            try { return Convert.ToInt64(value, System.Globalization.CultureInfo.InvariantCulture); }
            catch { return fallback; }
        }

        internal static Dictionary<string, object> ObjectValue(Dictionary<string, object> input, string key)
        {
            object value;
            if (!input.TryGetValue(key, out value) || value == null) return null;
            return value as Dictionary<string, object>;
        }
    }
}
