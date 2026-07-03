import "./AttendancePage.css";
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Calendar, Clock, ChevronDown, Search } from "lucide-react";
import toast from "react-hot-toast";
import Modal from "../../components/common/Modal";
import Table from "../../components/common/Table";
import { ATTENDANCE_EVENT } from "../../components/common/attendanceQuickActionUtils";
import { apiRequest, API_BASE_URL } from "../../services/api";
import type { Attendance, AttendanceRegularizationRequest, Employee, Role } from "../../types";
import { formatAttendanceTime, formatDateLabel, formatInTimeZone, formatWeekday, isToday, TIMEZONE, addMinutesToTime } from "../../utils/format";
import { useApp } from "../../context/useApp";
import WorkdayTimeline from "../dashboard/WorkdayTimeline";
import { toZonedTime } from "date-fns-tz";

type AttendancePageProps = {
  token: string | null;
  role: Role;
  currentEmployeeId: number | null;
  currentEmployee: Employee | null;
};

type AttendanceListRow = Omit<Attendance, "status"> & {
  status: Attendance["status"] | "UNMARKED";
};

type VisibleMonth = {
  month: number;
  year: number;
};

type TeamLeadMainTab = "DAY" | "MONTH";

function toLocalDateString(value: Date) {
  return formatInTimeZone(value, TIMEZONE, "yyyy-MM-dd");
}

function convertTo24Hour(time12: string, ampm: string): string {
  if (!time12 || !time12.trim() || time12.includes("-")) return "";
  
  const parts = time12.split(":");
  let hours = parseInt(parts[0], 10);
  let minutes = 0;
  
  if (parts[1]) {
    minutes = parseInt(parts[1], 10);
  }
  
  if (isNaN(hours)) return "";
  if (isNaN(minutes)) minutes = 0;
  
  if (ampm === "PM" && hours < 12) {
    hours += 12;
  } else if (ampm === "AM" && hours === 12) {
    hours = 0;
  }
  
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function formatTimeInput(value: string, prevValue: string): string {
  if (!value) {
    return "--:--";
  }

  if (!prevValue || prevValue.length !== 5 || prevValue[2] !== ":") {
    prevValue = "--:--";
  }

  // Deletion logic
  if (value.length < prevValue.length) {
    const nDeleted = prevValue.length - value.length;
    let start = 0;
    while (start < value.length && value[start] === prevValue[start]) {
      start++;
    }

    const chars = prevValue.split("");
    for (let i = 0; i < nDeleted; i++) {
      let delIdx = start + i;
      if (delIdx === 2) {
        delIdx = 1;
      }
      if (delIdx >= 0 && delIdx < 5) {
        chars[delIdx] = "-";
      }
    }
    chars[2] = ":";
    return chars.join("");
  }

  // Addition logic
  if (value.length > prevValue.length) {
    let start = 0;
    while (start < prevValue.length && value[start] === prevValue[start]) {
      start++;
    }

    const insertedChar = value[start];
    if (!/^\d$/.test(insertedChar)) {
      return prevValue;
    }

    const chars = prevValue.split("");
    let targetIdx = start;
    if (targetIdx === 2) {
      targetIdx = 3;
    }

    if (targetIdx >= 0 && targetIdx < 5) {
      chars[targetIdx] = insertedChar;
    }
    chars[2] = ":";
    return chars.join("");
  }

  // Same length but character changes
  const chars = prevValue.split("");
  for (let i = 0; i < 5; i++) {
    if (i === 2) continue;
    if (value[i] !== prevValue[i]) {
      if (/^\d$/.test(value[i])) {
        chars[i] = value[i];
      } else if (value[i] === "-") {
        chars[i] = "-";
      }
    }
  }
  chars[2] = ":";
  return chars.join("");
}

function parseLocalDateString(value: string) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(year, (month || 1) - 1, day || 1);
}

function getVisibleMonthFromDate(value: string) {
  const date = parseLocalDateString(value);
  return {
    month: date.getMonth(),
    year: date.getFullYear(),
  };
}

function getCalendarDays({ month, year }: VisibleMonth) {
  const firstDay = new Date(year, month, 1);
  const lastDay = new Date(year, month + 1, 0);
  const leadingDays = (firstDay.getDay() + 6) % 7;
  const totalDays = lastDay.getDate();
  const totalCells = Math.ceil((leadingDays + totalDays) / 7) * 7;

  return Array.from({ length: totalCells }, (_, index) => {
    const date = new Date(year, month, index - leadingDays + 1);
    return {
      key: date.toISOString(),
      value: date,
      inCurrentMonth: date.getMonth() === month,
    };
  });
}

export default function AttendancePage({ token, role, currentEmployeeId, currentEmployee }: AttendancePageProps) {
  const { liveStatuses } = useApp();
  const today = toLocalDateString(new Date());

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const getLatenessBreakdown = (rec: any) => {
    const breakdown: string[] = [];
    let totalLateness = 0;

    // 1. Check-in lateness
    const lateByMinutes = rec.lateByMinutes || 0;
    if (lateByMinutes > 0) {
      breakdown.push(`${lateByMinutes}m`);
      totalLateness += lateByMinutes;
    }

    // 2. Break latenesses
    if (rec.breakSessions && rec.breakSessions.length > 0) {
      const emp = rec.employee || currentEmployee;
      const shift = emp?.shift;
      const hasBreaks = shift ? shift.hasBreaks : true;

      if (hasBreaks) {
        const shiftStartTimeStr = shift?.startTime || "09:00";
        const shiftStartHour = parseInt(shiftStartTimeStr.split(":")[0], 10);
        const isMorningShift = !isNaN(shiftStartHour) && shiftStartHour < 12;

        const parseTimeToMinutes = (timeStr: string): number => {
          const [hours, minutes] = timeStr.split(":").map(Number);
          return (isNaN(hours) || isNaN(minutes)) ? 0 : hours * 60 + minutes;
        };

        const morningTeaStartMins = parseTimeToMinutes(shift?.morningTeaStart || "10:30");
        const morningTeaEndMins = parseTimeToMinutes(shift?.morningTeaEnd || "11:15");
        const lunchStartMins = parseTimeToMinutes(shift?.lunchStart || "12:00");
        const lunchEndMins = parseTimeToMinutes(shift?.lunchEnd || "14:30");
        const eveningTeaStartMins = parseTimeToMinutes(shift?.eveningTeaStart || "15:30");
        const eveningTeaEndMins = parseTimeToMinutes(shift?.eveningTeaEnd || "17:00");
        const dinnerStartMins = parseTimeToMinutes(shift?.dinnerStart || "20:00");
        const dinnerEndMins = parseTimeToMinutes(shift?.dinnerEnd || "22:00");

        for (const bs of rec.breakSessions) {
          if (!bs.endTime) continue;

          const durationMinutes = bs.durationMinutes || 0;
          const bStartLocal = toZonedTime(new Date(bs.startTime), TIMEZONE);
          const startHour = bStartLocal.getHours();
          const startMin = bStartLocal.getMinutes();
          const totalStartMins = startHour * 60 + startMin;

          let allowedDuration = 0;
          if (totalStartMins >= morningTeaStartMins && totalStartMins <= morningTeaEndMins) {
            allowedDuration = (shift ? shift.allowMorningTea : true) ? 15 : 0;
          } else if (totalStartMins >= lunchStartMins && totalStartMins <= lunchEndMins) {
            allowedDuration = (isMorningShift && (shift ? shift.allowLunch : true)) ? 40 : 0;
          } else if (totalStartMins >= eveningTeaStartMins && totalStartMins <= eveningTeaEndMins) {
            allowedDuration = (shift ? shift.allowEveningTea : true) ? 20 : 0;
          } else if (totalStartMins >= dinnerStartMins && totalStartMins <= dinnerEndMins) {
            allowedDuration = (!isMorningShift && (shift ? shift.allowDinner : true)) ? 40 : 0;
          }

          if (allowedDuration > 0 && durationMinutes > allowedDuration) {
            const breakLate = durationMinutes - allowedDuration;
            if (breakLate > 0) {
              breakdown.push(`${breakLate}m`);
              totalLateness += breakLate;
            }
          }
        }
      }
    }

    if (totalLateness > 0) {
      if (breakdown.length > 1) {
        return `${breakdown.join(" + ")} = ${totalLateness}m`;
      }
      return `${breakdown[0]}`;
    }

    return "";
  };
  const [selectedTimelineItem, setSelectedTimelineItem] = useState<{
    date: string;
    record: Attendance;
  } | null>(null);

  const liveStatusArray = useMemo(() => {
    return Object.values(liveStatuses || {});
  }, [liveStatuses]);

  const [loadingTimelineEmpId, setLoadingTimelineEmpId] = useState<number | null>(null);

  const handleViewTimeline = async (empId: number) => {
    if (loadingTimelineEmpId) return;
    try {
      setLoadingTimelineEmpId(empId);
      const response = await apiRequest<Attendance[]>(`/attendance?employeeId=${empId}&date=${today}`, { token });
      const record = response.data?.[0];
      if (record) {
        setSelectedTimelineItem({
          date: today,
          record: record
        });
      } else {
        toast.error("No active attendance record found for this employee today.");
      }
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to load timeline.");
    } finally {
      setLoadingTimelineEmpId(null);
    }
  };
  const joiningDateFormatted = currentEmployee?.joiningDate 
    ? toLocalDateString(new Date(currentEmployee.joiningDate)) 
    : undefined;
  const [attendance, setAttendance] = useState<Attendance[]>([]);
  const [regularizations, setRegularizations] = useState<AttendanceRegularizationRequest[]>([]);
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [employeesTotal, setEmployeesTotal] = useState(0);
  const [filterStatus, setFilterStatus] = useState("");
  const [teamLeadMainTab, setTeamLeadMainTab] = useState<TeamLeadMainTab>("DAY");
  const [dailyViewTab, setDailyViewTab] = useState<"LIVE" | "HISTORY">("HISTORY");
  const [liveStatusFilter, setLiveStatusFilter] = useState<"ALL" | "ACTIVE" | "AWAY" | "OFFLINE">("ALL");
  const [liveSearchQuery, setLiveSearchQuery] = useState("");
  const [filterDate, setFilterDate] = useState(today);
  const [filterMode, setFilterMode] = useState<"DAY" | "MONTH">("DAY");
  const [filterMonth, setFilterMonth] = useState<number>(() => new Date().getMonth() + 1);
  const [filterYear, setFilterYear] = useState<number>(() => new Date().getFullYear());

  const monthOptions = useMemo(() => {
    const options = [];
    const now = new Date();
    for (let i = 0; i < 12; i++) {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const m = d.getMonth() + 1;
      const y = d.getFullYear();
      const label = formatInTimeZone(d, TIMEZONE, "MMMM yyyy");
      options.push({ value: `${m}-${y}`, label, month: m, year: y });
    }
    return options;
  }, []);

  const yesterdayDateStr = useMemo(() => {
    const yest = new Date();
    yest.setDate(yest.getDate() - 1);
    return toLocalDateString(yest);
  }, []);

  const [datePickerOpen, setDatePickerOpen] = useState(false);
  const [visibleMonth, setVisibleMonth] = useState<VisibleMonth>(() => getVisibleMonthFromDate(today));
  const [regularizationOpen, setRegularizationOpen] = useState(false);

  const [finalizeConfirmOpen, setFinalizeConfirmOpen] = useState(false);
  const [regularizationForm, setRegularizationForm] = useState({
    attendanceDate: today,
    proposedCheckInTime: "",
    proposedCheckOutTime: "",
    reason: "",
  });
  const [checkInTime, setCheckInTime] = useState("--:--");
  const [checkInAmPm, setCheckInAmPm] = useState("AM");
  const [checkOutTime, setCheckOutTime] = useState("--:--");
  const [checkOutAmPm, setCheckOutAmPm] = useState("PM");
  const [showCheckInDropdown, setShowCheckInDropdown] = useState(false);
  const [showCheckOutDropdown, setShowCheckOutDropdown] = useState(false);
  const [selectedUpdate, setSelectedUpdate] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [submittingRegularization, setSubmittingRegularization] = useState(false);

  const [overtimePreApprovalOpen, setOvertimePreApprovalOpen] = useState(false);
  const [overtimeReason, setOvertimeReason] = useState("");
  const [submittingOvertime, setSubmittingOvertime] = useState(false);

  const [downloadMonth, setDownloadMonth] = useState<number>(() => new Date().getMonth() + 1);
  const [downloadYear, setDownloadYear] = useState<number>(() => new Date().getFullYear());
  const [downloadType, setDownloadType] = useState<"general" | "employee">("general");
  const [exporting, setExporting] = useState(false);

  const handleDownloadOfflineSheet = async () => {
    try {
      setExporting(true);
      const url = `${API_BASE_URL}/attendance/export?month=${downloadMonth}&year=${downloadYear}&type=${downloadType}`;
      const response = await fetch(url, {
        method: "GET",
        headers: {
          Authorization: token ? `Bearer ${token}` : "",
        },
      });

      if (!response.ok) {
        let errMsg = "Export failed";
        try {
          const errJson = await response.json();
          errMsg = errJson.message || errMsg;
        } catch {
          // ignore
        }
        throw new Error(errMsg);
      }

      const blob = await response.blob();
      const downloadUrl = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = downloadUrl;
      
      const MONTH_NAMES = [
        "January", "February", "March", "April", "May", "June",
        "July", "August", "September", "October", "November", "December"
      ];
      const monthName = MONTH_NAMES[downloadMonth - 1];
      
      const filename = downloadType === "employee"
        ? `Employee_Wise_Attendance_Report_${monthName}_${downloadYear}.xlsx`
        : `General_Attendance_Report_${monthName}_${downloadYear}.xlsx`;

      a.download = filename;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      window.URL.revokeObjectURL(downloadUrl);
      toast.success("Attendance report downloaded successfully!");
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to download attendance report.");
    } finally {
      setExporting(false);
    }
  };

  const myTodayAttendance = useMemo(() => {
    if (!currentEmployeeId) return null;
    return attendance.find(
      (record) =>
        record.employeeId === currentEmployeeId &&
        toLocalDateString(new Date(record.attendanceDate)) === today
    );
  }, [attendance, currentEmployeeId, today]);

  const showPaidOvertimeRequestBtn = useMemo(() => {
    if (filterDate !== today) return false;

    // Check if submitted before 5:00 PM IST (Asia/Kolkata)
    const zonedNow = toZonedTime(new Date(), "Asia/Kolkata");
    if (zonedNow.getHours() >= 17) return false;

    // Must be checked in today
    if (!myTodayAttendance || !myTodayAttendance.checkInTime) return false;

    // Must not have an existing overtime session
    if (myTodayAttendance.overtimeSession) return false;

    return true;
  }, [filterDate, today, myTodayAttendance]);

  async function handleOvertimePreApprovalSubmit() {
    if (!overtimeReason.trim()) {
      toast.error("Reason is required");
      return;
    }
    if (submittingOvertime) return;

    try {
      setSubmittingOvertime(true);
      const response = await apiRequest<any>("/attendance/overtime/pre-approval", {
        method: "POST",
        token,
        body: {
          reason: overtimeReason.trim(),
        },
      });
      toast.success(response.message || "Overtime pre-approval request submitted successfully");
      setOvertimePreApprovalOpen(false);
      setOvertimeReason("");
      await reloadAttendance();
    } catch (requestError) {
      toast.error(requestError instanceof Error ? requestError.message : "Failed to submit overtime pre-approval request.");
    } finally {
      setSubmittingOvertime(false);
    }
  }

  useEffect(() => {
    function handleClickOutside(event: MouseEvent) {
      const target = event.target as HTMLElement;
      if (!target.closest(".time-input-container--checkin")) {
        setShowCheckInDropdown(false);
      }
      if (!target.closest(".time-input-container--checkout")) {
        setShowCheckOutDropdown(false);
      }
    }
    document.addEventListener("mousedown", handleClickOutside);
    return () => {
      document.removeEventListener("mousedown", handleClickOutside);
    };
  }, []);
  const handleTimeSelect = (
    type: "checkin" | "checkout",
    part: "hour" | "minute" | "ampm",
    val: string
  ) => {
    if (type === "checkin") {
      let [h, m] = checkInTime.split(":");
      if (h === "--" || !h) h = "09";
      if (m === "--" || !m) m = "00";

      if (part === "hour") {
        setCheckInTime(`${val}:${m}`);
      } else if (part === "minute") {
        setCheckInTime(`${h}:${val}`);
      } else if (part === "ampm") {
        setCheckInAmPm(val);
      }
    } else {
      let [h, m] = checkOutTime.split(":");
      if (h === "--" || !h) h = "06";
      if (m === "--" || !m) m = "00";

      if (part === "hour") {
        setCheckOutTime(`${val}:${m}`);
      } else if (part === "minute") {
        setCheckOutTime(`${h}:${val}`);
      } else if (part === "ampm") {
        setCheckOutAmPm(val);
      }
    }
  };

  const isTeamLead = Boolean(currentEmployee?.capabilities?.some((capability) => capability.capability === "TEAM_LEAD"));
  const canManageOthers = role !== "EMPLOYEE" || isTeamLead;
  const showTeamWorkspace = role === "EMPLOYEE" && isTeamLead;
  const showEmployeeColumn = canManageOthers && !showTeamWorkspace;
  const canFinalizeAttendance = role === "ADMIN" || role === "HR";
  const showAttendanceOverviewFilters = showEmployeeColumn;
  const activeOverviewFilter = filterStatus === "HALF_DAY" ? "PRESENT" : filterStatus;
  const navigate = useNavigate();
  const calendarDays = useMemo(() => getCalendarDays(visibleMonth), [visibleMonth]);
  const currentMonthLabel = formatInTimeZone(new Date(visibleMonth.year, visibleMonth.month, 1), 'Asia/Kolkata', 'MMMM yyyy');

  function getWorkedDurationLabel(record: AttendanceListRow) {
    if (record.status === "LEAVE") {
      return "-";
    }

    if (record.status === "ABSENT") {
      return "Absent";
    }

    if (record.status === "UNMARKED") {
      return "Unmarked";
    }

    if (record.checkOutTime) {
      return formatWorkedDuration(record.workedMinutes);
    }

    return isToday(record.attendanceDate) ? "In progress" : "Checkout missing";
  }

  function renderWorkedDuration(record: AttendanceListRow) {
    const label = getWorkedDurationLabel(record);

    if (label === "Checkout missing") {
      return <span className="attendance-warning-text">{label}</span>;
    }

    return label;
  }

  function renderOvertime(record: AttendanceListRow) {
    const penaltyMins = record.penaltyMinutes || 0;
    const requiredMins = 540 + penaltyMins;

    if (!record.overtimeSession) {
      if (record.workedMinutes > requiredMins) {
        const otMins = record.workedMinutes - requiredMins;
        return (
          <span className="status-pill status-pill--approved" style={{ fontSize: '11px', fontWeight: 'bold' }}>
            +{formatWorkedDuration(otMins)}
          </span>
        );
      }
      return <span className="muted">—</span>;
    }

    const { duration, status, isPaid, endTime } = record.overtimeSession;
    
    if (status === "REJECTED") {
      return <span className="status-pill status-pill--rejected" style={{ fontSize: '11px' }}>Rejected</span>;
    }

    // 1. Pending Pre-Approval Request (Before 5 PM request, not yet worked)
    if (status === "PENDING_VERIFICATION" && isPaid && !endTime) {
      return (
        <span className="status-pill status-pill--pending" style={{ fontSize: '11px', fontWeight: 'bold', border: '1px solid rgba(245, 158, 11, 0.3)' }}>
          Pending Paid Approval
        </span>
      );
    }

    // 2. Pre-Approved Paid Overtime (Approved by Manager/HR, not yet started/worked)
    if (status === "APPROVED") {
      return (
        <span className="status-pill" style={{ background: 'rgba(124, 58, 237, 0.1)', color: '#6d28d9', border: '1px solid rgba(124, 58, 237, 0.2)', fontSize: '11px', fontWeight: 'bold' }}>
          Pre-Approved Paid
        </span>
      );
    }

    const durationLabel = duration ? formatWorkedDuration(duration) : "0m";

    if (status === "VERIFIED") {
      return (
        <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
          <span className="status-pill status-pill--approved" style={{ fontSize: '11px', fontWeight: 'bold' }}>
            +{durationLabel}
          </span>
          {isPaid && (
            <span className="status-pill" style={{ background: 'rgba(124, 58, 237, 0.1)', color: '#6d28d9', border: '1px solid rgba(124, 58, 237, 0.2)', fontSize: '10px', fontWeight: 'bold', padding: '2px 6px', borderRadius: '4px', whiteSpace: 'nowrap' }}>
              Paid
            </span>
          )}
        </div>
      );
    }

    if (status === "ACTIVE") {
      return (
        <span className="status-pill status-pill--half-day" style={{ fontSize: '11px' }}>
          Active{isPaid ? " (Paid)" : ""}
        </span>
      );
    }

    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
        <span className="status-pill status-pill--pending" style={{ fontSize: '11px' }} title="Pending verification">
          {durationLabel} (Pending)
        </span>
        {isPaid && (
          <span className="status-pill" style={{ background: 'rgba(124, 58, 237, 0.1)', color: '#6d28d9', border: '1px solid rgba(124, 58, 237, 0.2)', fontSize: '10px', fontWeight: 'bold', padding: '2px 6px', borderRadius: '4px', whiteSpace: 'nowrap' }}>
            Paid
          </span>
        )}
      </div>
    );
  }

  const reloadAttendance = useCallback(async () => {
    try {
      setLoading(true);
      const searchParams = new URLSearchParams();
      const useDayFilter = !(showTeamWorkspace && teamLeadMainTab === "MONTH");
      if (useDayFilter) {
        if (filterMode === "DAY" && filterDate) {
          searchParams.set("date", filterDate);
        } else if (filterMode === "MONTH") {
          searchParams.set("month", String(filterMonth));
          searchParams.set("year", String(filterYear));
        }
      }
      const path = `/attendance${searchParams.toString() ? `?${searchParams.toString()}` : ""}`;
      const response = await apiRequest<Attendance[]>(path, { token });
      setAttendance(response.data);
    } catch (requestError) {
      toast.error(requestError instanceof Error ? requestError.message : "Failed to load attendance history.");
    } finally {
      setLoading(false);
    }
  }, [filterDate, filterMode, filterMonth, filterYear, showTeamWorkspace, teamLeadMainTab, token]);

  const reloadRegularizations = useCallback(async () => {
    try {
      const response = await apiRequest<AttendanceRegularizationRequest[]>("/attendance/regularizations", { token });
      setRegularizations(response.data);
    } catch (requestError) {
      toast.error(requestError instanceof Error ? requestError.message : "Failed to load attendance correction requests.");
    }
  }, [token]);

  const reloadEmployees = useCallback(async () => {
    if (role !== "EMPLOYEE") {
      try {
        const response = await apiRequest<{ items: Employee[]; pagination?: { total: number } }>("/employees?limit=1000", { token });
        setEmployees(response.data.items);
        setEmployeesTotal(response.data.pagination?.total ?? response.data.items.length);
      } catch (requestError) {
        toast.error(requestError instanceof Error ? requestError.message : "Failed to load employees for attendance.");
      }
      return;
    }

    if (!isTeamLead || !currentEmployeeId) {
      setEmployees([]);
      setEmployeesTotal(currentEmployeeId ? 1 : 0);
      return;
    }

    const scopedEmployees = currentEmployee?.scopedTeamMembers?.map((item) => item.employee) ?? [];
    setEmployees(scopedEmployees);
    setEmployeesTotal(new Set([currentEmployeeId, ...scopedEmployees.map((employee) => employee.id)]).size);
  }, [currentEmployee, currentEmployeeId, isTeamLead, role, token]);

  useEffect(() => {
    reloadAttendance();
  }, [reloadAttendance]);

  useEffect(() => {
    const handleAttendanceUpdated = () => {
      void reloadAttendance();
    };

    window.addEventListener(ATTENDANCE_EVENT, handleAttendanceUpdated);
    return () => window.removeEventListener(ATTENDANCE_EVENT, handleAttendanceUpdated);
  }, [reloadAttendance]);

  useEffect(() => {
    if (filterDate !== today) {
      return undefined;
    }

    const intervalId = window.setInterval(() => {
      void reloadAttendance();
    }, 10000);

    return () => window.clearInterval(intervalId);
  }, [filterDate, reloadAttendance, today]);

  // Sync Attendance data instantly when the browser tab/window gains focus
  useEffect(() => {
    const handleFocus = () => {
      void reloadAttendance();
      void reloadEmployees();
      void reloadRegularizations();
    };
    window.addEventListener("focus", handleFocus);
    return () => window.removeEventListener("focus", handleFocus);
  }, [reloadAttendance, reloadEmployees, reloadRegularizations]);

  useEffect(() => {
    reloadRegularizations();
  }, [reloadRegularizations]);

  useEffect(() => {
    reloadEmployees();
  }, [reloadEmployees]);

  useEffect(() => {
    setVisibleMonth(getVisibleMonthFromDate(filterDate || today));
  }, [filterDate, today]);

  async function handleFinalizeAttendance() {
    try {
      const response = await apiRequest<{ attendanceDate: string; createdCount: number }>("/attendance/finalize", {
        method: "POST",
        token,
        body: {
          date: filterDate || undefined,
        },
      });

      const createdCount = response.data.createdCount;
      toast.success(
        createdCount > 0
          ? `Attendance finalized. ${createdCount} employee${createdCount === 1 ? "" : "s"} marked absent.`
          : "Attendance finalized. No new absent records were needed.",
      );
      await reloadAttendance();
    } catch (requestError) {
      toast.error(requestError instanceof Error ? requestError.message : "Failed to finalize attendance.");
    }
  }

  async function handleRegularizationSubmit() {
    if (submittingRegularization) return;
    const checkIn24 = convertTo24Hour(checkInTime, checkInAmPm);
    const checkOut24 = convertTo24Hour(checkOutTime, checkOutAmPm);

    try {
      setSubmittingRegularization(true);
      const response = await apiRequest<AttendanceRegularizationRequest>("/attendance/regularizations", {
        method: "POST",
        token,
        body: {
          attendanceDate: regularizationForm.attendanceDate,
          proposedCheckInTime: checkIn24 || undefined,
          proposedCheckOutTime: checkOut24 || undefined,
          reason: regularizationForm.reason,
        },
      });
      toast.success(response.message);
      setRegularizationOpen(false);
      setRegularizationForm({
        attendanceDate: today,
        proposedCheckInTime: "",
        proposedCheckOutTime: "",
        reason: "",
      });
      setCheckInTime("--:--");
      setCheckOutTime("--:--");
      setCheckInAmPm("AM");
      setCheckOutAmPm("PM");
      await reloadRegularizations();
    } catch (requestError) {
      toast.error(requestError instanceof Error ? requestError.message : "Failed to submit attendance correction request.");
    } finally {
      setSubmittingRegularization(false);
    }
  }

  function formatWorkedDuration(workedMinutes: number) {
    if (!workedMinutes || workedMinutes <= 0) {
      return "-";
    }

    const hours = Math.floor(workedMinutes / 60);
    const minutes = workedMinutes % 60;

    if (hours > 0 && minutes > 0) {
      return `${hours}h ${minutes}m`;
    }

    if (hours > 0) {
      return `${hours}h`;
    }

    return `${minutes}m`;
  }

  function getStatusClass(status: AttendanceListRow["status"]) {
    return `status-pill status-pill--${status.toLowerCase().replace(/_/g, "-")}`;
  }

  function getStatusLabel(record: AttendanceListRow) {
    const baseLabel = record.status === "HALF_DAY" ? "Half day" : record.status === "UNMARKED" ? "Unmarked" : record.status.charAt(0) + record.status.slice(1).toLowerCase();

    if (record.leaveTypeCode && (record.status === "LEAVE" || record.status === "HALF_DAY")) {
      return `${baseLabel} (${record.leaveTypeCode})`;
    }

    return baseLabel;
  }


  const scopedAttendance = useMemo(() => {
    if (!showTeamWorkspace || !currentEmployeeId) {
      return attendance;
    }

    return attendance.filter((record) => record.employeeId === currentEmployeeId);
  }, [attendance, currentEmployeeId, showTeamWorkspace]);

  const filteredAttendance = scopedAttendance.filter((record) => {
    if (filterStatus) {
      if (filterStatus === "PRESENT") {
        if (record.status !== "PRESENT" && record.status !== "HALF_DAY") {
          return false;
        }
      } else if (record.status !== filterStatus) {
        return false;
      }
    }

    return true;
  });

  const workforceEmployees = useMemo(() => {
    if (role === "EMPLOYEE") {
      return currentEmployee ? [currentEmployee] : [];
    }

    return employees;
  }, [currentEmployee, employees, role]);

  const attendanceOverviewSource = useMemo(() => scopedAttendance, [scopedAttendance]);

  const attendanceOverview = useMemo(
    () =>
      attendanceOverviewSource.reduce(
        (summary, record) => {
          if (record.status === "PRESENT" || record.status === "HALF_DAY") {
            summary.present += 1;
          } else if (record.status === "ABSENT") {
            summary.absent += 1;
          } else if (record.status === "LEAVE") {
            summary.leave += 1;
          }

          return summary;
        },
        { present: 0, absent: 0, leave: 0 },
      ),
    [attendanceOverviewSource],
  );

  const totalWorkforceCount = useMemo(() => {
    if (employeesTotal > 0) {
      return employeesTotal;
    }

    return workforceEmployees.length;
  }, [employeesTotal, workforceEmployees.length]);

  const markedEmployeeIds = useMemo(
    () => new Set(attendanceOverviewSource.map((record) => record.employee?.id ?? record.employeeId)),
    [attendanceOverviewSource],
  );

  const unmarkedRows = useMemo<AttendanceListRow[]>(() => {
    if (!filterDate) {
      return [];
    }

    return workforceEmployees
      .filter((employee) => !markedEmployeeIds.has(employee.id))
      .map((employee) => ({
        id: -employee.id,
        employeeId: employee.id,
        attendanceDate: parseLocalDateString(filterDate).toISOString(),
        checkInTime: null,
        checkOutTime: null,
        workedMinutes: 0,
        status: "UNMARKED",
        employee,
      }));
  }, [filterDate, markedEmployeeIds, workforceEmployees]);

  const attendanceRows = useMemo<AttendanceListRow[]>(() => {
    if (filterStatus === "UNMARKED") {
      return unmarkedRows;
    }

    return filteredAttendance;
  }, [filterStatus, filteredAttendance, unmarkedRows]);

  const unmarkedCount = useMemo(() => {
    if (employeesTotal > 0) {
      return Math.max(0, employeesTotal - markedEmployeeIds.size);
    }

    return unmarkedRows.length;
  }, [employeesTotal, markedEmployeeIds.size, unmarkedRows.length]);

  const columns = [
    ...(showEmployeeColumn ? ["Employee"] : []),
    "Date",
    "Check in",
    "Check out",
    "Late time",
    "Worked duration",
    "Overtime",
    "Today's update",
    "Status",
  ];

  const visibleRegularizations = useMemo(() => {
    if (role === "EMPLOYEE") {
      return regularizations.filter((record) => record.employeeId === currentEmployeeId);
    }

    return regularizations;
  }, [currentEmployeeId, regularizations, role]);

  const monthlySummaryRows = useMemo(() => {
    const source = showTeamWorkspace
      ? attendance.filter((record) => record.employeeId === currentEmployeeId)
      : attendance;
    const grouped = source.reduce<Record<string, { year: number; month: number; present: number; halfDay: number; absent: number; leave: number; total: number }>>((acc, record) => {
      const date = toZonedTime(new Date(record.attendanceDate), TIMEZONE);
      const month = date.getMonth() + 1;
      const year = date.getFullYear();
      const key = `${year}-${month}`;

      if (!acc[key]) {
        acc[key] = { year, month, present: 0, halfDay: 0, absent: 0, leave: 0, total: 0 };
      }

      if (record.status === "PRESENT") acc[key].present += 1;
      if (record.status === "HALF_DAY") acc[key].halfDay += 1;
      if (record.status === "ABSENT") acc[key].absent += 1;
      if (record.status === "LEAVE") acc[key].leave += 1;
      acc[key].total += 1;
      return acc;
    }, {});

    return Object.values(grouped).sort((a, b) => (b.year * 100 + b.month) - (a.year * 100 + a.month));
  }, [attendance, currentEmployeeId, showTeamWorkspace]);

  return (
    <section className="stack">
      {(showTeamWorkspace || (canManageOthers && teamLeadMainTab === "DAY")) ? (
        <div className="attendance-workspace-nav-row" style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '16px', gap: '16px', flexWrap: 'wrap', width: '100%' }}>
          {/* Left side: daily sub-tabs */}
          {canManageOthers && (!showTeamWorkspace || teamLeadMainTab === "DAY") ? (
            <div className="attendance-team-main-tabs daily-sub-tabs" role="tablist" aria-label="Daily workspace sections" style={{ marginBottom: 0 }}>
              <button
                type="button"
                role="tab"
                aria-selected={dailyViewTab === "HISTORY"}
                className={`attendance-team-main-tab ${dailyViewTab === "HISTORY" ? "attendance-team-main-tab--active" : ""}`.trim()}
                onClick={() => setDailyViewTab("HISTORY")}
              >
                Daily Attendance Logs
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={dailyViewTab === "LIVE"}
                className={`attendance-team-main-tab ${dailyViewTab === "LIVE" ? "attendance-team-main-tab--active" : ""}`.trim()}
                onClick={() => setDailyViewTab("LIVE")}
              >
                Live Telemetry Tracker
              </button>
            </div>
          ) : null}

          {/* Right side: main workspace tabs */}
          {showTeamWorkspace ? (
            <div className="attendance-team-main-tabs" role="tablist" aria-label="Attendance workspace" style={{ marginLeft: 'auto' }}>
              <button
                type="button"
                role="tab"
                aria-selected={teamLeadMainTab === "DAY"}
                className={`attendance-team-main-tab ${teamLeadMainTab === "DAY" ? "attendance-team-main-tab--active" : ""}`.trim()}
                onClick={() => setTeamLeadMainTab("DAY")}
              >
                Daily View
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={teamLeadMainTab === "MONTH"}
                className={`attendance-team-main-tab ${teamLeadMainTab === "MONTH" ? "attendance-team-main-tab--active" : ""}`.trim()}
                onClick={() => setTeamLeadMainTab("MONTH")}
              >
                Monthly Summary
              </button>
            </div>
          ) : null}
        </div>
      ) : null}

      {canManageOthers && (!showTeamWorkspace || teamLeadMainTab === "DAY") && dailyViewTab === "LIVE" && (() => {
        const activeCount = liveStatusArray.filter(e => e.status === "ACTIVE").length;
        const awayCount = liveStatusArray.filter(e => e.status === "AWAY").length;
        const offlineCount = liveStatusArray.filter(e => e.status === "OFFLINE").length;

        const filteredEmployees = liveStatusFilter === "ALL"
          ? liveStatusArray
          : liveStatusArray.filter(e => e.status === liveStatusFilter);

        const searchedEmployees = filteredEmployees.filter(e => {
          const query = liveSearchQuery.trim().toLowerCase();
          if (!query) return true;
          const fullName = `${e.firstName} ${e.lastName}`.toLowerCase();
          const code = e.employeeCode.toLowerCase();
          return fullName.includes(query) || code.includes(query);
        });

        // Sort: Active first, then Away, then Offline
        const sortedEmployees = [...searchedEmployees].sort((a, b) => {
          const order = { ACTIVE: 0, AWAY: 1, OFFLINE: 2 };
          return (order[a.status] ?? 3) - (order[b.status] ?? 3);
        });

        return (
        <div className="card live-status-card">
          <div className="live-status-header">
            <div className="live-status-title-stack">
              <div className="live-status-indicator-glow" />
              <h3 style={{ margin: 0 }}>Workforce Live Status</h3>
            </div>
            <span className="live-status-time">Real-time telemetry</span>
          </div>

          {/* Search bar */}
          <div className="live-search-wrapper">
            <div className="live-search-box">
              <Search className="search-icon" />
              <input
                type="text"
                placeholder="Search by employee name or code..."
                value={liveSearchQuery}
                onChange={(e) => setLiveSearchQuery(e.target.value)}
              />
              {liveSearchQuery && (
                <button
                  type="button"
                  className="live-search-clear"
                  onClick={() => setLiveSearchQuery("")}
                  title="Clear search"
                >
                  ✕
                </button>
              )}
            </div>
          </div>

          {/* Filter tabs */}
          <div className="live-filter-tabs">
            {(["ALL", "ACTIVE", "AWAY", "OFFLINE"] as const).map((filter) => {
              const count = filter === "ALL" ? liveStatusArray.length
                : filter === "ACTIVE" ? activeCount
                : filter === "AWAY" ? awayCount : offlineCount;
              return (
                <button
                  key={filter}
                  type="button"
                  className={`live-filter-tab ${liveStatusFilter === filter ? `live-filter-tab--active live-filter-tab--${filter.toLowerCase()}` : ""}`.trim()}
                  onClick={() => setLiveStatusFilter(filter)}
                >
                  {filter === "ALL" ? "All" : filter.charAt(0) + filter.slice(1).toLowerCase()}
                  <span className="live-filter-tab__count">{count}</span>
                </button>
              );
            })}
          </div>

          {/* Compact employee list */}
          <div className="live-compact-list">
            {sortedEmployees.length === 0 ? (
              <div className="live-status-empty">
                <span className="muted">No employees in this category</span>
              </div>
            ) : (
              sortedEmployees.map((emp) => {
                const isActive = emp.status === "ACTIVE";
                const isAway = emp.status === "AWAY";
                const statusClass = isActive ? "active" : isAway ? "away" : "offline";
                const statusLabel = isActive ? "Active" : isAway ? "Away" : "Offline";
                const hasCheckIn = !!emp.checkInTime;
                const isDesktopConnected = !!(emp.lastDesktopActive && (Date.now() - new Date(emp.lastDesktopActive).getTime() < 90000));

                return (
                  <div key={emp.employeeId} className={`live-row live-row--${statusClass}`}>
                    <div className="live-row__left">
                      <div className="live-avatar-wrapper">
                        <div className="live-avatar-initials">
                          {emp.firstName.charAt(0)}{emp.lastName.charAt(0)}
                        </div>
                        <span className={`live-badge live-badge--${statusClass}`} />
                      </div>
                      <div className="live-row__identity">
                        <span className="live-name">
                          {emp.firstName} {emp.lastName}
                          {isDesktopConnected && (
                            <span 
                              className="live-desktop-active-icon" 
                              title="Desktop Agent Connected & Online" 
                              style={{ marginLeft: '6px', fontSize: '13px', display: 'inline-flex', verticalAlign: 'middle', cursor: 'help' }}
                              role="img"
                              aria-label="Desktop Agent Connected"
                            >
                              💻
                            </span>
                          )}
                        </span>
                        <span className="live-code">#{emp.employeeCode}</span>
                      </div>
                    </div>
                    <div className="live-row__center">
                      <span className={`live-status-chip live-status-chip--${statusClass}`}>
                        <span className={`live-status-chip__dot live-status-chip__dot--${statusClass}`} />
                        {statusLabel}
                      </span>
                    </div>
                    <div className="live-row__meta">
                      <div className="live-row__meta-item">
                        <span className="label">Check-in</span>
                        <span className="value">{emp.checkInTime ? formatAttendanceTime(emp.checkInTime) : "—"}</span>
                      </div>
                      {(isAway || !isActive) && emp.lastEventTime && (
                        <div className="live-row__meta-item">
                          <span className="label">Last Event</span>
                          <span className="value font-mono">
                            {emp.lastEvent?.replace("_", " ") || "—"} · {new Date(emp.lastEventTime).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true })}
                          </span>
                        </div>
                      )}
                    </div>
                    <div className="live-row__action">
                      <button
                        type="button"
                        className="live-timeline-btn"
                        disabled={!hasCheckIn || loadingTimelineEmpId !== null}
                        onClick={() => handleViewTimeline(emp.employeeId)}
                      >
                        {loadingTimelineEmpId === emp.employeeId ? "Loading..." : "Timeline"}
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
        );
      })()}

      {(!showTeamWorkspace || teamLeadMainTab === "DAY") && (!canManageOthers || dailyViewTab === "HISTORY") ? (
        <div className="card dense-table-card attendance-table-card">
          <div className="stack">
            <div className="attendance-history-header">
              <div>
                <h3>Attendance history</h3>
                <p className="muted">
                  {showTeamWorkspace
                    ? "Track your own attendance entries and manage your correction requests."
                    : "Track attendance entries, mark today, and manage correction requests from one workspace."}
                </p>
              </div>
              <div className="button-row row-actions">
                {(role === "ADMIN" || role === "HR") ? (
                  <>
                    <button
                      type="button"
                      className="secondary attendance-header-action"
                      onClick={() => navigate("/attendance/requests")}
                      style={{ position: 'relative' }}
                    >
                      Correction Requests
                      {visibleRegularizations.filter(r => r.status === "PENDING").length > 0 && (
                        <span className="notification-dot" style={{ position: 'absolute', top: '-4px', right: '-4px' }}></span>
                      )}
                    </button>
                    
                    <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
                      <select
                        className="attendance-date-input"
                        style={{ minWidth: "160px", cursor: "pointer", height: '42px', minHeight: '42px', borderRadius: '999px', padding: '0 24px 0 16px', border: '1px solid rgba(15, 23, 42, 0.08)', background: 'linear-gradient(180deg, rgba(255, 255, 255, 0.98), #f7fbff)', color: 'var(--color-text-strong)', fontWeight: 'var(--fw-semibold)', fontSize: 'var(--text-sm)' }}
                        value={`${downloadMonth}-${downloadYear}`}
                        onChange={(e) => {
                          const [m, y] = e.target.value.split("-").map(Number);
                          setDownloadMonth(m);
                          setDownloadYear(y);
                        }}
                      >
                        {monthOptions.map((opt) => (
                          <option key={opt.value} value={opt.value}>
                            {opt.label}
                          </option>
                        ))}
                      </select>

                      <select
                        className="attendance-date-input"
                        style={{ minWidth: "160px", cursor: "pointer", height: '42px', minHeight: '42px', borderRadius: '999px', padding: '0 24px 0 16px', border: '1px solid rgba(15, 23, 42, 0.08)', background: 'linear-gradient(180deg, rgba(255, 255, 255, 0.98), #f7fbff)', color: 'var(--color-text-strong)', fontWeight: 'var(--fw-semibold)', fontSize: 'var(--text-sm)' }}
                        value={downloadType}
                        onChange={(e) => setDownloadType(e.target.value as "general" | "employee")}
                      >
                        <option value="general">General Monthly</option>
                        <option value="employee">Employee-wise</option>
                      </select>

                      <button
                        type="button"
                        className="secondary attendance-header-action"
                        style={{ minHeight: '42px', display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                        onClick={handleDownloadOfflineSheet}
                        disabled={exporting}
                      >
                        {exporting ? "Downloading..." : "Download Report"}
                      </button>
                    </div>
                  </>
                ) : (
                  <div className="button-row">
                    {showPaidOvertimeRequestBtn && (
                      <button
                        className="secondary attendance-header-action"
                        onClick={() => setOvertimePreApprovalOpen(true)}
                        style={{
                          borderColor: 'rgba(124, 58, 237, 0.4)',
                          color: '#6d28d9',
                          background: 'rgba(124, 58, 237, 0.05)',
                          fontWeight: 'bold'
                        }}
                      >
                        Request Paid Overtime
                      </button>
                    )}
                    <button className="secondary attendance-header-action" onClick={() => setRegularizationOpen(true)}>
                      Request correction
                    </button>
                    <button className="secondary attendance-header-action" onClick={() => navigate("/attendance/requests")}>
                      View requests
                    </button>
                  </div>
                )}
                {canFinalizeAttendance ? (
                  <button className="secondary attendance-header-action" onClick={() => setFinalizeConfirmOpen(true)}>
                    Finalize selected day
                  </button>
                ) : null}
              </div>
            </div>
            <div className="attendance-toolbar">
              <div className="attendance-history-filters" style={{ display: "flex", alignItems: "flex-end", flexWrap: "wrap", gap: "var(--space-4)" }}>
                {/* Date Picker (Day Mode) */}
                <label className="attendance-filter-field attendance-filter-field--date">
                  Date
                  <div className="attendance-date-picker">
                    <button
                      type="button"
                      className={`attendance-date-input attendance-date-trigger ${filterMode === "DAY" ? "attendance-date-trigger--active" : ""}`}
                      onClick={() => setDatePickerOpen((current) => !current)}
                    >
                      <span>{filterMode === "DAY" ? formatDateLabel(filterDate) : "Select Day..."}</span>
                      <ChevronDown size={16} className="attendance-date-chevron" />
                    </button>
                    {datePickerOpen ? (
                      <div className="attendance-date-popover">
                        <div className="attendance-date-popover__header">
                          <button
                            type="button"
                            className="secondary attendance-date-popover__nav"
                            onClick={() =>
                              setVisibleMonth((current) => {
                                const previousMonth = new Date(current.year, current.month - 1, 1);
                                return {
                                  month: previousMonth.getMonth(),
                                  year: previousMonth.getFullYear(),
                                };
                              })
                            }
                          >
                            Prev
                          </button>
                          <strong>{currentMonthLabel}</strong>
                          <button
                            type="button"
                            className="secondary attendance-date-popover__nav"
                            onClick={() =>
                              setVisibleMonth((current) => {
                                const nextMonth = new Date(current.year, current.month + 1, 1);
                                return {
                                  month: nextMonth.getMonth(),
                                  year: nextMonth.getFullYear(),
                                };
                              })
                            }
                          >
                            Next
                          </button>
                        </div>
                        <div className="attendance-date-popover__weekdays">
                          {["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"].map((label) => (
                            <span key={label}>{label}</span>
                          ))}
                        </div>
                        <div className="attendance-date-popover__grid">
                          {calendarDays.map((day) => {
                            const isoDate = toLocalDateString(day.value);
                            const isSelected = isoDate === filterDate && filterMode === "DAY";
                            const isFuture = isoDate > today;

                            return (
                              <button
                                key={day.key}
                                type="button"
                                className={`attendance-date-popover__day ${!day.inCurrentMonth ? "attendance-date-popover__day--muted" : ""} ${isSelected ? "attendance-date-popover__day--selected" : ""}`.trim()}
                                disabled={isFuture}
                                onClick={() => {
                                  setFilterDate(isoDate);
                                  setFilterMode("DAY");
                                  setDatePickerOpen(false);
                                }}
                              >
                                {day.value.getDate()}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    ) : null}
                  </div>
                </label>

                {/* Yesterday Shortcut */}
                <button
                  type="button"
                  className="secondary shortcut-btn"
                  onClick={() => {
                    setFilterDate(yesterdayDateStr);
                    setFilterMode("DAY");
                  }}
                >
                  Yesterday
                </button>

                {/* View by Month Dropdown */}
                {role === "EMPLOYEE" && (
                  <label className="attendance-filter-field">
                    View by Month
                    <div className="attendance-date-picker" style={{ position: "relative", display: "inline-block" }}>
                      <select
                        className={`attendance-date-input attendance-date-trigger ${filterMode === "MONTH" ? "attendance-date-trigger--active" : ""}`}
                        style={{ minWidth: "160px", cursor: "pointer", paddingRight: "36px", appearance: "none", WebkitAppearance: "none", MozAppearance: "none" }}
                        value={filterMode === "MONTH" ? `${filterMonth}-${filterYear}` : ""}
                        onChange={(e) => {
                          if (e.target.value === "") {
                            setFilterMode("DAY");
                          } else {
                            const [m, y] = e.target.value.split("-").map(Number);
                            setFilterMonth(m);
                            setFilterYear(y);
                            setFilterMode("MONTH");
                          }
                        }}
                      >
                        <option value="">Select Month</option>
                        {monthOptions.map((opt) => (
                          <option key={opt.value} value={opt.value}>
                            {opt.label}
                          </option>
                        ))}
                      </select>
                      <ChevronDown size={16} className="attendance-date-chevron" style={{ position: "absolute", right: "12px", top: "50%", transform: "translateY(-50%)", pointerEvents: "none", color: "#64748b" }} />
                    </div>
                  </label>
                )}
              </div>
              {showAttendanceOverviewFilters ? (
                <div className="attendance-overview-row">
                  <button
                    type="button"
                    className={`attendance-overview-chip attendance-overview-chip--present ${activeOverviewFilter === "PRESENT" ? "attendance-overview-chip--active" : ""}`.trim()}
                    onClick={() => setFilterStatus((current) => (current === "PRESENT" || current === "HALF_DAY" ? "" : "PRESENT"))}
                  >
                    <span className="attendance-overview-chip__label">Present</span>
                    <strong className="attendance-overview-chip__value">
                      {attendanceOverview.present}/{totalWorkforceCount}
                    </strong>
                  </button>
                  <button
                    type="button"
                    className={`attendance-overview-chip attendance-overview-chip--absent ${activeOverviewFilter === "ABSENT" ? "attendance-overview-chip--active" : ""}`.trim()}
                    onClick={() => setFilterStatus((current) => (current === "ABSENT" ? "" : "ABSENT"))}
                  >
                    <span className="attendance-overview-chip__label">Absent</span>
                    <strong className="attendance-overview-chip__value">{attendanceOverview.absent}</strong>
                  </button>
                  <button
                    type="button"
                    className={`attendance-overview-chip attendance-overview-chip--leave ${activeOverviewFilter === "LEAVE" ? "attendance-overview-chip--active" : ""}`.trim()}
                    onClick={() => setFilterStatus((current) => (current === "LEAVE" ? "" : "LEAVE"))}
                  >
                    <span className="attendance-overview-chip__label">On leave</span>
                    <strong className="attendance-overview-chip__value">{attendanceOverview.leave}</strong>
                  </button>
                  <button
                    type="button"
                    className={`attendance-overview-chip attendance-overview-chip--unmarked ${activeOverviewFilter === "UNMARKED" ? "attendance-overview-chip--active" : ""}`.trim()}
                    onClick={() => setFilterStatus((current) => (current === "UNMARKED" ? "" : "UNMARKED"))}
                  >
                    <span className="attendance-overview-chip__label">Unmarked</span>
                    <strong className="attendance-overview-chip__value">{unmarkedCount}</strong>
                  </button>
                </div>
              ) : null}
            </div>
          </div>
          {loading ? (
            <div className="page-loading">
              <span className="skeleton-line skeleton-line--title" />
              <span className="skeleton-line skeleton-line--long" />
              <span className="skeleton-line skeleton-line--long" />
              <span className="skeleton-line skeleton-line--long" />
            </div>
          ) : (
            <Table
              compact
              columns={columns}
              onRowClick={(index) => {
                const record = attendanceRows[index];
                if (record?.employee) {
                  navigate(`/employees/${record.employee.id}?tab=attendance`);
                }
              }}
              rows={attendanceRows.map((record) => {
                const latenessLabel = getLatenessBreakdown(record);
                const cells = [
                  <div className="table-cell-stack" key={`date-${record.id}`}>
                    <span className="table-cell-primary">{isToday(record.attendanceDate) ? "Today" : formatDateLabel(record.attendanceDate)}</span>
                    <span className="table-cell-secondary">
                      {isToday(record.attendanceDate) ? formatDateLabel(record.attendanceDate) : formatWeekday(record.attendanceDate)}
                    </span>
                  </div>,
                  formatAttendanceTime(record.checkInTime),
                  formatAttendanceTime(record.checkOutTime),
                  latenessLabel ? (
                    <span key={`late-${record.id}`} style={{
                      fontWeight: '600',
                      color: '#b45309',
                      background: 'rgba(245, 158, 11, 0.1)',
                      border: '1px solid rgba(245, 158, 11, 0.2)',
                      borderRadius: '6px',
                      padding: '2px 8px',
                      fontSize: '12px',
                      display: 'inline-block',
                      whiteSpace: 'nowrap'
                    }}>
                      {latenessLabel}
                    </span>
                  ) : (
                    <span key={`late-${record.id}`} className="muted">—</span>
                  ),
                  renderWorkedDuration(record),
                  renderOvertime(record),
                  <span 
                    key={`update-${record.id}`} 
                    className="muted" 
                    style={{ 
                      fontSize: '12px', 
                      maxWidth: '180px', 
                      display: 'block', 
                      overflow: 'hidden', 
                      textOverflow: 'ellipsis', 
                      whiteSpace: 'nowrap',
                      cursor: record.todaysUpdate ? 'pointer' : 'default',
                      textDecoration: record.todaysUpdate ? 'underline' : 'none',
                      textDecorationStyle: 'dotted'
                    }} 
                    title={record.todaysUpdate ? "Click to view full update" : ""}
                    onClick={(e) => {
                      if (record.todaysUpdate) {
                        e.stopPropagation();
                        setSelectedUpdate(record.todaysUpdate);
                      }
                    }}
                  >
                    {record.todaysUpdate || "-"}
                  </span>,
                  <div className="table-cell-stack" key={`status-${record.id}`}>
                    <span className={getStatusClass(record.status)}>{getStatusLabel(record)}</span>
                  </div>,
                ];

                if (showEmployeeColumn) {
                  cells.unshift(
                    <div className="table-cell-stack attendance-person-cell" key={`employee-${record.id}`}>
                      <span className="table-cell-primary">
                        {record.employee ? `${record.employee.firstName} ${record.employee.lastName}` : "Unknown employee"}
                      </span>
                      <span className="table-cell-secondary attendance-person-cell__code">{record.employee?.employeeCode ?? "-"}</span>
                    </div>,
                  );
                }

                return cells;
              })}
            />
          )}
        </div>
      ) : null}

      {showTeamWorkspace && teamLeadMainTab === "MONTH" ? (
        <div className="card dense-table-card attendance-table-card">
          <div className="attendance-history-header">
            <div>
              <h3>Monthly attendance summary</h3>
              <p className="muted">Month-wise rollup of your attendance records.</p>
            </div>
          </div>
          <Table
            compact
            columns={["Month", "Present", "Half day", "Absent", "Leave", "Total records"]}
            rows={monthlySummaryRows.map((row) => [
              `${formatInTimeZone(new Date(row.year, row.month - 1, 1), 'Asia/Kolkata', 'MMMM yyyy')}`,
              String(row.present),
              String(row.halfDay),
              String(row.absent),
              String(row.leave),
              String(row.total),
            ])}
            emptyState={{
              title: "No monthly attendance data",
              description: "Attendance records will appear here once available.",
            }}
          />
        </div>
      ) : null}



      <Modal open={regularizationOpen} title="Request attendance correction" onClose={() => setRegularizationOpen(false)}>
        <div className="stack regularization-form">
          <label>
            Date
            <div className="time-input-container">
              <Calendar size={16} className="time-input-icon" />
              <input
                type="date"
                className="regularization-time-input"
                min={joiningDateFormatted}
                max={today}
                value={regularizationForm.attendanceDate}
                onChange={(event) => setRegularizationForm((current) => ({ ...current, attendanceDate: event.target.value }))}
              />
            </div>
          </label>
          <div className="regularization-time-grid">
            <label>
              Proposed check in
              <div className="time-input-container time-input-container--checkin" style={{ position: 'relative' }}>
                <Clock
                  size={16}
                  className="time-input-icon time-input-icon--clickable"
                  onClick={() => setShowCheckInDropdown((prev) => !prev)}
                />
                <input
                  type="text"
                  className="regularization-time-input"
                  placeholder="e.g. 09:00"
                  value={checkInTime}
                  onChange={(event) => {
                    const input = event.target;
                    const oldVal = checkInTime;
                    const newVal = formatTimeInput(input.value, oldVal);
                    
                    let newCursorPos = input.selectionStart || 0;
                    if (input.value.length > oldVal.length) {
                      let start = 0;
                      while (start < oldVal.length && input.value[start] === oldVal[start]) {
                        start++;
                      }
                      newCursorPos = start + 1;
                      if (newCursorPos === 2) {
                        newCursorPos = 3;
                      }
                    } else if (input.value.length < oldVal.length) {
                      let start = 0;
                      while (start < input.value.length && input.value[start] === oldVal[start]) {
                        start++;
                      }
                      const nDeleted = oldVal.length - input.value.length;
                      if (nDeleted === 1 && start === 2) {
                        newCursorPos = 1;
                      } else {
                        newCursorPos = start;
                      }
                    }
                    
                    setCheckInTime(newVal);
                    requestAnimationFrame(() => {
                      try {
                        input.setSelectionRange(newCursorPos, newCursorPos);
                      } catch (e) {}
                    });
                  }}
                />
                <select
                  value={checkInAmPm}
                  onChange={(event) => setCheckInAmPm(event.target.value)}
                  style={{
                    border: 'none',
                    background: 'transparent',
                    color: 'var(--color-text-strong)',
                    fontWeight: '700',
                    fontSize: '13px',
                    cursor: 'pointer',
                    outline: 'none',
                    padding: '0 8px 0 0',
                    width: 'auto',
                    minHeight: 'auto',
                    backgroundImage: 'none',
                    appearance: 'auto'
                  }}
                >
                  <option value="AM">AM</option>
                  <option value="PM">PM</option>
                </select>

                {showCheckInDropdown && (
                  <div className="time-picker-popover">
                    <div className="time-picker-columns">
                      <div className="time-picker-column">
                        <div className="time-picker-column-header">Hour</div>
                        <div className="time-picker-options-scroll">
                          {Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, "0")).map((hr) => {
                            const [currentHour] = checkInTime.split(":");
                            const isSelected = currentHour === hr;
                            return (
                              <button
                                key={hr}
                                type="button"
                                className={`time-picker-option ${isSelected ? "time-picker-option--active" : ""}`}
                                onClick={() => handleTimeSelect("checkin", "hour", hr)}
                              >
                                {hr}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                      <div className="time-picker-column">
                        <div className="time-picker-column-header">Min</div>
                        <div className="time-picker-options-scroll">
                          {Array.from({ length: 60 }, (_, i) => String(i).padStart(2, "0")).map((min) => {
                            const [, currentMin] = checkInTime.split(":");
                            const isSelected = currentMin === min;
                            return (
                              <button
                                key={min}
                                type="button"
                                className={`time-picker-option ${isSelected ? "time-picker-option--active" : ""}`}
                                onClick={() => handleTimeSelect("checkin", "minute", min)}
                              >
                                {min}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                      <div className="time-picker-column">
                        <div className="time-picker-column-header">Period</div>
                        <div className="time-picker-options-scroll">
                          {["AM", "PM"].map((period) => {
                            const isSelected = checkInAmPm === period;
                            return (
                              <button
                                key={period}
                                type="button"
                                className={`time-picker-option ${isSelected ? "time-picker-option--active" : ""}`}
                                onClick={() => handleTimeSelect("checkin", "ampm", period)}
                              >
                                {period}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    </div>
                    <div className="time-picker-footer">
                      <button
                        type="button"
                        className="time-picker-done-btn"
                        onClick={() => setShowCheckInDropdown(false)}
                      >
                        Done
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </label>
            <label>
              Proposed check out
              <div className="time-input-container time-input-container--checkout" style={{ position: 'relative' }}>
                <Clock
                  size={16}
                  className="time-input-icon time-input-icon--clickable"
                  onClick={() => setShowCheckOutDropdown((prev) => !prev)}
                />
                <input
                  type="text"
                  className="regularization-time-input"
                  placeholder="e.g. 06:00"
                  value={checkOutTime}
                  onChange={(event) => {
                    const input = event.target;
                    const oldVal = checkOutTime;
                    const newVal = formatTimeInput(input.value, oldVal);
                    
                    let newCursorPos = input.selectionStart || 0;
                    if (input.value.length > oldVal.length) {
                      let start = 0;
                      while (start < oldVal.length && input.value[start] === oldVal[start]) {
                        start++;
                      }
                      newCursorPos = start + 1;
                      if (newCursorPos === 2) {
                        newCursorPos = 3;
                      }
                    } else if (input.value.length < oldVal.length) {
                      let start = 0;
                      while (start < input.value.length && input.value[start] === oldVal[start]) {
                        start++;
                      }
                      const nDeleted = oldVal.length - input.value.length;
                      if (nDeleted === 1 && start === 2) {
                        newCursorPos = 1;
                      } else {
                        newCursorPos = start;
                      }
                    }
                    
                    setCheckOutTime(newVal);
                    requestAnimationFrame(() => {
                      try {
                        input.setSelectionRange(newCursorPos, newCursorPos);
                      } catch (e) {}
                    });
                  }}
                />
                <select
                  value={checkOutAmPm}
                  onChange={(event) => setCheckOutAmPm(event.target.value)}
                  style={{
                    border: 'none',
                    background: 'transparent',
                    color: 'var(--color-text-strong)',
                    fontWeight: '700',
                    fontSize: '13px',
                    cursor: 'pointer',
                    outline: 'none',
                    padding: '0 8px 0 0',
                    width: 'auto',
                    minHeight: 'auto',
                    backgroundImage: 'none',
                    appearance: 'auto'
                  }}
                >
                  <option value="AM">AM</option>
                  <option value="PM">PM</option>
                </select>

                {showCheckOutDropdown && (
                  <div className="time-picker-popover">
                    <div className="time-picker-columns">
                      <div className="time-picker-column">
                        <div className="time-picker-column-header">Hour</div>
                        <div className="time-picker-options-scroll">
                          {Array.from({ length: 12 }, (_, i) => String(i + 1).padStart(2, "0")).map((hr) => {
                            const [currentHour] = checkOutTime.split(":");
                            const isSelected = currentHour === hr;
                            return (
                              <button
                                key={hr}
                                type="button"
                                className={`time-picker-option ${isSelected ? "time-picker-option--active" : ""}`}
                                onClick={() => handleTimeSelect("checkout", "hour", hr)}
                              >
                                {hr}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                      <div className="time-picker-column">
                        <div className="time-picker-column-header">Min</div>
                        <div className="time-picker-options-scroll">
                          {Array.from({ length: 60 }, (_, i) => String(i).padStart(2, "0")).map((min) => {
                            const [, currentMin] = checkOutTime.split(":");
                            const isSelected = currentMin === min;
                            return (
                              <button
                                key={min}
                                type="button"
                                className={`time-picker-option ${isSelected ? "time-picker-option--active" : ""}`}
                                onClick={() => handleTimeSelect("checkout", "minute", min)}
                              >
                                {min}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                      <div className="time-picker-column">
                        <div className="time-picker-column-header">Period</div>
                        <div className="time-picker-options-scroll">
                          {["AM", "PM"].map((period) => {
                            const isSelected = checkOutAmPm === period;
                            return (
                              <button
                                key={period}
                                type="button"
                                className={`time-picker-option ${isSelected ? "time-picker-option--active" : ""}`}
                                onClick={() => handleTimeSelect("checkout", "ampm", period)}
                              >
                                {period}
                              </button>
                            );
                          })}
                        </div>
                      </div>
                    </div>
                    <div className="time-picker-footer">
                      <button
                        type="button"
                        className="time-picker-done-btn"
                        onClick={() => setShowCheckOutDropdown(false)}
                      >
                        Done
                      </button>
                    </div>
                  </div>
                )}
              </div>
            </label>
          </div>
          <label>
            Reason
            <textarea
              rows={4}
              value={regularizationForm.reason}
              onChange={(event) => setRegularizationForm((current) => ({ ...current, reason: event.target.value }))}
              placeholder="Why should this attendance entry be corrected?"
            />
          </label>
          <div className="button-row">
            <button onClick={handleRegularizationSubmit} disabled={submittingRegularization}>
              {submittingRegularization ? "Submitting..." : "Submit request"}
            </button>
            <button className="secondary" onClick={() => setRegularizationOpen(false)}>
              Close
            </button>
          </div>
        </div>
      </Modal>

      <Modal open={overtimePreApprovalOpen} title="Request Paid Overtime Approval" onClose={() => setOvertimePreApprovalOpen(false)}>
        <div className="stack regularization-form">
          <p className="muted" style={{ fontSize: '13px', marginBottom: '8px' }}>
            Submit an overtime pre-approval request before 5:00 PM. Once approved by a Manager, HR, or Admin, your overtime will be classified as <strong>Paid Overtime</strong>.
          </p>
          <label>
            Reason for Overtime
            <textarea
              rows={4}
              value={overtimeReason}
              onChange={(event) => setOvertimeReason(event.target.value)}
              placeholder="Please provide the business justification or task list for this paid overtime..."
              required
            />
          </label>
          <div className="button-row">
            <button 
              onClick={handleOvertimePreApprovalSubmit} 
              disabled={submittingOvertime || !overtimeReason.trim()}
              style={{
                background: 'var(--color-primary, #6d28d9)',
                color: 'white'
              }}
            >
              {submittingOvertime ? "Submitting..." : "Submit Pre-Approval Request"}
            </button>
            <button className="secondary" onClick={() => setOvertimePreApprovalOpen(false)}>
              Close
            </button>
          </div>
        </div>
      </Modal>

      <Modal open={finalizeConfirmOpen} title="Finalize attendance" onClose={() => setFinalizeConfirmOpen(false)}>
        <div className="stack regularization-form">
          <p className="muted">
            Finalizing this date will mark all unrecorded working-day employees absent for the selected day.
          </p>
          <div className="button-row">
            <button
              type="button"
              className="secondary"
              onClick={() => setFinalizeConfirmOpen(false)}
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={() => {
                setFinalizeConfirmOpen(false);
                void handleFinalizeAttendance();
              }}
            >
              Finalize selected day
            </button>
          </div>
        </div>
      </Modal>

      <Modal open={!!selectedUpdate} title="Today's update" onClose={() => setSelectedUpdate(null)}>
        <div className="stack" style={{ padding: '4px 0' }}>
          <p style={{ 
            fontSize: '15px', 
            lineHeight: '1.6', 
            color: 'var(--color-text-default)',
            whiteSpace: 'pre-wrap',
            wordBreak: 'break-word'
          }}>
            {selectedUpdate}
          </p>
          <div className="button-row" style={{ marginTop: '16px', justifyContent: 'flex-end' }}>
            <button className="secondary" onClick={() => setSelectedUpdate(null)}>
              Close
            </button>
          </div>
        </div>
      </Modal>

      <Modal 
        open={!!selectedTimelineItem} 
        title={(() => {
          if (!selectedTimelineItem) return "Workday Timeline";
          const emp = selectedTimelineItem.record.employee || (selectedTimelineItem.record.employeeId === currentEmployeeId ? currentEmployee : null);
          const empName = emp ? `${emp.firstName} ${emp.lastName}` : "";
          const dateLabel = formatDateLabel(selectedTimelineItem.date);
          return empName ? `${empName} - Workday Timeline (${dateLabel})` : `Workday Timeline - ${dateLabel}`;
        })()}
        onClose={() => setSelectedTimelineItem(null)}
        className="timeline-modal"
      >
        {selectedTimelineItem && (
          <div className="stack" style={{ padding: '8px 0', gap: '16px' }}>
            <WorkdayTimeline
              employeeId={selectedTimelineItem.record.employeeId}
              token={token}
              startTime={selectedTimelineItem.record.employee?.shift?.startTime}
              endTime={selectedTimelineItem.record.employee?.shift?.endTime}
              lateThreshold={selectedTimelineItem.record.employee?.shift ? addMinutesToTime(selectedTimelineItem.record.employee.shift.startTime, selectedTimelineItem.record.employee.shift.gracePeriodMinutes) : undefined}
              checkInTime={selectedTimelineItem.record.checkInTime}
              checkOutTime={selectedTimelineItem.record.checkOutTime}
              workedMinutes={selectedTimelineItem.record.workedMinutes}
              penaltyMinutes={selectedTimelineItem.record.penaltyMinutes}
              customBreakSessions={selectedTimelineItem.record.breakSessions || []}
              dateContext={selectedTimelineItem.date}
              className="wdt-flat"
            />
            <div className="button-row" style={{ marginTop: '12px', justifyContent: 'flex-end' }}>
              <button className="secondary" onClick={() => setSelectedTimelineItem(null)}>
                Close
              </button>
            </div>
          </div>
        )}
      </Modal>

    </section>
  );
}
