using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Windows.Media;
using System.Windows.Media.Imaging;

namespace Znada.ThumbnailHelper
{
    [Flags]
    internal enum WtsFlags : uint
    {
        Extract = 0x00000000,
        ScaleToRequestedSize = 0x00000040,
        ScaleUp = 0x00010000
    }

    [Flags]
    internal enum WtsCacheFlags : uint
    {
        Default = 0x00000000,
        LowQuality = 0x00000001,
        Cached = 0x00000002
    }

    internal enum WtsAlphaType
    {
        Unknown = 0,
        Rgb = 1,
        Argb = 2
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct NativeSize
    {
        internal int Width;
        internal int Height;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct NativeBitmap
    {
        internal int Type;
        internal int Width;
        internal int Height;
        internal int WidthBytes;
        internal ushort Planes;
        internal ushort BitsPixel;
        internal IntPtr Bits;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct BitmapInfoHeader
    {
        internal uint Size;
        internal int Width;
        internal int Height;
        internal ushort Planes;
        internal ushort BitCount;
        internal uint Compression;
        internal uint SizeImage;
        internal int XPelsPerMeter;
        internal int YPelsPerMeter;
        internal uint ClrUsed;
        internal uint ClrImportant;
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct DibSection
    {
        internal NativeBitmap Bitmap;
        internal BitmapInfoHeader Header;
        internal uint Bitfields0;
        internal uint Bitfields1;
        internal uint Bitfields2;
        internal IntPtr Section;
        internal uint Offset;
    }

    [ComImport]
    [Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IShellItem
    {
        [PreserveSig]
        int BindToHandler(IntPtr bindContext, ref Guid handlerId, ref Guid interfaceId, out IntPtr result);

        [PreserveSig]
        int GetParent(out IShellItem parent);

        [PreserveSig]
        int GetDisplayName(uint nameType, out IntPtr name);

        [PreserveSig]
        int GetAttributes(uint mask, out uint attributes);

        [PreserveSig]
        int Compare(IShellItem other, uint hint, out int order);
    }

    [ComImport]
    [Guid("F676C15D-596A-4CE2-8234-33996F445DB1")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IThumbnailCache
    {
        [PreserveSig]
        int GetThumbnail(
            [MarshalAs(UnmanagedType.Interface)] IShellItem shellItem,
            uint requestedSize,
            WtsFlags flags,
            [MarshalAs(UnmanagedType.Interface)] out ISharedBitmap thumbnail,
            out WtsCacheFlags cacheFlags,
            IntPtr thumbnailId);
    }

    [ComImport]
    [Guid("091162A4-BC96-411F-AAE8-C5122CD03363")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface ISharedBitmap
    {
        [PreserveSig]
        int GetSharedBitmap(out IntPtr bitmap);

        [PreserveSig]
        int GetSize(out NativeSize size);

        [PreserveSig]
        int GetFormat(out WtsAlphaType alphaType);

        [PreserveSig]
        int InitializeBitmap(IntPtr bitmap, WtsAlphaType alphaType);

        [PreserveSig]
        int Detach(out IntPtr bitmap);
    }

    internal sealed class ExtractedThumbnail
    {
        internal byte[] Bytes;
        internal string Mime;
        internal int Width;
        internal int Height;
        internal string Alpha;
        internal string WindowsCache;
        internal bool LowQuality;
        internal double DurationMs;
    }

    internal static class ShellThumbnailExtractor
    {
        private const uint BiRgb = 0;
        private const uint DibRgbColors = 0;
        private static readonly Guid ShellItemId = new Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE");
        private static readonly Guid LocalThumbnailCacheId = new Guid("50EF4544-AC9F-4A8E-B21B-8A26180DB13F");
        // MEDIA-002: pictures, then video. Mirrors libraryExtensions() in src/media-type.js;
        // test/media-type.test.js holds the two lists equal. Windows gives a video frame
        // only where a codec is installed; without one the request fails like any other.
        private static readonly HashSet<string> Extensions = new HashSet<string>(StringComparer.OrdinalIgnoreCase)
        {
            ".jpg", ".jpeg", ".png", ".bmp", ".webp", ".gif",
            ".mp4", ".m4v", ".mov", ".qt", ".webm", ".mkv", ".avi", ".wmv", ".asf", ".mpg", ".mpeg", ".m2v",
            ".ts", ".mts", ".m2ts", ".3gp", ".3g2", ".flv", ".ogv", ".f4v", ".vob", ".divx"
        };

        [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = true)]
        private static extern int SHCreateItemFromParsingName(
            [MarshalAs(UnmanagedType.LPWStr)] string path,
            IntPtr bindContext,
            ref Guid interfaceId,
            [MarshalAs(UnmanagedType.Interface)] out IShellItem shellItem);

        [DllImport("gdi32.dll", EntryPoint = "GetObjectW", SetLastError = true)]
        private static extern int GetObject(IntPtr handle, int bufferSize, out DibSection dibSection);

        [DllImport("gdi32.dll", SetLastError = true)]
        private static extern int GetDIBits(
            IntPtr deviceContext,
            IntPtr bitmap,
            uint startScan,
            uint scanLines,
            [Out] byte[] bits,
            ref BitmapInfoHeader info,
            uint usage);

        [DllImport("user32.dll")]
        private static extern IntPtr GetDC(IntPtr window);

        [DllImport("user32.dll")]
        private static extern int ReleaseDC(IntPtr window, IntPtr deviceContext);

        internal static ExtractedThumbnail Extract(string inputPath, int requestedSize, int jpegQuality)
        {
            if (String.IsNullOrWhiteSpace(inputPath) || inputPath.IndexOf('\0') >= 0)
                throw new HelperFailure("bad_request", "Source path is invalid", false);
            if (!Path.IsPathRooted(inputPath))
                throw new HelperFailure("bad_request", "Source path is invalid", false);

            string fullPath;
            try { fullPath = Path.GetFullPath(inputPath); }
            catch { throw new HelperFailure("bad_request", "Source path is invalid", false); }

            FileInfo info;
            try { info = new FileInfo(fullPath); }
            catch { throw new HelperFailure("bad_request", "Source path is invalid", false); }

            if (!info.Exists) throw new HelperFailure("not_found", "Source file is unavailable", false);
            if ((info.Attributes & FileAttributes.Directory) != 0)
                throw new HelperFailure("not_file", "Source path is not a file", false);
            if (!Extensions.Contains(info.Extension))
                throw new HelperFailure("unsupported", "Source format is not supported", false);

            int size = Math.Max(16, Math.Min(1024, requestedSize));
            int quality = Math.Max(1, Math.Min(100, jpegQuality));
            Stopwatch stopwatch = Stopwatch.StartNew();
            IShellItem item = null;
            IThumbnailCache cache = null;
            ISharedBitmap shared = null;

            try
            {
                Guid iid = ShellItemId;
                int hr = SHCreateItemFromParsingName(fullPath, IntPtr.Zero, ref iid, out item);
                ThrowForExtractionHr(hr, "Unable to create a Windows Shell item");

                Type cacheType = Type.GetTypeFromCLSID(LocalThumbnailCacheId, true);
                cache = (IThumbnailCache)Activator.CreateInstance(cacheType);

                WtsCacheFlags cacheFlags;
                hr = cache.GetThumbnail(
                    item,
                    (uint)size,
                    WtsFlags.Extract | WtsFlags.ScaleToRequestedSize | WtsFlags.ScaleUp,
                    out shared,
                    out cacheFlags,
                    IntPtr.Zero);
                ThrowForExtractionHr(hr, "Windows could not extract this thumbnail");

                WtsAlphaType alphaType;
                hr = shared.GetFormat(out alphaType);
                if (hr < 0) alphaType = WtsAlphaType.Unknown;

                IntPtr bitmapHandle;
                hr = shared.GetSharedBitmap(out bitmapHandle);
                ThrowForExtractionHr(hr, "Windows returned an unreadable thumbnail");
                if (bitmapHandle == IntPtr.Zero)
                    throw new HelperFailure("extract_failed", "Windows returned an empty thumbnail", false);

                int width;
                int height;
                byte[] pixels = CopyPixels(bitmapHandle, out width, out height);
                bool transparent = NormalizeAndHasTransparency(pixels, alphaType);
                byte[] encoded = Encode(pixels, width, height, transparent, quality);

                stopwatch.Stop();
                return new ExtractedThumbnail
                {
                    Bytes = encoded,
                    Mime = transparent ? "image/png" : "image/jpeg",
                    Width = width,
                    Height = height,
                    Alpha = transparent ? "argb" : "rgb",
                    WindowsCache = (cacheFlags & WtsCacheFlags.Cached) != 0 ? "hit" : "miss",
                    LowQuality = (cacheFlags & WtsCacheFlags.LowQuality) != 0,
                    DurationMs = Math.Round(stopwatch.Elapsed.TotalMilliseconds, 3)
                };
            }
            catch (UnauthorizedAccessException)
            {
                throw new HelperFailure("access_denied", "Access to the source file was denied", false);
            }
            catch (HelperFailure)
            {
                throw;
            }
            catch (ExternalException ex)
            {
                throw new HelperFailure("extract_failed", "Windows thumbnail extraction failed", IsRetriableHResult(ex.ErrorCode));
            }
            catch
            {
                throw new HelperFailure("internal", "Thumbnail helper failed", false);
            }
            finally
            {
                ReleaseCom(shared);
                ReleaseCom(cache);
                ReleaseCom(item);
            }
        }

        private static byte[] CopyPixels(IntPtr bitmapHandle, out int width, out int height)
        {
            DibSection section;
            int result = GetObject(bitmapHandle, Marshal.SizeOf(typeof(DibSection)), out section);
            if (result == 0)
                throw new HelperFailure("encode_failed", "Thumbnail bitmap metadata is unavailable", false);

            width = section.Bitmap.Width;
            height = Math.Abs(section.Bitmap.Height);
            if (width <= 0 || height <= 0 || width > 4096 || height > 4096)
                throw new HelperFailure("encode_failed", "Thumbnail bitmap dimensions are invalid", false);

            int targetStride = checked(width * 4);
            byte[] pixels = new byte[checked(targetStride * height)];
            BitmapInfoHeader header = new BitmapInfoHeader
            {
                Size = (uint)Marshal.SizeOf(typeof(BitmapInfoHeader)),
                Width = width,
                // A negative height asks GDI for a normalized top-down buffer. Reading
                // dsBm.bmBits directly was unreliable for Shell-owned DIB sections and
                // inverted every thumbnail on the owner's machine.
                Height = -height,
                Planes = 1,
                BitCount = 32,
                Compression = BiRgb,
                SizeImage = (uint)pixels.Length
            };
            IntPtr dc = GetDC(IntPtr.Zero);
            if (dc == IntPtr.Zero)
                throw new HelperFailure("encode_failed", "Thumbnail bitmap could not be opened", false);
            try
            {
                if (GetDIBits(dc, bitmapHandle, 0, (uint)height, pixels, ref header, DibRgbColors) == 0)
                    throw new HelperFailure("encode_failed", "Thumbnail pixels could not be read", false);
            }
            finally
            {
                ReleaseDC(IntPtr.Zero, dc);
            }

            return pixels;
        }

        private static bool NormalizeAndHasTransparency(byte[] pixels, WtsAlphaType alphaType)
        {
            if (alphaType == WtsAlphaType.Rgb)
            {
                for (int i = 3; i < pixels.Length; i += 4) pixels[i] = 255;
                return false;
            }

            bool anyNonZero = false;
            for (int i = 3; i < pixels.Length; i += 4)
            {
                if (pixels[i] != 0) anyNonZero = true;
            }
            // Some providers return WTSAT_UNKNOWN with an unused, all-zero alpha byte.
            // Treating that buffer as ARGB would encode an invisible PNG.
            if (alphaType == WtsAlphaType.Unknown && !anyNonZero)
            {
                for (int i = 3; i < pixels.Length; i += 4) pixels[i] = 255;
                return false;
            }
            for (int i = 3; i < pixels.Length; i += 4)
            {
                if (pixels[i] != 255) return true;
            }
            return false;
        }

        private static byte[] Encode(byte[] pixels, int width, int height, bool transparent, int jpegQuality)
        {
            int stride = checked(width * 4);
            PixelFormat format = transparent ? PixelFormats.Pbgra32 : PixelFormats.Bgra32;
            BitmapSource source = BitmapSource.Create(width, height, 96, 96, format, null, pixels, stride);
            source.Freeze();

            BitmapEncoder encoder;
            if (transparent)
            {
                encoder = new PngBitmapEncoder();
            }
            else
            {
                encoder = new JpegBitmapEncoder { QualityLevel = jpegQuality };
            }
            encoder.Frames.Add(BitmapFrame.Create(source));
            using (MemoryStream stream = new MemoryStream())
            {
                encoder.Save(stream);
                return stream.ToArray();
            }
        }

        private static void ThrowForExtractionHr(int hr, string message)
        {
            if (hr >= 0) return;
            throw new HelperFailure("extract_failed", message, IsRetriableHResult(hr));
        }

        private static bool IsRetriableHResult(int hr)
        {
            uint value = unchecked((uint)hr);
            return value == 0x8004B201 || value == 0x8004B202 || value == 0x8004B204 || value == 0x8004B205;
        }

        private static void ReleaseCom(object value)
        {
            if (value == null || !Marshal.IsComObject(value)) return;
            try { Marshal.FinalReleaseComObject(value); }
            catch { }
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    internal struct PropertyKey
    {
        internal Guid FormatId;
        internal uint PropertyId;

        internal PropertyKey(string formatId, uint propertyId)
        {
            FormatId = new Guid(formatId);
            PropertyId = propertyId;
        }
    }

    // Only the two members read here: the type tag and the 8-byte value. Size 24 is the
    // x64 PROPVARIANT, so Windows never writes past the end of the struct.
    [StructLayout(LayoutKind.Explicit, Size = 24)]
    internal struct PropVariant
    {
        [FieldOffset(0)] internal ushort VarType;
        [FieldOffset(8)] internal ulong UInt64Value;
        [FieldOffset(8)] internal uint UInt32Value;
    }

    [ComImport]
    [Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99")]
    [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IPropertyStore
    {
        [PreserveSig] int GetCount(out uint count);
        [PreserveSig] int GetAt(uint index, out PropertyKey key);
        [PreserveSig] int GetValue(ref PropertyKey key, out PropVariant value);
        [PreserveSig] int SetValue(ref PropertyKey key, ref PropVariant value);
        [PreserveSig] int Commit();
    }

    internal sealed class MediaInfo
    {
        internal double DurationMs;
        internal int Width;
        internal int Height;
    }

    // MEDIA-002. A video's length and frame size, read from the file's Windows properties
    // (the "Length" column in Explorer). The file is never decoded here: Windows' property
    // handler reads the container header, so a large video costs the same as a small one.
    internal static class MediaInfoReader
    {
        private const ushort VtUi4 = 19;
        private const ushort VtUi8 = 21;
        private static readonly Guid PropertyStoreId = new Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99");
        private static readonly PropertyKey Duration = new PropertyKey("64440490-4C8B-11D1-8B70-080036B11A03", 3);
        private static readonly PropertyKey FrameWidth = new PropertyKey("64440491-4C8B-11D1-8B70-080036B11A03", 3);
        private static readonly PropertyKey FrameHeight = new PropertyKey("64440491-4C8B-11D1-8B70-080036B11A03", 4);

        [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = true)]
        private static extern int SHGetPropertyStoreFromParsingName(
            [MarshalAs(UnmanagedType.LPWStr)] string path,
            IntPtr bindContext,
            uint flags,
            ref Guid interfaceId,
            [MarshalAs(UnmanagedType.Interface)] out IPropertyStore store);

        [DllImport("ole32.dll", PreserveSig = true)]
        private static extern int PropVariantClear(ref PropVariant value);

        internal static MediaInfo Read(string inputPath)
        {
            if (String.IsNullOrWhiteSpace(inputPath) || inputPath.IndexOf('\0') >= 0 || !Path.IsPathRooted(inputPath))
                throw new HelperFailure("bad_request", "Source path is invalid", false);
            string fullPath;
            try { fullPath = Path.GetFullPath(inputPath); }
            catch { throw new HelperFailure("bad_request", "Source path is invalid", false); }
            if (!File.Exists(fullPath)) throw new HelperFailure("not_found", "Source file is unavailable", false);

            IPropertyStore store = null;
            try
            {
                Guid iid = PropertyStoreId;
                // GPS_DEFAULT (0): read-only store, the file's own property handler.
                int hr = SHGetPropertyStoreFromParsingName(fullPath, IntPtr.Zero, 0, ref iid, out store);
                if (hr < 0 || store == null)
                    throw new HelperFailure("extract_failed", "Windows could not read the file properties", false);
                ulong ticks = ReadNumber(store, Duration, VtUi8);
                return new MediaInfo
                {
                    // 100-nanosecond units; 0 means Windows did not say.
                    DurationMs = ticks > 0 ? Math.Round(ticks / 10000.0) : 0,
                    Width = (int)Math.Min(ReadNumber(store, FrameWidth, VtUi4), 100000),
                    Height = (int)Math.Min(ReadNumber(store, FrameHeight, VtUi4), 100000)
                };
            }
            catch (HelperFailure)
            {
                throw;
            }
            catch
            {
                throw new HelperFailure("extract_failed", "Windows could not read the file properties", false);
            }
            finally
            {
                if (store != null && Marshal.IsComObject(store))
                {
                    try { Marshal.FinalReleaseComObject(store); }
                    catch { }
                }
            }
        }

        private static ulong ReadNumber(IPropertyStore store, PropertyKey key, ushort expected)
        {
            PropVariant value;
            PropertyKey local = key;
            if (store.GetValue(ref local, out value) < 0) return 0;
            try
            {
                if (value.VarType == VtUi8 && expected == VtUi8) return value.UInt64Value;
                if (value.VarType == VtUi4) return value.UInt32Value;
                return 0;
            }
            finally
            {
                PropVariantClear(ref value);
            }
        }
    }
}
