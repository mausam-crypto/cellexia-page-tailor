import { PrismaClient } from "@prisma/client";

declare global {
  var prismaGlobal: PrismaClient;
}

if (process.env.NODE_ENV !== "production") {
  if (!global.prismaGlobal) {
    global.prismaGlobal = new PrismaClient();
  }
}

const prisma = global.prismaGlobal ?? new PrismaClient();

// SQLite's default journal mode makes every write block all readers (and
// vice versa) — with the background generation queue writing while admin
// pages read, that surfaces as "database is locked" stalls. WAL lets one
// writer and many readers proceed concurrently, and it is a persistent
// property of the database file, so setting it on boot covers every
// connection. Best-effort: a failure just leaves the old mode in place.
void prisma.$queryRawUnsafe("PRAGMA journal_mode=WAL;").catch(() => {});

export default prisma;
