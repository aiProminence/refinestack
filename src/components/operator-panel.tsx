import { OperatorClient } from "@/components/operator-client";
import { listProjects } from "@/lib/db";
import { getDashboardContext } from "@/app/dashboard/_context";

export async function OperatorPanel() {
  const ctx = await getDashboardContext();
  const projects = await listProjects(ctx);
  const project = projects[0];
  if (!project) {
    return <details className="operator-panel"><summary><span className="operator-orb" aria-hidden="true">R</span><span><strong>RefineStack operator</strong><small>Project required</small></span></summary><div className="operator-body"><p>Create a project before querying workspace records.</p></div></details>;
  }
  return <OperatorClient projectId={project.id} />;
}
