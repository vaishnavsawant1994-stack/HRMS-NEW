import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { ChevronDown, ChevronUp, CheckCircle, Lock, Unlock, Moon, Sun, Power, LogOut, Coffee, Utensils } from 'lucide-react';
import { apiRequest } from '../../services/api';
import { isToday, formatAttendanceTime, toZonedTime } from '../../utils/format';
import './WorkdayTimeline.css';
import type { BreakSession, DesktopActivityLog } from '../../types';

interface WorkdayTimelineProps {
  employeeId?: number;
  startTime?: string;
  endTime?: string;
  lateThreshold?: string;
  checkInTime?: string | Date | null;
  checkOutTime?: string | Date | null;
  workedMinutes?: number | null;
  penaltyMinutes?: number | null;
  token?: string | null;
  customBreakSessions?: BreakSession[];
  dateContext?: string;
  className?: string;
}

const BREAK_SCHEDULE_DATA = [
  { label: 'Morning Tea Break', start: '10:45', end: '11:00', display: '10:45 AM – 11:00 AM' },
  { label: 'Lunch', start: '13:00', end: '13:40', display: '1:00 PM – 1:40 PM' },
  { label: 'Evening Tea Break', start: '16:10', end: '16:30', display: '4:10 PM – 4:30 PM' },
];

function format12h(timeStr: string): string {
  if (!timeStr) return '';
  const [h, m] = timeStr.split(':').map(Number);
  const period = h >= 12 ? 'PM' : 'AM';
  const displayH = h % 12 || 12;
  return `${displayH}:${m.toString().padStart(2, '0')} ${period}`;
}

interface ScheduledBreak {
  isBreak: boolean;
  type: "Morning Tea Break" | "Lunch Break" | "Evening Tea Break" | "Dinner Break" | null;
}

// Wide flexible break windows — matches the backend Quota-Based classification.
// Morning Tea : 09:30 – 12:00  (min 10 min to qualify)
// Lunch       : 12:00 – 15:00  (min 20 min to qualify)
// Evening Tea : 15:00 – 18:00  (min 10 min to qualify)
// Dinner      : 19:00 – 23:00  (min 20 min to qualify)
const BREAK_MIN_QUALIFY: Record<string, number> = {
  'Morning Tea Break': 10,
  'Lunch Break': 20,
  'Evening Tea Break': 10,
  'Dinner Break': 20,
};

const getScheduledBreakInfo = (dateInput: Date | string): ScheduledBreak => {
  const date = toZonedTime(new Date(dateInput), 'Asia/Kolkata');
  const totalMins = date.getHours() * 60 + date.getMinutes();

  // Morning Tea: 9:30 AM – 12:00 PM
  if (totalMins >= 9 * 60 + 30 && totalMins < 12 * 60) {
    return { isBreak: true, type: 'Morning Tea Break' };
  }
  // Lunch: 12:00 PM – 3:00 PM
  if (totalMins >= 12 * 60 && totalMins < 15 * 60) {
    return { isBreak: true, type: 'Lunch Break' };
  }
  // Evening Tea: 3:00 PM – 6:00 PM
  if (totalMins >= 15 * 60 && totalMins < 18 * 60) {
    return { isBreak: true, type: 'Evening Tea Break' };
  }
  // Dinner: 7:00 PM – 11:00 PM
  if (totalMins >= 19 * 60 && totalMins < 23 * 60) {
    return { isBreak: true, type: 'Dinner Break' };
  }

  return { isBreak: false, type: null };
};



const WorkdayTimeline: React.FC<WorkdayTimelineProps> = ({
  employeeId,
  startTime = "09:00",
  endTime = "18:00",
  lateThreshold = "09:00",
  checkInTime = null,
  checkOutTime = null,
  workedMinutes = null,
  penaltyMinutes = null,
  token = null,
  customBreakSessions,
  dateContext,
  className = '',
}) => {
  const [isExpanded, setIsExpanded] = useState(false);
  const [progress, setProgress] = useState(0);
  const [checkInPct, setCheckInPct] = useState<number | null>(null);
  const [checkInLabel, setCheckInLabel] = useState<string>('');
  const [checkOutPct, setCheckOutPct] = useState<number | null>(null);
  const [checkOutLabel, setCheckOutLabel] = useState<string>('');
  const [workedTime, setWorkedTime] = useState<{ hours: number; minutes: number } | null>(null);
  const [elapsedTime, setElapsedTime] = useState<{ hours: number; minutes: number } | null>(null);
  const [isShiftOver, setIsShiftOver] = useState(false);
  const [isShiftPending, setIsShiftPending] = useState(false);
  const [checkInIsLate, setCheckInIsLate] = useState(false);
  const [breakSessions, setBreakSessions] = useState<BreakSession[]>([]);

  const [desktopLogs, setDesktopLogs] = useState<DesktopActivityLog[]>([]);
  const [lastDesktopActive, setLastDesktopActive] = useState<string | null>(null);

  // Hover Tooltip State
  const [hoverText, setHoverText] = useState<string | null>(null);
  const [hoverPos, setHoverPos] = useState<number>(0);

  const loadBreaks = useCallback(async () => {
    if (!token) return;
    try {
      const res = await apiRequest<{ breakSessions: BreakSession[] }>('/attendance/break/today', { token });
      setBreakSessions(res.data?.breakSessions ?? []);
    } catch { /* ignore */ }
  }, [token]);

  const loadDesktopLogs = useCallback(async () => {
    if (!token) return;
    try {
      const qs = new URLSearchParams();
      if (employeeId) qs.append('employeeId', employeeId.toString());
      if (dateContext) qs.append('date', dateContext);
      
      const endpoint = `/attendance/desktop-activity-log?${qs.toString()}`;
      const res = await apiRequest<{ events: DesktopActivityLog[], lastDesktopActive: string | null }>(endpoint, { token: token || undefined });
      setDesktopLogs(res.data?.events ?? []);
      setLastDesktopActive(res.data?.lastDesktopActive ?? null);
    } catch { /* ignore */ }
  }, [employeeId, dateContext, token]);

  useEffect(() => {
    loadDesktopLogs();
  }, [loadDesktopLogs]);

  useEffect(() => {
    if (customBreakSessions) {
      setBreakSessions(customBreakSessions);
      return;
    }
    loadBreaks();
    const handler = () => loadBreaks();
    window.addEventListener('break-updated', handler);
    return () => window.removeEventListener('break-updated', handler);
  }, [customBreakSessions, loadBreaks]);

  useEffect(() => {
    const calculate = () => {
      const baseDate = dateContext ? new Date(dateContext + 'T00:00:00') : new Date();
      const isDateToday = dateContext ? isToday(dateContext) : true;
      
      // Determine logical endpoint for active tracking
      let activeEnd = new Date();
      if (isDateToday) {
        if (checkOutTime) {
          activeEnd = new Date(checkOutTime);
        } else {
          // If the agent is offline (no heartbeat/activity in 10 minutes), bound tracking to the last active time
          const lastActiveTime = lastDesktopActive ? new Date(lastDesktopActive) : null;
          const now = new Date();
          const tenMins = 10 * 60000;
          
          if (lastActiveTime && checkInTime && lastActiveTime.getTime() > new Date(checkInTime).getTime() && now.getTime() - lastActiveTime.getTime() > tenMins) {
            activeEnd = lastActiveTime;
          } else if (desktopLogs.length > 0 && checkInTime) {
            const lastLogTime = new Date(desktopLogs[desktopLogs.length - 1].timestamp);
            if (lastLogTime.getTime() > new Date(checkInTime).getTime() && now.getTime() - lastLogTime.getTime() > tenMins) {
              activeEnd = lastLogTime;
            }
          }
        }
      } else {
        if (checkOutTime) {
          activeEnd = new Date(checkOutTime);
        } else if (desktopLogs.length > 0) {
          activeEnd = new Date(desktopLogs[desktopLogs.length - 1].timestamp);
        } else if (checkInTime) {
          activeEnd = new Date(checkInTime);
        } else {
          activeEnd = new Date(baseDate);
          activeEnd.setHours(23, 59, 59, 999);
        }
      }

      const [startH, startM] = startTime.split(':').map(Number);
      const [endH, endM] = endTime.split(':').map(Number);
      const [lateH, lateM] = lateThreshold.split(':').map(Number);

      const start = new Date(baseDate); start.setHours(startH, startM, 0, 0);
      const end = new Date(baseDate); end.setHours(endH, endM, 0, 0);
      const late = new Date(baseDate); late.setHours(lateH, lateM, 0, 0);

      const totalMs = end.getTime() - start.getTime();
      
      let elapsedMs = activeEnd.getTime() - start.getTime();
      if (checkOutTime) {
        const co = toZonedTime(new Date(checkOutTime), 'Asia/Kolkata');
        const coToday = new Date(baseDate);
        coToday.setHours(co.getHours(), co.getMinutes(), co.getSeconds(), 0);
        elapsedMs = coToday.getTime() - start.getTime();
      } else if (!isDateToday) {
        // For past dates without checkout, set elapsed to show up to the activeEnd (e.g. last desktop activity or checkin)
        const activeEndZoned = toZonedTime(activeEnd, 'Asia/Kolkata');
        const activeEndToday = new Date(baseDate);
        activeEndToday.setHours(activeEndZoned.getHours(), activeEndZoned.getMinutes(), activeEndZoned.getSeconds(), 0);
        elapsedMs = activeEndToday.getTime() - start.getTime();
      }

      const pct = Math.max(0, (elapsedMs / totalMs) * 100);
      setProgress(checkInTime ? pct : 0);
      setIsShiftOver(checkOutTime ? true : activeEnd > end);
      setIsShiftPending(activeEnd < start);

      if (checkInTime) {
        const ci = toZonedTime(new Date(checkInTime), 'Asia/Kolkata');
        const ciToday = new Date(baseDate);
        ciToday.setHours(ci.getHours(), ci.getMinutes(), ci.getSeconds(), 0);
        
        let workedMins = 0;
        if (checkOutTime && typeof workedMinutes === 'number' && workedMinutes > 0) {
          workedMins = workedMinutes;
        } else {
          const coVal = checkOutTime ? new Date(checkOutTime) : new Date(activeEnd);
          const totalElapsedMins = Math.max(0, Math.floor((coVal.getTime() - new Date(checkInTime).getTime()) / 60000));
          
          let productiveMins = 0;
          
          const parsedBreaks = breakSessions.map(s => {
            const start = new Date(s.startTime).getTime();
            const end = s.endTime ? new Date(s.endTime).getTime() : new Date().getTime();
            return { start, end };
          });

          const sortedLogs = [...desktopLogs].sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

          for (let m = 0; m < totalElapsedMins; m++) {
            const timeAtMinute = new Date(checkInTime).getTime() + m * 60000;
            
            const isInsideBreak = parsedBreaks.some(b => timeAtMinute >= b.start && timeAtMinute < b.end);
            if (isInsideBreak) {
              continue;
            }

            let state: 'active' | 'idle' | 'locked' = 'active';
            for (const log of sortedLogs) {
              const logTime = new Date(log.timestamp).getTime();
              if (checkInTime && logTime < new Date(checkInTime).getTime()) {
                continue;
              }
              if (logTime <= timeAtMinute) {
                if (log.eventType === 'LOCK' || log.eventType === 'SLEEP' || log.eventType === 'SHUTDOWN') {
                  state = 'locked';
                } else if (log.eventType === 'UNLOCK' || log.eventType === 'WAKE' || log.eventType === 'IDLE_END') {
                  state = 'active';
                } else if (log.eventType === 'IDLE_START') {
                  state = 'idle';
                }
              } else {
                break;
              }
            }

            if (state === 'active') {
              productiveMins++;
            }
          }
          workedMins = productiveMins;
        }

        setWorkedTime({ hours: Math.floor(workedMins / 60), minutes: workedMins % 60 });
        const coVal = checkOutTime ? new Date(checkOutTime) : new Date(activeEnd);
        const elapsedMins = Math.max(0, Math.floor((coVal.getTime() - new Date(checkInTime).getTime()) / 60000));
        setElapsedTime({ hours: Math.floor(elapsedMins / 60), minutes: elapsedMins % 60 });

        const ciPct = Math.max(0, Math.min(100, ((ciToday.getTime() - start.getTime()) / totalMs) * 100));
        setCheckInPct(ciPct);
        setCheckInLabel(formatAttendanceTime(checkInTime instanceof Date ? checkInTime.toISOString() : checkInTime));
        setCheckInIsLate(ciToday > late);
      } else {
        setWorkedTime(null); setElapsedTime(null); setCheckInPct(null); setCheckInLabel(''); setCheckInIsLate(false);
      }

      if (checkOutTime) {
        const co = toZonedTime(new Date(checkOutTime), 'Asia/Kolkata');
        const coToday = new Date(baseDate);
        coToday.setHours(co.getHours(), co.getMinutes(), co.getSeconds(), 0);
        const coPct = Math.max(0, Math.min(100, ((coToday.getTime() - start.getTime()) / totalMs) * 100));
        setCheckOutPct(coPct);
        setCheckOutLabel(formatAttendanceTime(checkOutTime instanceof Date ? checkOutTime.toISOString() : checkOutTime));
      } else {
        setCheckOutPct(null); setCheckOutLabel('');
      }
    };

    calculate();

    if (checkOutTime || dateContext) {
      return;
    }

    const iv = setInterval(calculate, 30000);
    return () => clearInterval(iv);
  }, [startTime, endTime, lateThreshold, checkInTime, checkOutTime, workedMinutes, dateContext, desktopLogs, breakSessions]);

  const breakSessionsMapped = useMemo(() => {
    // Group breaks by window type to enforce quota (only first qualifying break
    // per window is official; the rest are raw away segments).
    const officialWindowsSeen = new Set<string>();

    return breakSessions.map(s => {
      const baseDate = dateContext ? new Date(dateContext + 'T00:00:00') : new Date();
      const isDateToday = dateContext ? isToday(dateContext) : true;
      const now = isDateToday ? new Date() : new Date(dateContext + 'T23:59:59');
      const [startH, startM] = startTime.split(':').map(Number);
      const [endH, endM] = endTime.split(':').map(Number);
      const shiftStart = new Date(baseDate); shiftStart.setHours(startH, startM, 0, 0);
      const shiftEnd = new Date(baseDate); shiftEnd.setHours(endH, endM, 0, 0);
      const totalMs = shiftEnd.getTime() - shiftStart.getTime();

      const bStart = toZonedTime(new Date(s.startTime), 'Asia/Kolkata');
      const bStartToday = new Date(baseDate);
      bStartToday.setHours(bStart.getHours(), bStart.getMinutes(), bStart.getSeconds(), 0);

      const bEndZoned = toZonedTime(new Date(s.endTime || now), 'Asia/Kolkata');
      const bEndToday = new Date(baseDate);
      bEndToday.setHours(bEndZoned.getHours(), bEndZoned.getMinutes(), bEndZoned.getSeconds(), 0);

      const startPct = Math.max(0, Math.min(100, ((bStartToday.getTime() - shiftStart.getTime()) / totalMs) * 100));
      const endPct = Math.max(0, Math.min(100, ((bEndToday.getTime() - shiftStart.getTime()) / totalMs) * 100));

      const durationMins = s.endTime
        ? Math.floor((new Date(s.endTime).getTime() - new Date(s.startTime).getTime()) / 60000)
        : null;

      // Determine if this is an official scheduled break
      const breakInfo = getScheduledBreakInfo(bStart);
      const minToQualify = breakInfo.type ? (BREAK_MIN_QUALIFY[breakInfo.type] ?? 0) : 0;
      const isManual = !desktopLogs.some(l =>
        Math.abs(new Date(l.timestamp).getTime() - bStart.getTime()) < 60000
      );
      const meetsMinDuration = isManual || durationMins === null || durationMins >= minToQualify;
      const windowKey = breakInfo.type ?? '';
      let isOfficialBreak = false;

      if (breakInfo.isBreak && meetsMinDuration && windowKey) {
        if (!officialWindowsSeen.has(windowKey)) {
          officialWindowsSeen.add(windowKey);
          isOfficialBreak = true;
        }
      }

      return {
        id: s.id,
        startPct,
        endPct,
        isOpen: !s.endTime,
        isOfficialBreak,
        isManual,
        startTimeLabel: formatAttendanceTime(s.startTime),
        endTimeLabel: s.endTime ? formatAttendanceTime(s.endTime) : 'Ongoing'
      };
    });
  }, [breakSessions, desktopLogs, startTime, endTime, dateContext]);

  const scheduledBreakPcts = useMemo(() => {
    const [startH, startM] = startTime.split(':').map(Number);
    const [endH, endM] = endTime.split(':').map(Number);
    const totalMins = (endH * 60 + endM) - (startH * 60 + startM);
    const shiftStartMin = startH * 60 + startM;

    return BREAK_SCHEDULE_DATA.map(b => {
      const [bsH, bsM] = b.start.split(':').map(Number);
      const [beH, beM] = b.end.split(':').map(Number);
      const startPct = ((bsH * 60 + bsM) - shiftStartMin) / totalMins * 100;
      const endPct = ((beH * 60 + beM) - shiftStartMin) / totalMins * 100;
      return { ...b, startPct, endPct };
    });
  }, [startTime, endTime]);

  const desktopSegments = useMemo(() => {
    if (!desktopLogs.length) return [];
    
    const [startH, startM] = startTime.split(':').map(Number);
    const [endH, endM] = endTime.split(':').map(Number);
    const baseDate = dateContext ? new Date(dateContext + 'T00:00:00') : new Date();
    const shiftStart = new Date(baseDate); shiftStart.setHours(startH, startM, 0, 0);
    const shiftEnd = new Date(baseDate); shiftEnd.setHours(endH, endM, 0, 0);
    const totalMs = shiftEnd.getTime() - shiftStart.getTime();

    const getLocalDateForTimestamp = (ts: string | Date) => {
      const zoned = toZonedTime(new Date(ts), 'Asia/Kolkata');
      const local = new Date(baseDate);
      local.setHours(zoned.getHours(), zoned.getMinutes(), zoned.getSeconds(), 0);
      return local;
    };

    const segments: Array<{ type: 'active' | 'idle' | 'locked', startPct: number, endPct: number, durationMs: number }> = [];

    // Base start point is check-in or first log
    let lastTime = checkInTime ? getLocalDateForTimestamp(checkInTime) : getLocalDateForTimestamp(desktopLogs[0].timestamp);

    let currentState: 'active' | 'idle' | 'locked' = 'active';

    for (const log of desktopLogs) {
      const logTime = getLocalDateForTimestamp(log.timestamp);

      if (logTime < lastTime) continue;

      if (logTime.getTime() > lastTime.getTime()) {
        const startPct = Math.max(0, Math.min(100, ((lastTime.getTime() - shiftStart.getTime()) / totalMs) * 100));
        const endPct = Math.max(0, Math.min(100, ((logTime.getTime() - shiftStart.getTime()) / totalMs) * 100));
        if (endPct > startPct) {
          segments.push({ type: currentState, startPct, endPct, durationMs: logTime.getTime() - lastTime.getTime() });
        }
      }

      if (log.eventType === 'LOCK' || log.eventType === 'SLEEP') currentState = 'locked';
      else if (log.eventType === 'UNLOCK' || log.eventType === 'WAKE') currentState = 'active';
      else if (log.eventType === 'IDLE_START') currentState = 'idle';
      else if (log.eventType === 'IDLE_END') currentState = 'active';
      else if (log.eventType === 'SHUTDOWN') currentState = 'locked';

      lastTime = logTime;
    }

    const isDateToday = dateContext ? isToday(dateContext) : true;
    let finalEndValue = new Date();
    if (isDateToday) {
      if (checkOutTime) {
        finalEndValue = new Date(checkOutTime);
      } else {
        // If the agent is offline (no heartbeat/activity in 10 minutes), bound tracking to the last active time
        const lastActiveTime = lastDesktopActive ? new Date(lastDesktopActive) : null;
        const now = new Date();
        const tenMins = 10 * 60000;
        
        if (lastActiveTime && now.getTime() - lastActiveTime.getTime() > tenMins) {
          finalEndValue = lastActiveTime;
        } else if (!lastActiveTime && desktopLogs.length > 0) {
          const lastLogTime = new Date(desktopLogs[desktopLogs.length - 1].timestamp);
          if (now.getTime() - lastLogTime.getTime() > tenMins) {
            finalEndValue = lastLogTime;
          }
        }
      }
    } else {
      if (checkOutTime) {
        finalEndValue = new Date(checkOutTime);
      } else if (desktopLogs.length > 0) {
        finalEndValue = new Date(desktopLogs[desktopLogs.length - 1].timestamp);
      } else if (checkInTime) {
        finalEndValue = new Date(checkInTime);
      } else {
        finalEndValue = new Date(baseDate);
        finalEndValue.setHours(23, 59, 59, 999);
      }
    }
    const finalEnd = getLocalDateForTimestamp(finalEndValue);
    
    // Only add final segment if we haven't checked out and the shift isn't completely over
    // or if we have a checkout time to bound it
    if (finalEnd.getTime() > lastTime.getTime()) {
        const startPct = Math.max(0, Math.min(100, ((lastTime.getTime() - shiftStart.getTime()) / totalMs) * 100));
        const endPct = Math.max(0, Math.min(100, ((finalEnd.getTime() - shiftStart.getTime()) / totalMs) * 100));
        if (endPct > startPct) {
          segments.push({ type: currentState, startPct, endPct, durationMs: finalEnd.getTime() - lastTime.getTime() });
        }
    }

    // Post-process segments: convert any idle segment under 10 minutes (600,000ms) to active
    const processedSegments = segments.map(seg => {
      if (seg.type === 'idle' && seg.durationMs < 600000) {
        return { ...seg, type: 'active' as const };
      }
      return seg;
    });

    // Merge consecutive segments of the same type
    const mergedSegments: typeof processedSegments = [];
    for (const seg of processedSegments) {
      if (mergedSegments.length === 0) {
        mergedSegments.push(seg);
      } else {
        const last = mergedSegments[mergedSegments.length - 1];
        if (last.type === seg.type) {
          last.endPct = seg.endPct;
          last.durationMs += seg.durationMs;
        } else {
          mergedSegments.push(seg);
        }
      }
    }

    return mergedSegments;
  }, [desktopLogs, startTime, endTime, dateContext, checkInTime, checkOutTime]);

  const combinedLogItems = useMemo(() => {
    const items: Array<{
      key: string;
      timestamp: Date;
      icon: React.ReactNode;
      desc: string;
    }> = [];

    // 1. Check In
    if (checkInTime) {
      items.push({
        key: 'check-in',
        timestamp: new Date(checkInTime),
        icon: <CheckCircle size={14} color="var(--wdt-accent-emerald)" strokeWidth={2.5} />,
        desc: 'Checked In',
      });
    }

    // 2. Check Out
    if (checkOutTime) {
      items.push({
        key: 'check-out',
        timestamp: new Date(checkOutTime),
        icon: <LogOut size={14} color="var(--wdt-accent-rose)" />,
        desc: 'Checked Out',
      });
    }

    const isDateToday = dateContext ? isToday(dateContext) : true;
    const baseDate = dateContext ? new Date(dateContext + 'T00:00:00') : new Date();

    // Helper to determine if an IDLE event is under 10 minutes and should be filtered out
    const shouldFilterIdleLog = (log: typeof desktopLogs[0], index: number) => {
      if (log.eventType === 'IDLE_START') {
        let endTimeVal = isDateToday ? new Date() : new Date(baseDate);
        if (!isDateToday) {
          endTimeVal.setHours(23, 59, 59, 999);
        }
        for (let j = index + 1; j < desktopLogs.length; j++) {
          const nextLog = desktopLogs[j];
          if (
            nextLog.eventType === 'IDLE_END' ||
            nextLog.eventType === 'UNLOCK' ||
            nextLog.eventType === 'WAKE' ||
            nextLog.eventType === 'LOCK' ||
            nextLog.eventType === 'SLEEP'
          ) {
            endTimeVal = new Date(nextLog.timestamp);
            break;
          }
        }
        const durationMs = endTimeVal.getTime() - new Date(log.timestamp).getTime();
        return durationMs < 600000;
      }
      if (log.eventType === 'IDLE_END') {
        let startTimeVal = new Date(log.timestamp);
        for (let j = index - 1; j >= 0; j--) {
          const prevLog = desktopLogs[j];
          if (prevLog.eventType === 'IDLE_START') {
            startTimeVal = new Date(prevLog.timestamp);
            break;
          }
        }
        const durationMs = new Date(log.timestamp).getTime() - startTimeVal.getTime();
        return durationMs < 600000;
      }
      return false;
    };

    // 3. Desktop Activity Logs
    desktopLogs.forEach((log, index) => {
      const isLock = log.eventType === 'LOCK' || log.eventType === 'SLEEP';
      const isUnlock = log.eventType === 'UNLOCK' || log.eventType === 'WAKE';
      const isIdleStart = log.eventType === 'IDLE_START';
      const isIdleEnd = log.eventType === 'IDLE_END';
      
      const logTime = new Date(log.timestamp);
      
      // Filter out idle events under 10 minutes
      if ((isIdleStart || isIdleEnd) && shouldFilterIdleLog(log, index)) {
        return;
      }

      // If this desktop activity corresponds to an active scheduled break session (within 60s),
      // we hide it to prevent duplicate logs. If it falls outside scheduled break hours, we
      // keep the raw desktop event because it is more informative ("Screen Locked", "Went Idle", etc.).
      const matchesScheduledBreak = breakSessions.some(session => {
        const breakStart = new Date(session.startTime);
        const breakEnd = session.endTime ? new Date(session.endTime) : null;
        
        // Skip comparing with transient breaks under 1 minute since they are filtered out
        const breakDurationMs = breakEnd ? (breakEnd.getTime() - breakStart.getTime()) : 0;
        if (breakEnd && breakDurationMs < 60000) {
          return false;
        }

        // Only hide the desktop log if the corresponding break is official or manual
        const mapped = breakSessionsMapped.find(m => m.id === session.id);
        if (!mapped) return false;
        
        const isOfficial = mapped.isOfficialBreak || mapped.isManual;
        if (!isOfficial) {
          return false;
        }

        const startDiff = Math.abs(logTime.getTime() - breakStart.getTime()) < 60000;
        const endDiff = breakEnd ? Math.abs(logTime.getTime() - breakEnd.getTime()) < 60000 : false;
        
        return startDiff || endDiff;
      });

      if (matchesScheduledBreak) {
        return; // Filter out redundant desktop activity item
      }
      
      let icon = <Power size={14} color="var(--wdt-accent-rose)" />;
      let desc = 'Shutdown';
      
      if (isLock) {
        icon = <Lock size={14} color="#8b5cf6" />;
        desc = log.eventType === 'LOCK' ? 'Screen Locked' : 'System Sleep';
      } else if (isUnlock) {
        icon = <Unlock size={14} color="var(--wdt-accent-emerald)" />;
        desc = log.eventType === 'UNLOCK' ? 'Screen Unlocked' : 'System Wake';
      } else if (isIdleStart) {
        icon = <Moon size={14} color="#64748b" />;
        desc = 'Went Idle';
      } else if (isIdleEnd) {
        icon = <Sun size={14} color="#f59e0b" />;
        desc = 'Returned from Idle';
      }

      items.push({
        key: `desktop-${log.id}`,
        timestamp: logTime,
        icon,
        desc,
      });
    });

    // 4. Break Sessions
    breakSessions.forEach((session) => {
      const startD = new Date(session.startTime);

      // Only display official or manual break sessions as official breaks in the Event Log.
      // Non-official/short breaks fallback to raw desktop logs.
      const mapped = breakSessionsMapped.find(m => m.id === session.id);
      if (!mapped) return;

      const isOfficial = mapped.isOfficialBreak || mapped.isManual;
      if (!isOfficial) {
        return;
      }

      // If the break session has ended and lasted less than 1 minute, skip it to prevent transient clutter
      if (session.endTime) {
        const durationMs = new Date(session.endTime).getTime() - startD.getTime();
        if (durationMs < 60000) {
          return;
        }
      }

      const breakInfo = getScheduledBreakInfo(startD);
      const name = breakInfo.type || "Custom Break";

      items.push({
        key: `break-start-${session.id}`,
        timestamp: startD,
        icon: name.includes('Lunch') ? <Utensils size={14} color="#3b82f6" /> : <Coffee size={14} color="#f59e0b" />,
        desc: `${name} Started`,
      });

      if (session.endTime) {
        const endD = new Date(session.endTime);
        items.push({
          key: `break-end-${session.id}`,
          timestamp: endD,
          icon: name.includes('Lunch') ? <Utensils size={14} color="var(--wdt-accent-emerald)" /> : <Coffee size={14} color="var(--wdt-accent-emerald)" />,
          desc: `${name} Ended`,
        });
      }
    });

    // Sort chronologically
    return items.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  }, [checkInTime, checkOutTime, desktopLogs, breakSessions, breakSessionsMapped]);

  const handleMouseMove = (e: React.MouseEvent<HTMLDivElement>) => {
    if (isExpanded) return;
    const rect = e.currentTarget.getBoundingClientRect();
    const pct = ((e.clientX - rect.left) / rect.width) * 100;
    const clampedPct = Math.max(0, Math.min(100, pct));
    setHoverPos(clampedPct);

    // 1. Check if hovering over a scheduled window
    const sch = scheduledBreakPcts.find(b => clampedPct >= b.startPct && clampedPct <= b.endPct);
    if (sch) {
      const labelSuffix = sch.label.toLowerCase().includes('break') ? '' : ' Break';
      setHoverText(`${sch.label}${labelSuffix}`);
      return;
    }

    // 2. Check if hovering over an actual break
    const act = breakSessionsMapped.find(s => clampedPct >= s.startPct && clampedPct <= s.endPct);
    if (act) {
      setHoverText(`Actual Break`);
      return;
    }

    // 2.5. Check if hovering over a desktop activity segment
    const seg = desktopSegments.find(s => clampedPct >= s.startPct && clampedPct <= s.endPct);
    if (seg) {
      const desc = seg.type === 'locked' ? 'Screen Locked' :
                   seg.type === 'idle' ? 'Went Idle' : 'Active / Working';
      const durMin = Math.round(seg.durationMs / 60000);
      const durStr = durMin > 0 ? ` (${durMin}m)` : '';
      setHoverText(`${desc}${durStr}`);
      return;
    }

    // 3. Fallback to specific time
    const [startH, startM] = startTime.split(':').map(Number);
    const [endH, endM] = endTime.split(':').map(Number);
    const startMins = startH * 60 + startM;
    const endMins = endH * 60 + endM;
    const totalMins = endMins - startMins;
    const currentMins = startMins + (totalMins * (clampedPct / 100));
    const h = Math.floor(currentMins / 60);
    const m = Math.floor(currentMins % 60);
    const period = h >= 12 ? 'PM' : 'AM';
    const displayH = h % 12 || 12;
    setHoverText(`${displayH}:${m.toString().padStart(2, '0')} ${period}`);
  };

  const hasActiveBreak = breakSessions.some(s => !s.endTime);

  const uptimeStr = useMemo(() => {
    if (!checkInTime) return '--';

    const isDateToday = dateContext ? isToday(dateContext) : true;
    
    let activeEnd = new Date();
    if (isDateToday) {
      if (checkOutTime) {
        activeEnd = new Date(checkOutTime);
      } else {
        // If the agent is offline (no heartbeat/activity in 10 minutes), bound tracking to the last active time
        const lastActiveTime = lastDesktopActive ? new Date(lastDesktopActive) : null;
        const now = new Date();
        const tenMins = 10 * 60000;
        
        if (lastActiveTime && checkInTime && lastActiveTime.getTime() > new Date(checkInTime).getTime() && now.getTime() - lastActiveTime.getTime() > tenMins) {
          activeEnd = lastActiveTime;
        } else if (desktopLogs.length > 0 && checkInTime) {
          const lastLogTime = new Date(desktopLogs[desktopLogs.length - 1].timestamp);
          if (lastLogTime.getTime() > new Date(checkInTime).getTime() && now.getTime() - lastLogTime.getTime() > tenMins) {
            activeEnd = lastLogTime;
          }
        }
      }
    } else {
      if (checkOutTime) {
        activeEnd = new Date(checkOutTime);
      } else if (desktopLogs.length > 0) {
        activeEnd = new Date(desktopLogs[desktopLogs.length - 1].timestamp);
      } else {
        activeEnd = new Date(checkInTime);
      }
    }

    if (hasActiveBreak) return '0m';

    const completedBreaks = breakSessions
      .filter(s => s.endTime)
      .sort((a, b) => {
        const timeA = a.endTime ? new Date(a.endTime).getTime() : 0;
        const timeB = b.endTime ? new Date(b.endTime).getTime() : 0;
        return timeB - timeA;
      });

    let uptimeMs = 0;
    if (completedBreaks.length > 0 && completedBreaks[0].endTime) {
      const lastBreakEnd = new Date(completedBreaks[0].endTime);
      uptimeMs = activeEnd.getTime() - lastBreakEnd.getTime();
    } else {
      const ci = new Date(checkInTime);
      uptimeMs = activeEnd.getTime() - ci.getTime();
    }

    const uptimeMins = Math.max(0, Math.floor(uptimeMs / 60000));
    const h = Math.floor(uptimeMins / 60);
    const m = uptimeMins % 60;
    return h > 0 ? `${h}h ${m}m` : `${m}m`;
  }, [checkInTime, checkOutTime, breakSessions, dateContext, desktopLogs]);

  const formatDuration = (h: number, m: number) => h > 0 ? `${h}h ${m}m` : `${m}m`;
  const requiredMins = 540 + (penaltyMinutes || 0);
  const isOvertime = workedTime ? (workedTime.hours * 60 + workedTime.minutes) > requiredMins : false;

  const statusLabel = !checkInTime ? 'Not Checked In' : checkOutTime ? 'Completed' : isShiftOver ? 'Shift Ended' : isShiftPending ? 'Pending' : hasActiveBreak ? 'Away / On Break' : 'Active';
  const statusClass = !checkInTime ? 'offline' : checkOutTime ? 'over' : isShiftOver ? 'over' : isShiftPending ? 'pending' : hasActiveBreak ? 'away' : 'active';

  const finalEndTimeLabel = useMemo(() => {
    if (!endTime) return '';
    const penalty = penaltyMinutes || 0;
    if (penalty <= 0) return format12h(endTime);
    
    const [h, m] = endTime.split(':').map(Number);
    const tempDate = new Date();
    tempDate.setHours(h, m + penalty, 0, 0);
    const newH = tempDate.getHours().toString().padStart(2, '0');
    const newM = tempDate.getMinutes().toString().padStart(2, '0');
    return format12h(`${newH}:${newM}`);
  }, [endTime, penaltyMinutes]);

  return (
    <div className={`card wdt-premium-v2 ${isExpanded ? 'is-expanded' : 'is-collapsed'} ${className}`}>
      <div className="wdt-body-clipper">
        <div className="wdt-glass-shine" />
      </div>

      <div className={`wdt-header-minimal ${!isExpanded ? 'wdt-header-collapsed' : ''}`}>
        <div className="wdt-status-group">
          <span className={`wdt-pulse-dot ${statusClass}`} />
          <span className="wdt-status-text">{statusLabel}</span>
        </div>

        <h3 className="wdt-title-sleek">Workday Progress</h3>

        <div className="wdt-minimal-meta">
          {workedTime && (
            <span className="wdt-time-compact">
              {formatDuration(workedTime.hours, workedTime.minutes)} worked
              {elapsedTime && ` (out of ${formatDuration(elapsedTime.hours, elapsedTime.minutes)} elapsed)`}
              {penaltyMinutes ? ` (includes ${penaltyMinutes}m penalty)` : ''}
              {isOvertime && (
                <span className="wdt-overtime-badge">
                  +{formatDuration(
                    Math.floor((workedTime.hours * 60 + workedTime.minutes - requiredMins) / 60),
                    (workedTime.hours * 60 + workedTime.minutes - requiredMins) % 60
                  )} OT
                </span>
              )}
            </span>
          )}
        </div>
      </div>
      <div className="wdt-bar-interface-row">
        <div className="wdt-gauge-area">
          <div className="wdt-gauge-container">
            <div
              className={`wdt-main-rail ${isOvertime ? 'wdt-main-rail--overtime' : ''}`}
              onMouseMove={handleMouseMove}
              onMouseLeave={() => setHoverText(null)}
            >
              <div className="wdt-rail-glass" />
              
              {!checkInTime && (
                <div className="wdt-rail-placeholder">
                  Not checked in today
                </div>
              )}
              
              <div className="wdt-rail-content">
                {checkInPct !== null && checkInIsLate && (
                  <div 
                    className="wdt-fill-late" 
                    style={{ width: `${checkInPct}%` }}
                  >
                    <div className="wdt-fill-glow" />
                  </div>
                )}

                {scheduledBreakPcts.map((b) => (
                  <div
                    key={b.label}
                    className="wdt-ghost-window"
                    style={{ left: `${b.startPct}%`, width: `${b.endPct - b.startPct}%` }}
                  >
                    {isExpanded && <div className="wdt-window-label">{b.label}</div>}
                  </div>
                ))}

                {desktopSegments.length > 0 ? (
                  desktopSegments.map((seg, i) => (
                    <div
                      key={i}
                      className={`wdt-fill-segment wdt-fill-segment--${seg.type}`}
                      style={{ left: `${seg.startPct}%`, width: `${seg.endPct - seg.startPct}%` }}
                    >
                      <div className="wdt-fill-glow" />
                    </div>
                  ))
                ) : (
                  <div
                    className={`wdt-fill-worked ${checkInPct !== null && checkInIsLate ? 'is-segmented' : ''}`}
                    style={{
                      left: `${checkInPct || 0}%`,
                      width: `${Math.max(0, Math.min(100 - (checkInPct || 0), progress - (checkInPct || 0)))}%`
                    }}
                  >
                    <div className="wdt-fill-glow" />
                  </div>
                )}

                {checkOutTime && progress < 100 && (
                  <div
                    className="wdt-fill-early-checkout-unfilled"
                    style={{
                      left: `${progress}%`,
                      width: `${100 - progress}%`
                    }}
                  />
                )}

                {breakSessionsMapped.map((seg) => (
                  <div
                    key={seg.id}
                    className={`wdt-break-block${seg.isOfficialBreak ? '' : ' wdt-break-block--away'}${seg.isOpen ? ' is-active' : ''}`}
                    style={{
                      left: `${seg.startPct}%`,
                      width: `${Math.max(1, seg.endPct - seg.startPct)}%`,
                    }}
                  >
                    <div className="wdt-fill-glow" />
                  </div>
                ))}
              </div>

              {isExpanded && checkInPct !== null && (
                <div className={`wdt-marker-checkin ${checkInIsLate ? 'is-late' : ''}`} style={{ left: `${checkInPct}%` }}>
                  <div 
                    className="wdt-checkin-tag"
                    style={{
                      left: checkInPct < 10 ? '0' : checkInPct > 90 ? 'auto' : '50%',
                      right: checkInPct > 90 ? '0' : 'auto',
                      transform: checkInPct < 10 ? 'translateX(0)' : checkInPct > 90 ? 'translateX(0)' : 'translateX(-50%)',
                      '--arrow-left': checkInPct < 10 ? '12px' : checkInPct > 90 ? 'calc(100% - 12px)' : '50%'
                    } as React.CSSProperties}
                  >
                    Checked In: {checkInLabel}
                  </div>
                </div>
              )}

              {isExpanded && checkOutPct !== null && (
                <div className="wdt-marker-checkout" style={{ left: `${checkOutPct}%` }}>
                  <div 
                    className="wdt-checkout-tag"
                    style={{
                      left: checkOutPct < 10 ? '0' : checkOutPct > 90 ? 'auto' : '50%',
                      right: checkOutPct > 90 ? '0' : 'auto',
                      transform: checkOutPct < 10 ? 'translateX(0)' : checkOutPct > 90 ? 'translateX(0)' : 'translateX(-50%)',
                      '--arrow-left': checkOutPct < 10 ? '12px' : checkOutPct > 90 ? 'calc(100% - 12px)' : '50%'
                    } as React.CSSProperties}
                  >
                    Checked Out: {checkOutLabel}
                  </div>
                </div>
              )}

              {!isExpanded && hoverText && (
                <div className="wdt-hover-bubble" style={{ left: `${hoverPos}%` }}>
                  {hoverText}
                </div>
              )}
            </div>

            {isExpanded && (
              <div className="wdt-gauge-footer">
                <span className="wdt-bound-label">{checkInLabel || format12h(startTime)}</span>
                <div className="wdt-gauge-steps">
                  {Array.from({ length: 8 }).map((_, i) => <div key={i} className="wdt-step" />)}
                </div>
                <span className="wdt-bound-label">{finalEndTimeLabel}</span>
              </div>
            )}
          </div>
        </div>

        <button className="wdt-toggle-icon-btn" onClick={() => setIsExpanded(!isExpanded)}>
          {isExpanded ? <ChevronUp size={20} /> : <ChevronDown size={20} />}
        </button>
      </div>

      {isExpanded && (
        <div className="wdt-expanded-layout">
          <div className="wdt-event-log-panel">
            <h3 className="wdt-panel-title">Event Log</h3>
            <div className="wdt-log-list">
              {combinedLogItems.map((item) => (
                <div key={item.key} className="wdt-log-item">
                  <span className="wdt-log-time">{formatAttendanceTime(item.timestamp.toISOString())}</span>
                  <span className="wdt-log-icon">{item.icon}</span>
                  <span className="wdt-log-desc">{item.desc}</span>
                </div>
              ))}
            </div>
          </div>

          <div className="wdt-summary-panel">
            <h3 className="wdt-panel-title">Day Summary</h3>
            <div className="wdt-summary-cards">
              <div className="wdt-summary-card">
                <span className="wdt-sc-label">Productive Time</span>
                <span className="wdt-sc-value">{workedTime ? formatDuration(workedTime.hours, workedTime.minutes) : '--'}</span>
              </div>
              <div className="wdt-summary-card">
                <span className="wdt-sc-label">Break Time</span>
                <span className="wdt-sc-value">
                  {breakSessions.length > 0 ? `${breakSessions.reduce((acc, s) => acc + s.durationMinutes, 0)}m` : '--'}
                </span>
              </div>
              <div className="wdt-summary-card">
                <span className="wdt-sc-label">Uptime (since break/away)</span>
                <span className="wdt-sc-value">{uptimeStr}</span>
              </div>
              <div className="wdt-summary-card">
                <span className="wdt-sc-label">Active Penalties</span>
                <span className="wdt-sc-value">{penaltyMinutes && penaltyMinutes > 0 ? `${penaltyMinutes}m` : '--'}</span>
              </div>
            </div>
            
            {/* Break Schedule mapping just to keep the old info available */}
            <div className="wdt-summary-schedule">
              <span className="wdt-sc-label">Break Schedule</span>
              {BREAK_SCHEDULE_DATA.map(b => (
                <div key={b.label} className="wdt-mini-row">
                  <span>{b.label}</span>
                  <span className="bold">{b.display}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default WorkdayTimeline;
