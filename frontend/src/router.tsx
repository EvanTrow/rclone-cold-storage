import { createBrowserRouter } from "react-router-dom";
import { Layout } from "./components/Layout";
import { Dashboard } from "./pages/Dashboard";
import { History } from "./pages/History";
import { Jobs } from "./pages/Jobs";
import { Login } from "./pages/Login";
import { Nodes } from "./pages/Nodes";
import { Settings } from "./pages/Settings";
import { Setup } from "./pages/Setup";

export const router = createBrowserRouter([
  { path: "/login", element: <Login /> },
  { path: "/setup", element: <Setup /> },
  {
    path: "/",
    element: <Layout />,
    children: [
      { index: true, element: <Dashboard /> },
      { path: "nodes", element: <Nodes /> },
      { path: "jobs", element: <Jobs /> },
      { path: "history", element: <History /> },
      { path: "settings", element: <Settings /> },
    ],
  },
]);
