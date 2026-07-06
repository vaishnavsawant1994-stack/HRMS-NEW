using System;
using System.Collections.Generic;
using System.IO;
using System.Net.Http;
using System.Net.Http.Headers;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Threading;
using System.Threading.Tasks;

namespace HRMS_Agent
{
    public class DesktopEvent
    {
        public string EventType { get; set; } = string.Empty;
        public string Timestamp { get; set; } = string.Empty;
    }

    public class ApiConfig
    {
        public string ApiUrl { get; set; } = "https://www.intellihrhub.com";
        public string Token { get; set; } = string.Empty;
        public string UserEmail { get; set; } = string.Empty;
        public string UserName { get; set; } = string.Empty;
        // Encrypted using Windows DPAPI — never stored in plain text
        public string EncryptedPassword { get; set; } = string.Empty;
    }

    public class AttendanceRecord
    {
        public int Id { get; set; }
        public int EmployeeId { get; set; }
        public string? CheckInTime { get; set; }
        public string? CheckOutTime { get; set; }
        public string Status { get; set; } = string.Empty;
        public int WorkedMinutes { get; set; }
        public int PenaltyMinutes { get; set; }
        public int LateByMinutes { get; set; }
    }

    public class BreakSessionRecord
    {
        public int Id { get; set; }
        public int AttendanceId { get; set; }
        public string StartTime { get; set; } = string.Empty;
        public string? EndTime { get; set; }
        public int? DurationMinutes { get; set; }
    }

    public class ShiftRecord
    {
        public int Id { get; set; }
        public string Name { get; set; } = string.Empty;
        public string StartTime { get; set; } = "09:00";
        public string EndTime { get; set; } = "18:00";
        public int RequiredMinutes { get; set; } = 540;
        public int GracePeriodMinutes { get; set; } = 15;
        public bool AllowMorningTea { get; set; }
        public string MorningTeaStart { get; set; } = "10:30";
        public string MorningTeaEnd { get; set; } = "11:15";
        public bool AllowLunch { get; set; }
        public string LunchStart { get; set; } = "12:00";
        public string LunchEnd { get; set; } = "14:30";
        public bool AllowEveningTea { get; set; }
        public string EveningTeaStart { get; set; } = "15:30";
        public string EveningTeaEnd { get; set; } = "17:00";
    }

    public class AttendanceTodayData
    {
        public AttendanceRecord? AttendanceToday { get; set; }
        public ShiftRecord? Shift { get; set; }
    }

    public class AttendanceTodayResponse
    {
        public bool Success { get; set; }
        public string Message { get; set; } = string.Empty;
        public AttendanceTodayData? Data { get; set; }
    }

    public class BreakTodayData
    {
        public List<BreakSessionRecord>? BreakSessions { get; set; }
    }

    public class BreakTodayResponse
    {
        public bool Success { get; set; }
        public string Message { get; set; } = string.Empty;
        public BreakTodayData? Data { get; set; }
    }

    public static class ApiSync
    {
        private static readonly HttpClient _httpClient = new HttpClient();
        private static readonly string AppDataFolder = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "IntelliHrHub_Agent"
        );
        private static readonly string ConfigPath = Path.Combine(AppDataFolder, "config.json");
        private static readonly string QueuePath = Path.Combine(AppDataFolder, "offline_queue.json");

        private static ApiConfig _config = new ApiConfig();
        private static readonly List<DesktopEvent> _offlineQueue = new List<DesktopEvent>();
        private static bool _isProcessingQueue = false;

        public static ShiftRecord? CurrentShift { get; private set; }
        public static string? LastLoggedEvent { get; set; }
        public static bool LastLoginWasNetworkError { get; private set; }

        public static event Action<string>? OnStatusChanged;
        public static event Action<string, DateTime>? OnEventLogged;

        static ApiSync()
        {
            try
            {
                _httpClient.DefaultRequestHeaders.UserAgent.ParseAdd("IntelliHrHub-Agent/1.0");

                if (!Directory.Exists(AppDataFolder))
                {
                    Directory.CreateDirectory(AppDataFolder);
                }

                LoadConfig();
                LoadOfflineQueue();
            }
            catch (Exception ex)
            {
                Console.WriteLine($"Initialization error: {ex.Message}");
            }
        }

        public static bool IsLoggedIn => !string.IsNullOrEmpty(_config.Token);
        public static string CurrentEmail => _config.UserEmail;
        public static string CurrentName => _config.UserName;
        public static string ApiUrl => _config.ApiUrl;
        // True if the device has ever been configured (email stored), even if token expired
        public static bool HasStoredCredentials => !string.IsNullOrEmpty(_config.UserEmail) && !string.IsNullOrEmpty(_config.EncryptedPassword);

        // Encrypt/decrypt password using Windows DPAPI (machine + user scope)
        private static string EncryptPassword(string plainText)
        {
            try
            {
                var bytes = Encoding.UTF8.GetBytes(plainText);
                var encrypted = ProtectedData.Protect(bytes, null, DataProtectionScope.CurrentUser);
                return Convert.ToBase64String(encrypted);
            }
            catch { return string.Empty; }
        }

        private static string DecryptPassword(string encrypted)
        {
            try
            {
                if (string.IsNullOrEmpty(encrypted)) return string.Empty;
                var bytes = Convert.FromBase64String(encrypted);
                var decrypted = ProtectedData.Unprotect(bytes, null, DataProtectionScope.CurrentUser);
                return Encoding.UTF8.GetString(decrypted);
            }
            catch { return string.Empty; }
        }

        // Silently re-authenticate using stored credentials. Returns true if token refreshed.
        public static async Task<bool> TryRefreshTokenAsync()
        {
            if (string.IsNullOrEmpty(_config.UserEmail) || string.IsNullOrEmpty(_config.EncryptedPassword))
                return false;
            var password = DecryptPassword(_config.EncryptedPassword);
            if (string.IsNullOrEmpty(password)) return false;
            return await LoginAsync(_config.UserEmail, password);
        }

        public static void SetApiUrl(string url)
        {
            _config.ApiUrl = url.TrimEnd('/');
            SaveConfig();
        }

        private static void LoadConfig()
        {
            if (File.Exists(ConfigPath))
            {
                try
                {
                    var json = File.ReadAllText(ConfigPath);
                    var loaded = JsonSerializer.Deserialize<ApiConfig>(json);
                    if (loaded != null)
                    {
                        _config = loaded;
                    }
                }
                catch
                {
                    // Fallback to default config
                }
            }
        }

        private static void SaveConfig()
        {
            try
            {
                var json = JsonSerializer.Serialize(_config, new JsonSerializerOptions { WriteIndented = true });
                File.ReadAllText(ConfigPath); // Check access
                File.WriteAllText(ConfigPath, json);
            }
            catch (Exception)
            {
                File.WriteAllText(ConfigPath, JsonSerializer.Serialize(_config));
            }
        }

        private static void LoadOfflineQueue()
        {
            if (File.Exists(QueuePath))
            {
                try
                {
                    var json = File.ReadAllText(QueuePath);
                    var loaded = JsonSerializer.Deserialize<List<DesktopEvent>>(json);
                    if (loaded != null)
                    {
                        _offlineQueue.AddRange(loaded);
                    }
                }
                catch
                {
                    // Corrupted queue file
                }
            }
        }

        private static void SaveOfflineQueue()
        {
            try
            {
                lock (_offlineQueue)
                {
                    var json = JsonSerializer.Serialize(_offlineQueue, new JsonSerializerOptions { WriteIndented = true });
                    File.WriteAllText(QueuePath, json);
                }
            }
            catch
            {
                // Ignore queue save errors
            }
        }

        public static async Task<bool> LoginAsync(string email, string password)
        {
            try
            {
                var payload = new { email, password };
                var content = new StringContent(JsonSerializer.Serialize(payload), Encoding.UTF8, "application/json");
                
                var response = await _httpClient.PostAsync($"{_config.ApiUrl}/api/auth/login", content);
                if (!response.IsSuccessStatusCode)
                {
                    LastLoginWasNetworkError = false;
                    return false;
                }

                var responseJson = await response.Content.ReadAsStringAsync();
                using var doc = JsonDocument.Parse(responseJson);
                var root = doc.RootElement;

                if (root.TryGetProperty("success", out var successProp) && successProp.GetBoolean() &&
                    root.TryGetProperty("data", out var dataProp))
                {
                    if (dataProp.TryGetProperty("token", out var tokenProp))
                    {
                        _config.Token = tokenProp.GetString() ?? string.Empty;
                        _config.UserEmail = email;
                        // Store encrypted password for silent re-authentication
                        _config.EncryptedPassword = EncryptPassword(password);
                        
                        string fullName = "";
                        if (dataProp.TryGetProperty("user", out var userProp))
                        {
                            if (userProp.TryGetProperty("employee", out var empProp) && empProp.ValueKind != JsonValueKind.Null)
                            {
                                string firstName = "";
                                string lastName = "";
                                if (empProp.TryGetProperty("firstName", out var fnProp)) firstName = fnProp.GetString() ?? "";
                                if (empProp.TryGetProperty("lastName", out var lnProp)) lastName = lnProp.GetString() ?? "";
                                fullName = $"{firstName} {lastName}".Trim();
                            }
                        }
                        _config.UserName = !string.IsNullOrEmpty(fullName) ? fullName : email;

                        SaveConfig();
                        OnStatusChanged?.Invoke("Logged in successfully");
                        
                        // Try syncing offline items
                        _ = ProcessOfflineQueueAsync();
                        LastLoginWasNetworkError = false;
                        return true;
                    }
                }
                LastLoginWasNetworkError = false;
                return false;
            }
            catch (Exception ex)
            {
                OnStatusChanged?.Invoke($"Login failed: {ex.Message}");
                LastLoginWasNetworkError = true;
                return false;
            }
        }

        public static void Logout()
        {
            _config.Token = string.Empty;
            _config.UserEmail = string.Empty;
            _config.UserName = string.Empty;
            SaveConfig();
            OnStatusChanged?.Invoke("Logged out");
        }

        public static async Task LogEventAsync(string eventType)
        {
            OnEventLogged?.Invoke(eventType, DateTime.Now);
            LastLoggedEvent = eventType;

            var newEvent = new DesktopEvent
            {
                EventType = eventType,
                Timestamp = DateTime.UtcNow.ToString("o") // ISO 8601 UTC
            };

            // Offline-first: Queue and write to disk synchronously to survive sleeps/shutdowns
            lock (_offlineQueue)
            {
                _offlineQueue.Add(newEvent);
                SaveOfflineQueue();
            }

            OnStatusChanged?.Invoke($"Queued: {eventType}");

            // Process the queue and wait for it to complete
            await ProcessOfflineQueueAsync();
        }

        private static async Task<bool> SendEventPayloadAsync(DesktopEvent ev)
        {
            try
            {
                using var request = new HttpRequestMessage(HttpMethod.Post, $"{_config.ApiUrl}/api/attendance/desktop-event");
                request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _config.Token);
                
                var options = new JsonSerializerOptions { PropertyNamingPolicy = JsonNamingPolicy.CamelCase };
                var json = JsonSerializer.Serialize(ev, options);
                request.Content = new StringContent(json, Encoding.UTF8, "application/json");

                using var cts = new System.Threading.CancellationTokenSource(3000); // 3 seconds timeout
                var response = await _httpClient.SendAsync(request, cts.Token);

                if (response.StatusCode == System.Net.HttpStatusCode.Unauthorized)
                {
                    if (await TryRefreshTokenAsync())
                    {
                        using var retryReq = new HttpRequestMessage(HttpMethod.Post, $"{_config.ApiUrl}/api/attendance/desktop-event");
                        retryReq.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _config.Token);
                        retryReq.Content = new StringContent(json, Encoding.UTF8, "application/json");
                        response = await _httpClient.SendAsync(retryReq, cts.Token);
                    }
                }

                return response.IsSuccessStatusCode;
            }
            catch
            {
                return false;
            }
        }

        public static async Task ProcessOfflineQueueAsync()
        {
            if (_isProcessingQueue || !IsLoggedIn) return;
            _isProcessingQueue = true;

            try
            {
                while (true)
                {
                    DesktopEvent? nextEvent = null;
                    lock (_offlineQueue)
                    {
                        if (_offlineQueue.Count > 0)
                        {
                            nextEvent = _offlineQueue[0];
                        }
                    }

                    if (nextEvent == null) break;

                    bool sent = await SendEventPayloadAsync(nextEvent);
                    if (sent)
                    {
                        lock (_offlineQueue)
                        {
                            _offlineQueue.RemoveAt(0);
                            SaveOfflineQueue();
                        }
                        OnStatusChanged?.Invoke($"Synced offline event: {nextEvent.EventType}");
                    }
                    else
                    {
                        // Server still unreachable, stop processing for now
                        break;
                    }
                }
            }
            finally
            {
                _isProcessingQueue = false;
            }
        }

        public static async Task<bool> FetchProfileAsync()
        {
            if (!IsLoggedIn) return false;
            try
            {
                using var request = new HttpRequestMessage(HttpMethod.Get, $"{_config.ApiUrl}/api/auth/me");
                request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _config.Token);

                var response = await _httpClient.SendAsync(request);
                if (!response.IsSuccessStatusCode) return false;

                var json = await response.Content.ReadAsStringAsync();
                using var doc = JsonDocument.Parse(json);
                var root = doc.RootElement;

                if (root.TryGetProperty("success", out var successProp) && successProp.GetBoolean() &&
                    root.TryGetProperty("data", out var dataProp))
                {
                    string fullName = "";
                    if (dataProp.TryGetProperty("employee", out var empProp) && empProp.ValueKind != JsonValueKind.Null)
                    {
                        string firstName = "";
                        string lastName = "";
                        if (empProp.TryGetProperty("firstName", out var fnProp)) firstName = fnProp.GetString() ?? "";
                        if (empProp.TryGetProperty("lastName", out var lnProp)) lastName = lnProp.GetString() ?? "";
                        fullName = $"{firstName} {lastName}".Trim();
                    }

                    if (!string.IsNullOrEmpty(fullName))
                    {
                        _config.UserName = fullName;
                        SaveConfig();
                        return true;
                    }
                }
                return false;
            }
            catch (Exception ex)
            {
                Console.WriteLine($"Error fetching profile: {ex.Message}");
                return false;
            }
        }

        public static async Task<AttendanceRecord?> GetAttendanceTodayAsync()
        {
            if (!IsLoggedIn) return null;
            try
            {
                using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(15));
                using var request = new HttpRequestMessage(HttpMethod.Get, $"{_config.ApiUrl}/api/attendance/today");
                request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _config.Token);

                var response = await _httpClient.SendAsync(request, cts.Token);

                // Token expired — attempt silent re-authentication
                if (response.StatusCode == System.Net.HttpStatusCode.Unauthorized)
                {
                    if (await TryRefreshTokenAsync())
                    {
                        using var retryReq = new HttpRequestMessage(HttpMethod.Get, $"{_config.ApiUrl}/api/attendance/today");
                        retryReq.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _config.Token);
                        response = await _httpClient.SendAsync(retryReq, cts.Token);
                    }
                }

                if (!response.IsSuccessStatusCode) return null;

                var json = await response.Content.ReadAsStringAsync();
                var options = new JsonSerializerOptions { PropertyNameCaseInsensitive = true };
                var resObj = JsonSerializer.Deserialize<AttendanceTodayResponse>(json, options);

                if (resObj?.Data != null)
                {
                    CurrentShift = resObj.Data.Shift;
                }

                return resObj?.Data?.AttendanceToday;
            }
            catch (Exception ex)
            {
                Console.WriteLine($"Error fetching today's attendance: {ex.Message}");
                return null;
            }
        }

        public static async Task<List<BreakSessionRecord>> GetBreaksTodayAsync()
        {
            if (!IsLoggedIn) return new List<BreakSessionRecord>();
            try
            {
                using var request = new HttpRequestMessage(HttpMethod.Get, $"{_config.ApiUrl}/api/attendance/break/today");
                request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _config.Token);
                
                var response = await _httpClient.SendAsync(request);
                if (!response.IsSuccessStatusCode) return new List<BreakSessionRecord>();

                var json = await response.Content.ReadAsStringAsync();
                var options = new JsonSerializerOptions { PropertyNameCaseInsensitive = true };
                var resObj = JsonSerializer.Deserialize<BreakTodayResponse>(json, options);
                return resObj?.Data?.BreakSessions ?? new List<BreakSessionRecord>();
            }
            catch (Exception ex)
            {
                Console.WriteLine($"Error fetching today's breaks: {ex.Message}");
                return new List<BreakSessionRecord>();
            }
        }

        public static async Task<bool> CheckInAsync()
        {
            if (!IsLoggedIn) return false;
            try
            {
                using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(30));
                using var request = new HttpRequestMessage(HttpMethod.Post, $"{_config.ApiUrl}/api/attendance/check-in");
                request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _config.Token);
                request.Content = new StringContent("{}", Encoding.UTF8, "application/json");

                var response = await _httpClient.SendAsync(request, cts.Token);
                if (response.StatusCode == System.Net.HttpStatusCode.Unauthorized)
                {
                    if (await TryRefreshTokenAsync())
                    {
                        request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _config.Token);
                        using var retryReq = new HttpRequestMessage(HttpMethod.Post, $"{_config.ApiUrl}/api/attendance/check-in");
                        retryReq.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _config.Token);
                        retryReq.Content = new StringContent("{}", Encoding.UTF8, "application/json");
                        var retryResp = await _httpClient.SendAsync(retryReq, cts.Token);
                        return retryResp.IsSuccessStatusCode;
                    }
                    return false;
                }
                return response.IsSuccessStatusCode;
            }
            catch (OperationCanceledException)
            {
                OnStatusChanged?.Invoke("Check-in timed out");
                return false;
            }
            catch (Exception ex)
            {
                Console.WriteLine($"Error during check-in: {ex.Message}");
                return false;
            }
        }

        public static async Task<bool> CheckOutAsync(string statusUpdate)
        {
            if (!IsLoggedIn) return false;
            try
            {
                using var cts = new CancellationTokenSource(TimeSpan.FromSeconds(30));
                using var request = new HttpRequestMessage(HttpMethod.Post, $"{_config.ApiUrl}/api/attendance/check-out");
                request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _config.Token);

                var payload = new { todaysUpdate = statusUpdate };
                request.Content = new StringContent(JsonSerializer.Serialize(payload), Encoding.UTF8, "application/json");

                var response = await _httpClient.SendAsync(request, cts.Token);
                if (response.StatusCode == System.Net.HttpStatusCode.Unauthorized)
                {
                    if (await TryRefreshTokenAsync())
                    {
                        using var retryReq = new HttpRequestMessage(HttpMethod.Post, $"{_config.ApiUrl}/api/attendance/check-out");
                        retryReq.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _config.Token);
                        retryReq.Content = new StringContent(JsonSerializer.Serialize(payload), Encoding.UTF8, "application/json");
                        var retryResp = await _httpClient.SendAsync(retryReq, cts.Token);
                        return retryResp.IsSuccessStatusCode;
                    }
                    return false;
                }
                return response.IsSuccessStatusCode;
            }
            catch (OperationCanceledException)
            {
                OnStatusChanged?.Invoke("Check-out timed out after 30 seconds");
                return false;
            }
            catch (Exception ex)
            {
                Console.WriteLine($"Error during check-out: {ex.Message}");
                return false;
            }
        }

        public static async Task<bool> StartBreakAsync()
        {
            if (!IsLoggedIn) return false;
            try
            {
                using var request = new HttpRequestMessage(HttpMethod.Post, $"{_config.ApiUrl}/api/attendance/break/start");
                request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _config.Token);
                request.Content = new StringContent("{}", Encoding.UTF8, "application/json");

                var response = await _httpClient.SendAsync(request);
                return response.IsSuccessStatusCode;
            }
            catch (Exception ex)
            {
                Console.WriteLine($"Error starting break: {ex.Message}");
                return false;
            }
        }

        public static async Task<bool> EndBreakAsync()
        {
            if (!IsLoggedIn) return false;
            try
            {
                using var request = new HttpRequestMessage(HttpMethod.Post, $"{_config.ApiUrl}/api/attendance/break/end");
                request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _config.Token);
                request.Content = new StringContent("{}", Encoding.UTF8, "application/json");

                var response = await _httpClient.SendAsync(request);
                return response.IsSuccessStatusCode;
            }
            catch (Exception ex)
            {
                Console.WriteLine($"Error ending break: {ex.Message}");
                return false;
            }
        }

        public static async Task<List<DesktopEventRecord>?> GetDesktopActivityLogsTodayAsync()
        {
            if (!IsLoggedIn) return null;
            try
            {
                using var request = new HttpRequestMessage(HttpMethod.Get, $"{_config.ApiUrl}/api/attendance/desktop-activity-log");
                request.Headers.Authorization = new AuthenticationHeaderValue("Bearer", _config.Token);

                var response = await _httpClient.SendAsync(request);
                if (!response.IsSuccessStatusCode) return null;

                var json = await response.Content.ReadAsStringAsync();
                var options = new JsonSerializerOptions { PropertyNameCaseInsensitive = true };
                var resObj = JsonSerializer.Deserialize<DesktopActivityLogResponse>(json, options);
                return resObj?.Data?.Events;
            }
            catch (Exception ex)
            {
                Console.WriteLine($"Error fetching desktop activity logs: {ex.Message}");
                return null;
            }
        }
    }

    public class DesktopEventRecord
    {
        public int Id { get; set; }
        public int EmployeeId { get; set; }
        public string EventType { get; set; } = string.Empty;
        public string Timestamp { get; set; } = string.Empty;
        public string? IpAddress { get; set; }
    }

    public class DesktopActivityLogData
    {
        public List<DesktopEventRecord>? Events { get; set; }
    }

    public class DesktopActivityLogResponse
    {
        public bool Success { get; set; }
        public string Message { get; set; } = string.Empty;
        public DesktopActivityLogData? Data { get; set; }
    }
}
