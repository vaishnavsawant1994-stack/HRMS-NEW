import "../../test/setup";
import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { MemoryRouter } from "react-router-dom";
import CalendarPage from "./CalendarPage";
import { mockApiRoutes } from "../../test/api";
import { createCalendarDay } from "../../test/fixtures";

describe("CalendarPage", () => {
  test("renders calendar days and hides admin actions for employees", async () => {
    const now = new Date();

    mockApiRoutes([
      {
        path: /\/calendar\?month=\d+&year=\d+$/,
        data: {
          month: now.getMonth() + 1,
          year: now.getFullYear(),
          days: [
            createCalendarDay(),
            createCalendarDay({
              date: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-02T00:00:00.000Z`,
              dayNumber: 2,
              weekday: 4,
              status: "HOLIDAY",
              isWorkingDay: false,
              exception: {
                id: 9,
                date: `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-02T00:00:00.000Z`,
                type: "HOLIDAY",
                name: "Founders Day",
                description: "Company holiday",
                createdById: 1,
                createdAt: "2026-04-01T00:00:00.000Z",
                updatedAt: "2026-04-01T00:00:00.000Z",
              },
            }),
          ],
          exceptions: [],
        },
      },
    ]);

    render(
      <MemoryRouter>
        <CalendarPage token="token" role="EMPLOYEE" />
      </MemoryRouter>,
    );

    expect(await screen.findByText("Founders Day")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /add holiday/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /working saturday/i })).not.toBeInTheDocument();
  });

  test("shows management actions for HR users", async () => {
    const now = new Date();

    mockApiRoutes([
      {
        path: /\/calendar\?month=\d+&year=\d+$/,
        data: {
          month: now.getMonth() + 1,
          year: now.getFullYear(),
          days: [createCalendarDay()],
          exceptions: [],
        },
      },
    ]);

    render(
      <MemoryRouter>
        <CalendarPage token="token" role="HR" />
      </MemoryRouter>,
    );

    expect(await screen.findByRole("button", { name: /add holiday/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /working saturday/i })).toBeInTheDocument();
  });
});
