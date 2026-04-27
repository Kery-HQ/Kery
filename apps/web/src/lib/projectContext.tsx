import React from "react";
import { fetchProjects } from "../projectApi";

export type Project = { id: string; name: string; domain?: string | null };

type ProjectContextType = {
  projects: Project[];
  currentProjectId: string | null;
  currentProject: Project | null;
  projectsLoaded: boolean;
  setCurrentProjectId: (id: string) => void;
  refreshProjects: () => Promise<void>;
};

const ProjectContext = React.createContext<ProjectContextType>({
  projects: [],
  currentProjectId: null,
  currentProject: null,
  projectsLoaded: false,
  setCurrentProjectId: () => {},
  refreshProjects: async () => {},
});

export function useProject() {
  return React.useContext(ProjectContext);
}

export function ProjectProvider({ children }: { children: React.ReactNode }) {
  const [projects, setProjects] = React.useState<Project[]>([]);
  const [projectsLoaded, setProjectsLoaded] = React.useState(false);
  const [currentProjectId, setCurrentProjectIdState] = React.useState<string | null>(
    () => localStorage.getItem("kery_project_id")
  );

  async function refreshProjects() {
    try {
      const res = await fetchProjects();
      const list: Project[] = res.projects || [];
      setProjects(list);
      setCurrentProjectIdState((prev) => {
        if (prev && list.find((p) => p.id === prev)) return prev;
        const first = list[0]?.id ?? null;
        if (first) localStorage.setItem("kery_project_id", first);
        return first;
      });
    } catch {}
    setProjectsLoaded(true);
  }

  function setCurrentProjectId(id: string) {
    localStorage.setItem("kery_project_id", id);
    setCurrentProjectIdState(id);
  }

  React.useEffect(() => {
    refreshProjects();
  }, []);

  const currentProject = projects.find((p) => p.id === currentProjectId) ?? null;

  return (
    <ProjectContext.Provider value={{ projects, currentProjectId, currentProject, projectsLoaded, setCurrentProjectId, refreshProjects }}>
      {children}
    </ProjectContext.Provider>
  );
}
