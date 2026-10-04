using System;
using System.Collections.Generic;
using System.Net;
using System.Net.Sockets;
using System.Text;
using System.Threading;
using UnityEngine;

namespace KSCTowerNetwork
{
    internal enum TowerUdpMessageType : byte
    {
        TelemetrySample = 1,
        TelemetryStatus = 2,
        GhostQuery = 3,
        ReplyOk = 100,
        ReplyError = 101
    }

    internal static class TowerUdpClient
    {
        private const byte ProtocolVersion = 1;
        private const int HeaderBytes = 1 + 1 + 1 + 4 + 8 + 2 + 2 + 2;
        private static int _sequence = 1;

        public static bool TryRequest(
            TowerUdpMessageType messageType,
            string sessionId,
            string payloadJson,
            out string replyJson,
            out string error)
        {
            replyJson = string.Empty;
            error = string.Empty;
            TowerModSettings.EnsureLoaded();
            if (!TowerModSettings.UseUdpLiveTransport)
            {
                error = "udp disabled";
                return false;
            }

            var sid = sessionId ?? string.Empty;
            var token = TowerModSettings.SkipTowerLogin ? string.Empty : (TowerModSettings.TowerAuthToken ?? string.Empty);
            var payload = Encoding.UTF8.GetBytes(payloadJson ?? "{}");
            var frame = EncodeFrame(messageType, sid, token, payload);
            var seq = ReadSequence(frame);

            UdpClient udp = null;
            try
            {
                udp = new UdpClient();
                udp.Client.SendTimeout = Math.Max(100, TowerModSettings.LiveUdpTimeoutMs);
                udp.Client.ReceiveTimeout = Math.Max(100, TowerModSettings.LiveUdpTimeoutMs);

                IPAddress addr;
                if (!IPAddress.TryParse(TowerModSettings.LiveUdpHost, out addr))
                {
                    var hosts = Dns.GetHostAddresses(TowerModSettings.LiveUdpHost);
                    if (hosts == null || hosts.Length == 0)
                    {
                        error = "udp host resolve failed";
                        return false;
                    }
                    addr = hosts[0];
                }

                var endpoint = new IPEndPoint(addr, TowerModSettings.LiveUdpPort);
                udp.Send(frame, frame.Length, endpoint);

                IPEndPoint from = null;
                var response = udp.Receive(ref from);
                if (response == null || response.Length < HeaderBytes)
                {
                    error = "udp response empty";
                    return false;
                }

                DecodedFrame decoded;
                if (!TryDecodeFrame(response, out decoded))
                {
                    error = "udp response decode failed";
                    return false;
                }

                if (decoded.Sequence != seq)
                {
                    // Accept out-of-order response anyway (single request socket usually avoids this),
                    // but surface it in logs for diagnosis.
                    Debug.LogWarning("[KSCTowerNetwork] UDP reply sequence mismatch");
                }

                replyJson = decoded.PayloadText;
                if (decoded.MessageType == TowerUdpMessageType.ReplyError)
                {
                    error = decoded.PayloadText;
                    return false;
                }

                return decoded.MessageType == TowerUdpMessageType.ReplyOk;
            }
            catch (Exception ex)
            {
                error = ex.Message;
                return false;
            }
            finally
            {
                if (udp != null)
                {
                    try
                    {
                        udp.Close();
                    }
                    catch
                    {
                        /* ignore */
                    }
                }
            }
        }

        private static byte[] EncodeFrame(
            TowerUdpMessageType messageType,
            string sessionId,
            string token,
            byte[] payload)
        {
            var sid = Encoding.UTF8.GetBytes(sessionId ?? string.Empty);
            var tok = Encoding.UTF8.GetBytes(token ?? string.Empty);
            if (sid.Length > ushort.MaxValue || tok.Length > ushort.MaxValue || payload.Length > ushort.MaxValue)
            {
                throw new InvalidOperationException("UDP frame field too large");
            }

            var seq = unchecked((uint)Interlocked.Increment(ref _sequence));
            var ts = unchecked((ulong)DateTimeOffset.UtcNow.ToUnixTimeMilliseconds());
            var outBuf = new byte[HeaderBytes + sid.Length + tok.Length + payload.Length];
            int o = 0;
            outBuf[o++] = ProtocolVersion;
            outBuf[o++] = (byte)messageType;
            outBuf[o++] = 0; // flags
            WriteU32(outBuf, ref o, seq);
            WriteU64(outBuf, ref o, ts);
            WriteU16(outBuf, ref o, (ushort)sid.Length);
            WriteU16(outBuf, ref o, (ushort)tok.Length);
            WriteU16(outBuf, ref o, (ushort)payload.Length);
            Buffer.BlockCopy(sid, 0, outBuf, o, sid.Length);
            o += sid.Length;
            Buffer.BlockCopy(tok, 0, outBuf, o, tok.Length);
            o += tok.Length;
            Buffer.BlockCopy(payload, 0, outBuf, o, payload.Length);
            return outBuf;
        }

        private struct DecodedFrame
        {
            public TowerUdpMessageType MessageType;
            public uint Sequence;
            public string PayloadText;
        }

        private static bool TryDecodeFrame(byte[] frame, out DecodedFrame decoded)
        {
            decoded = new DecodedFrame();
            if (frame == null || frame.Length < HeaderBytes)
            {
                return false;
            }

            int o = 0;
            var version = frame[o++];
            if (version != ProtocolVersion)
            {
                return false;
            }

            var mt = frame[o++];
            o++; // flags
            var seq = ReadU32(frame, ref o);
            ReadU64(frame, ref o); // timestamp
            var sidLen = ReadU16(frame, ref o);
            var tokLen = ReadU16(frame, ref o);
            var payloadLen = ReadU16(frame, ref o);
            var need = HeaderBytes + sidLen + tokLen + payloadLen;
            if (frame.Length < need)
            {
                return false;
            }

            o += sidLen;
            o += tokLen;
            var payloadText = Encoding.UTF8.GetString(frame, o, payloadLen);
            decoded = new DecodedFrame
            {
                MessageType = (TowerUdpMessageType)mt,
                Sequence = seq,
                PayloadText = payloadText
            };
            return true;
        }

        private static uint ReadSequence(byte[] frame)
        {
            int o = 3;
            return ReadU32(frame, ref o);
        }

        private static void WriteU16(byte[] b, ref int o, ushort v)
        {
            b[o++] = (byte)((v >> 8) & 0xff);
            b[o++] = (byte)(v & 0xff);
        }

        private static void WriteU32(byte[] b, ref int o, uint v)
        {
            b[o++] = (byte)((v >> 24) & 0xff);
            b[o++] = (byte)((v >> 16) & 0xff);
            b[o++] = (byte)((v >> 8) & 0xff);
            b[o++] = (byte)(v & 0xff);
        }

        private static void WriteU64(byte[] b, ref int o, ulong v)
        {
            b[o++] = (byte)((v >> 56) & 0xff);
            b[o++] = (byte)((v >> 48) & 0xff);
            b[o++] = (byte)((v >> 40) & 0xff);
            b[o++] = (byte)((v >> 32) & 0xff);
            b[o++] = (byte)((v >> 24) & 0xff);
            b[o++] = (byte)((v >> 16) & 0xff);
            b[o++] = (byte)((v >> 8) & 0xff);
            b[o++] = (byte)(v & 0xff);
        }

        private static ushort ReadU16(byte[] b, ref int o)
        {
            var v = (ushort)((b[o] << 8) | b[o + 1]);
            o += 2;
            return v;
        }

        private static uint ReadU32(byte[] b, ref int o)
        {
            var v = ((uint)b[o] << 24) | ((uint)b[o + 1] << 16) | ((uint)b[o + 2] << 8) | b[o + 3];
            o += 4;
            return v;
        }

        private static ulong ReadU64(byte[] b, ref int o)
        {
            var v =
                ((ulong)b[o] << 56) |
                ((ulong)b[o + 1] << 48) |
                ((ulong)b[o + 2] << 40) |
                ((ulong)b[o + 3] << 32) |
                ((ulong)b[o + 4] << 24) |
                ((ulong)b[o + 5] << 16) |
                ((ulong)b[o + 6] << 8) |
                b[o + 7];
            o += 8;
            return v;
        }
    }
}
