import { PrismaClient, RoleName, EmploymentStatus } from "@prisma/client";
import bcrypt from "bcrypt";
import { ensureEmployeeLeaveBalances } from "../src/utils/leave-balance";
import { getFinancialYearForDate } from "../src/utils/financial-year";

const prisma = new PrismaClient();

const testUsers = [
  {
    email: "admin@intellisys.com",
    firstName: "Test",
    lastName: "Admin",
    employeeCode: "TEST-ADMIN",
    roleName: RoleName.ADMIN,
    departmentCode: "ADMIN",
    jobTitle: "Administrator",
  },
  {
    email: "hr@intellisys.com",
    firstName: "Test",
    lastName: "HR",
    employeeCode: "TEST-HR",
    roleName: RoleName.HR,
    departmentCode: "HR",
    jobTitle: "HR Manager",
  },
  {
    email: "manager@intellisys.com",
    firstName: "Test",
    lastName: "Manager",
    employeeCode: "TEST-MANAGER",
    roleName: RoleName.MANAGER,
    departmentCode: "SD",
    jobTitle: "Engineering Manager",
  },
  {
    email: "employee@intellisys.com",
    firstName: "Test",
    lastName: "Employee",
    employeeCode: "TEST-EMPLOYEE",
    roleName: RoleName.EMPLOYEE,
    departmentCode: "SD",
    jobTitle: "Software Engineer",
  }
];

async function main() {
  const password = "Password@123";
  const passwordHash = await bcrypt.hash(password, 10);

  // Find a default shift (Day Shift or any active shift)
  let shift = await prisma.shift.findFirst({ where: { name: "Day Shift" } });
  if (!shift) {
    shift = await prisma.shift.findFirst();
  }

  const joiningDate = new Date();
  const financialYear = getFinancialYearForDate(joiningDate);

  console.log("Starting test user seeding for E2E role profiles...");

  for (const userConfig of testUsers) {
    console.log(`Processing: ${userConfig.email} (${userConfig.roleName})...`);

    // 1. Get role
    const roleRecord = await prisma.role.findUnique({
      where: { name: userConfig.roleName }
    });
    if (!roleRecord) {
      throw new Error(`Role ${userConfig.roleName} not found in database`);
    }

    // 2. Get department
    let department = await prisma.department.findUnique({
      where: { code: userConfig.departmentCode }
    });
    if (!department) {
      console.warn(`Department ${userConfig.departmentCode} not found. Creating/falling back...`);
      department = await prisma.department.upsert({
        where: { code: userConfig.departmentCode },
        update: {},
        create: {
          name: userConfig.departmentCode === "ADMIN" ? "Administration" : "HR",
          code: userConfig.departmentCode,
        }
      });
    }

    // 3. Check if user already exists
    const existingUser = await prisma.user.findUnique({
      where: { email: userConfig.email },
      include: { employee: true }
    });

    let employeeId: number;

    if (existingUser) {
      console.log(`User with email ${userConfig.email} already exists. Updating...`);
      const updatedUser = await prisma.user.update({
        where: { id: existingUser.id },
        data: {
          passwordHash,
          roleId: roleRecord.id,
          isActive: true,
        }
      });

      if (existingUser.employee) {
        const updatedEmployee = await prisma.employee.update({
          where: { id: existingUser.employee.id },
          data: {
            employeeCode: userConfig.employeeCode,
            firstName: userConfig.firstName,
            lastName: userConfig.lastName,
            departmentId: department.id,
            shiftId: shift?.id ?? null,
            employmentStatus: EmploymentStatus.ACTIVE,
            isActive: true,
            jobTitle: userConfig.jobTitle,
          }
        });
        employeeId = updatedEmployee.id;
      } else {
        const createdEmployee = await prisma.employee.create({
          data: {
            userId: updatedUser.id,
            employeeCode: userConfig.employeeCode,
            firstName: userConfig.firstName,
            lastName: userConfig.lastName,
            departmentId: department.id,
            shiftId: shift?.id ?? null,
            joiningDate,
            employmentStatus: EmploymentStatus.ACTIVE,
            isActive: true,
            jobTitle: userConfig.jobTitle,
          }
        });
        employeeId = createdEmployee.id;
      }
    } else {
      console.log(`Creating user with email ${userConfig.email}...`);
      const createdEmployee = await prisma.$transaction(async (tx) => {
        const user = await tx.user.create({
          data: {
            email: userConfig.email,
            passwordHash,
            roleId: roleRecord.id,
            isActive: true
          }
        });

        return tx.employee.create({
          data: {
            userId: user.id,
            employeeCode: userConfig.employeeCode,
            firstName: userConfig.firstName,
            lastName: userConfig.lastName,
            departmentId: department!.id,
            shiftId: shift?.id ?? null,
            joiningDate,
            employmentStatus: EmploymentStatus.ACTIVE,
            isActive: true,
            jobTitle: userConfig.jobTitle,
          }
        });
      });
      employeeId = createdEmployee.id;
    }

    // Seed leave balances
    await ensureEmployeeLeaveBalances(prisma, employeeId, financialYear);
    console.log(`Successfully processed test user: ${userConfig.firstName} ${userConfig.lastName} (${userConfig.email})`);
  }

  console.log("Successfully completed seeding test user accounts!");
}

main()
  .catch((e) => console.error("Error creating test users:", e))
  .finally(async () => {
    await prisma.$disconnect();
  });
