using System;
using System.Runtime.InteropServices;
using System.Timers;

namespace HRMS_Agent
{
    public class IdleTracker
    {
        [StructLayout(LayoutKind.Sequential)]
        private struct LASTINPUTINFO
        {
            public uint cbSize;
            public uint dwTime;
        }

        [DllImport("user32.dll")]
        private static extern bool GetLastInputInfo(ref LASTINPUTINFO plii);

        private readonly System.Timers.Timer _timer;
        private bool _isIdle = false;
        private readonly uint _idleThresholdMs;

        public IdleTracker(double checkIntervalMs = 10000, uint idleThresholdMs = 300000) // Default 10s check, 5m threshold
        {
            _idleThresholdMs = idleThresholdMs;
            _timer = new System.Timers.Timer(checkIntervalMs);
            _timer.Elapsed += OnTimerElapsed;
        }

        public void Start()
        {
            _timer.Start();
        }

        public void Stop()
        {
            _timer.Stop();
            if (_isIdle)
            {
                _isIdle = false;
                _ = ApiSync.LogEventAsync("IDLE_END");
            }
        }

        public static uint GetIdleTimeMs()
        {
            LASTINPUTINFO lii = new LASTINPUTINFO();
            lii.cbSize = (uint)Marshal.SizeOf(lii);
            lii.dwTime = 0;

            if (GetLastInputInfo(ref lii))
            {
                uint tickCount = (uint)Environment.TickCount;
                return tickCount - lii.dwTime;
            }
            return 0;
        }

        private async void OnTimerElapsed(object? sender, ElapsedEventArgs e)
        {
            try
            {
                uint idleTimeMs = GetIdleTimeMs();

                if (idleTimeMs >= _idleThresholdMs)
                {
                    if (!_isIdle)
                    {
                        _isIdle = true;
                        await ApiSync.LogEventAsync("IDLE_START");
                    }
                }
                else
                {
                    if (_isIdle)
                    {
                        _isIdle = false;
                        await ApiSync.LogEventAsync("IDLE_END");
                    }
                }
            }
            catch (Exception ex)
            {
                Console.WriteLine($"Idle check error: {ex.Message}");
            }
        }
    }
}
