import { ApiProblem } from "@/lib/platform/api";
import { withApiRequest } from "@/lib/platform/api-handler";
import { cursorSecret, decodeCursor, encodeCursor, pageLimit } from "@/lib/platform/pagination";

export const runtime = "nodejs";

export async function GET(request: Request) {
  return withApiRequest(request, "read", async ({ admin, principal, url }) => {
    const limit = pageLimit(url.searchParams.get("limit"));
    const secret = cursorSecret();
    const cursor = decodeCursor(url.searchParams.get("cursor"), secret);
    let query = admin.from("projects")
      .select("id,name,domain,category,default_market,default_locale,languages,status,created_at,updated_at")
      .eq("workspace_id", principal.workspaceId).order("updated_at", { ascending: false })
      .order("id", { ascending: false }).limit(limit + 1);
    if (cursor) query = query.or(`updated_at.lt.${cursor.sort},and(updated_at.eq.${cursor.sort},id.lt.${cursor.id})`);
    const { data, error } = await query;
    if (error) throw new ApiProblem(503, "data_unavailable", "Project data is temporarily unavailable.");
    const items = (data ?? []).slice(0, limit);
    const last = items.at(-1);
    return { data: {
      items,
      nextCursor: (data?.length ?? 0) > limit && last ? encodeCursor({ v: 1, sort: last.updated_at, id: last.id }, secret) : null,
    } };
  });
}
