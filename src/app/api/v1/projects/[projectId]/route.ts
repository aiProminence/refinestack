import { withApiRequest } from "@/lib/platform/api-handler";
import { ensureProject } from "@/lib/platform/routes";

export const runtime = "nodejs";

export async function GET(request: Request, context: { params: Promise<{ projectId: string }> }) {
  return withApiRequest(request, "read", async ({ admin, principal }) => {
    const { projectId } = await context.params;
    return { data: await ensureProject(admin, principal.workspaceId, projectId) };
  });
}
