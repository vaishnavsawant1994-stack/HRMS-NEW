import "../../test/setup";
import { render, screen, fireEvent } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { MemoryRouter } from "react-router-dom";
import { AppProvider } from "../../context/AppProvider";
import AttendancePage from "./AttendancePage";
import { mockApiRoutes } from "../../test/api";
import { createAttendance, createEmployee } from "../../test/fixtures";

describe("AttendancePage", () => {
  test("renders attendance history and action buttons for employees", async () => {
    mockApiRoutes([
      {
        path: "/attendance?date=2026-05-12",
        data: [
          createAttendance({
            attendanceDate: "2026-05-12T00:00:00.000Z",
            checkInTime: "2026-05-12T14:33:00.000Z", // 2:33 PM UTC -> 8:03 PM IST
            checkOutTime: "2026-05-12T16:01:00.000Z", // 4:01 PM UTC -> 9:31 PM IST
            status: "PRESENT",
          }),
        ],
      },
      {
        path: "/attendance/regularizations",
        data: [],
      },
    ]);

    const employee = createEmployee({ id: 1 });

    render(
      <MemoryRouter>
        <AppProvider token="token" role="EMPLOYEE">
          <AttendancePage
          token="token"
          role="EMPLOYEE"
          currentEmployeeId={1}
          currentEmployee={employee}
          />
        </AppProvider>
      </MemoryRouter>,
    );

    expect(await screen.findByText("Attendance history")).toBeInTheDocument();
    
    // In the new UI, employees see these buttons in the header
    expect(screen.getByRole("button", { name: /request correction/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /view requests/i })).toBeInTheDocument();
    
    // Verify record rendering (using IST time as displayed in UI)
    expect(screen.getByText("8:03 PM")).toBeInTheDocument();
    expect(screen.getByText("9:31 PM")).toBeInTheDocument();
  });

  test("allows opening the correction request modal", async () => {
    mockApiRoutes([
      { path: "/attendance?date=2026-05-12", data: [] },
      { path: "/attendance/regularizations", data: [] },
    ]);

    const employee = createEmployee({ id: 1 });

    render(
      <MemoryRouter>
        <AppProvider token="token" role="EMPLOYEE">
          <AttendancePage
          token="token"
          role="EMPLOYEE"
          currentEmployeeId={1}
          currentEmployee={employee}
          />
        </AppProvider>
      </MemoryRouter>,
    );

    await screen.findByText("Attendance history");
    fireEvent.click(screen.getByRole("button", { name: /request correction/i }));

    // The modal should open with the correct title and submit button
    expect(await screen.findByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText("Request attendance correction")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /submit request/i })).toBeInTheDocument();
  });

  test("limits the correction request date picker input to not select dates before joining date", async () => {
    mockApiRoutes([
      { path: "/attendance?date=2026-05-12", data: [] },
      { path: "/attendance/regularizations", data: [] },
    ]);

    // Employee joined on 2026-05-08
    const employee = createEmployee({ 
      id: 1,
      joiningDate: "2026-05-08T00:00:00.000Z" 
    });

    render(
      <MemoryRouter>
        <AppProvider token="token" role="EMPLOYEE">
          <AttendancePage
          token="token"
          role="EMPLOYEE"
          currentEmployeeId={1}
          currentEmployee={employee}
          />
        </AppProvider>
      </MemoryRouter>,
    );

    await screen.findByText("Attendance history");
    fireEvent.click(screen.getByRole("button", { name: /request correction/i }));

    expect(await screen.findByRole("dialog")).toBeInTheDocument();

    // Query date input inside dialog (Portalled)
    const dateInput = document.body.querySelector("input[type='date']") as HTMLInputElement;
    expect(dateInput).toBeInTheDocument();
    
    // It should have min attribute set to formatted joining date: "2026-05-08"
    expect(dateInput.getAttribute("min")).toBe("2026-05-08");
  });
});
