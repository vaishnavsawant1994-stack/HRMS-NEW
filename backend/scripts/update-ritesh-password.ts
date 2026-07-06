import { PrismaClient } from "@prisma/client";
import bcrypt from "bcrypt";

const prisma = new PrismaClient();

async function main() {
  const email = "ritesh.intellisys@gmail.com";
  const password = "Password@123";
  const passwordHash = await bcrypt.hash(password, 10);

  const user = await prisma.user.findUnique({
    where: { email }
  });

  if (!user) {
    console.error(`User ${email} not found.`);
    return;
  }

  await prisma.user.update({
    where: { id: user.id },
    data: { passwordHash }
  });

  console.log(`Successfully updated password for ${email}`);
}

main()
  .then(async () => {
    await prisma.$disconnect();
  })
  .catch(async (e) => {
    console.error(e);
    await prisma.$disconnect();
    process.exit(1);
  });
