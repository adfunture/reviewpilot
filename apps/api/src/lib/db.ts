import { PrismaClient } from "@prisma/client";

let client: PrismaClient | undefined;

export function db(): PrismaClient {
  if (!client) client = new PrismaClient();
  return client;
}

export async function disconnectDb(): Promise<void> {
  if (client) await client.$disconnect();
  client = undefined;
}

export async function audit(
  shopId: string | null,
  actor: string,
  action: string,
  entity?: string,
  entityId?: string,
  data?: unknown,
): Promise<void> {
  await db().auditLog.create({
    data: { shopId, actor, action, entity, entityId, data: data === undefined ? undefined : (data as object) },
  });
}
