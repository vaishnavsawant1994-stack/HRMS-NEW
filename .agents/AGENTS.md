# Project Tracking & Sync Rules

## 1. Trigger Phrase: "Sync Project Sheet" or "/sync-excel"
*   **Trigger:** Whenever the user says `"Sync Project Sheet"`, `"/sync-excel"`, or mentions updating the task list/spreadsheet.
*   **Required Action:**
    1.  Update the progress percentages and `"lastUpdated"` field in [project-memory.json](file:///d:/Intellisys/HRMS-NEW/project-memory.json) using the current date-time.
    2.  Update the status of the task in [tasks.json](file:///d:/Intellisys/HRMS-NEW/tasks.json).
    3.  Log the task progress in [daily-log.json](file:///d:/Intellisys/HRMS-NEW/daily-log.json).
    4.  Update the narrative of the task in [daily-status-feed.json](file:///d:/Intellisys/HRMS-NEW/daily-status-feed.json).
    5.  Run the Excel generator script using `npm run sync-excel` (within the `backend` folder) to compile these updates into the `Standup_Feed` and other tracker sheets inside `HRMS_Project_Management.xlsx`.

## 2. Automatic Updates
*   At the end of any feature implementation, integration, or bug fix task, the agent should proactively review these tracking files, update them, and run the sync script to ensure the project documentation is never stale.

## 3. Issue Diagnosis and Verification Workflow
*   **Trigger:** Whenever the user reports an issue or bug.
*   **Required Action Workflow:**
    1.  **Verify the Issue** – First, investigate whether the reported problem actually exists. Do not assume user observations are always correct or immediately start making changes.
    2.  **Find the Root Cause** – If confirmed, identify the actual root cause instead of treating only the visible symptom.
    3.  **Explain Your Findings** – Briefly explain, in simple terms, what the problem is, why it is happening, and what you plan to change to fix it.
    4.  **Wait for Confirmation** – Do not start editing code files, updating task lists, committing, or pushing changes until the user explicitly confirms that the diagnosis and proposed approach are correct.
    5.  **Implement the Fix** – After approval, make the necessary changes.
    6.  **Let the User Verify** – Once changes are complete, stop and let the user test whether the issue has actually been resolved.
    7.  **Finalize Only After Confirmation** – Only after the user confirms the fix is working should you update task statuses, commit the changes, and push them to the repository.
