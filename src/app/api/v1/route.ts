import { withApiRequest } from "@/lib/platform/api-handler";

export const runtime = "nodejs";

export async function GET(request: Request) {
  return withApiRequest(request, "read", async () => ({
    data: {
      version: "v1",
      resources: ["projects", "runs", "observations", "exports"],
      documentation: "/api-docs",
    },
  }));
}
