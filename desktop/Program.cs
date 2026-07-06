using System;
using System.Collections.Generic;
using System.Drawing;
using System.Threading.Tasks;
using System.Windows.Forms;

namespace HRMS_Agent
{
    internal static class Program
    {
        private static System.Threading.Mutex? _appMutex;

        [STAThread]
        private static void Main()
        {
            const string mutexName = @"Local\IntelliHrHub_Agent_Mutex_Unique_998234";
            _appMutex = new System.Threading.Mutex(true, mutexName, out bool isNewInstance);

            if (!isNewInstance)
            {
                MessageBox.Show(
                    "Another instance of the IntelliHrHub Desktop Agent is already running.",
                    "Agent Already Running",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Warning
                );
                return;
            }

            try
            {
                ApplicationConfiguration.Initialize();
                using var context = new HRMSApplicationContext();
                Application.Run(context);
            }
            finally
            {
                try
                {
                    _appMutex.ReleaseMutex();
                }
                catch (ObjectDisposedException) { }
                catch (ApplicationException) { } // If mutex wasn't acquired successfully
                _appMutex.Dispose();
            }
        }
    }

    public class HRMSApplicationContext : ApplicationContext
    {
        private enum ReminderType
        {
            CheckIn,
            MorningTea,
            Lunch,
            EveningTea,
            CheckOut
        }

        private readonly NotifyIcon _trayIcon;
        private readonly SessionMonitor _sessionMonitor;
        private readonly IdleTracker _idleTracker;
        private readonly ToolStripMenuItem _statusMenuItem;
        private readonly ToolStripMenuItem _connectMenuItem;

        // Timers for background operations
        private readonly System.Windows.Forms.Timer _pollTimer;
        private readonly System.Windows.Forms.Timer _reminderTimer;

        // Daily reminder flags — persisted to disk so app restarts don't re-fire
        private static readonly string ReminderStatePath = System.IO.Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "IntelliHrHub_Agent", "reminder-state.json");

        private DateTime? _lastCheckInReminderDate;
        private DateTime? _lastMorningTeaReminderDate;
        private DateTime? _lastLunchReminderDate;
        private DateTime? _lastEveningTeaReminderDate;
        private DateTime? _lastCheckOutReminderDate;

        // Snooze status
        private DateTime? _snoozeUntil;
        private ReminderType? _snoozedReminderType;
        private ReminderForm? _activeReminderForm;

        // Dashboard Form instance
        private DashboardForm? _dashboardForm;

        public HRMSApplicationContext()
        {
            // Initialize event monitors
            _sessionMonitor = new SessionMonitor();
            _idleTracker = new IdleTracker();

            // Register app in Windows Startup — quote path to handle spaces
            try
            {
                using var key = Microsoft.Win32.Registry.CurrentUser.OpenSubKey(@"SOFTWARE\Microsoft\Windows\CurrentVersion\Run", true);
                if (key != null)
                {
                    var quotedPath = $"\"{Application.ExecutablePath}\"";
                    key.SetValue("IntelliHrHub_Agent", quotedPath);
                    // Verify the write succeeded
                    var written = key.GetValue("IntelliHrHub_Agent") as string;
                    if (written != quotedPath)
                    {
                        Console.WriteLine("Warning: Startup registry entry could not be verified.");
                    }
                }
            }
            catch (Exception ex)
            {
                Console.WriteLine($"Warning: Could not register startup entry: {ex.Message}");
            }

            // Load persisted reminder flags
            LoadReminderState();

            // Set up context menu
            var contextMenu = new ContextMenuStrip();

            _statusMenuItem = new ToolStripMenuItem("Status: Initializing...") { Enabled = false };
            _connectMenuItem = new ToolStripMenuItem("Connect Account...", null, OnConnectClick);

            contextMenu.Items.AddRange(new ToolStripItem[]
            {
                _statusMenuItem,
                new ToolStripSeparator(),
                _connectMenuItem,
                new ToolStripSeparator(),
                new ToolStripMenuItem("Exit", null, OnExitClick) // Restored Exit
            });

            // Set up System Tray Icon
            _trayIcon = new NotifyIcon
            {
                Icon = Icon.ExtractAssociatedIcon(Application.ExecutablePath) ?? SystemIcons.Shield,
                ContextMenuStrip = contextMenu,
                Visible = true,
                Text = "IntelliHrHub Desktop Agent"
            };

            // Double-click tray icon opens the interactive dashboard
            _trayIcon.DoubleClick += (s, e) => ShowDashboardForm();

            // Register event handler for API status updates
            ApiSync.OnStatusChanged += UpdateStatusText;

            // Trigger a refresh whenever a telemetry event is logged
            ApiSync.OnEventLogged += async (evt, ts) =>
            {
                await RefreshStatusAndMenuAsync();
            };

            // Sync offline queue and retry authentication immediately when network connection state changes
            System.Net.NetworkInformation.NetworkChange.NetworkAddressChanged += async (s, e) =>
            {
                _ = ApiSync.ProcessOfflineQueueAsync();
                await RefreshStatusAndMenuAsync();
            };

            // Start monitors
            _sessionMonitor.Start();
            _idleTracker.Start();

            // Initialize Polling Timer (Runs every 60 seconds to refresh status)
            _pollTimer = new System.Windows.Forms.Timer { Interval = 60000 };
            _pollTimer.Tick += async (s, e) => await RefreshStatusAndMenuAsync();
            _pollTimer.Start();

            // Initialize Reminder Timer (Runs every 30 seconds to evaluate schedules)
            _reminderTimer = new System.Windows.Forms.Timer { Interval = 30000 };
            _reminderTimer.Tick += OnReminderTimerTick;
            _reminderTimer.Start();

            // Perform initial refresh
            _ = RefreshStatusAndMenuAsync();

            if (!ApiSync.IsLoggedIn)
            {
                if (ApiSync.HasStoredCredentials)
                {
                    // Device is configured but token expired — attempt silent re-auth
                    System.Windows.Forms.Timer startupTimer = new System.Windows.Forms.Timer { Interval = 200 };
                    startupTimer.Tick += async (s, e) =>
                    {
                        startupTimer.Stop();
                        startupTimer.Dispose();
                        bool refreshed = await ApiSync.TryRefreshTokenAsync();
                        if (refreshed)
                        {
                            ShowDashboardForm();
                            _ = StartupDataRetryAsync();
                        }
                        else if (ApiSync.LastLoginWasNetworkError)
                        {
                            // Transient network connectivity error — run silently in tray
                            UpdateStatusText("Waiting for network...");
                        }
                        else
                        {
                            // Silent re-auth failed (password changed?) — show login
                            ShowLoginForm();
                        }
                    };
                    startupTimer.Start();
                }
                else
                {
                    // Never configured — show login form
                    System.Windows.Forms.Timer startupTimer = new System.Windows.Forms.Timer { Interval = 100 };
                    startupTimer.Tick += (s, e) =>
                    {
                        startupTimer.Stop();
                        startupTimer.Dispose();
                        ShowLoginForm();
                    };
                    startupTimer.Start();
                }
            }
            else
            {
                // Already logged in — show dashboard and retry data load if needed
                System.Windows.Forms.Timer startupTimer = new System.Windows.Forms.Timer { Interval = 200 };
                startupTimer.Tick += (s, e) =>
                {
                    startupTimer.Stop();
                    startupTimer.Dispose();
                    ShowDashboardForm();
                    _ = StartupDataRetryAsync();
                };
                startupTimer.Start();
            }
        }

        // Startup retry loop: if first data fetch returns null, retry up to 3 times
        private async Task StartupDataRetryAsync()
        {
            for (int attempt = 0; attempt < 3; attempt++)
            {
                if (attempt > 0) await Task.Delay(5000);
                var attendance = await ApiSync.GetAttendanceTodayAsync();
                if (attendance != null)
                {
                    await RefreshStatusAndMenuAsync();
                    return;
                }
            }
            // After 3 attempts still null — just refresh (will show whatever data is available)
            await RefreshStatusAndMenuAsync();
        }

        // Save reminder flag dates to disk so they survive app restarts
        private void SaveReminderState()
        {
            try
            {
                var state = new
                {
                    LastCheckIn = _lastCheckInReminderDate?.ToString("O"),
                    LastMorningTea = _lastMorningTeaReminderDate?.ToString("O"),
                    LastLunch = _lastLunchReminderDate?.ToString("O"),
                    LastEveningTea = _lastEveningTeaReminderDate?.ToString("O"),
                    LastCheckOut = _lastCheckOutReminderDate?.ToString("O"),
                };
                System.IO.File.WriteAllText(ReminderStatePath,
                    System.Text.Json.JsonSerializer.Serialize(state, new System.Text.Json.JsonSerializerOptions { WriteIndented = true }));
            }
            catch { /* ignore */ }
        }

        private void LoadReminderState()
        {
            try
            {
                if (!System.IO.File.Exists(ReminderStatePath)) return;
                using var doc = System.Text.Json.JsonDocument.Parse(System.IO.File.ReadAllText(ReminderStatePath));
                var root = doc.RootElement;
                DateTime parse(string key) => root.TryGetProperty(key, out var p) && DateTime.TryParse(p.GetString(), out var d) ? d : DateTime.MinValue;
                _lastCheckInReminderDate = parse("LastCheckIn");
                _lastMorningTeaReminderDate = parse("LastMorningTea");
                _lastLunchReminderDate = parse("LastLunch");
                _lastEveningTeaReminderDate = parse("LastEveningTea");
                _lastCheckOutReminderDate = parse("LastCheckOut");
            }
            catch { /* ignore */ }
        }

        private void UpdateStatusText(string status)
        {
            if (_statusMenuItem.Owner?.InvokeRequired ?? false)
            {
                _statusMenuItem.Owner.Invoke(new Action(() => UpdateStatusText(status)));
                return;
            }

            _statusMenuItem.Text = $"Status: {status}";
            
            if (ApiSync.IsLoggedIn)
            {
                _connectMenuItem.Text = "Disconnect / Change Account";
                _trayIcon.Text = $"IntelliHrHub Agent ({ApiSync.CurrentEmail})";
            }
            else
            {
                _connectMenuItem.Text = "Connect Account...";
                _trayIcon.Text = "IntelliHrHub Desktop Agent (Disconnected)";
            }
        }

        private void ShowDashboardForm()
        {
            if (!ApiSync.IsLoggedIn)
            {
                ShowLoginForm();
                return;
            }

            if (_dashboardForm == null || _dashboardForm.IsDisposed)
            {
                _dashboardForm = new DashboardForm(
                    async () => {
                        // On manual sync requested from Dashboard
                        UpdateStatusText("Syncing...");
                        await ApiSync.ProcessOfflineQueueAsync();
                        await RefreshStatusAndMenuAsync();
                    },
                    () => {
                        // On logout requested from Dashboard
                        var result = MessageBox.Show(
                            "Are you sure you want to disconnect and log out of your account?",
                            "Confirm Disconnect",
                            MessageBoxButtons.YesNo,
                            MessageBoxIcon.Question
                        );
                        if (result == DialogResult.Yes)
                        {
                            ApiSync.Logout();
                            _dashboardForm?.Hide(); // Close/Hide dashboard window
                            _ = RefreshStatusAndMenuAsync();
                            ShowLoginForm();
                        }
                    }
                );
            }

            // Sync the state immediately on show
            _ = RefreshStatusAndMenuAsync();

            _dashboardForm.Show();
            _dashboardForm.Activate();
            if (_dashboardForm.WindowState == FormWindowState.Minimized)
            {
                _dashboardForm.WindowState = FormWindowState.Normal;
            }
        }

        private async Task RefreshStatusAndMenuAsync()
        {
            if (!ApiSync.IsLoggedIn)
            {
                if (ApiSync.HasStoredCredentials && ApiSync.LastLoginWasNetworkError)
                {
                    // Attempt background reconnect silently if the previous failure was a transient network error
                    UpdateStatusText("Reconnecting...");
                    bool refreshed = await ApiSync.TryRefreshTokenAsync();
                    if (refreshed)
                    {
                        _trayIcon.ShowBalloonTip(3000, "Agent Connected", $"Successfully linked to {ApiSync.CurrentEmail}", ToolTipIcon.Info);
                        ShowDashboardForm();
                        _ = StartupDataRetryAsync();
                    }
                    else if (ApiSync.LastLoginWasNetworkError)
                    {
                        UpdateTrayContextMenu(null, new List<BreakSessionRecord>());
                        UpdateStatusText("Waiting for network...");
                        _dashboardForm?.UpdateState(null, new List<BreakSessionRecord>(), null);
                        return;
                    }
                    else
                    {
                        // Stored credentials invalidated or password changed
                        UpdateTrayContextMenu(null, new List<BreakSessionRecord>());
                        UpdateStatusText("Not connected");
                        _dashboardForm?.UpdateState(null, new List<BreakSessionRecord>(), null);
                        ShowLoginForm();
                        return;
                    }
                }
                else
                {
                    UpdateTrayContextMenu(null, new List<BreakSessionRecord>());
                    UpdateStatusText("Not connected");
                    _dashboardForm?.UpdateState(null, new List<BreakSessionRecord>(), null);
                    return;
                }
            }

            // Sync offline queue in the background (survives offline sleep/shutdown events)
            await ApiSync.ProcessOfflineQueueAsync();

            if (string.IsNullOrEmpty(ApiSync.CurrentName))
            {
                await ApiSync.FetchProfileAsync();
            }

            var attendance = await ApiSync.GetAttendanceTodayAsync();
            var breaks = await ApiSync.GetBreaksTodayAsync();
            var logs = await ApiSync.GetDesktopActivityLogsTodayAsync();

            if (logs != null && logs.Count > 0)
            {
                ApiSync.LastLoggedEvent = logs[logs.Count - 1].EventType;
            }

            // Stale status self-healing: if user is active (idle < 15s) but last DB state was Away/Locked/Sleep
            uint currentIdleMs = IdleTracker.GetIdleTimeMs();
            if (currentIdleMs < 15000 && ApiSync.LastLoggedEvent != null)
            {
                if (ApiSync.LastLoggedEvent == "LOCK")
                {
                    await ApiSync.LogEventAsync("UNLOCK");
                    var newLogs = await ApiSync.GetDesktopActivityLogsTodayAsync();
                    if (newLogs != null && newLogs.Count > 0)
                    {
                        logs = newLogs;
                        ApiSync.LastLoggedEvent = logs[logs.Count - 1].EventType;
                    }
                }
                else if (ApiSync.LastLoggedEvent == "SLEEP")
                {
                    await ApiSync.LogEventAsync("WAKE");
                    var newLogs = await ApiSync.GetDesktopActivityLogsTodayAsync();
                    if (newLogs != null && newLogs.Count > 0)
                    {
                        logs = newLogs;
                        ApiSync.LastLoggedEvent = logs[logs.Count - 1].EventType;
                    }
                }
                else if (ApiSync.LastLoggedEvent == "IDLE_START")
                {
                    await ApiSync.LogEventAsync("IDLE_END");
                    var newLogs = await ApiSync.GetDesktopActivityLogsTodayAsync();
                    if (newLogs != null && newLogs.Count > 0)
                    {
                        logs = newLogs;
                        ApiSync.LastLoggedEvent = logs[logs.Count - 1].EventType;
                    }
                }
            }

            UpdateTrayContextMenu(attendance, breaks);

            // Forward state to the Dashboard mini-app window
            if (_dashboardForm != null && !_dashboardForm.IsDisposed)
            {
                _dashboardForm.UpdateState(attendance, breaks, logs);
            }

            string statusText = $"Connected as {ApiSync.CurrentEmail}";
            if (attendance != null)
            {
                bool isOnBreak = breaks.Exists(b => b.EndTime == null);
                if (isOnBreak)
                {
                    statusText = "On Break";
                }
                else if (attendance.CheckOutTime != null)
                {
                    statusText = "Checked Out";
                }
                else if (attendance.CheckInTime != null)
                {
                    statusText = "Active / Working";
                }
            }
            UpdateStatusText(statusText);
        }

        private void UpdateTrayContextMenu(AttendanceRecord? attendance, List<BreakSessionRecord> breaks)
        {
            if (_trayIcon.ContextMenuStrip.InvokeRequired)
            {
                _trayIcon.ContextMenuStrip.Invoke(new Action(() => UpdateTrayContextMenu(attendance, breaks)));
                return;
            }

            var contextMenu = _trayIcon.ContextMenuStrip;
            contextMenu.Items.Clear();

            // 1. Add Status Item
            contextMenu.Items.Add(_statusMenuItem);
            contextMenu.Items.Add(new ToolStripSeparator());

            // 2. Add Open Dashboard Option (At the very top of actions)
            if (ApiSync.IsLoggedIn)
            {
                var openDashItem = new ToolStripMenuItem("🖥️ Open Dashboard", null, (s, e) => ShowDashboardForm())
                {
                    Font = new Font(contextMenu.Font ?? SystemFonts.DefaultFont, FontStyle.Bold)
                };
                contextMenu.Items.Add(openDashItem);
                contextMenu.Items.Add(new ToolStripSeparator());
            }

            // 3. Add Dynamic Actions based on current status
            if (ApiSync.IsLoggedIn)
            {
                bool hasCheckedIn = attendance?.CheckInTime != null;
                bool hasCheckedOut = attendance?.CheckOutTime != null;
                bool isOnBreak = breaks.Exists(b => b.EndTime == null);

                if (!hasCheckedIn)
                {
                    var checkInItem = new ToolStripMenuItem("🌅 Check In Now", null, async (s, e) => {
                        UpdateStatusText("Checking in...");
                        bool res = await ApiSync.CheckInAsync();
                        if (res)
                        {
                            _trayIcon.ShowBalloonTip(3000, "Morning Check-In", "You have successfully checked in for your shift.", ToolTipIcon.Info);
                        }
                        await RefreshStatusAndMenuAsync();
                    });
                    contextMenu.Items.Add(checkInItem);
                }
                else if (isOnBreak)
                {
                    var activeBreak = breaks.Find(b => b.EndTime == null);
                    string breakName = "Break";
                    if (activeBreak != null && DateTime.TryParse(activeBreak.StartTime, out var start))
                    {
                        var localStart = start.ToLocalTime();
                        if (localStart.Hour == 10 || (localStart.Hour == 11 && localStart.Minute <= 15))
                            breakName = "Morning Tea Break";
                        else if (localStart.Hour == 12 || localStart.Hour == 13)
                            breakName = "Lunch Break";
                        else
                            breakName = "Evening Tea Break";
                    }

                    var endBreakItem = new ToolStripMenuItem($"🛑 End {breakName}", null, async (s, e) => {
                        var confirmResult = MessageBox.Show(
                            $"Are you sure you want to end your {breakName} and return to work?",
                            "Confirm End Break",
                            MessageBoxButtons.YesNo,
                            MessageBoxIcon.Question
                        );
                        if (confirmResult == DialogResult.Yes)
                        {
                            UpdateStatusText("Ending break...");
                            bool res = await ApiSync.EndBreakAsync();
                            if (res)
                            {
                                _trayIcon.ShowBalloonTip(3000, "Break Ended", $"Your {breakName} has ended. Welcome back.", ToolTipIcon.Info);
                            }
                            await RefreshStatusAndMenuAsync();
                        }
                    });
                    contextMenu.Items.Add(endBreakItem);
                }
                else if (!hasCheckedOut)
                {
                    // Check which breaks were already taken today
                    bool tookMorningTea = breaks.Exists(b => {
                        if (DateTime.TryParse(b.StartTime, out var start))
                        {
                            var localStart = start.ToLocalTime();
                            return localStart.Hour == 10 || (localStart.Hour == 11 && localStart.Minute <= 15);
                        }
                        return false;
                    });

                    bool tookLunch = breaks.Exists(b => {
                        if (DateTime.TryParse(b.StartTime, out var start))
                        {
                            var localStart = start.ToLocalTime();
                            return localStart.Hour == 12 || localStart.Hour == 13;
                        }
                        return false;
                    });

                    bool tookEveningTea = breaks.Exists(b => {
                        if (DateTime.TryParse(b.StartTime, out var start))
                        {
                            var localStart = start.ToLocalTime();
                            return localStart.Hour == 14 || localStart.Hour == 15 || localStart.Hour == 16 || localStart.Hour == 17;
                        }
                        return false;
                    });

                    if (!tookMorningTea)
                    {
                        var startMorningTeaItem = new ToolStripMenuItem("☕ Start Morning Tea Break", null, async (s, e) => {
                            var confirmResult = MessageBox.Show(
                                "Are you sure you want to start your Morning Tea Break?",
                                "Confirm Start Break",
                                MessageBoxButtons.YesNo,
                                MessageBoxIcon.Question
                            );
                            if (confirmResult == DialogResult.Yes)
                            {
                                UpdateStatusText("Starting Morning Tea Break...");
                                bool res = await ApiSync.StartBreakAsync();
                                if (res)
                                {
                                    _trayIcon.ShowBalloonTip(3000, "Break Started", "Morning tea break logged successfully.", ToolTipIcon.Info);
                                }
                                await RefreshStatusAndMenuAsync();
                            }
                        });
                        contextMenu.Items.Add(startMorningTeaItem);
                    }

                    if (!tookLunch)
                    {
                        var startLunchItem = new ToolStripMenuItem("🍱 Start Lunch Break", null, async (s, e) => {
                            var confirmResult = MessageBox.Show(
                                "Are you sure you want to start your Lunch Break?",
                                "Confirm Start Break",
                                MessageBoxButtons.YesNo,
                                MessageBoxIcon.Question
                            );
                            if (confirmResult == DialogResult.Yes)
                            {
                                UpdateStatusText("Starting Lunch Break...");
                                bool res = await ApiSync.StartBreakAsync();
                                if (res)
                                {
                                    _trayIcon.ShowBalloonTip(3000, "Lunch Started", "Lunch break logged successfully.", ToolTipIcon.Info);
                                }
                                await RefreshStatusAndMenuAsync();
                            }
                        });
                        contextMenu.Items.Add(startLunchItem);
                    }

                    if (!tookEveningTea)
                    {
                        var startEveningTeaItem = new ToolStripMenuItem("☕ Start Evening Tea Break", null, async (s, e) => {
                            var confirmResult = MessageBox.Show(
                                "Are you sure you want to start your Evening Tea Break?",
                                "Confirm Start Break",
                                MessageBoxButtons.YesNo,
                                MessageBoxIcon.Question
                            );
                            if (confirmResult == DialogResult.Yes)
                            {
                                UpdateStatusText("Starting Evening Tea Break...");
                                bool res = await ApiSync.StartBreakAsync();
                                if (res)
                                {
                                    _trayIcon.ShowBalloonTip(3000, "Break Started", "Evening tea break logged successfully.", ToolTipIcon.Info);
                                }
                                await RefreshStatusAndMenuAsync();
                            }
                        });
                        contextMenu.Items.Add(startEveningTeaItem);
                    }

                    var checkOutItem = new ToolStripMenuItem("🚪 Check Out Now", null, async (s, e) => {
                        if (attendance != null && attendance.CheckInTime != null)
                        {
                            if (DateTimeOffset.TryParse(attendance.CheckInTime, out var checkInOffset))
                            {
                                double grossMins = (DateTimeOffset.UtcNow - checkInOffset).TotalMinutes;
                                double totalBreakMinutes = 0;
                                foreach (var b in breaks)
                                {
                                    if (DateTimeOffset.TryParse(b.StartTime, out var bStart))
                                    {
                                        DateTimeOffset bEnd = DateTimeOffset.UtcNow;
                                        if (!string.IsNullOrEmpty(b.EndTime) && DateTimeOffset.TryParse(b.EndTime, out var tempEnd))
                                        {
                                            bEnd = tempEnd;
                                        }
                                        totalBreakMinutes += (bEnd - bStart).TotalMinutes;
                                    }
                                }

                                double workedMinutes = Math.Max(0, grossMins - totalBreakMinutes);
                                int requiredMinutes = ApiSync.CurrentShift != null ? ApiSync.CurrentShift.RequiredMinutes : 540;
                                requiredMinutes += attendance.PenaltyMinutes;

                                if (workedMinutes < requiredMinutes)
                                {
                                    double remaining = requiredMinutes - workedMinutes;
                                    int remH = (int)(remaining / 60);
                                    int remM = (int)(remaining % 60);

                                    var warnResult = MessageBox.Show(
                                        $"⚠️ WARNING: You have not completed your required working hours today yet!\n\n" +
                                        $"You still have approximately {remH}h {remM}m remaining (including any late penalties).\n\n" +
                                        $"Are you sure you want to check out?",
                                        "Early Check-Out Warning",
                                        MessageBoxButtons.YesNo,
                                        MessageBoxIcon.Warning
                                    );

                                    if (warnResult == DialogResult.No)
                                    {
                                        return;
                                    }
                                }
                            }
                        }

                        using (var statusForm = new StatusUpdateForm())
                        {
                            if (statusForm.ShowDialog() == DialogResult.OK)
                            {
                                string statusUpdate = statusForm.StatusUpdate;
                                UpdateStatusText("Checking out...");
                                bool res = await ApiSync.CheckOutAsync(statusUpdate);
                                if (res)
                                {
                                    _trayIcon.ShowBalloonTip(3000, "Shift Completed", "You have successfully checked out. Have a great evening!", ToolTipIcon.Info);
                                }
                                await RefreshStatusAndMenuAsync();
                            }
                        }
                    });
                    contextMenu.Items.Add(checkOutItem);
                }
                else
                {
                    var completedItem = new ToolStripMenuItem("🎉 Shift Completed Today", null) { Enabled = false };
                    contextMenu.Items.Add(completedItem);
                }

                contextMenu.Items.Add(new ToolStripSeparator());
            }

            // 4. Add Static Items
            contextMenu.Items.Add(_connectMenuItem);
            
            var syncMenuItem = new ToolStripMenuItem("Sync Now", null, OnSyncClick);
            contextMenu.Items.Add(syncMenuItem);
            
            contextMenu.Items.Add(new ToolStripSeparator());
            
            var exitMenuItem = new ToolStripMenuItem("Exit", null, OnExitClick);
            contextMenu.Items.Add(exitMenuItem);
        }

        private async void OnReminderTimerTick(object? sender, EventArgs e)
        {
            if (!ApiSync.IsLoggedIn) return;

            // Handle active snooze timer
            if (_snoozeUntil.HasValue)
            {
                if (DateTime.Now >= _snoozeUntil.Value)
                {
                    var typeToTrigger = _snoozedReminderType;
                    _snoozeUntil = null;
                    _snoozedReminderType = null;

                    if (typeToTrigger.HasValue)
                    {
                        TriggerReminderPopup(typeToTrigger.Value);
                    }
                }
                return;
            }

            // Don't spawn a new popup if one is currently active on the screen
            if (_activeReminderForm != null && !_activeReminderForm.IsDisposed) return;

            var now = DateTime.Now;
            // weekday check
            if (now.DayOfWeek == DayOfWeek.Saturday || now.DayOfWeek == DayOfWeek.Sunday) return;

            var today = now.Date;

            // Fetch state to verify if reminder is actually necessary
            var attendance = await ApiSync.GetAttendanceTodayAsync();
            var breaks = await ApiSync.GetBreaksTodayAsync();

            // If API failed while logged in, don't fire reminders based on stale/missing data
            if (attendance == null && ApiSync.IsLoggedIn) return;

            bool hasCheckedIn = attendance?.CheckInTime != null;
            bool hasCheckedOut = attendance?.CheckOutTime != null;
            bool isOnBreak = breaks.Exists(b => b.EndTime == null);

            var shift = ApiSync.CurrentShift;

            // Default shift settings
            TimeSpan shiftStart = new TimeSpan(9, 0, 0);
            TimeSpan shiftEnd = new TimeSpan(18, 0, 0);
            int gracePeriod = 15;

            bool allowMorningTea = true;
            TimeSpan morningTeaStart = new TimeSpan(10, 30, 0);
            TimeSpan morningTeaEnd = new TimeSpan(11, 15, 0);

            bool allowLunch = true;
            TimeSpan lunchStart = new TimeSpan(12, 0, 0);
            TimeSpan lunchEnd = new TimeSpan(14, 30, 0);

            bool allowEveningTea = true;
            TimeSpan eveningTeaStart = new TimeSpan(15, 30, 0);
            TimeSpan eveningTeaEnd = new TimeSpan(17, 0, 0);

            if (shift != null)
            {
                TimeSpan.TryParse(shift.StartTime, out shiftStart);
                TimeSpan.TryParse(shift.EndTime, out shiftEnd);
                gracePeriod = shift.GracePeriodMinutes;

                allowMorningTea = shift.AllowMorningTea;
                TimeSpan.TryParse(shift.MorningTeaStart, out morningTeaStart);
                TimeSpan.TryParse(shift.MorningTeaEnd, out morningTeaEnd);

                allowLunch = shift.AllowLunch;
                TimeSpan.TryParse(shift.LunchStart, out lunchStart);
                TimeSpan.TryParse(shift.LunchEnd, out lunchEnd);

                allowEveningTea = shift.AllowEveningTea;
                TimeSpan.TryParse(shift.EveningTeaStart, out eveningTeaStart);
                TimeSpan.TryParse(shift.EveningTeaEnd, out eveningTeaEnd);
            }

            TimeSpan currentTime = now.TimeOfDay;

            // 1. Check-In Reminder
            var checkInStartTrigger = shiftStart.Add(TimeSpan.FromMinutes(gracePeriod > 0 ? gracePeriod : 5));
            var checkInEndTrigger = shiftStart.Add(TimeSpan.FromMinutes(30));
            if (currentTime >= checkInStartTrigger && currentTime <= checkInEndTrigger)
            {
                if (!hasCheckedIn && _lastCheckInReminderDate != today)
                {
                    _lastCheckInReminderDate = today;
                    SaveReminderState();
                    TriggerReminderPopup(ReminderType.CheckIn);
                    return;
                }
            }

            // 2. Morning Tea Break Reminder
            if (allowMorningTea && hasCheckedIn && !hasCheckedOut && !isOnBreak && _lastMorningTeaReminderDate != today)
            {
                var morningTeaTarget = new TimeSpan(10, 45, 0);
                if (currentTime >= morningTeaTarget && currentTime <= morningTeaTarget.Add(TimeSpan.FromMinutes(15)))
                {
                    bool tookMorningTea = breaks.Exists(b => {
                        if (DateTimeOffset.TryParse(b.StartTime, out var startOffset))
                        {
                            var localStart = startOffset.LocalDateTime.TimeOfDay;
                            // Wide window: 09:30 – 12:00
                            return localStart >= new TimeSpan(9, 30, 0) && localStart < new TimeSpan(12, 0, 0);
                        }
                        return false;
                    });

                    if (!tookMorningTea)
                    {
                        _lastMorningTeaReminderDate = today;
                        SaveReminderState();
                        TriggerReminderPopup(ReminderType.MorningTea);
                        return;
                    }
                }
            }

            // 3. Lunch Break Reminder
            if (allowLunch && hasCheckedIn && !hasCheckedOut && !isOnBreak && _lastLunchReminderDate != today)
            {
                var lunchTarget = new TimeSpan(13, 0, 0);
                if (currentTime >= lunchTarget && currentTime <= lunchTarget.Add(TimeSpan.FromMinutes(15)))
                {
                    bool tookLunch = breaks.Exists(b => {
                        if (DateTimeOffset.TryParse(b.StartTime, out var startOffset))
                        {
                            var localStart = startOffset.LocalDateTime.TimeOfDay;
                            // Wide window: 12:00 – 15:00
                            return localStart >= new TimeSpan(12, 0, 0) && localStart < new TimeSpan(15, 0, 0);
                        }
                        return false;
                    });

                    if (!tookLunch)
                    {
                        _lastLunchReminderDate = today;
                        SaveReminderState();
                        TriggerReminderPopup(ReminderType.Lunch);
                        return;
                    }
                }
            }

            // 4. Evening Tea Break Reminder
            if (allowEveningTea && hasCheckedIn && !hasCheckedOut && !isOnBreak && _lastEveningTeaReminderDate != today)
            {
                var eveningTeaTarget = new TimeSpan(16, 10, 0);
                if (currentTime >= eveningTeaTarget && currentTime <= eveningTeaTarget.Add(TimeSpan.FromMinutes(15)))
                {
                    bool tookEveningTea = breaks.Exists(b => {
                        if (DateTimeOffset.TryParse(b.StartTime, out var startOffset))
                        {
                            var localStart = startOffset.LocalDateTime.TimeOfDay;
                            // Wide window: 15:00 – 18:00
                            return localStart >= new TimeSpan(15, 0, 0) && localStart < new TimeSpan(18, 0, 0);
                        }
                        return false;
                    });

                    if (!tookEveningTea)
                    {
                        _lastEveningTeaReminderDate = today;
                        SaveReminderState();
                        TriggerReminderPopup(ReminderType.EveningTea);
                        return;
                    }
                }
            }

            // 5. Check-Out Reminder
            if (hasCheckedIn && !hasCheckedOut && _lastCheckOutReminderDate != today)
            {
                if (DateTimeOffset.TryParse(attendance.CheckInTime, out var checkInOffset))
                {
                    int requiredMinutes = shift != null ? shift.RequiredMinutes : 540;
                    requiredMinutes += attendance.PenaltyMinutes;

                    var targetCheckoutTime = checkInOffset.LocalDateTime.AddMinutes(requiredMinutes);

                    if (now >= targetCheckoutTime && now <= targetCheckoutTime.AddMinutes(30))
                    {
                        _lastCheckOutReminderDate = today;
                        SaveReminderState();
                        TriggerReminderPopup(ReminderType.CheckOut);
                        return;
                    }
                }
            }
        }

        private void TriggerReminderPopup(ReminderType type)
        {
            string emoji = "🔔";
            string title = "HRMS Reminder";
            string message = "Time for an update.";
            string actionText = "Proceed";
            Func<Task<bool>> onAction = async () => false;

            switch (type)
            {
                case ReminderType.CheckIn:
                    emoji = "🌅";
                    title = "Morning Check-In";
                    message = "Good morning! Time to start your workday shift. Click below to check in and avoid late penalties.";
                    actionText = "Check In Now";
                    onAction = async () => {
                        bool res = await ApiSync.CheckInAsync();
                        if (res)
                        {
                            _trayIcon.ShowBalloonTip(3000, "Checked In", "Successfully checked in from reminder.", ToolTipIcon.Info);
                            await RefreshStatusAndMenuAsync();
                        }
                        return res;
                    };
                    break;

                case ReminderType.MorningTea:
                    emoji = "☕";
                    title = "Morning Tea Break";
                    message = "It's 10:45 AM. Time for your morning tea break (15 minutes). Step away to rest and recharge.";
                    actionText = "Start Break";
                    onAction = async () => {
                        var confirmResult = MessageBox.Show(
                            _activeReminderForm,
                            "Are you sure you want to start your Morning Tea Break?",
                            "Confirm Start Break",
                            MessageBoxButtons.YesNo,
                            MessageBoxIcon.Question
                        );
                        if (confirmResult == DialogResult.Yes)
                        {
                            bool res = await ApiSync.StartBreakAsync();
                            if (res)
                            {
                                _trayIcon.ShowBalloonTip(3000, "Break Started", "Morning tea break logged successfully.", ToolTipIcon.Info);
                                await RefreshStatusAndMenuAsync();
                            }
                            return res;
                        }
                        return false;
                    };
                    break;

                case ReminderType.Lunch:
                    emoji = "🍱";
                    title = "Lunch Break";
                    message = "It's 1:00 PM. Time to grab some lunch (40 minutes). Make sure to log your break session.";
                    actionText = "Start Break";
                    onAction = async () => {
                        var confirmResult = MessageBox.Show(
                            _activeReminderForm,
                            "Are you sure you want to start your Lunch Break?",
                            "Confirm Start Break",
                            MessageBoxButtons.YesNo,
                            MessageBoxIcon.Question
                        );
                        if (confirmResult == DialogResult.Yes)
                        {
                            bool res = await ApiSync.StartBreakAsync();
                            if (res)
                            {
                                _trayIcon.ShowBalloonTip(3000, "Lunch Started", "Lunch break logged successfully.", ToolTipIcon.Info);
                                await RefreshStatusAndMenuAsync();
                            }
                            return res;
                        }
                        return false;
                    };
                    break;

                case ReminderType.EveningTea:
                    emoji = "☕";
                    title = "Evening Tea Break";
                    message = "It's 4:10 PM. Time for your evening tea break (20 minutes) to refresh your focus.";
                    actionText = "Start Break";
                    onAction = async () => {
                        var confirmResult = MessageBox.Show(
                            _activeReminderForm,
                            "Are you sure you want to start your Evening Tea Break?",
                            "Confirm Start Break",
                            MessageBoxButtons.YesNo,
                            MessageBoxIcon.Question
                        );
                        if (confirmResult == DialogResult.Yes)
                        {
                            bool res = await ApiSync.StartBreakAsync();
                            if (res)
                            {
                                _trayIcon.ShowBalloonTip(3000, "Break Started", "Evening tea break logged successfully.", ToolTipIcon.Info);
                                await RefreshStatusAndMenuAsync();
                            }
                            return res;
                        }
                        return false;
                    };
                    break;

                case ReminderType.CheckOut:
                    emoji = "🚪";
                    title = "End of Shift Check-Out";
                    message = "Your shift is complete. Don't forget to check out and log your hours.";
                    actionText = "Check Out Now";
                    onAction = async () => {
                        var tempAttendance = await ApiSync.GetAttendanceTodayAsync();
                        var tempBreaks = await ApiSync.GetBreaksTodayAsync();
                        if (tempAttendance != null && tempAttendance.CheckInTime != null)
                        {
                            if (DateTimeOffset.TryParse(tempAttendance.CheckInTime, out var checkInOffset))
                            {
                                double grossMins = (DateTimeOffset.UtcNow - checkInOffset).TotalMinutes;
                                double totalBreakMinutes = 0;
                                foreach (var b in tempBreaks)
                                {
                                    if (DateTimeOffset.TryParse(b.StartTime, out var bStart))
                                    {
                                        DateTimeOffset bEnd = DateTimeOffset.UtcNow;
                                        if (!string.IsNullOrEmpty(b.EndTime) && DateTimeOffset.TryParse(b.EndTime, out var tempEnd))
                                        {
                                            bEnd = tempEnd;
                                        }
                                        totalBreakMinutes += (bEnd - bStart).TotalMinutes;
                                    }
                                }

                                double workedMinutes = Math.Max(0, grossMins - totalBreakMinutes);
                                int requiredMinutes = ApiSync.CurrentShift != null ? ApiSync.CurrentShift.RequiredMinutes : 540;
                                requiredMinutes += tempAttendance.PenaltyMinutes;

                                if (workedMinutes < requiredMinutes)
                                {
                                    double remaining = requiredMinutes - workedMinutes;
                                    int remH = (int)(remaining / 60);
                                    int remM = (int)(remaining % 60);

                                    var warnResult = MessageBox.Show(
                                        _activeReminderForm,
                                        $"⚠️ WARNING: You have not completed your required working hours today yet!\n\n" +
                                        $"You still have approximately {remH}h {remM}m remaining (including any late penalties).\n\n" +
                                        $"Are you sure you want to check out?",
                                        "Early Check-Out Warning",
                                        MessageBoxButtons.YesNo,
                                        MessageBoxIcon.Warning
                                    );

                                    if (warnResult == DialogResult.No)
                                    {
                                        return false;
                                    }
                                }
                            }
                        }

                        using (var statusForm = new StatusUpdateForm())
                        {
                            if (statusForm.ShowDialog(_activeReminderForm) == DialogResult.OK)
                            {
                                string statusUpdate = statusForm.StatusUpdate;
                                bool res = await ApiSync.CheckOutAsync(statusUpdate);
                                if (res)
                                {
                                    _trayIcon.ShowBalloonTip(3000, "Checked Out", "Successfully checked out from reminder.", ToolTipIcon.Info);
                                    await RefreshStatusAndMenuAsync();
                                }
                                return res;
                            }
                        }
                        return false;
                    };
                    break;
            }

            _activeReminderForm = new ReminderForm(
                emoji,
                title,
                message,
                actionText,
                onAction,
                (snoozeMins) => {
                    _snoozeUntil = DateTime.Now.AddMinutes(snoozeMins);
                    _snoozedReminderType = type;
                    _activeReminderForm = null;
                },
                () => {
                    _snoozeUntil = null;
                    _snoozedReminderType = null;
                    _activeReminderForm = null;
                }
            );

            _activeReminderForm.Show();
        }

        private void ShowLoginForm()
        {
            if (ApiSync.IsLoggedIn)
            {
                var result = MessageBox.Show(
                    $"You are currently connected as {ApiSync.CurrentEmail}.\nDo you want to disconnect and switch accounts?",
                    "Change Account",
                    MessageBoxButtons.YesNo,
                    MessageBoxIcon.Question
                );

                if (result == DialogResult.Yes)
                {
                    ApiSync.Logout();
                    _dashboardForm?.Hide();
                    _ = RefreshStatusAndMenuAsync();
                }
                else
                {
                    return;
                }
            }

            using var loginForm = new LoginForm();
            if (loginForm.ShowDialog() == DialogResult.OK)
            {
                _trayIcon.ShowBalloonTip(3000, "Agent Connected", $"Successfully linked to {ApiSync.CurrentEmail}", ToolTipIcon.Info);
                _ = RefreshStatusAndMenuAsync();
                ShowDashboardForm(); // Automatically open dashboard upon login
            }
        }

        private void OnConnectClick(object? sender, EventArgs e)
        {
            ShowLoginForm();
        }

        private async void OnSyncClick(object? sender, EventArgs e)
        {
            if (!ApiSync.IsLoggedIn)
            {
                MessageBox.Show("Please connect an account first.", "Sync", MessageBoxButtons.OK, MessageBoxIcon.Warning);
                return;
            }

            UpdateStatusText("Syncing...");
            await ApiSync.ProcessOfflineQueueAsync();
            await RefreshStatusAndMenuAsync();
        }

        private void OnExitClick(object? sender, EventArgs e)
        {
            var result = MessageBox.Show(
                "Exiting the IntelliHrHub Agent will stop automated attendance tracking. Are you sure you want to exit?",
                "Exit IntelliHrHub Agent",
                MessageBoxButtons.YesNo,
                MessageBoxIcon.Warning
            );

            if (result == DialogResult.Yes)
            {
                ExitContext();
            }
        }

        private void ExitContext()
        {
            _sessionMonitor.Stop();
            _idleTracker.Stop();
            _dashboardForm?.Dispose(); // Disposes dashboard window on exit
            _trayIcon.Visible = false;
            _trayIcon.Dispose();
            Application.Exit();
        }

        protected override void Dispose(bool disposing)
        {
            if (disposing)
            {
                _pollTimer?.Dispose();
                _reminderTimer?.Dispose();
                _activeReminderForm?.Dispose();
                _dashboardForm?.Dispose();
                _trayIcon?.Dispose();
            }
            base.Dispose(disposing);
        }
    }
}
