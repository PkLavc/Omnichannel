import { PrismaClient } from "@prisma/client";
import { importQuickReplies } from "../services/importer.js";

const [tenantSelector, file, sheet] = process.argv.slice(2);
if (!tenantSelector?.trim() || !file?.trim()) {
  throw new Error("Uso: rag:import <tenant-id-ou-slug> <arquivo.xlsx> [planilha]");
}

const prisma = new PrismaClient();
try {
  const tenant = await prisma.tenant.findFirst({
    where: {
      OR: [{ id: tenantSelector.trim() }, { slug: tenantSelector.trim() }],
      active: true,
    },
  });
  if (!tenant) throw new Error(`Empresa ativa não encontrada: ${tenantSelector}`);
  const imported = await importQuickReplies(prisma, tenant.id, file, sheet || undefined);
  console.log(JSON.stringify({ tenant: tenant.slug, imported }));
} finally {
  await prisma.$disconnect();
}
